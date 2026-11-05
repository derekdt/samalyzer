// `npm run investing-basics` — log in and save every section page of the
// Investing Basics chapters as self-contained HTML under
// gen/investing-basics/chapter-<n>/<n.m>-<name>/. Independent of the other
// commands.
//
// Each chapter is several pages (1.1, 1.2, … plus a Q&A page) linked by a row
// of section buttons. Sections are discovered from those buttons at run time,
// so new sections are picked up without a config change.

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const puppeteer = require('puppeteer');

const { log, logError, parseCliArgs, politeDelay } = require('./util');
const { login } = require('./auth');
const { saveSourceHtml, ensureAllImagesLoaded, unwrapImageLinks, expandAllComments } = require('./exportArticle');
const { prepareForSave } = require('./strategy');

const DEFAULT_CHAPTERS = [
  { number: 1, path: '/investing-basics/time/' },
  { number: 2, path: '/investing-basics/inherent-leverage/' },
  { number: 3, path: '/investing-basics/risk-management-1/' },
  { number: 4, path: '/investing-basics/options/' },
  { number: 5, path: '/investing-basics/chapter-5-1/' },
];

function loadConfig() {
  const cfgPath = path.resolve(__dirname, '..', 'config.json');
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

function printHelp() {
  console.log(`
Samalyzer — Investing Basics chapters

Usage:
  npm run investing-basics                       Save every section of the configured chapters.
  npm run investing-basics -- --chapter 3        Only chapter 3.
  npm run investing-basics -- --dry-run          List the sections found, don't save anything.
  npm run investing-basics -- --headless=false   Run with a visible browser window.
  npm run investing-basics -- --help             Print this help.
`);
}

function slug(s) {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Same page regardless of trailing slash, query or #fragment.
function pageKey(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return null;
  }
}

function sectionPaths(outDir, chapterDir, sectionDir) {
  const dir = path.join(outDir, chapterDir, sectionDir);
  const sourceDir = path.join(dir, 'source');
  return {
    dir,
    metadataJson: path.join(dir, 'metadata.json'),
    sourceDir,
    html: path.join(sourceDir, 'index.html'),
    imagesDir: path.join(sourceDir, 'images'),
    stylesDir: path.join(sourceDir, 'styles'),
    assetsDir: path.join(sourceDir, 'assets'),
  };
}

// Section buttons on the current page, e.g. "1.2 Mitigating Risk" -> URL.
async function sectionButtons(page, chapterNumber) {
  return page.evaluate((n) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const content = document.querySelector('.entry-content') || document.body;
    const re = new RegExp(`^${n}\\.(\\d+)\\b\\s*(.*)$`);
    const out = [];
    for (const a of content.querySelectorAll('a[href]')) {
      if (!visible(a)) continue;
      const m = clean(a.textContent).match(re);
      if (m) out.push({ number: `${n}.${m[1]}`, label: m[2].trim(), href: a.href });
    }
    return out;
  }, chapterNumber);
}

// "Chapter 1: Time can be your greatest Strength…" headings on the index page.
async function chapterTitles(page, indexUrl) {
  await page.goto(indexUrl, { waitUntil: 'networkidle2' });
  return page.evaluate(() => {
    const out = {};
    for (const h of document.querySelectorAll('h1, h2, h3, h4')) {
      const m = h.textContent.replace(/\s+/g, ' ').trim().match(/^chapter\s+(\d+)\s*:\s*(.+)$/i);
      if (m) out[m[1]] = m[2];
    }
    return out;
  });
}

async function assertAuthenticated(page, config) {
  const html = await page.content();
  if ((config.paywallMarker && html.includes(config.paywallMarker)) || (await page.$('input[name="pwd"]'))) {
    throw new Error('page is showing a login/paywall prompt; session is not authenticated');
  }
}

async function run() {
  const { flags } = parseCliArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    printHelp();
    return;
  }

  const config = loadConfig();
  if (flags.headless !== undefined) {
    config.headless = !(flags.headless === 'false' || flags.headless === false);
  }
  const dryRun = Boolean(flags['dry-run']);
  const onlyChapter = flags.chapter !== undefined ? Number(flags.chapter) : null;
  const genDir = path.resolve(config.genDir || './gen');
  const outDir = path.join(genDir, 'investing-basics');
  const ib = config.investingBasics || {};
  const indexUrl = `${config.baseUrl}${ib.indexPath || '/investing-basics/'}`;
  const chapters = (ib.chapters || DEFAULT_CHAPTERS)
    .filter((c) => onlyChapter == null || c.number === onlyChapter)
    .map((c) => ({ ...c, url: `${config.baseUrl}${c.path}` }));
  if (chapters.length === 0) throw new Error(`no configured chapter matches --chapter ${flags.chapter}`);

  const browser = await puppeteer.launch({
    headless: config.headless,
    defaultViewport: { width: 1280, height: 1800 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let exported = 0;
  let failed = 0;
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs || 60000);
    await login(page, config);

    const titles = await chapterTitles(page, indexUrl);

    // 1. Discovery: read each chapter's section buttons from its first page.
    const sections = []; // { chapter, number, label, url, dir }
    const byKey = new Map(); // pageKey(any known URL) -> section
    const addSection = (chapter, number, label, url) => {
      const existing = sections.find((s) => s.number === number);
      if (existing) {
        byKey.set(pageKey(url), existing);
        return existing;
      }
      const name = label || (number.endsWith('.1') ? 'introduction' : 'section');
      // e.g. "1.2-mitigating-risk", "2.4-options-v-margin", "1.6-q-and-a"
      const section = { chapter, number, label: label || null, url, dir: `${number}-${slug(name)}` };
      sections.push(section);
      byKey.set(pageKey(url), section);
      return section;
    };

    for (const ch of chapters) {
      await page.goto(ch.url, { waitUntil: 'networkidle2' });
      await assertAuthenticated(page, config);
      const buttons = await sectionButtons(page, ch.number);
      if (buttons.length === 0) {
        // No button row: treat the start page as the chapter's only section.
        addSection(ch, `${ch.number}.1`, null, page.url());
      }
      for (const b of buttons) addSection(ch, b.number, b.label, b.href);
      // The start page under its final (redirected) URL.
      const start = buttons.find((b) => pageKey(b.href) === pageKey(page.url())) || buttons[0];
      if (start) byKey.set(pageKey(page.url()), sections.find((s) => s.number === start.number));
      await politeDelay(config.delayBetweenPagesMs, 'next chapter');
    }

    // Button links are often short forms that redirect ("/time-2" →
    // "/investing-basics/time-2/"), and pages link to each other by either
    // form. Resolve each section's final URL up front (a plain request, no
    // rendering) so every spelling is relinked, not just the ones visited so far.
    const cookie = (await page.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
    for (const s of sections) {
      try {
        const resp = await fetch(s.url, { method: 'HEAD', redirect: 'follow', headers: { Cookie: cookie } });
        if (resp.ok && resp.url) {
          byKey.set(pageKey(resp.url), s);
          s.url = resp.url;
        }
      } catch (err) {
        log(`  could not resolve ${s.url} (${err.message}); links to it may stay remote`);
      }
    }

    const ordered = () =>
      sections.slice().sort((a, b) => {
        const [a1, a2] = a.number.split('.').map(Number);
        const [b1, b2] = b.number.split('.').map(Number);
        return a1 - b1 || a2 - b2;
      });

    log(`found ${sections.length} section page(s) in ${chapters.length} chapter(s):`);
    for (const s of ordered()) log(`  chapter-${s.chapter.number}/${s.dir}  ${s.url}`);
    if (dryRun) {
      log('--dry-run set; nothing saved');
      return;
    }

    // From chapter-<n>/<section>/source/index.html, another section is
    // ../../../chapter-<m>/<other>/source/index.html.
    const localLinks = () => {
      const links = {};
      for (const [key, s] of byKey) links[key] = `../../../chapter-${s.chapter.number}/${s.dir}/source/index.html`;
      return links;
    };

    // 2. Export each section. Sections only linked from a later page are
    // added as they're found.
    const done = new Set();
    for (;;) {
      const s = ordered().find((x) => !done.has(x));
      if (!s) break;
      done.add(s);
      const label = `chapter-${s.chapter.number}/${s.dir}`;
      log(`[${done.size}/${sections.length}] ${label}  ${s.url}`);
      try {
        await page.goto(s.url, { waitUntil: 'networkidle2' });
        await assertAuthenticated(page, config);
        byKey.set(pageKey(page.url()), s);
        s.finalUrl = page.url().replace(/#.*$/, '');

        const before = sections.length;
        for (const b of await sectionButtons(page, s.chapter.number)) addSection(s.chapter, b.number, b.label, b.href);
        if (sections.length > before) {
          log(`  found ${sections.length - before} more section(s) linked from this page; pages already saved won't link to them locally`);
        }

        const expanded = await expandAllComments(page, {
          selectors: config.commentExpanderSelectors || [],
          textPatterns: config.commentExpanderTextPatterns || [],
        });
        const { opened, relinked } = await prepareForSave(page, localLinks());
        const imgs = await ensureAllImagesLoaded(page);
        await unwrapImageLinks(page);
        const info = await page.evaluate(() => ({
          title: document.title.replace(/\s*[–-]\s*Sam Weiss\s*$/, '').trim(),
          commentCount: document.querySelectorAll('.wpd-comment').length,
        }));
        log(
          `  opened ${opened} section(s), ${info.commentCount} comment(s) (${expanded.clicks} expand click(s)), ` +
            `relinked ${relinked} link(s), images ${imgs.loaded}/${imgs.total}`
        );

        const target = sectionPaths(outDir, `chapter-${s.chapter.number}`, s.dir);
        fs.mkdirSync(target.dir, { recursive: true });
        await saveSourceHtml(page, s.finalUrl, target);

        const metadata = {
          chapter: s.chapter.number,
          chapterTitle: titles[s.chapter.number] || null,
          section: s.number,
          sectionLabel: s.label,
          title: info.title,
          url: s.finalUrl,
          commentCount: info.commentCount,
          exportedAt: new Date().toISOString(),
          sourcePath: 'source',
        };
        fs.writeFileSync(target.metadataJson, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
        exported++;
      } catch (err) {
        failed++;
        logError(`failed to export ${label} (${s.url}): ${err.message}`);
      }
      if (ordered().some((x) => !done.has(x))) await politeDelay(config.delayBetweenArticlesMs, 'next section');
    }
  } finally {
    await browser.close();
  }

  log(`done — exported=${exported} failed=${failed} → ${outDir}`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  run().catch((err) => {
    logError(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}
