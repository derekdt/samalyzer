// Pure parsing for the /app/trades/ page. No browser or network access here:
// the command in trades.js extracts text blocks from the page and hands them to
// parseBlocks(). Trades are hand-typed and the wording drifts a lot, so every
// trade keeps its original text in `raw` and lists anything that could not be
// parsed in `parseWarnings`.

const MONTH_ALT =
  'January|February|March|April|May|June|July|August|September|October|November|December|' +
  'Sept|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const MON = `(${MONTH_ALT})\\.?`;
const FULL_DATE_SRC = `${MON},?\\s+(\\d{1,2}),?\\s+(\\d{4})`;
const FULL_DATE = new RegExp(`\\b${FULL_DATE_SRC}`, 'i');
const MONTH_YEAR = new RegExp(`\\b${MON},?\\s+(\\d{4})\\b`, 'i');
const MONTH_DAY = new RegExp(`\\b${MON}\\s+(\\d{1,2})(?!\\d)`, 'i');
const MONTH_ONLY = new RegExp(`\\b${MON}(?![a-z])`, 'i');
const EXECUTED_TIME = new RegExp(
  `(\\d{1,2}):(\\d{2})\\s*(?:([AP])\\.?M\\.?)?\\s*(EST|EDT|ET)?\\s*,?\\s*(?:on\\s+)?${FULL_DATE_SRC}`,
  'i'
);
const EXECUTED_DATE_ONLY = new RegExp(`\\b(?:made\\s+on|expired\\s+on|on)\\s+${FULL_DATE_SRC}`, 'i');

const NUM = '([\\d,]+(?:\\.\\d+)?)';
const PRICE = new RegExp(`(?:@\\s*\\$*|\\bat\\s+\\$+)\\s*${NUM}`, 'i');
const QUANTITY = /\bx\s*(\d[\d,]*)\b\s*(contracts?|contacts?|shares?)?/i;
const SPREAD_STRIKES = new RegExp(`\\$\\s*${NUM}\\s*[-–]\\s*\\$?\\s*${NUM}`);
const OPTION_STRIKE = new RegExp(
  `\\$+\\s*${NUM}\\s*(?:calls?|puts?|leaps|call-options?|put-options?)\\b`,
  'i'
);

const TRADE_LINE = /^(\d+\.\s*)?(buy|sell|bought)\b/i;
const PORTFOLIO_LINE = /^(?:trade executed:\s*)?([A-Z][A-Za-z]+)\s+portfolio$/i;
const SECTION_END = /^[-–—\s]*end\b/i;

// Company names Sam writes without a ticker. Each mapping matches how he
// writes the ticker elsewhere on the page, e.g. "Google (GOOGL)".
const NAME_TO_TICKER = {
  nvidia: 'NVDA',
  apple: 'AAPL',
  google: 'GOOGL',
  amazon: 'AMZN',
  tesla: 'TSLA',
  facebook: 'META',
  microsoft: 'MSFT',
  palantir: 'PLTR',
  reddit: 'RDDT',
  'nasdaq-100': 'QQQ',
};

const NOT_TICKERS = new Set([
  'BUY', 'SELL', 'TO', 'OPEN', 'CLOSE', 'LONG', 'LEAPS', 'X', 'AT',
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUNE', 'JUL', 'JULY', 'AUG', 'SEP', 'SEPT', 'OCT', 'NOV', 'DEC',
]);

function monthNumber(name) {
  const key = name.toLowerCase().replace('.', '').slice(0, 3);
  return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(key) + 1;
}

const pad = (n) => String(n).padStart(2, '0');
const toNumber = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')));

function isoDate(monthName, day, year) {
  return `${year}-${pad(monthNumber(monthName))}-${pad(Number(day))}`;
}

function findDate(text) {
  const m = text && text.match(FULL_DATE);
  return m ? isoDate(m[1], m[2], m[3]) : null;
}

// Offset of America/New_York (e.g. "-04:00") on a given calendar date.
function newYorkOffset(dateIso) {
  const probe = new Date(`${dateIso}T16:00:00Z`);
  const tz = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName').value; // "GMT-4"
  const m = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return '-05:00';
  return `${m[1]}${pad(m[2])}:${m[3] || '00'}`;
}

function parseAction(line) {
  let m = line.match(/^(buy|sell)\s+to\s+(open|close)\b(?:\s*\(short\))?/i);
  if (m) return { action: `${m[1].toLowerCase()}_to_${m[2].toLowerCase()}`, end: m[0].length };
  m = line.match(/^(bought|buy(?:\s+long)?)\b/i);
  if (m) return { action: 'buy_to_open', end: m[0].length };
  m = line.match(/^sell\b/i);
  if (m) return { action: 'sell_to_close', end: m[0].length };
  return { action: null, end: 0 };
}

function parseSymbol(region) {
  const paren = region.match(/\(([A-Z]{1,5})\)/);
  if (paren) return paren[1];
  const words = region.split(/[\s,()]+/).filter(Boolean);
  for (const w of words) {
    if (/^\$|^\d/.test(w)) break; // reached strikes/prices
    if (/^[A-Z]{1,5}$/.test(w) && !NOT_TICKERS.has(w)) return w;
  }
  for (const w of words) {
    const t = NAME_TO_TICKER[w.toLowerCase()];
    if (t) return t;
  }
  return null;
}

function parseExpiration(region) {
  let m = region.match(FULL_DATE);
  if (m) return { expiration: isoDate(m[1], m[2], m[3]), expirationRaw: m[0] };
  m = region.match(MONTH_YEAR);
  if (m) return { expiration: `${m[2]}-${pad(monthNumber(m[1]))}`, expirationRaw: m[0] };
  m = region.match(MONTH_DAY) || region.match(MONTH_ONLY);
  if (m) return { expiration: null, expirationRaw: m[0] };
  return { expiration: null, expirationRaw: null };
}

function parseAllocation(line) {
  const pct = line.match(/(\d+(?:\.\d+)?)\s*%/);
  const kind = line.toLowerCase().match(/allocation|reduc\w*|value|cash received|sale/);
  let allocationType = kind ? kind[0] : null;
  if (allocationType && allocationType.startsWith('reduc')) allocationType = 'reduction';
  return {
    allocationPercent: pct ? Number(pct[1]) : null,
    allocationType,
    allocationNote: line,
  };
}

// Parse one trade line, e.g.
// "Buy to Open QQQ January 21, 2028 $700 Calls @ $86.50 x 1 Contract made at 1:05 PM EDT on October 30, 2026"
function parseTradeLine(rawLine) {
  const line = rawLine.replace(/^\d+\.\s*/, '').replace(/\s+/g, ' ').trim();
  const warnings = [];
  const { action, end: actionEnd } = parseAction(line);

  const priceM = PRICE.exec(line);
  const qtyM = QUANTITY.exec(line);
  const timeM = EXECUTED_TIME.exec(line);

  // The instrument description sits between the action and the first of
  // price / quantity / timestamp.
  const stops = [priceM, qtyM, timeM].filter(Boolean).map((m) => m.index);
  const regionEnd = stops.length ? Math.min(...stops) : line.length;
  const region = line.slice(actionEnd, regionEnd);

  const symbol = parseSymbol(region);

  let instrument = null;
  let optionType = null;
  let strikes = [];
  const typeWord = region.match(/\b(call|put)s?\b|\b(call|put)[-\s]?(spread|options?)\b/i);
  if (typeWord) optionType = (typeWord[1] || typeWord[2]).toLowerCase();

  if (/spread/i.test(region)) {
    instrument = 'spread';
    const s = region.match(SPREAD_STRIKES);
    if (s) strikes = [toNumber(s[1]), toNumber(s[2])];
  } else if (/\b(calls?|puts?|leaps|call-options?|put-options?)\b/i.test(region)) {
    instrument = 'option';
    const s = region.match(OPTION_STRIKE);
    if (s) strikes = [toNumber(s[1])];
  } else if (/\bshares?\b|common stock/i.test(line)) {
    instrument = 'stock';
  }

  let expiration = null;
  let expirationRaw = null;
  if (instrument === 'option' || instrument === 'spread') {
    ({ expiration, expirationRaw } = parseExpiration(region));
  }

  const price = priceM ? toNumber(priceM[1]) : null;
  const quantity = qtyM ? toNumber(qtyM[1]) : null;
  let quantityUnit = null;
  if (qtyM && qtyM[2]) quantityUnit = /share/i.test(qtyM[2]) ? 'shares' : 'contracts';
  else if (instrument) quantityUnit = instrument === 'stock' ? 'shares' : 'contracts';

  // Execution time. The time label Sam writes (EST/EDT) is often wrong for the
  // season, so executedAt uses the actual New York offset for that date and the
  // label is kept as written in timezoneLabel.
  let executedAt = null;
  let executedDate = null;
  let timezoneLabel = null;
  const tail = line.slice(regionEnd);
  let dateOnlyM = null;
  if (timeM) {
    let hour = Number(timeM[1]) % 12;
    // No AM/PM written: trades happen in market hours, so 12:xx and 1-7 are PM.
    const pm = timeM[3] ? timeM[3].toUpperCase() === 'P' : Number(timeM[1]) === 12 || Number(timeM[1]) < 8;
    if (pm) hour += 12;
    executedDate = isoDate(timeM[5], timeM[6], timeM[7]);
    executedAt = `${executedDate}T${pad(hour)}:${timeM[2]}:00${newYorkOffset(executedDate)}`;
    timezoneLabel = timeM[4] ? timeM[4].toUpperCase() : null;
  } else {
    dateOnlyM = tail.match(EXECUTED_DATE_ONLY);
    if (dateOnlyM) executedDate = isoDate(dateOnlyM[1], dateOnlyM[2], dateOnlyM[3]);
  }

  // Anything left after the price/quantity that isn't the timestamp is a note:
  // "[Option Exercised]", "Covered Calls expired worthless in July. Profit booked." etc.
  const notes = [];
  const lastFieldEnd = Math.max(
    priceM ? priceM.index + priceM[0].length : 0,
    qtyM ? qtyM.index + qtyM[0].length : 0
  );
  let rest = line.slice(lastFieldEnd);
  if (timeM) rest = rest.replace(timeM[0], ' ');
  else if (dateOnlyM && /^made on/i.test(dateOnlyM[0])) rest = rest.replace(dateOnlyM[0], ' ');
  rest = rest.replace(/\[([^\]]+)\]/g, (_, inner) => {
    notes.push(inner.trim());
    return ' ';
  });
  rest = rest.replace(/\(([^)]+)\)/g, (_, inner) => {
    notes.push(inner.trim());
    return ' ';
  });
  rest = rest
    .replace(/\bmade\s+(?:at|on)\b/gi, ' ')
    .replace(/\bat\b\s*(?=[.\s]*$)/i, ' ')
    .replace(/^[\s.,;:]+|[\s.,;:]+$/g, '')
    .replace(/\s+/g, ' ');
  if (rest) notes.push(rest);

  if (!action) warnings.push('action');
  if (!symbol) warnings.push('symbol');
  if (!instrument) warnings.push('instrument');
  if (price == null) warnings.push('price');
  if (quantity == null) warnings.push('quantity');
  if (instrument === 'option' || instrument === 'spread') {
    if (!optionType) warnings.push('optionType');
    if (strikes.length === 0) warnings.push('strikes');
    if (!expiration) warnings.push(expirationRaw ? 'expiration incomplete' : 'expiration');
  }

  return {
    action,
    symbol,
    instrument,
    optionType: instrument === 'stock' ? null : optionType,
    strikes,
    expiration,
    expirationRaw,
    price,
    quantity,
    quantityUnit,
    executedAt,
    executedDate,
    timezoneLabel,
    notes,
    raw: line,
    warnings,
  };
}

// blocks: [{ tag, lines: string[], strong: string[], em: string[], links: string[] }]
// in page order. Returns { trades, unrecognized }.
function parseBlocks(blocks) {
  const trades = [];
  const unrecognized = [];
  let section = null; // { title, date }

  for (const block of blocks) {
    // A block is a trade entry if it has a trade line or a "<Name> Portfolio"
    // header (e.g. a test notification posted under a portfolio heading).
    const isTradeEntry = block.lines.some((l) => TRADE_LINE.test(l) || PORTFOLIO_LINE.test(l));

    if (!isTradeEntry) {
      // Section markers, e.g. "<< OPTIONS EXPIRATION TRADES Friday, June 19, 2026 >>"
      // followed later by a matching "... END" / "End of March 25, 2026 Section".
      // The first dated line opens a section; sub-headings and intro text inside
      // it don't replace it.
      for (const line of block.lines) {
        if (SECTION_END.test(line) || line === 'END') section = null;
        else if (!section && FULL_DATE.test(line)) {
          section = { title: line.replace(/^[<\s–—-]+|[>\s–—-]+$/g, ''), date: findDate(line) };
        }
      }
      continue;
    }

    let portfolio = null;
    let last = null;
    for (const line of block.lines) {
      const header = line.match(PORTFOLIO_LINE);
      if (header) {
        portfolio = header[1];
        continue;
      }
      // "Targaryen" / "Baratheon" written alone in bold, without "Portfolio".
      if (/^[A-Z][a-z]+$/.test(line) && block.strong.includes(line)) {
        portfolio = line;
        continue;
      }
      if (TRADE_LINE.test(line)) {
        const { warnings, notes, raw, ...fields } = parseTradeLine(line);
        let dateSource = fields.executedDate ? 'trade' : null;
        if (!fields.executedDate && section && section.date) {
          fields.executedDate = section.date;
          dateSource = 'section';
        }
        if (!fields.executedDate) warnings.push('executedDate');
        if (!portfolio) warnings.push('portfolio');
        last = {
          portfolio,
          ...fields,
          dateSource,
          allocationPercent: null,
          allocationType: null,
          allocationNote: null,
          notes,
          section: section ? section.title : null,
          articleUrl: block.links[0] || null,
          raw,
          parseWarnings: warnings,
        };
        trades.push(last);
        continue;
      }
      if (last && (block.em.includes(line) || /%|hedge/i.test(line))) {
        if (/%/.test(line) && last.allocationNote == null) Object.assign(last, parseAllocation(line));
        else last.notes.push(line);
        continue;
      }
      unrecognized.push(line);
    }
  }

  return { trades, unrecognized };
}

module.exports = { parseBlocks, parseTradeLine, newYorkOffset };
