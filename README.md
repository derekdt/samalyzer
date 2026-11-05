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

## Configuration

`config.json` (committed) controls everything that isn't a secret:

| Key | Purpose |
| --- | --- |
| `baseUrl`, `archivePath`, `loginPath` | Site URLs. |
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
