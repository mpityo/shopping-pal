#!/usr/bin/env node
/**
 * Refresh data/bogos.json with this week's Publix BOGO deals.
 *
 * Runs in CI, not in the browser: Publix does not send CORS headers, so the
 * page cannot call them directly. The Action commits the JSON and GitHub Pages
 * serves it same-origin.
 *
 * Publix has no documented public API, and the endpoints its own site uses
 * move around. Rather than pinning one URL and one response shape, this tries
 * several candidates and normalises whatever JSON comes back by looking for
 * the largest array of objects that carry a title-ish field. If every
 * candidate fails it exits non-zero and leaves the existing file untouched,
 * so the site keeps showing the last good ad and flags it as stale.
 *
 * Usage:
 *   node scripts/fetch-publix-bogos.mjs [--store 1234] [--out data/bogos.json]
 *   node scripts/fetch-publix-bogos.mjs --fixture sample.json   # offline test
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const STORE = args.store ?? process.env.PUBLIX_STORE_NUMBER ?? '';
const OUT = resolve(args.out ?? 'data/bogos.json');
const TIMEOUT_MS = 20_000;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Tried in order; the first one that yields deals wins. */
const CANDIDATES = [
  {
    name: 'services v4 savings',
    url: (store) =>
      `https://services.publix.com/api/v4/savings?promotionType=BOGO&pageSize=200&page=1` +
      (store ? `&storeNumber=${encodeURIComponent(store)}` : ''),
  },
  {
    name: 'services v1 savings',
    url: (store) =>
      `https://services.publix.com/api/v1/savings?promotionTypes=BOGO&pageSize=200` +
      (store ? `&storeNumber=${encodeURIComponent(store)}` : ''),
  },
  {
    name: 'weeklyad sitecore',
    url: (store) =>
      `https://services.publix.com/api/v1/weeklyad/bogo` +
      (store ? `?storeNumber=${encodeURIComponent(store)}` : ''),
  },
];

async function main() {
  if (args.fixture) {
    const raw = await readFile(resolve(args.fixture), 'utf8');
    const { deals, report } = normalise(JSON.parse(raw));
    describe('fixture', report);
    await publish(deals, `fixture:${args.fixture}`);
    return;
  }

  if (!STORE) {
    log(
      'WARNING: no store number set. The weekly-ad BOGOs are per-store, so ' +
        'without one this may only return national offers. Set a repository ' +
        'variable PUBLIX_STORE_NUMBER (Settings → Secrets and variables → ' +
        'Actions → Variables).',
    );
    console.log('::warning title=No Publix store number::Set the PUBLIX_STORE_NUMBER repository variable for store-specific BOGOs.');
  }

  const failures = [];
  const results = [];

  // Try every candidate rather than stopping at the first that returns JSON:
  // several of them answer, and the one that answers first is not necessarily
  // the one carrying the weekly ad.
  for (const candidate of CANDIDATES) {
    const url = candidate.url(STORE);
    try {
      log(`trying ${candidate.name}: ${url}`);
      const json = await getJson(url);
      const { deals, report } = normalise(json);
      describe(candidate.name, report);
      if (deals.length) results.push({ deals, url, name: candidate.name });
      else failures.push(`${candidate.name}: reached it, but no BOGO rows`);
    } catch (err) {
      failures.push(`${candidate.name}: ${err.message}`);
      log(`  → ${err.message}`);
    }
  }

  if (results.length) {
    results.sort((a, b) => b.deals.length - a.deals.length);
    const best = results[0];
    if (results.length > 1) {
      log(`picked ${best.name} (${best.deals.length} deals) over ${results.length - 1} other source(s)`);
    }
    await publish(best.deals, best.url);
    return;
  }

  await recordFailure(failures);
}

/** Print what a payload actually looked like, so the log is diagnostic. */
function describe(name, report) {
  log(
    `  ${name}: ${report.rows} rows | ${report.textBogo} read as BOGO | ` +
      `${report.typedBogo} typed BOGO`,
  );
  if (report.keys.length) log(`  fields: ${report.keys.slice(0, 14).join(', ')}`);
  for (const title of report.skipped) log(`  skipped (not a BOGO): ${title.slice(0, 90)}`);
}

// ── HTTP ─────────────────────────────────────────────────────────────────

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': UA,
        referer: 'https://www.publix.com/savings/weekly-ad',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`response was not JSON (${text.slice(0, 60).replace(/\s+/g, ' ')}…)`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ── Normalising ──────────────────────────────────────────────────────────

const TITLE_KEYS = ['title', 'name', 'productName', 'description', 'displayName', 'itemName'];
const BRAND_KEYS = ['brand', 'brandName', 'manufacturer'];
const CATEGORY_KEYS = ['category', 'categoryName', 'department', 'aisle', 'productCategory'];
const SAVINGS_KEYS = ['savings', 'savingsText', 'promotionText', 'offerText', 'dealText', 'price', 'subtitle'];
const ID_KEYS = ['id', 'promotionId', 'itemId', 'productId', 'sku'];

/** Depth-first walk collecting every array of objects in the payload. */
function collectArrays(node, out = [], depth = 0) {
  if (depth > 8 || node == null) return out;
  if (Array.isArray(node)) {
    if (node.some((v) => v && typeof v === 'object' && !Array.isArray(v))) out.push(node);
    for (const child of node) collectArrays(child, out, depth + 1);
  } else if (typeof node === 'object') {
    for (const value of Object.values(node)) collectArrays(value, out, depth + 1);
  }
  return out;
}

function pick(obj, keys) {
  for (const key of keys) {
    const found = Object.keys(obj).find((k) => k.toLowerCase() === key.toLowerCase());
    const value = found ? obj[found] : undefined;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

/**
 * Publix returns product text with HTML entities baked in ("Annie&#39;s",
 * "Jalape&ntilde;o", "&trade;"). There is no DOM in Node to decode them, so
 * handle numeric escapes plus the named ones that actually turn up in grocery
 * copy.
 */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026',
  trade: '\u2122', reg: '\u00ae', copy: '\u00a9',
  cent: '\u00a2', pound: '\u00a3', euro: '\u20ac', deg: '\u00b0',
  frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be',
  ntilde: '\u00f1', eacute: '\u00e9', egrave: '\u00e8', agrave: '\u00e0',
  ccedil: '\u00e7', uuml: '\u00fc', ouml: '\u00f6', auml: '\u00e4',
};

function decodeEntities(text) {
  if (typeof text !== 'string' || !text.includes('&')) return text;
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z0-9]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does this row describe an actual buy-one-get-one, judged from its own text?
 *
 * Publix phrases these as "Buy any ONE (1) X ... Get ONE (1) Y FREE", so a
 * naive `includes('buy one')` misses them, and a whole-object substring match
 * is worse: querying promotionType=BOGO makes every row echo the word "bogo"
 * somewhere, which let plain "SAVE $1.00" coupons through as BOGOs.
 */
function isBogoText(text) {
  const t = text.toLowerCase();
  if (/\bbogo\b|\bb1g1\b|buy\s*1\s*get\s*1/.test(t)) return true;
  // "buy ... free" in that order covers the long-form phrasing.
  return /\bbuy\b/.test(t) && /\bfree\b/.test(t);
}

/** A field whose value is literally a BOGO promotion type. */
function hasBogoType(obj) {
  return Object.values(obj).some(
    (v) => typeof v === 'string' && /^(bogo|b1g1|buyonegetone|buy one get one( free)?)$/i.test(v.trim()),
  );
}

function rowText(row) {
  return decodeEntities(
    [pick(row, TITLE_KEYS), pick(row, SAVINGS_KEYS), pick(row, BRAND_KEYS)]
      .filter(Boolean)
      .join(' '),
  );
}

/**
 * Turn an arbitrary payload into deals, and report enough about what was seen
 * for the Action log to be diagnostic when the shape changes again.
 */
function normalise(payload) {
  const arrays = collectArrays(payload);
  const report = { rows: 0, textBogo: 0, typedBogo: 0, skipped: [], keys: [] };
  if (!arrays.length) return { deals: [], report };

  // Prefer the array whose entries most often carry a usable title.
  const scored = arrays
    .map((arr) => {
      const objs = arr.filter((v) => v && typeof v === 'object' && !Array.isArray(v));
      return { arr: objs, score: objs.filter((o) => pick(o, TITLE_KEYS)).length };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { deals: [], report };

  const rows = scored[0].arr;
  report.rows = rows.length;
  report.keys = Object.keys(rows[0] ?? {});

  const textBogo = rows.filter((r) => isBogoText(rowText(r)));
  const typedBogo = rows.filter(hasBogoType);
  report.textBogo = textBogo.length;
  report.typedBogo = typedBogo.length;

  // Trust the row's own wording first. Only fall back to the API's labelling
  // when nothing reads like a BOGO, and never fall back to "everything".
  let source = textBogo;
  if (!source.length && typedBogo.length) {
    log('  no row text reads as BOGO; trusting the feed\'s own promotion type');
    source = typedBogo;
  }

  const kept = new Set(source);
  for (const row of rows) {
    if (kept.has(row)) continue;
    const title = decodeEntities(pick(row, TITLE_KEYS) ?? '');
    if (title && report.skipped.length < 5) report.skipped.push(title);
  }

  const deals = [];
  const seen = new Set();

  for (const row of source) {
    const title = decodeEntities(pick(row, TITLE_KEYS) ?? '');
    if (!title || title.length > 200) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    deals.push({
      id: pick(row, ID_KEYS) ?? key.replace(/[^a-z0-9]+/g, '-').slice(0, 60),
      title,
      brand: decodeEntities(pick(row, BRAND_KEYS) ?? '') || null,
      category: decodeEntities(pick(row, CATEGORY_KEYS) ?? '') || null,
      savings: decodeEntities(pick(row, SAVINGS_KEYS) ?? '') || null,
    });
  }

  return { deals, report };
}

// ── Output ───────────────────────────────────────────────────────────────

async function publish(deals, source) {
  const now = new Date();
  const payload = {
    status: 'ok',
    updated: now.toISOString(),
    store: STORE ? `Publix store #${STORE}` : 'Publix (no store set)',
    storeNumber: STORE || null,
    validThrough: nextWednesday(now),
    source,
    count: deals.length,
    deals,
  };

  if (args['dry-run']) {
    console.log(JSON.stringify(payload, null, 2).slice(0, 2000));
    log(`dry run — would write ${deals.length} deals to ${OUT}`);
    return;
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  log(`wrote ${deals.length} deals to ${OUT}`);
}

/**
 * A failed refresh is recorded rather than thrown away: the previously fetched
 * deals are kept (the app flags them as stale on its own) and the attempt is
 * stamped so it is obvious from the site — and from the JSON — that the feed
 * stopped updating. The job stays green so a broken endpoint does not mail out
 * a failure every single day; it emits a CI warning instead.
 */
async function recordFailure(failures) {
  const detail = failures.join('; ');
  let existing = null;
  try {
    existing = JSON.parse(await readFile(OUT, 'utf8'));
  } catch {
    /* first run, or the file was never written */
  }

  const payload = {
    ...(existing ?? { status: 'unavailable', updated: null, store: null, deals: [] }),
    lastAttempt: new Date().toISOString(),
    lastError: detail,
  };

  console.error('Could not refresh the Publix BOGO feed. Tried:');
  for (const f of failures) console.error(`  • ${f}`);
  console.error(
    'Keeping whatever was already in the feed. The site marks it stale, and ' +
      'deals can still be added by hand in the app.\n' +
      'If Publix changed their endpoints, update CANDIDATES in this file.',
  );
  console.log(`::warning title=Publix BOGO refresh failed::${detail}`);

  if (args['dry-run']) return;
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/** Publix ads typically run Wed–Tue; this is a display hint, not a guarantee. */
function nextWednesday(from) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + ((3 - d.getUTCDay() + 7) % 7 || 7) - 1);
  return d.toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function log(message) {
  console.log(`[bogos] ${message}`);
}

main().catch((err) => {
  console.error(`[bogos] unexpected failure: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
