const path = require('path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(range) {
  if (!Array.isArray(range) || range.length !== 2) return 0;
  const [min, max] = range;
  return Math.floor(min + Math.random() * (max - min));
}

async function politeDelay(range, label) {
  const ms = randomDelay(range);
  if (ms > 0) {
    log(`waiting ${ms}ms${label ? ` before ${label}` : ''}`);
    await sleep(ms);
  }
}

function slugFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'article';
  } catch {
    return 'article';
  }
}

function parsePublishedDate(text) {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function briefingPaths(outputDir, publishedDate, url, maxSlugLength) {
  let slug = slugFromUrl(url);
  if (Number.isFinite(maxSlugLength) && maxSlugLength > 0 && slug.length > maxSlugLength) {
    slug = slug.slice(0, maxSlugLength).replace(/-+$/, '');
  }
  const datePart = publishedDate || 'unknown-date';
  const name = `${datePart}_${slug}`;
  const dir = path.join(outputDir, name);
  const sourceDir = path.join(dir, 'source');
  const imagesDir = path.join(sourceDir, 'images');
  const stylesDir = path.join(sourceDir, 'styles');
  const assetsDir = path.join(sourceDir, 'assets');
  return {
    dir,
    slug: name,
    pdf: path.join(dir, 'export.pdf'),
    metadataJson: path.join(dir, 'metadata.json'),
    sourceDir,
    html: path.join(sourceDir, 'index.html'),
    imagesDir,
    stylesDir,
    assetsDir,
  };
}

function briefingFilename(outputDir, publishedDate, url, maxSlugLength) {
  return briefingPaths(outputDir, publishedDate, url, maxSlugLength).pdf;
}

function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  console.log(`[${ts}]`, ...args);
}

function logError(...args) {
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  console.error(`[${ts}] ERROR`, ...args);
}

function parseCliArgs(argv) {
  const args = { flags: {}, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args.positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      args.flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.flags[key] = next;
        i++;
      } else {
        args.flags[key] = true;
      }
    }
  }
  return args;
}

module.exports = {
  sleep,
  randomDelay,
  politeDelay,
  slugFromUrl,
  parsePublishedDate,
  briefingFilename,
  briefingPaths,
  log,
  logError,
  parseCliArgs,
};
