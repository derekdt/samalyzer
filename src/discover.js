const { log, politeDelay, parsePublishedDate } = require('./util');

async function listArticles(page, config, { maxPages = null, stopIf = null, onPage = null } = {}) {
  const { baseUrl, archivePath, delayBetweenPagesMs, navigationTimeoutMs } = config;
  const cap = maxPages ?? config.maxPages ?? null;

  const results = [];
  const seen = new Set();
  let pageNumber = 1;
  let stopped = false;

  while (true) {
    const url =
      pageNumber === 1
        ? `${baseUrl}${archivePath}`
        : `${baseUrl}${archivePath}page/${pageNumber}/`;

    log(`discovering page ${pageNumber}: ${url}`);
    const resp = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: navigationTimeoutMs,
    });

    if (!resp || !resp.ok()) {
      if (resp && resp.status() === 404) {
        log(`page ${pageNumber} returned 404 — assuming end of archive`);
        break;
      }
      log(`page ${pageNumber} returned status ${resp ? resp.status() : 'unknown'} — stopping`);
      break;
    }

    const rawItems = await extractCards(page, baseUrl);
    const items = rawItems.filter((i) => i.publishedDate);
    const dropped = rawItems.length - items.length;
    log(
      `page ${pageNumber}: found ${items.length} dated cards` +
        (dropped ? ` (skipped ${dropped} non-article links)` : '')
    );

    const pageNewItems = [];
    for (const item of items) {
      if (stopIf && stopIf(item)) {
        log(`page ${pageNumber}: hit stop sentinel (${item.url}) — stopping discovery`);
        stopped = true;
        break;
      }
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      results.push(item);
      pageNewItems.push(item);
    }
    const newOnThisPage = pageNewItems.length;

    if (onPage && pageNewItems.length > 0) {
      await onPage(pageNewItems, results);
    }

    if (stopped) break;

    if (items.length === 0 || newOnThisPage === 0) {
      log(`page ${pageNumber}: no new articles — stopping`);
      break;
    }

    const hasNext = await page.evaluate(() => {
      const next = document.querySelector(
        'a.next, a.next.page-numbers, .pagination a[rel="next"], .nav-links a.next'
      );
      if (next) return true;
      const anchors = Array.from(document.querySelectorAll('a'));
      return anchors.some((a) => /next\s*(→|»|>)?/i.test((a.textContent || '').trim()));
    });

    if (!hasNext) {
      log(`no "next" link on page ${pageNumber} — finished`);
      break;
    }

    if (cap && pageNumber >= cap) {
      log(`reached maxPages=${cap} — stopping discovery`);
      break;
    }

    pageNumber++;
    await politeDelay(delayBetweenPagesMs, 'next archive page');
  }

  log(`discovery complete: ${results.length} unique articles across ${pageNumber} page(s)`);
  return results;
}

async function extractCards(page, baseUrl) {
  return page.evaluate((base) => {
    const baseHost = new URL(base).host;
    const anchorMap = new Map();

    const anchors = Array.from(document.querySelectorAll('a[href]'));
    for (const a of anchors) {
      let href;
      try {
        href = new URL(a.href, base).toString();
      } catch {
        continue;
      }
      const u = new URL(href);
      if (u.host !== baseHost) continue;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length !== 1) continue;
      const slug = parts[0];
      const skip = new Set([
        'blog-2',
        'wp-login.php',
        'wp-admin',
        'about',
        'contact',
        'subscribe',
        'login',
        'terms',
        'privacy',
        'faq',
        'category',
        'tag',
        'page',
        'feed',
      ]);
      if (skip.has(slug)) continue;
      if (slug.startsWith('#')) continue;
      const clean = `${u.origin}${u.pathname}`.replace(/\/?$/, '/');
      if (!anchorMap.has(clean)) {
        anchorMap.set(clean, a);
      }
    }

    const results = [];
    for (const [url, anchor] of anchorMap.entries()) {
      let card = anchor.closest('article');
      if (!card) card = anchor.closest('.post, .entry, .card, li, .wp-block-post, .type-post');
      if (!card) card = anchor.parentElement;
      const cardText = card ? (card.innerText || '').replace(/\s+/g, ' ').trim() : '';

      let title = '';
      const titleAnchor = card
        ? card.querySelector('h1 a, h2 a, h3 a, .entry-title a, .post-title a')
        : null;
      if (titleAnchor) {
        title = (titleAnchor.textContent || '').trim();
      } else if (anchor.textContent && anchor.textContent.trim().length > 4) {
        title = anchor.textContent.trim();
      }

      const dateMatch = cardText.match(
        /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/
      );
      const rawDate = dateMatch ? dateMatch[0] : null;

      results.push({ url, title, rawDate });
    }

    return results;
  }, baseUrl).then((raw) =>
    raw.map((r) => ({
      url: r.url,
      title: r.title,
      publishedDate: parsePublishedDate(r.rawDate),
    }))
  );
}

module.exports = { listArticles };
