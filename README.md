# Samalyzer

Sam Weiss newsletter daily briefing archiver.

Logs into your paid https://sam-weiss.com/ subscription, walks the full `/blog-2/` archive, and saves each article — with every comment and reply expanded — as a daily briefing PDF. Tracks exported articles in a local manifest so repeat runs only fetch new briefings.

## Setup

Requires **Node.js 18+**. Not currently installed on this machine — install from https://nodejs.org/ (LTS build is fine) or via `winget install OpenJS.NodeJS.LTS`, then reopen your terminal so `node` and `npm` are on PATH.

```bash
cd D:\Projects\samalyzer
npm install          # installs puppeteer (downloads Chromium ~200MB) + dotenv
cp .env.example .env
```

Edit `.env` and set your WordPress credentials:

```
WP_USERNAME=your-wordpress-username
WP_PASSWORD=your-wordpress-password
```

## Usage

```bash
# Full run — log in, discover all articles, export missing daily briefings.
npm start

# Discover only — print the queue, do not export.
npm start -- --dry-run

# Re-export everything, ignoring the manifest.
npm start -- --force

# Export a single article (useful for testing).
npm start -- --url https://sam-weiss.com/some-article-slug/ --headless=false

# Throttle a first run.
npm start -- --max-pages 3 --max-articles 5
```

Flags are passed after `--` so npm hands them to the script.

Other flags:
- `--headless=false` — run Chromium with a visible window (handy for debugging the first run).
- `--help` — print the full flag list.

## Output

All generated output lives under `./gen/` (gitignored in full, so future sibling outputs land there too).

- Daily Briefings: `./gen/daily-briefings/YYYY-MM-DD_slug/export.pdf` (publish date parsed from the archive card; slug taken from the URL and used as the folder name).
- Companion metadata: `./gen/daily-briefings/YYYY-MM-DD_slug/metadata.json` — per-briefing JSON with `url`, `slug`, `title` (pulled from the article `<h1>`), `publishedDate`, `commentCount` (counted after comment expansion), `exportedAt`, `exportPath` (directory — relative to `metadata.json` — where `export.pdf` lives), and `sourcePath` (directory where the self-contained source lives; `index.html` is always its entry point). Intended for downstream indexing.
- Self-contained source: `./gen/daily-briefings/YYYY-MM-DD_slug/source/index.html` — the article's DOM captured after comment expansion and image un-lazying, with external references rewritten to local copies. The exporter downloads:
  - every `<img>` `src` / `srcset` → `source/images/`
  - every `<link rel="stylesheet">` and any `@import`ed CSS → `source/styles/` (CSS `url(...)` refs rewritten to `../assets/`)
  - fonts and background images referenced from downloaded CSS **and** inline `<style>` blocks / `style=""` attributes → `source/assets/`

  Scripts, favicons, and decorative avatars/emoji (Gravatar, `s.w.org`) are intentionally **not** downloaded. Open `index.html` directly from disk without a network connection.
- Manifest: `./gen/manifest.json` — a compact index of exported URLs. Each entry stores only `publishedDate`, `exportedAt`, and `exportPath` (the briefing folder relative to `gen/`, e.g. `daily-briefings/2026-04-17_slug`). All other details live inside each briefing's own `metadata.json`. Delete an entry to force a re-export on the next run.

The whole `gen/` folder is gitignored.

## Trades

A separate command reads the Samwise portfolio trades page (`/app/trades/`) and writes every trade to `./gen/trades.json`. It doesn't touch the daily briefing export, and it saves no HTML.

```bash
npm run trades                    # log in, read the trades page, create/update gen/trades.json
npm run trades -- --dry-run       # parse and report, don't write
npm run trades -- --headless=false
```

The page lists the full trade history, so each run re-reads all of it and rewrites the file. The log lists trades that are new since the last run and any that have disappeared from the page. Each trade has a stable `id` built from its text, and `firstSeenAt` records the first run that saw it. If Sam edits a trade's wording, it shows up as one removed and one new trade.

`trades.json` has `source`, `scrapedAt`, `count` (total trades) and a `portfolios` array. Each portfolio has a `name`, a `type`, and its `trades`, newest first:

```json
{
  "source": "https://sam-weiss.com/app/trades/",
  "scrapedAt": "…",
  "count": 640,
  "portfolios": [
    { "name": "Hightower", "type": "options", "trades": [ { …trade… }, … ] },
    { "name": "Frey", "type": "common_stock", "trades": [ … ] },
    …
  ]
}
```

`type` comes from `portfolioTypes` in `config.json` (`options` or `common_stock`). It can't be read from the trades: options portfolios also hold shares (NVDL), and stock portfolios also trade covered calls and put hedges. A portfolio not listed there gets `type: null` and a note in the log. Portfolios appear in order of most recent activity. A trade whose portfolio can't be read goes under a portfolio named `Unassigned`. Each trade:

| Field | Meaning |
| --- | --- |
| `portfolio` | `Hightower`, `Stark`, `Lannister`, `Arryn`, `Frey`, `Tyrell`, `Tarly`, `Targaryen`, `Baratheon`, … |
| `action` | `buy_to_open`, `sell_to_close`, `buy_to_close`, `sell_to_open`. Plain "Buy"/"Bought"/"Buy Long" maps to `buy_to_open`; plain "Sell" to `sell_to_close`. |
| `symbol` | Ticker. When only a company name is given, it is mapped (`Nvidia` → `NVDA`, `Google` → `GOOGL`, …). Typos on the page (e.g. `NVLD`) are kept as written. |
| `instrument` | `option`, `spread`, or `stock`. |
| `optionType` | `call` / `put` (null for stock, and for "Leaps" lines that don't say which). |
| `strikes` | `[700]` for a single option, `[1900, 2000]` for a spread, `[]` for stock. |
| `expiration` | `YYYY-MM-DD`, or `YYYY-MM` when no day is given; null when the page only says e.g. "Sep". `expirationRaw` keeps the text as written. |
| `price`, `quantity`, `quantityUnit` | Fill price per contract/share, count, and `contracts` or `shares`. |
| `executedAt` | ISO timestamp with the real New York offset for that date. Sam often writes "EST" in summer, so the offset ignores the label; `timezoneLabel` keeps what he wrote. Null when no time is given. |
| `executedDate` | `YYYY-MM-DD`. `dateSource` is `trade` (from the trade line) or `section` (from a dated heading such as "OPTIONS EXPIRATION TRADES Friday, June 19, 2026"). |
| `allocationPercent`, `allocationType`, `allocationNote` | From the italic line, e.g. `7.5`, `allocation`, `"7.5% Portfolio Allocation"`. Types seen: `allocation`, `reduction`, `value`, `cash received`, `sale`. |
| `notes` | Extra text such as `Option Exercised`, `Contract Expired`, `Expired Hedge`. |
| `section` | Heading the trade was grouped under, if any. |
| `articleUrl` | Article linked from the trade's timestamp. |
| `raw` | The trade line exactly as published. Always present. |
| `parseWarnings` | Fields that couldn't be read from the text (e.g. `symbol` when the line names no ticker, `expiration incomplete` for "Sep $600 Puts"). Empty for cleanly parsed trades. |

Lines inside a trade entry that aren't recognised (e.g. a test notification) are skipped and printed in the log. If the page yields no trades at all, the command fails without touching `trades.json`.

## QQQ data tables

`npm run qqq-tables` reads Sam's NASDAQ-100 (QQQ) data tables page (`/nasdaq-100-qqq-corrections-rallies/`) and writes one CSV per table to `./gen/qqq-tables/`. The file name is the slugged table name, without the table number, e.g. `nasdaq-100-qqq-correction-table.csv`. Each run overwrites the files with the current page. No HTML is saved.

```bash
npm run qqq-tables                 # write gen/qqq-tables/*.csv
npm run qqq-tables -- --dry-run    # list tables and row counts, don't write
```

Each CSV has:

- `row_type`: `data`, or `summary` for the "Total" / "Averages" rows at the bottom of some tables.
- One cleaned column per table column, named in snake_case (`Pct. Loss` → `pct_loss`, `Rally %` → `rally_pct`, `Rally #` → `rally_number`):
  - money and percentages become plain numbers (`-$80.20` → `-80.20`, `05.79%` → `5.79`; percent columns stay in percent units)
  - dates become `YYYY-MM-DD`, or `YYYY-MM` when only a month is given (`Oct 1999 (DOT-COM)` → `1999-10`)
  - dashes meaning "no value" become empty
  - anything else (weekday names, "Total") is kept as text
- The same columns again with a `_raw` suffix, holding each cell exactly as published.

The page is read with JavaScript disabled, so rows come out in Sam's published order rather than whatever sort the interactive table widget applies.

## Configuration

`config.json` (committed) controls everything that isn't a secret:

| Key | Purpose |
| --- | --- |
| `baseUrl`, `archivePath`, `loginPath`, `tradesPath`, `qqqTablesPath` | Site URLs. |
| `portfolioTypes` | Portfolio name → `options` / `common_stock`, used for `type` in `trades.json`. |
| `genDir` | Root directory for all generated output. `daily-briefings/` and `manifest.json` are created underneath it. |
| `delayBetweenArticlesMs`, `delayBetweenPagesMs` | `[min, max]` random delays in ms. Be polite. |
| `pdfFormat` | `"Letter"`, `"A4"`, etc. — any Puppeteer format string. |
| `headless` | `true` for background runs, `false` for visible browser. |
| `maxPages`, `maxArticles` | `null` = unlimited. Useful for testing. |
| `navigationTimeoutMs` | Per-navigation timeout. Bump if the site is slow. |
| `articleBodySelectors` | Selectors tried to detect the rendered article body. |
| `commentExpanderSelectors` | CSS selectors for comment "load more" / "view replies" controls. |
| `commentExpanderTextPatterns` | Regex patterns (as strings) for buttons matched by text (case-insensitive). |
| `paywallMarker` | Text the crawler looks for to detect an expired/broken session. |

If you see comments missing in the daily briefing or the crawler can't detect the article body, the fix is almost always a tweak to `commentExpanderSelectors` / `articleBodySelectors` — no code change required. Run with `--url <article> --headless=false` to watch what's happening live.

## First-run checklist

1. `npm install`
2. `cp .env.example .env` and fill in credentials
3. `npm start -- --url <some article URL> --headless=false` — confirm one daily briefing comes out complete.
4. `npm start -- --dry-run` — confirm discovery walks all archive pages.
5. `npm start` — full archive export (first run will take a while — ~49 pages of articles at polite delays).
6. Re-run `npm start` immediately — should report `0 queued`.

## Scheduling daily runs

Use Windows Task Scheduler:

- Program: `node`
- Arguments: `src\index.js`
- Start in: `D:\Projects\samalyzer`
- Trigger: daily, after market close.

Or invoke `npm start` inside the same working directory.

## Troubleshooting

- **"Missing WP_USERNAME or WP_PASSWORD"** — `.env` is missing or not in the project root.
- **"Login failed: ..."** — credentials are wrong, or the site shows a CAPTCHA that wasn't there before. Re-run with `--headless=false` to see what's on screen.
- **"Paywall detected on article page"** — the session got invalidated mid-run. Re-run; if it keeps happening, reduce `delayBetweenArticlesMs` aggressiveness isn't the issue — the site may have logged you out due to concurrent browser logins.
- **Missing comments in daily briefings** — add selectors/text patterns to `config.json`. Open an article logged in, inspect the "Load more replies" control, and add its class or a matching text regex.
