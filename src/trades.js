// `npm run trades` — log in, read the /app/trades/ page, and create or update
// gen/trades.json. Independent of the daily briefing export (`npm start`).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const puppeteer = require('puppeteer');

const { log, logError, parseCliArgs } = require('./util');
const { login } = require('./auth');
const { parseBlocks } = require('./tradeParser');

function loadConfig() {
  const cfgPath = path.resolve(__dirname, '..', 'config.json');
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

function printHelp() {
  console.log(`
Samalyzer — Samwise portfolio trades

Usage:
  npm run trades                        Log in, read the trades page, write gen/trades.json.
  npm run trades -- --dry-run           Parse and report, but don't write the file.
  npm run trades -- --headless=false    Run with a visible browser window.
  npm run trades -- --help              Print this help.
`);
}

// Text blocks of the trades page, in page order. Each <br> becomes a line.
async function extractBlocks(page) {
  return page.evaluate(() => {
    const clean = (s) => s.replace(/\s+/g, ' ').trim();
    const root = document.querySelector('.entry-content') || document.body;
    const selector = 'h1,h2,h3,h4,h5,h6,p,li';
    return [...root.querySelectorAll(selector)]
      .filter((el) => !el.querySelector(selector))
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        lines: el.innerText.split('\n').map(clean).filter(Boolean),
        strong: [...el.querySelectorAll('strong, b')].map((s) => clean(s.innerText)).filter(Boolean),
        em: [...el.querySelectorAll('em, i')].map((s) => clean(s.innerText)).filter(Boolean),
        links: [...el.querySelectorAll('a[href]')].map((a) => a.href),
      }))
      .filter((b) => b.lines.length > 0);
  });
}

// Stable id from the trade's own text, so re-runs match the same trade even if
// new trades are added above it. Identical lines get an occurrence suffix.
function assignIds(trades) {
  const seen = new Map();
  for (const t of trades) {
    const key = [t.portfolio || '', t.raw, t.allocationNote || '', t.articleUrl || ''].join('|');
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    const hash = crypto.createHash('sha1').update(`${key}|${n}`).digest('hex').slice(0, 12);
    t.id = hash;
  }
}

function readExisting(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`${filePath} exists but is not valid JSON (${err.message}); fix or delete it and re-run`);
  }
}

const META_KEYS = new Set(['source', 'scrapedAt', 'count']);
const UNASSIGNED = 'Unassigned';

// All trades in an existing trades.json. Reads the current `portfolios` layout
// and the two earlier ones (flat `trades` array, one root key per portfolio).
function existingTrades(existing) {
  if (!existing) return [];
  if (Array.isArray(existing.portfolios)) return existing.portfolios.flatMap((p) => p.trades || []);
  if (Array.isArray(existing.trades)) return existing.trades;
  return Object.entries(existing)
    .filter(([k, v]) => !META_KEYS.has(k) && Array.isArray(v))
    .flatMap(([, v]) => v);
}

// portfolioTypes: { "<Name>": "options" | "common_stock" } from config.json.
function buildOutput(trades, existing, sourceUrl, portfolioTypes = {}) {
  const now = new Date().toISOString();
  const previous = new Map(existingTrades(existing).map((t) => [t.id, t]));

  const ordered = trades.map((t) => {
    const prior = previous.get(t.id);
    const { id, ...rest } = t;
    return { id, ...rest, firstSeenAt: prior ? prior.firstSeenAt : now };
  });

  const currentIds = new Set(ordered.map((t) => t.id));
  const added = ordered.filter((t) => !previous.has(t.id));
  const removed = [...previous.values()].filter((t) => !currentIds.has(t.id));

  // One entry per portfolio, in order of most recent activity; trades keep
  // page order (newest first).
  const byName = new Map();
  for (const t of ordered) {
    const name = t.portfolio || UNASSIGNED;
    if (!byName.has(name)) byName.set(name, { name, type: portfolioTypes[name] || null, trades: [] });
    byName.get(name).trades.push(t);
  }
  const portfolios = [...byName.values()];
  const untyped = portfolios.filter((p) => !p.type).map((p) => p.name);

  return {
    output: { source: sourceUrl, scrapedAt: now, count: ordered.length, portfolios },
    added,
    removed,
    untyped,
  };
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
  const genDir = path.resolve(config.genDir || './gen');
  const outPath = path.join(genDir, 'trades.json');
  const tradesUrl = `${config.baseUrl}${config.tradesPath || '/app/trades/'}`;

  const existing = readExisting(outPath);
  log(`trades file: ${outPath} (${existing ? `${existing.count} trades` : 'not yet created'})`);

  const browser = await puppeteer.launch({
    headless: config.headless,
    defaultViewport: { width: 1280, height: 1800 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let blocks;
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs || 60000);
    await login(page, config);

    log(`loading ${tradesUrl}`);
    await page.goto(tradesUrl, { waitUntil: 'networkidle2' });
    const html = await page.content();
    if ((config.paywallMarker && html.includes(config.paywallMarker)) || (await page.$('input[name="pwd"]'))) {
      throw new Error('Trades page is showing a login/paywall prompt; session is not authenticated');
    }
    blocks = await extractBlocks(page);
  } finally {
    await browser.close();
  }

  const { trades, unrecognized } = parseBlocks(blocks);
  if (trades.length === 0) {
    throw new Error('No trades found on the page; the layout may have changed. Not touching trades.json.');
  }
  assignIds(trades);

  const { output, added, removed, untyped } = buildOutput(trades, existing, tradesUrl, config.portfolioTypes);
  const withWarnings = trades.filter((t) => t.parseWarnings.length > 0);

  log(`parsed ${trades.length} trades (${added.length} new, ${removed.length} no longer on page)`);
  if (existing) {
    for (const t of added.slice(0, 20)) log(`  + ${t.portfolio}: ${t.raw}`);
    if (added.length > 20) log(`  … and ${added.length - 20} more new`);
  }
  for (const t of removed) log(`  - ${t.portfolio}: ${t.raw}`);
  if (untyped.length) {
    log(`no type for portfolio(s) ${untyped.join(', ')}; add them to portfolioTypes in config.json`);
  }
  if (withWarnings.length) {
    log(`${withWarnings.length} trade(s) have fields that could not be parsed (see parseWarnings; raw text is kept)`);
  }
  if (unrecognized.length) {
    log(`${unrecognized.length} line(s) inside trade entries were not recognised and were skipped:`);
    for (const line of unrecognized) log(`  ? ${line}`);
  }

  if (dryRun) {
    log('--dry-run set; trades.json not written');
    return;
  }

  if (!fs.existsSync(genDir)) fs.mkdirSync(genDir, { recursive: true });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(output, null, 2)}\n`);
  fs.renameSync(tmp, outPath);
  log(`wrote ${outPath}`);
}

if (require.main === module) {
  run().catch((err) => {
    logError(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

module.exports = { extractBlocks, assignIds, buildOutput };
