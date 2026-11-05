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
const { relinkCollection, logStats } = require('./relink');

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

// Paginated archives exported by this command. Each has its own output folder
// and registry; `npm run articles` is `--collection articles`.
const COLLECTIONS = {
  'daily-briefings': { archivePath: (c) => c.archivePath, dir: 'daily-briefings' },
  articles: { archivePath: (c) => c.articlesArchivePath || '/category/articles/', dir: 'articles' },
};

function printHelp() {
  console.log(`
Samalyzer — Sam Weiss Newsletter Daily Briefing Archiver

Collections (default: daily-briefings, from /blog-2/):
  npm run articles -- <flags>             Same flags, for the Articles archive (/category/articles/) → gen/articles/.
  npm start -- --collection <name>        daily-briefings | articles

Usage:
  npm start                               Full run: login, discover, export missing daily briefings.
  npm start -- --dry-run                  Discover + list work queue, no daily briefings.
  npm start -- --force                    Re-export everything, even briefings already on disk.
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

  const collectionName = typeof flags.collection === 'string' ? flags.collection : 'daily-briefings';
  const collection = COLLECTIONS[collectionName];
  if (!collection) {
    throw new Error(`unknown --collection "${collectionName}" (expected: ${Object.keys(COLLECTIONS).join(', ')})`);
  }
  config.archivePath = collection.archivePath(config);

  const genDir = path.resolve(config.genDir || './gen');
  config.outputDir = path.join(genDir, collection.dir);
  config.registryPath = path.join(config.outputDir, 'registry.json');

  if (!fs.existsSync(config.outputDir)) fs.mkdirSync(config.outputDir, { recursive: true });
  const manifest = new Manifest(config.outputDir);
  const registry = new Registry(config.registryPath);

  const dryRun = Boolean(flags['dry-run']);
  const force = Boolean(flags.force);
  const fullRefresh = Boolean(flags['full-refresh']);
  const skipDiscovery = Boolean(flags['skip-discovery']);
  const discoverOnly = Boolean(flags['discover-only']);
  const singleUrl = typeof flags.url === 'string' ? flags.url : null;
  const maxArticles = config.maxArticles ? Number(config.maxArticles) : null;

  log(`collection: ${collectionName} (${config.archivePath} → ${config.outputDir})`);
  log(`config: headless=${config.headless}, genDir=${genDir}`);
  log(`on disk: ${manifest.count()} briefings already exported`);
  if (manifest.incomplete.length) {
    log(
      `on disk: ${manifest.incomplete.length} incomplete briefing folder(s), missing export.pdf, ` +
        `source/index.html or metadata.json (re-exported if listed in the registry): ${manifest.incomplete.join(', ')}`
    );
  }

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

      // Every registry article without a complete folder on disk, newest
      // first — including older ones whose earlier export failed.
      queue = registry.articles().filter((article) => force || !manifest.has(article.url));
      stats.skipped = registry.count() - queue.length;
      log(`${queue.length} queued for export, ${stats.skipped} already exported`);
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
        manifest.record(article.url, {
          publishedDate: article.publishedDate,
          exportPath: path.basename(path.dirname(result.path)),
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

  // New briefings' neighbours were saved with live Previous / Next links;
  // point them (and the new ones) at the local copies.
  if (stats.exported > 0) {
    logStats(collectionName, relinkCollection(config.outputDir));
  }

  if (stats.failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  logError(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
