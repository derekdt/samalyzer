// `npm run relink` — point each saved briefing's Previous / Next buttons at the
// local copy of that neighbouring briefing instead of the live site.
//
// Briefings are matched by the `url` in each folder's metadata.json. Links to
// a briefing that isn't on disk stay pointing at the site. Safe to re-run: links
// that are already local are left alone. Also runs automatically at the end of
// `npm start` / `npm run articles` when new briefings were exported.

const fs = require('fs');
const path = require('path');

const { log, logError, parseCliArgs } = require('./util');

const COLLECTION_DIRS = ['daily-briefings', 'articles'];

function pageKey(url) {
  try {
    const u = new URL(url.replace(/&amp;/g, '&'));
    return `${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return null;
  }
}

// url -> folder name, for every briefing folder with a metadata.json.
function briefingIndex(collectionDir) {
  const index = new Map();
  for (const entry of fs.readdirSync(collectionDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadataPath = path.join(collectionDir, entry.name, 'metadata.json');
    const htmlPath = path.join(collectionDir, entry.name, 'source', 'index.html');
    if (!fs.existsSync(metadataPath) || !fs.existsSync(htmlPath)) continue;
    try {
      const { url } = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      const key = url && pageKey(url);
      if (key) index.set(key, entry.name);
    } catch {}
  }
  return index;
}

// Rewrite the href of <a rel="prev"> / <a rel="next"> links whose target is a
// local briefing. From <folder>/source/index.html, a sibling briefing is
// ../../<other>/source/index.html.
function relinkHtml(html, index, stats) {
  return html.replace(/<a\b[^>]*>/g, (tag) => {
    const rel = tag.match(/\srel="([^"]*)"/);
    if (!rel || !/\b(prev|next)\b/.test(rel[1])) return tag;
    const href = tag.match(/\shref="([^"]*)"/);
    if (!href) return tag;
    if (!/^https?:/i.test(href[1])) {
      stats.alreadyLocal++;
      return tag;
    }
    const folder = index.get(pageKey(href[1]));
    if (!folder) {
      stats.noLocalCopy++;
      if (stats.missing.length < 10) stats.missing.push(href[1]);
      return tag;
    }
    stats.relinked++;
    const fragment = href[1].includes('#') ? href[1].slice(href[1].indexOf('#')) : '';
    return tag.replace(/\shref="[^"]*"/, () => ` href="${folder}/source/index.html${fragment}"`);
  });
}

// Relink one collection folder (e.g. gen/daily-briefings). A neighbour is
// looked up in the same collection first, then in the other collections next
// to it (an Article's neighbours are usually daily briefings). Returns stats.
function relinkCollection(collectionDir, { dryRun = false } = {}) {
  const stats = { files: 0, changed: 0, relinked: 0, alreadyLocal: 0, noLocalCopy: 0, missing: [] };
  if (!fs.existsSync(collectionDir)) return stats;
  const own = briefingIndex(collectionDir);

  // Target paths relative to <folder>/source/index.html.
  const targets = new Map();
  const genDir = path.dirname(collectionDir);
  for (const name of COLLECTION_DIRS) {
    const dir = path.join(genDir, name);
    if (path.resolve(dir) === path.resolve(collectionDir) || !fs.existsSync(dir)) continue;
    for (const [key, folder] of briefingIndex(dir)) targets.set(key, `../../../${name}/${folder}`);
  }
  for (const [key, folder] of own) targets.set(key, `../../${folder}`);

  for (const folder of new Set(own.values())) {
    const htmlPath = path.join(collectionDir, folder, 'source', 'index.html');
    stats.files++;
    const html = fs.readFileSync(htmlPath, 'utf8');
    const out = relinkHtml(html, targets, stats);
    if (out === html) continue;
    stats.changed++;
    if (!dryRun) {
      fs.writeFileSync(`${htmlPath}.tmp`, out, 'utf8');
      fs.renameSync(`${htmlPath}.tmp`, htmlPath);
    }
  }
  return stats;
}

function logStats(name, stats, dryRun) {
  log(
    `${name}: ${stats.relinked} prev/next link(s) ${dryRun ? 'would be ' : ''}relinked in ${stats.changed} of ${stats.files} briefing(s); ` +
      `${stats.alreadyLocal} already local, ${stats.noLocalCopy} with no local copy (left pointing at the site)`
  );
  for (const u of stats.missing) log(`  no local copy: ${u}`);
}

function run() {
  const { flags } = parseCliArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log(`
Samalyzer — relink Previous / Next buttons to local briefings

Usage:
  npm run relink               Relink gen/daily-briefings and gen/articles.
  npm run relink -- --dry-run  Report what would change, write nothing.
`);
    return;
  }
  const dryRun = Boolean(flags['dry-run']);
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
  const genDir = path.resolve(config.genDir || './gen');
  for (const name of COLLECTION_DIRS) {
    const dir = path.join(genDir, name);
    if (!fs.existsSync(dir)) continue;
    logStats(name, relinkCollection(dir, { dryRun }), dryRun);
  }
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    logError(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
}

module.exports = { relinkCollection, logStats };
