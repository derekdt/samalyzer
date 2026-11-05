const fs = require('fs');
const path = require('path');
require('dotenv').config();
const puppeteer = require('puppeteer');

const { log, logError, parseCliArgs, politeDelay, slugFromUrl } = require('./util');
const { login } = require('./auth');
const { listArticles } = require('./discover');
const { exportArticle } = require('./exportArticle');
const { Manifest } = require('./manifest');
const { Registry } = require('./registry');

function loadConfig() {
  const cfgPath = path.resolve(__dirname, '..', 'config.json');
  const raw = fs.readFileSync(cfgPath, 'utf8');
  return JSON.parse(raw);
}

function applyCliOverrides(config, flags) {
  const out = { ...config };
  if (flags.headless !== undefined) {
    out.headless = !(flags.headless === 'false' || flags.headless === false);
  }
  if (flags['max-pages'] !== undefined) {
    out.maxPages = Number(flags['max-pages']);
  }
  if (flags['max-articles'] !== undefined) {
    out.maxArticles = Number(flags['max-articles']);
  }
  return out;
}

function printHelp() {
  console.log(`
Samalyzer — Sam Weiss Newsletter Daily Briefing Archiver

Usage:
  npm start                               Full run: login, discover, export missing daily briefings.
  npm start -- --dry-run                  Discover + list work queue, no daily briefings.
  npm start -- --force                    Re-export everything, ignoring manifest.
  npm start -- --url <article-url>        Export a single article URL (still logs in).
  npm start -- --headless=false           Run with a visible browser window.
  npm start -- --max-pages <N>            Stop discovery after N archive pages.
  npm start -- --max-articles <N>         Export at most N articles this run.
  npm start -- --full-refresh             Rediscover every archive page, replacing the registry.
  npm start -- --skip-discovery           Use existing registry; make no archive requests.
  npm start -- --discover-only            Refresh the registry and exit without exporting.
  npm start -- --help                     Print this help.
`);
}

async function run() {
  const { flags } = parseCliArgs(process.argv.slice(2));

  if (flags.help || flags.h) {
    printHelp();
    return;
  }

  const baseConfig = loadConfig();
  const config = applyCliOverrides(baseConfig, flags);

  const genDir = path.resolve(config.genDir || './gen');
  config.outputDir = path.join(genDir, 'daily-briefings');
  config.manifestPath = path.join(genDir, 'manifest.json');
  config.registryPath = path.join(genDir, 'registry.json');

  if (!fs.existsSync(config.outputDir)) fs.mkdirSync(config.outputDir, { recursive: true });
  const manifest = new Manifest(config.manifestPath);
  const registry = new Registry(config.registryPath);

  const dryRun = Boolean(flags['dry-run']);
  const force = Boolean(flags.force);
  const fullRefresh = Boolean(flags['full-refresh']);
  const skipDiscovery = Boolean(flags['skip-discovery']);
  const discoverOnly = Boolean(flags['discover-only']);
  const singleUrl = typeof flags.url === 'string' ? flags.url : null;
  const maxArticles = config.maxArticles ? Number(config.maxArticles) : null;

  log(`config: headless=${config.headless}, genDir=${genDir}`);
  log(`manifest: ${manifest.count()} articles already exported`);

  const browser = await puppeteer.launch({
    headless: config.headless,
    defaultViewport: { width: 1280, height: 1800 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const stats = { exported: 0, skipped: 0, failed: 0 };

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs || 60000);

    await login(page, config);

    let queue;
    if (singleUrl) {
      queue = [
        {
          url: singleUrl,
          title: slugFromUrl(singleUrl),
          publishedDate: null,
        },
      ];
      log(`single-url mode: ${singleUrl}`);
    } else {
      if (fullRefresh || registry.count() === 0) {
        const reason = fullRefresh ? '--full-refresh' : 'registry empty';
        log(`discovery: full walk (${reason})`);
        registry.replace([]);
        const accumulated = [];
        await listArticles(page, config, {
          onPage: (pageItems) => {
            accumulated.push(...pageItems);
            registry.replace(accumulated);
          },
        });
        log(`registry: replaced with ${registry.count()} articles`);
      } else if (!skipDiscovery) {
        log(`discovery: incremental (stop at first known URL)`);
        const tail = registry.articles().slice();
        const tailSet = new Set(tail.map((a) => a.url));
        const accumulated = [];
        await listArticles(page, config, {
          stopIf: (item) => tailSet.has(item.url),
          onPage: (pageItems) => {
            accumulated.push(...pageItems);
            registry.replace([...accumulated, ...tail]);
          },
        });
        log(`registry: ${accumulated.length} new article(s) added (total ${registry.count()})`);
      } else {
        log(`discovery: skipped (--skip-discovery); using existing registry of ${registry.count()}`);
      }

      if (discoverOnly) {
        log('--discover-only set; registry refreshed, exiting without export');
        return;
      }

      queue = [];
      for (const article of registry.articles()) {
        if (!force && manifest.has(article.url)) break;
        queue.push(article);
      }
      stats.skipped = registry.count() - queue.length;
      log(`${queue.length} queued for export, ${stats.skipped} already in manifest`);
    }

    if (maxArticles && queue.length > maxArticles) {
      log(`limiting run to first ${maxArticles} articles (--max-articles)`);
      queue = queue.slice(0, maxArticles);
    }

    if (dryRun) {
      log('--dry-run set; listing queue and exiting');
      for (const a of queue) {
        console.log(`  ${a.publishedDate || '????-??-??'}  ${a.url}`);
      }
      return;
    }

    for (let i = 0; i < queue.length; i++) {
      const article = queue[i];
      log(`[${i + 1}/${queue.length}] ${article.url}`);
      try {
        const result = await exportArticle(page, article, config);
        const exportPathFromGen = path
          .relative(genDir, path.dirname(result.path))
          .split(path.sep)
          .join('/');
        manifest.record(article.url, {
          publishedDate: article.publishedDate,
          exportPath: exportPathFromGen,
        });
        stats.exported++;
      } catch (err) {
        stats.failed++;
        logError(`failed to export ${article.url}: ${err.message}`);
      }

      if (i < queue.length - 1) {
        await politeDelay(config.delayBetweenArticlesMs, 'next article');
      }
    }
  } finally {
    await browser.close();
  }

  log(
    `done — exported=${stats.exported} skipped=${stats.skipped} failed=${stats.failed}`
  );
  if (stats.failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  logError(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
