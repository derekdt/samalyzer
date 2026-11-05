// `npm run strategy` — log in and save the Samwise Strategy pages (Executive
// Summary, 4-Part Framework, High-Pro Strategy, Samwise Rule of Investing) as
// self-contained HTML under gen/samwise-strategy/. Independent of the other
// commands.

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const puppeteer = require('puppeteer');

const { log, logError, parseCliArgs } = require('./util');
const { login } = require('./auth');
const { saveSourceHtml, ensureAllImagesLoaded, unwrapImageLinks } = require('./exportArticle');

const DEFAULT_PAGES = [
  { name: 'Executive Summary', path: '/samwise/samwise-strategies/' },
  { name: '4-Part Framework', path: '/samwise/samwise-strategies/4-part-framework/' },
  { name: 'High-Pro Strategy', path: '/samwise/samwise-strategies/high-pro/' },
  { name: 'Samwise Rule of Investing', path: '/samwise/samwise-strategies4/' },
];

function loadConfig() {
  const cfgPath = path.resolve(__dirname, '..', 'config.json');
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

function printHelp() {
  console.log(`
Samalyzer — Samwise Strategy pages

Usage:
  npm run strategy                       Log in and save each strategy page to gen/samwise-strategy/<slug>/.
  npm run strategy -- --headless=false   Run with a visible browser window.
  npm run strategy -- --help             Print this help.
`);
}

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
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

function paths(outDir, pageSlug) {
  const dir = path.join(outDir, pageSlug);
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

// Open every collapsed section so the saved HTML shows all content, and point
// links to the other strategy pages at their local exports.
async function prepareForSave(page, localLinks) {
  return page.evaluate((links) => {
    const keyOf = (href) => {
      try {
        const u = new URL(href, location.href);
        return `${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
      } catch {
        return null;
      }
    };
    let opened = 0;
    for (const d of document.querySelectorAll('details')) {
      if (!d.open) {
        d.open = true;
        opened++;
      }
    }
    let relinked = 0;
    for (const a of document.querySelectorAll('a[href]')) {
      const raw = a.getAttribute('href');
      if (!raw || raw.startsWith('#')) continue;
      const local = links[keyOf(raw)];
      if (local) {
        a.setAttribute('href', local);
        relinked++;
      }
    }
    return { opened, relinked };
  }, localLinks);
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
  const genDir = path.resolve(config.genDir || './gen');
  const outDir = path.join(genDir, 'samwise-strategy');
  const pages = (config.strategyPages || DEFAULT_PAGES).map((p) => ({
    ...p,
    url: `${config.baseUrl}${p.path}`,
    slug: slug(p.name),
  }));

  // From <slug>/source/index.html, a sibling export is ../../<slug>/source/index.html.
  const localLinks = {};
  for (const p of pages) localLinks[pageKey(p.url)] = `../../${p.slug}/source/index.html`;

  const browser = await puppeteer.launch({
    headless: config.headless,
    defaultViewport: { width: 1280, height: 1800 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let failed = 0;
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs || 60000);
    await login(page, config);

    for (const p of pages) {
      log(`[${p.name}] ${p.url}`);
      try {
        await page.goto(p.url, { waitUntil: 'networkidle2' });
        const html = await page.content();
        if ((config.paywallMarker && html.includes(config.paywallMarker)) || (await page.$('input[name="pwd"]'))) {
          throw new Error('page is showing a login/paywall prompt; session is not authenticated');
        }

        const { opened, relinked } = await prepareForSave(page, localLinks);
        const imgs = await ensureAllImagesLoaded(page);
        await unwrapImageLinks(page);
        log(`  opened ${opened} collapsed section(s), relinked ${relinked} link(s), images ${imgs.loaded}/${imgs.total}`);

        const title = await page.evaluate(() => document.title.replace(/\s*[–-]\s*Sam Weiss\s*$/, '').trim());
        const target = paths(outDir, p.slug);
        fs.mkdirSync(target.dir, { recursive: true });
        await saveSourceHtml(page, p.url, target);

        const metadata = {
          name: p.name,
          url: p.url,
          slug: p.slug,
          title,
          exportedAt: new Date().toISOString(),
          sourcePath: 'source',
        };
        fs.writeFileSync(target.metadataJson, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
      } catch (err) {
        failed++;
        logError(`failed to export ${p.name} (${p.url}): ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  log(`done — exported=${pages.length - failed} failed=${failed} → ${outDir}`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  run().catch((err) => {
    logError(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

module.exports = { prepareForSave };
