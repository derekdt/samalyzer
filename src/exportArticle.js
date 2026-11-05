const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { log, logError, sleep, briefingPaths } = require('./util');

const IMAGE_DOWNLOAD_CONCURRENCY = 4;

const SKIPPED_IMAGE_HOSTS = [
  /(^|\.)gravatar\.com$/i,
  /^s\.w\.org$/i,
];

const RESOURCE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/g;
const CSS_IMPORT_RE =
  /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)|"([^"]+)"|'([^']+)')\s*([^;]*);/g;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const STYLE_ATTR_RE = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

const PRINT_STYLE_CSS = `
  @media print {
    .wpd-comment, .comment, li.comment { break-inside: avoid; page-break-inside: avoid; }
    body { background: #fff !important; color: #000 !important; }
    a { text-decoration: none !important; color: #000 !important; }
    img { max-width: 100% !important; height: auto !important; }
  }
`;

function buildPrintCss(printHideRules) {
  const groups = Array.isArray(printHideRules) ? printHideRules : [];
  const hideBlocks = groups
    .filter((g) => g && Array.isArray(g.selectors) && g.selectors.length > 0)
    .map((g) => {
      const name = g.name ? String(g.name).replace(/\*\//g, '*\\/') : 'unnamed group';
      const selectors = g.selectors.join(',\n      ');
      return `    /* HIDE: ${name} */\n    ${selectors} { display: none !important; }`;
    })
    .join('\n\n');

  return `@media print {\n${hideBlocks}\n  }\n${PRINT_STYLE_CSS}`;
}

async function exportArticle(page, articleMeta, config) {
  const {
    outputDir,
    pdfFormat,
    navigationTimeoutMs,
    articleBodySelectors,
    commentExpanderSelectors,
    commentExpanderTextPatterns,
    paywallMarker,
    printHideRules,
    maxSlugLength,
  } = config;

  const { url, publishedDate } = articleMeta;
  const paths = briefingPaths(outputDir, publishedDate, url, maxSlugLength);

  fs.mkdirSync(paths.dir, { recursive: true });

  log(`exporting: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: navigationTimeoutMs });

  const html = await page.content();
  if (paywallMarker && html.includes(paywallMarker)) {
    throw new Error('Paywall detected on article page — session may have expired');
  }

  await waitForArticleBody(page, articleBodySelectors);

  const expanded = await expandAllComments(page, {
    selectors: commentExpanderSelectors || [],
    textPatterns: commentExpanderTextPatterns || [],
  });
  log(`comment expansion: ${expanded.clicks} clicks across ${expanded.passes} pass(es)`);

  const imgStats = await ensureAllImagesLoaded(page);
  log(
    `images: ${imgStats.loaded}/${imgStats.total} loaded (${imgStats.failed} failed, ${imgStats.unlazied} un-lazied)`
  );

  const unwrapped = await unwrapImageLinks(page);
  log(`unwrapped ${unwrapped} image link(s)`);

  await page.addStyleTag({ content: buildPrintCss(printHideRules) });
  await page.emulateMediaType('print');

  const metadata = await page.evaluate(() => {
    const titleEl =
      document.querySelector('h1.entry-title') ||
      document.querySelector('h1.post-title') ||
      document.querySelector('article h1') ||
      document.querySelector('h1');
    const titleFromPage = titleEl
      ? (titleEl.innerText || titleEl.textContent || '').replace(/\s+/g, ' ').trim()
      : '';
    return {
      title: titleFromPage || null,
      commentCount: document.querySelectorAll('.wpd-comment').length,
    };
  });

  await page.pdf({
    path: paths.pdf,
    format: pdfFormat || 'Letter',
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
  });

  log(`wrote ${paths.pdf}`);

  const title = metadata.title || articleMeta.title || null;
  const commentCount = Number.isFinite(metadata.commentCount) ? metadata.commentCount : null;
  const result = { path: paths.pdf, exportPath: paths.slug, title, commentCount };

  try {
    await saveSourceHtml(page, url, paths);
    result.htmlPath = paths.html;
  } catch (err) {
    logError(`failed to write source HTML for ${url}: ${err.message}`);
  }

  try {
    const briefing = {
      url,
      slug: paths.slug,
      title,
      publishedDate: publishedDate || null,
      commentCount,
      exportedAt: new Date().toISOString(),
      exportPath: '.',
      sourcePath: 'source',
    };
    fs.writeFileSync(paths.metadataJson, JSON.stringify(briefing, null, 2), 'utf8');
    log(`wrote ${paths.metadataJson}`);
    result.metadataPath = paths.metadataJson;
  } catch (err) {
    logError(`failed to write metadata JSON for ${url}: ${err.message}`);
  }

  return result;
}

// Save the page's current DOM as a self-contained index.html: images,
// stylesheets (and their @imports), and CSS-referenced fonts/backgrounds are
// downloaded next to it and references rewritten to the local copies.
// paths: { sourceDir, html, imagesDir, stylesDir, assetsDir }
async function saveSourceHtml(page, url, paths) {
  fs.mkdirSync(paths.sourceDir, { recursive: true });
  const renderedHtml = await page.content();

  const cookieHeader = await buildCookieHeader(page);
  let baseHost = '';
  try {
    baseHost = new URL(url).host;
  } catch {}
  const fetchResource = makeFetcher(cookieHeader, baseHost);
  const assetCache = new Map();

  const imageMapping = await downloadImages(page, url, paths.imagesDir);
  const stylesheetMapping = await downloadStylesheets(
    page,
    url,
    paths.stylesDir,
    paths.assetsDir,
    fetchResource,
    assetCache
  );

  let localized = renderedHtml;
  localized = rewriteImageReferences(localized, imageMapping);
  localized = rewriteStylesheetReferences(localized, stylesheetMapping);
  localized = await localizeInlineCss(localized, url, paths.assetsDir, fetchResource, assetCache);
  const leftovers = dropRemoteImageCandidates(localized, baseHost);
  localized = leftovers.html;

  fs.writeFileSync(paths.html, localized, 'utf8');
  log(
    `wrote ${paths.html} ` +
      `(${imageMapping.size} image(s), ${stylesheetMapping.size} stylesheet(s), ` +
      `${assetCache.size} css-asset(s) localized)`
  );
  if (leftovers.dropped) {
    log(`  dropped ${leftovers.dropped} remote srcset/<source> candidate(s) with no local copy`);
  }
  if (leftovers.remoteSrc.length) {
    logError(
      `${leftovers.remoteSrc.length} image(s) still point at the live site (download failed): ` +
        leftovers.remoteSrc.slice(0, 5).map((u) => u.split('/').pop()).join(', ')
    );
  }
}

// After rewriting, any srcset candidate or <picture><source> still pointing at
// the site has no local copy. Browsers prefer those over a local <img src>, so
// the image would break offline: drop them (and a <source> left empty) so the
// local copy is used. <img src> values that are still remote are kept, since
// there's nothing local to fall back to, and reported.
function dropRemoteImageCandidates(html, baseHost) {
  const isRemote = (u) => {
    try {
      return new URL(u.replace(/&amp;/g, '&')).host === baseHost;
    } catch {
      return false;
    }
  };
  let dropped = 0;
  const filterSrcset = (value) => {
    const parts = value.split(/,(?=\s*\S)/).map((p) => p.trim()).filter(Boolean);
    const kept = parts.filter((p) => !isRemote(p.replace(/\s+\d+(?:\.\d+)?[wx]$/, '')));
    dropped += parts.length - kept.length;
    return kept;
  };

  let out = html.replace(/<source\b[^>]*\ssrcset="([^"]*)"[^>]*>/g, (tag, value) => {
    const kept = filterSrcset(value);
    if (kept.length === 0) return '';
    return tag.replace(/\ssrcset="[^"]*"/, () => ` srcset="${kept.join(', ')}"`);
  });

  const remoteSrc = [];
  out = out.replace(/<img\b[^>]*>/g, (tag) => {
    const src = tag.match(/\ssrc="([^"]*)"/);
    if (src && isRemote(src[1]) && !/gravatar|s\.w\.org/.test(src[1])) remoteSrc.push(src[1]);
    return tag.replace(/\ssrcset="([^"]*)"/, (m, value) => {
      const kept = filterSrcset(value);
      return kept.length ? ` srcset="${kept.join(', ')}"` : '';
    });
  });

  return { html: out, dropped, remoteSrc };
}

async function downloadImages(page, baseUrl, imagesDir) {
  const urls = await page.evaluate(() => {
    const out = new Set();
    // Resolve against the page so relative and unencoded URLs (e.g. file names
    // with spaces or U+202F) come out in the same form as img.src.
    const addSrcset = (srcset) => {
      if (!srcset) return;
      for (const part of srcset.split(/,(?=\s*\S)/)) {
        const u = part.trim().replace(/\s+\d+(?:\.\d+)?[wx]$/, '');
        if (!u) continue;
        try {
          out.add(new URL(u, document.baseURI).href);
        } catch {}
      }
    };
    const imgs = Array.from(document.querySelectorAll('img'));
    for (const img of imgs) {
      if (img.currentSrc) out.add(img.currentSrc);
      if (img.src) out.add(img.src);
      addSrcset(img.getAttribute('srcset'));
    }
    // <picture><source srcset> — the browser prefers these over the <img>.
    for (const source of document.querySelectorAll('picture source[srcset]')) {
      addSrcset(source.getAttribute('srcset'));
    }
    return Array.from(out);
  });

  const filtered = urls.filter((u) => !isSkippedImageHost(u));
  const skippedCount = urls.length - filtered.length;
  if (skippedCount > 0) {
    log(`skipping ${skippedCount} avatar/emoji image(s) from known hosts`);
  }
  if (filtered.length === 0) return new Map();

  fs.mkdirSync(imagesDir, { recursive: true });

  let baseHost = '';
  try {
    baseHost = new URL(baseUrl).host;
  } catch {}

  let cookieHeader = '';
  try {
    const cookies = await page.cookies();
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {}

  const mapping = new Map();
  const queue = filtered.slice();

  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      if (!url) break;
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(parsed.protocol)) continue;

      const filename = makeImageFilename(url);
      const filepath = path.join(imagesDir, filename);
      try {
        if (!fs.existsSync(filepath)) {
          const headers = { Accept: 'image/*,*/*;q=0.8' };
          if (parsed.host === baseHost && cookieHeader) {
            headers.Cookie = cookieHeader;
          }
          const resp = await fetchWithRetry(url, { headers });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());
          fs.writeFileSync(filepath, buf);
        }
        mapping.set(url, path.posix.join('images', filename));
      } catch (err) {
        logError(`image download failed: ${url} — ${err.message}`);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < IMAGE_DOWNLOAD_CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  return mapping;
}

function isSkippedImageHost(url) {
  try {
    const host = new URL(url).host;
    return SKIPPED_IMAGE_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

function makeImageFilename(url) {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
  let base = 'image';
  let ext = '';
  try {
    const u = new URL(url);
    const lastSeg = u.pathname.split('/').filter(Boolean).pop() || '';
    if (lastSeg) {
      const cleaned = lastSeg.split('?')[0].replace(/[^a-zA-Z0-9._-]/g, '_');
      const dot = cleaned.lastIndexOf('.');
      if (dot > 0 && dot < cleaned.length - 1) {
        base = cleaned.slice(0, dot).slice(0, 60) || 'image';
        ext = cleaned.slice(dot);
      } else {
        base = cleaned.slice(0, 60) || 'image';
      }
    }
  } catch {}
  return `${hash}-${base}${ext}`;
}

// The ways a URL can appear in serialized HTML: as resolved (percent-encoded),
// with & escaped, and decoded. The decoded form matters for file names with
// non-ASCII characters, e.g. macOS screenshots ("…10.37.48 PM.png"),
// where the attribute holds the raw character but img.src is "%E2%80%AF".
function urlSpellings(url) {
  const forms = new Set([url]);
  try {
    forms.add(decodeURI(url));
  } catch {}
  for (const f of [...forms]) forms.add(f.replace(/&/g, '&amp;'));
  return [...forms];
}

function replaceUrls(html, mapping) {
  if (!mapping || mapping.size === 0) return html;
  const pairs = [];
  for (const [url, localPath] of mapping.entries()) {
    for (const form of urlSpellings(url)) pairs.push([form, localPath]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  let out = html;
  for (const [form, localPath] of pairs) out = out.split(form).join(localPath);
  return out;
}

function rewriteImageReferences(html, mapping) {
  return replaceUrls(html, mapping);
}

async function buildCookieHeader(page) {
  try {
    const cookies = await page.cookies();
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

// fetch() with retries for transient failures (network errors, 429, 5xx).
// A 404 or other 4xx is returned as-is: the file really isn't there.
async function fetchWithRetry(url, options, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const resp = await fetch(url, options);
      if (resp.status !== 429 && resp.status < 500) return resp;
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts) await sleep(1000 * i);
  }
  throw lastErr;
}

function makeFetcher(cookieHeader, baseHost) {
  return async function fetchResource(url) {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error(`unsupported protocol: ${parsed.protocol}`);
    }
    const headers = {
      Accept: '*/*',
      'User-Agent': RESOURCE_USER_AGENT,
    };
    if (parsed.host === baseHost && cookieHeader) {
      headers.Cookie = cookieHeader;
    }
    const resp = await fetchWithRetry(url, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp;
  };
}

function makeHashedFilename(url, fallbackBase, forcedExt) {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
  let base = fallbackBase || 'asset';
  let ext = forcedExt || '';
  try {
    const u = new URL(url);
    const lastSeg = u.pathname.split('/').filter(Boolean).pop() || '';
    if (lastSeg) {
      const cleaned = lastSeg.split('?')[0].replace(/[^a-zA-Z0-9._-]/g, '_');
      const dot = cleaned.lastIndexOf('.');
      if (dot > 0 && dot < cleaned.length - 1) {
        base = cleaned.slice(0, dot).slice(0, 60) || fallbackBase || 'asset';
        if (!forcedExt) ext = cleaned.slice(dot);
      } else if (cleaned) {
        base = cleaned.slice(0, 60);
      }
    }
  } catch {}
  return `${hash}-${base}${ext}`;
}

async function downloadStylesheets(page, baseUrl, stylesDir, assetsDir, fetchResource, assetCache) {
  const stylesheetUrls = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]'));
    const seen = new Set();
    const out = [];
    for (const l of links) {
      const href = l.href;
      if (!href || seen.has(href)) continue;
      seen.add(href);
      out.push(href);
    }
    return out;
  });

  if (stylesheetUrls.length === 0) return new Map();

  fs.mkdirSync(stylesDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  const cssCache = new Map();
  const mapping = new Map();

  async function fetchAssetForCss(assetUrl) {
    if (assetCache.has(assetUrl)) return assetCache.get(assetUrl);
    try {
      const resp = await fetchResource(assetUrl);
      const buf = Buffer.from(await resp.arrayBuffer());
      const filename = makeHashedFilename(assetUrl, 'asset');
      fs.writeFileSync(path.join(assetsDir, filename), buf);
      assetCache.set(assetUrl, filename);
      return filename;
    } catch (err) {
      logError(`css asset download failed: ${assetUrl} — ${err.message}`);
      assetCache.set(assetUrl, null);
      return null;
    }
  }

  async function processCss(cssUrl) {
    if (cssCache.has(cssUrl)) return cssCache.get(cssUrl);
    cssCache.set(cssUrl, null);
    try {
      const resp = await fetchResource(cssUrl);
      const cssText = await resp.text();
      const rewritten = await rewriteCssText(cssText, cssUrl);
      const filename = makeHashedFilename(cssUrl, 'style', '.css');
      fs.writeFileSync(path.join(stylesDir, filename), rewritten, 'utf8');
      cssCache.set(cssUrl, filename);
      return filename;
    } catch (err) {
      logError(`stylesheet download failed: ${cssUrl} — ${err.message}`);
      return null;
    }
  }

  async function rewriteCssText(cssText, cssBaseUrl) {
    let out = cssText;

    const importRefs = new Set();
    let m;
    CSS_IMPORT_RE.lastIndex = 0;
    while ((m = CSS_IMPORT_RE.exec(out)) !== null) {
      const ref = m[1] || m[2] || m[3] || m[4] || m[5];
      if (ref) importRefs.add(ref);
    }
    const importLocal = new Map();
    for (const ref of importRefs) {
      let resolved;
      try {
        resolved = new URL(ref, cssBaseUrl).toString();
      } catch {
        continue;
      }
      const childFilename = await processCss(resolved);
      if (childFilename) importLocal.set(ref, childFilename);
    }
    if (importLocal.size > 0) {
      CSS_IMPORT_RE.lastIndex = 0;
      out = out.replace(CSS_IMPORT_RE, (full, dq1, sq1, bare1, dq2, sq2, mediaTail) => {
        const ref = dq1 || sq1 || bare1 || dq2 || sq2;
        const local = ref ? importLocal.get(ref) : null;
        if (!local) return full;
        const trailing = mediaTail ? ' ' + mediaTail.trim() : '';
        return `@import "${local}"${trailing};`;
      });
    }

    const urlRefs = new Set();
    CSS_URL_RE.lastIndex = 0;
    while ((m = CSS_URL_RE.exec(out)) !== null) {
      const ref = m[1] || m[2] || m[3];
      if (!ref) continue;
      if (ref.startsWith('data:') || ref.startsWith('#')) continue;
      urlRefs.add(ref);
    }
    const urlLocal = new Map();
    for (const ref of urlRefs) {
      let resolved;
      try {
        resolved = new URL(ref, cssBaseUrl).toString();
      } catch {
        continue;
      }
      const filename = await fetchAssetForCss(resolved);
      if (filename) urlLocal.set(ref, `../assets/${filename}`);
    }
    if (urlLocal.size > 0) {
      CSS_URL_RE.lastIndex = 0;
      out = out.replace(CSS_URL_RE, (full, dq, sq, bare) => {
        const ref = dq || sq || bare;
        const local = ref ? urlLocal.get(ref) : null;
        if (!local) return full;
        return `url("${local}")`;
      });
    }

    return out;
  }

  for (const url of stylesheetUrls) {
    const filename = await processCss(url);
    if (filename) mapping.set(url, path.posix.join('styles', filename));
  }

  return mapping;
}

async function localizeInlineCss(html, baseUrl, assetsDir, fetchResource, assetCache) {
  const refs = new Set();

  function collect(cssText) {
    if (!cssText) return;
    CSS_URL_RE.lastIndex = 0;
    let m;
    while ((m = CSS_URL_RE.exec(cssText)) !== null) {
      const ref = m[1] || m[2] || m[3];
      if (!ref) continue;
      if (ref.startsWith('data:') || ref.startsWith('#')) continue;
      refs.add(ref);
    }
  }

  STYLE_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = STYLE_BLOCK_RE.exec(html)) !== null) {
    collect(m[1]);
  }
  STYLE_ATTR_RE.lastIndex = 0;
  while ((m = STYLE_ATTR_RE.exec(html)) !== null) {
    collect(m[1] || m[2]);
  }

  if (refs.size === 0) return html;

  fs.mkdirSync(assetsDir, { recursive: true });

  const refToLocal = new Map();
  for (const ref of refs) {
    if (assetCache.has(ref)) {
      const cached = assetCache.get(ref);
      if (cached) refToLocal.set(ref, `assets/${cached}`);
      continue;
    }
    let resolved;
    try {
      resolved = new URL(ref, baseUrl).toString();
    } catch {
      continue;
    }
    if (assetCache.has(resolved)) {
      const cached = assetCache.get(resolved);
      if (cached) refToLocal.set(ref, `assets/${cached}`);
      continue;
    }
    try {
      const resp = await fetchResource(resolved);
      const buf = Buffer.from(await resp.arrayBuffer());
      const filename = makeHashedFilename(resolved, 'asset');
      fs.writeFileSync(path.join(assetsDir, filename), buf);
      assetCache.set(resolved, filename);
      refToLocal.set(ref, `assets/${filename}`);
    } catch (err) {
      logError(`inline-css asset download failed: ${ref} — ${err.message}`);
      assetCache.set(resolved, null);
    }
  }

  if (refToLocal.size === 0) return html;

  function rewriteCss(cssText) {
    if (typeof cssText !== 'string' || cssText.length === 0) return cssText;
    CSS_URL_RE.lastIndex = 0;
    return cssText.replace(CSS_URL_RE, (full, dq, sq, bare) => {
      const ref = dq || sq || bare;
      const local = ref ? refToLocal.get(ref) : null;
      if (!local) return full;
      return `url("${local}")`;
    });
  }

  let out = html;
  out = out.replace(STYLE_BLOCK_RE, (full, inner) => {
    if (!inner) return full;
    const rewritten = rewriteCss(inner);
    if (rewritten === inner) return full;
    return full.replace(inner, () => rewritten);
  });
  out = out.replace(STYLE_ATTR_RE, (full, dq, sq) => {
    const cssText = dq !== undefined ? dq : sq;
    if (!cssText) return full;
    const rewritten = rewriteCss(cssText);
    if (rewritten === cssText) return full;
    const quote = dq !== undefined ? '"' : "'";
    return ` style=${quote}${rewritten}${quote}`;
  });

  return out;
}

function rewriteStylesheetReferences(html, mapping) {
  return replaceUrls(html, mapping);
}

async function ensureAllImagesLoaded(page) {
  const unlazied = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    let changed = 0;
    const lazyAttrs = ['data-src', 'data-lazy-src', 'data-original', 'data-url'];
    const lazySrcsetAttrs = ['data-srcset', 'data-lazy-srcset'];
    for (const img of imgs) {
      let touched = false;
      if (img.getAttribute('loading') === 'lazy') {
        img.setAttribute('loading', 'eager');
        touched = true;
      }
      for (const a of lazyAttrs) {
        const v = img.getAttribute(a);
        if (v && !img.src) {
          img.src = v;
          touched = true;
        }
      }
      for (const a of lazySrcsetAttrs) {
        const v = img.getAttribute(a);
        if (v && !img.srcset) {
          img.srcset = v;
          touched = true;
        }
      }
      if (touched) changed++;
    }
    return changed;
  });

  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    const maxY = document.documentElement.scrollHeight;
    for (let y = 0; y <= maxY; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 150));
  });

  try {
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 15000 });
  } catch {}

  const stats = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const imgs = Array.from(document.querySelectorAll('img'));
        const total = imgs.length;
        if (total === 0) return resolve({ total: 0, loaded: 0, failed: 0 });

        let settled = 0;
        let loaded = 0;
        let failed = 0;

        const done = () => resolve({ total, loaded, failed });
        const timer = setTimeout(done, 15000);

        const mark = (ok) => {
          if (ok) loaded++;
          else failed++;
          settled++;
          if (settled >= total) {
            clearTimeout(timer);
            done();
          }
        };

        for (const img of imgs) {
          if (img.complete) {
            mark(img.naturalWidth > 0);
          } else {
            img.addEventListener('load', () => mark(true), { once: true });
            img.addEventListener('error', () => mark(false), { once: true });
          }
        }
      })
  );

  return { ...stats, unlazied };
}

async function unwrapImageLinks(page) {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a'));
    let unwrapped = 0;
    for (const a of anchors) {
      if (!a.querySelector('img')) continue;
      const textContent = (a.textContent || '').trim();
      if (textContent.length > 0) continue;
      const parent = a.parentNode;
      if (!parent) continue;
      while (a.firstChild) parent.insertBefore(a.firstChild, a);
      parent.removeChild(a);
      unwrapped++;
    }
    return unwrapped;
  });
}

async function waitForArticleBody(page, selectors) {
  const list = selectors && selectors.length ? selectors : ['article', '.entry-content'];
  const joined = list.join(', ');
  try {
    await page.waitForSelector(joined, { timeout: 15000 });
  } catch {
    logError(`article body selector not found (tried: ${joined}) — continuing anyway`);
  }
}

async function expandAllComments(page, { selectors, textPatterns }) {
  let totalClicks = 0;
  let passes = 0;
  const maxPasses = 10;

  for (let i = 0; i < maxPasses; i++) {
    passes = i + 1;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(600);

    const clicked = await page.evaluate(
      (sels, patterns) => {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (el.disabled) return false;
          return true;
        };

        let count = 0;
        const seen = new Set();

        for (const sel of sels) {
          let nodes = [];
          try {
            nodes = Array.from(document.querySelectorAll(sel));
          } catch {
            continue;
          }
          for (const n of nodes) {
            if (seen.has(n) || !isVisible(n)) continue;
            seen.add(n);
            try {
              n.click();
              count++;
            } catch {}
          }
        }

        const regexes = patterns.map((p) => new RegExp(p, 'i'));
        const candidates = Array.from(document.querySelectorAll('a, button, span[role="button"]'));
        for (const el of candidates) {
          if (seen.has(el) || !isVisible(el)) continue;
          const txt = (el.innerText || el.textContent || '').trim();
          if (!txt || txt.length > 80) continue;
          if (regexes.some((r) => r.test(txt))) {
            seen.add(el);
            try {
              el.click();
              count++;
            } catch {}
          }
        }

        return count;
      },
      selectors,
      textPatterns
    );

    totalClicks += clicked;

    if (clicked === 0) break;

    await sleep(1200);
    try {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 });
    } catch {}
  }

  return { clicks: totalClicks, passes };
}

module.exports = { exportArticle, saveSourceHtml, ensureAllImagesLoaded, unwrapImageLinks, expandAllComments };
