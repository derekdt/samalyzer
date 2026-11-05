// `npm run qqq-tables` — log in, read Sam's NASDAQ-100 (QQQ) data tables page,
// and write one CSV per table to gen/qqq-tables/. Independent of the other
// commands; saves no HTML.

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const puppeteer = require('puppeteer');

const { log, logError, parseCliArgs } = require('./util');
const { login } = require('./auth');

function loadConfig() {
  const cfgPath = path.resolve(__dirname, '..', 'config.json');
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

function printHelp() {
  console.log(`
Samalyzer — NASDAQ-100 (QQQ) data tables

Usage:
  npm run qqq-tables                       Log in, read the tables page, write gen/qqq-tables/*.csv.
  npm run qqq-tables -- --dry-run          Parse and report, but don't write files.
  npm run qqq-tables -- --headless=false   Run with a visible browser window.
  npm run qqq-tables -- --help             Print this help.
`);
}

// Tables as published, with the H2 heading above each one. Run with
// JavaScript disabled so this reads the original markup, not the DataTables
// widget (which clones headers into separate tables and can re-sort rows).
async function extractTables(page) {
  return page.evaluate(() => {
    const clean = (s) => s.replace(/\s+/g, ' ').trim();
    const headings = [...document.querySelectorAll('h1, h2')];
    return [...document.querySelectorAll('table')].map((table) => {
      let heading = null;
      for (const h of headings) {
        if (h.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) heading = h;
      }
      const rowsOf = (sel) =>
        [...table.querySelectorAll(sel)].map((tr) =>
          [...tr.querySelectorAll('th, td')].map((c) => ({
            text: clean(c.textContent),
            colspan: Number(c.getAttribute('colspan') || 1),
          }))
        );
      const head = rowsOf(':scope > thead > tr');
      const body = rowsOf(':scope > tbody > tr, :scope > tr');
      const foot = rowsOf(':scope > tfoot > tr');
      return {
        id: table.id || null,
        heading: heading ? clean(heading.textContent) : null,
        head,
        rows: [...(head.length ? [] : body.splice(0, 1)), ...body, ...foot],
        header: (head[0] || []).map((c) => c.text),
        headerFromBody: head.length === 0,
      };
    });
  });
}

// "Table 1.0: NASDAQ-100 (QQQ) Correction Table" -> "NASDAQ-100 (QQQ) Correction Table"
function tableName(heading) {
  return heading.replace(/^table\s+[\d.]+\s*:\s*/i, '').trim();
}

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Column header -> snake_case, e.g. "Pct. Loss" -> "pct_loss", "Rally #" -> "rally_number".
function columnName(header) {
  return header
    .replace(/#/g, ' number ')
    .replace(/%/g, ' pct ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "Apl" is a typo on the page ("Apl 26, 2010").
const MONTH_NAME = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|Apl|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const pad = (n) => String(n).padStart(2, '0');
const month = (name) => {
  const key = name.toLowerCase().slice(0, 3);
  return (key === 'apl' ? 4 : MONTHS.indexOf(key) + 1);
};
const year4 = (y) => (y.length === 2 ? (Number(y) < 70 ? 2000 : 1900) + Number(y) : Number(y));

// Cleaned value of one cell: plain number, ISO date (YYYY-MM-DD or YYYY-MM),
// or the text itself. Dashes standing for "no value" become empty.
function cleanValue(text) {
  let s = text.replace(/[–—−]/g, '-').trim();
  if (s === '' || /^-+$/.test(s)) return '';

  // Money / percent / plain numbers: "-$80.20", "05.79%", "+0.22%", "1,234".
  const num = s.match(/^([+-])?\s*\$?\s*([+-])?\s*(\d[\d,]*(?:\.\d+)?)\s*%?$/);
  if (num) {
    const negative = num[1] === '-' || num[2] === '-';
    let digits = num[3].replace(/,/g, '').replace(/^0+(?=\d)/, '');
    if (/^-?0(\.0+)?$/.test(digits)) return digits; // "-$0.00" -> "0.00"
    return `${negative ? '-' : ''}${digits}`;
  }

  // Dates. Strip markers like ">>" and labels like "(DOT-COM)" first.
  const d = s.replace(/>+|<+/g, '').replace(/\([^)]*\)/g, '').trim();
  let m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) return `${year4(m[3])}-${pad(m[1])}-${pad(m[2])}`;
  m = d.match(new RegExp(`^${MONTH_NAME}\\s+(\\d{1,2}),?\\s+(\\d{4})$`, 'i'));
  if (m) return `${m[3]}-${pad(month(m[1]))}-${pad(m[2])}`;
  m = d.match(new RegExp(`^${MONTH_NAME},?\\s+(\\d{4})$`, 'i'));
  if (m) return `${m[2]}-${pad(month(m[1]))}`;

  return text.trim();
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Build CSV rows: row_type, then a cleaned column per table column, then the
// original text of each column with a `_raw` suffix.
function buildCsv(table) {
  const names = table.header.map(columnName);
  const seen = new Map();
  const unique = names.map((n) => {
    const k = seen.get(n) || 0;
    seen.set(n, k + 1);
    return k ? `${n}_${k + 1}` : n;
  });

  const warnings = [];
  const lines = [['row_type', ...unique, ...unique.map((n) => `${n}_raw`)]];
  let dataRows = 0;
  let summaryRows = 0;
  for (const row of table.rows) {
    const cells = row.flatMap((c) => [c.text, ...Array(Math.max(0, c.colspan - 1)).fill('')]);
    if (cells.every((c) => c === '')) continue;
    if (cells.length !== unique.length) {
      warnings.push(`row "${cells[0]}" has ${cells.length} cells, expected ${unique.length}`);
    }
    while (cells.length < unique.length) cells.push('');
    cells.length = unique.length;
    const summary = /^(totals?|averages?|median)\b/i.test(cells[0]);
    if (summary) summaryRows++;
    else dataRows++;
    lines.push([summary ? 'summary' : 'data', ...cells.map(cleanValue), ...cells]);
  }
  const csv = `${lines.map((l) => l.map(csvCell).join(',')).join('\n')}\n`;
  return { csv, dataRows, summaryRows, warnings };
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
  const outDir = path.join(genDir, 'qqq-tables');
  const url = `${config.baseUrl}${config.qqqTablesPath || '/nasdaq-100-qqq-corrections-rallies/'}`;

  const browser = await puppeteer.launch({
    headless: config.headless,
    defaultViewport: { width: 1280, height: 1800 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let tables;
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs || 60000);
    await login(page, config);

    await page.setJavaScriptEnabled(false);
    log(`loading ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const html = await page.content();
    if ((config.paywallMarker && html.includes(config.paywallMarker)) || (await page.$('input[name="pwd"]'))) {
      throw new Error('Tables page is showing a login/paywall prompt; session is not authenticated');
    }
    tables = await extractTables(page);
  } finally {
    await browser.close();
  }

  tables = tables.filter((t) => t.header.length > 0 && t.rows.length > 0);
  if (tables.length === 0) {
    throw new Error('No tables found on the page; the layout may have changed. No files written.');
  }

  const outputs = [];
  const usedNames = new Set();
  for (const t of tables) {
    const name = t.heading ? tableName(t.heading) : t.id || `table-${outputs.length + 1}`;
    let file = `${slug(name)}.csv`;
    for (let n = 2; usedNames.has(file); n++) file = `${slug(name)}-${n}.csv`;
    usedNames.add(file);
    const built = buildCsv(t);
    outputs.push({ name, file, ...built });
  }

  log(`found ${outputs.length} tables:`);
  for (const o of outputs) {
    log(`  ${o.file}  (${o.dataRows} rows${o.summaryRows ? ` + ${o.summaryRows} summary` : ''})`);
    for (const w of o.warnings) log(`    warning: ${w}`);
  }

  if (dryRun) {
    log('--dry-run set; no files written');
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const o of outputs) {
    const target = path.join(outDir, o.file);
    fs.writeFileSync(`${target}.tmp`, o.csv);
    fs.renameSync(`${target}.tmp`, target);
  }
  log(`wrote ${outputs.length} CSV files to ${outDir}`);
}

if (require.main === module) {
  run().catch((err) => {
    logError(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

module.exports = { extractTables, buildCsv, cleanValue, columnName, slug, tableName };
