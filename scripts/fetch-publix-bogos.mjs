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
/**
 * The postal code decides whether the weekly ad can be fetched at all, and it
 * is the single easiest thing to misconfigure — GitHub's settings page has
 * separate tabs for Secrets and Variables, and only one of them feeds `vars`.
 * Accept the obvious near-misses and say which one was found, so a silent
 * "only 7 coupons" result cannot happen without an explanation in the log.
 */
const POSTAL_VARS = [
  'PUBLIX_POSTAL_CODE',
  'PUBLIC_POSTAL_CODE',
  'POSTAL_CODE',
  'PUBLIX_ZIP',
  'ZIP_CODE',
];

function resolvePostal() {
  if (args.postal) return { value: String(args.postal).trim(), from: '--postal' };
  for (const name of POSTAL_VARS) {
    const value = (process.env[name] ?? '').trim();
    if (value) return { value, from: name };
  }
  return { value: '', from: null };
}

const { value: POSTAL, from: POSTAL_FROM } = resolvePostal();
const TIMEOUT_MS = 20_000;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * Probe list for `--discover`.
 *
 * The one endpoint that answers ignores `promotionType` and returns the whole
 * digital-coupon gallery, and its rows carry a `waId` (weekly-ad id) next to
 * `dcId` (digital-coupon id) — so the weekly ad is plausibly reachable from
 * the same service under different parameters. Guessing one URL per CI run is
 * slow; this tries the lot in a single run and reports what each returns, so
 * the working combination can be picked out of one log.
 */
const PROBES = [
  ['v4 savings, no filter', (s) => `https://services.publix.com/api/v4/savings?pageSize=500&page=1${q(s)}`],
  ['v4 savings, weeklyad type', (s) => `https://services.publix.com/api/v4/savings?promotionType=WeeklyAd&pageSize=500${q(s)}`],
  ['v4 savings, savingsType', (s) => `https://services.publix.com/api/v4/savings?savingsType=WeeklyAd&pageSize=500${q(s)}`],
  ['v4 savings, BOGO+weeklyad', (s) => `https://services.publix.com/api/v4/savings?promotionType=BOGO&savingsType=WeeklyAd&pageSize=500${q(s)}`],
  ['v4 weeklyad', (s) => `https://services.publix.com/api/v4/weeklyad?pageSize=500${q(s)}`],
  ['v4 weeklyad items', (s) => `https://services.publix.com/api/v4/weeklyad/items?pageSize=500${q(s)}`],
  ['v4 savings/weeklyad', (s) => `https://services.publix.com/api/v4/savings/weeklyad?pageSize=500${q(s)}`],
  ['v3 savings', (s) => `https://services.publix.com/api/v3/savings?pageSize=500${q(s)}`],
  ['v2 weeklyad', (s) => `https://services.publix.com/api/v2/weeklyad?pageSize=500${q(s)}`],
  ['v1 weeklyads', (s) => `https://services.publix.com/api/v1/weeklyads${q(s, '?')}`],
  ['v4 savings page 2', (s) => `https://services.publix.com/api/v4/savings?pageSize=500&page=2${q(s)}`],
];

function q(store, lead = '&') {
  return store ? `${lead}storeNumber=${encodeURIComponent(store)}` : '';
}

/**
 * Pages to fetch as HTML rather than JSON.
 *
 * Round one proved services.publix.com/api/*\/savings is a digital-coupon
 * service that ignores every filter parameter — 182 coupon rows, zero
 * weekly-ad rows, identical for every combination tried. The weekly ad is not
 * behind that host at all, so guessing more paths there is pointless.
 *
 * What is worth knowing instead: which platform renders the weekly ad page.
 * Grocery circulars are usually served by a third party, and the page's own
 * script and iframe hosts give that away in one fetch.
 */
const HTML_PROBES = [
  ['weekly ad page', () => 'https://www.publix.com/savings/weekly-ad'],
  ['weekly ad, BOGO tab', () => 'https://www.publix.com/savings/weekly-ad/bogo'],
];

/** Ad platforms that commonly back grocery circulars, keyed off a postal code. */
const POSTAL_PROBES = [
  [
    'flipp item search',
    (zip) => `https://backflipp.wishabi.com/flipp/items/search?locale=en-us&postal_code=${zip}&q=bogo`,
  ],
  [
    'flipp merchants',
    (zip) => `https://backflipp.wishabi.com/flipp/merchants?locale=en-us&postal_code=${zip}`,
  ],
];

async function getText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': UA },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Report what a page is built from: embedded state blobs, and the external
 * hosts it pulls scripts and frames from. That is what identifies the ad
 * platform, which is the thing actually worth knowing.
 */
function describeHtml(html) {
  const lines = [];
  lines.push(`  ${html.length} bytes of HTML`);

  for (const marker of ['__NEXT_DATA__', '__INITIAL_STATE__', '__NUXT__', 'application/ld+json']) {
    const at = html.indexOf(marker);
    if (at >= 0) lines.push(`  contains ${marker} at offset ${at}`);
  }

  const hosts = new Map();
  for (const m of html.matchAll(/(?:src|href)="https?:\/\/([^/"]+)/gi)) {
    const host = m[1].toLowerCase();
    if (host.endsWith('publix.com')) continue;
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
  }
  const external = [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (external.length) {
    lines.push(`  external hosts: ${external.map(([h, n]) => `${h}×${n}`).join(', ')}`);
  }

  const interesting = new Set();
  for (const m of html.matchAll(/https?:\/\/[^"'\s<>]*(?:weekly|circular|flipp|wishabi|savings|promo)[^"'\s<>]*/gi)) {
    if (m[0].length < 200) interesting.add(m[0]);
  }
  for (const url of [...interesting].slice(0, 10)) lines.push(`  url: ${url}`);

  return lines;
}

/**
 * Try every probe and report what came back, without writing the feed.
 * Read the Action log, pick the endpoint that carries the weekly ad, and move
 * it into CANDIDATES.
 */
async function discover() {
  log(`discovery mode${STORE ? ` for store #${STORE}` : ' (no store number set!)'}`);
  for (const [name, build] of PROBES) {
    const url = build(STORE);
    try {
      const json = await getJson(url);
      const { deals, report } = normalise(json);
      log(`\n${name}`);
      log(`  ${url}`);
      describe(name, report);
      log(`  would yield ${deals.length} BOGO deal(s)`);
      for (const d of deals.slice(0, 3)) log(`  sample: ${d.title.slice(0, 88)}`);
    } catch (err) {
      log(`\n${name}\n  ${url}\n  → ${err.message}`);
    }
  }
  for (const [name, build] of HTML_PROBES) {
    const url = build();
    log(`\n${name}\n  ${url}`);
    try {
      const html = await getText(url);
      for (const line of describeHtml(html)) log(line);
    } catch (err) {
      log(`  → ${err.message}`);
    }
  }

  if (POSTAL) {
    for (const [name, build] of POSTAL_PROBES) {
      const url = build(encodeURIComponent(POSTAL));
      log(`\n${name}\n  ${url}`);
      try {
        const json = await getJson(url);
        const { deals, report } = normalise(json);
        describe(name, report);
        log(`  would yield ${deals.length} BOGO deal(s)`);
        for (const d of deals.slice(0, 5)) log(`  sample: ${d.title.slice(0, 88)}`);
      } catch (err) {
        log(`  → ${err.message}`);
      }
    }
  } else {
    log('\nNo postal code set, so the third-party circular platforms were not probed.');
    log('Set PUBLIX_POSTAL_CODE (or pass it to the workflow) to include them.');
  }

  log('\nDiscovery complete.');
}

/** Tried in order; the first one that yields deals wins. */
const CANDIDATES = [
  {
    name: 'services v4 savings',
    url: (store) =>
      `https://services.publix.com/api/v4/savings?promotionType=BOGO&pageSize=500&page=1` +
      (store ? `&storeNumber=${encodeURIComponent(store)}` : ''),
  },
];

const FLIPP = 'https://backflipp.wishabi.com/flipp';

/**
 * The weekly ad, via the circular platform that renders it.
 *
 * Discovery found it here after proving Publix's own savings API carries only
 * digital coupons. Two things matter for correctness:
 *
 *  - The search is keyed by postal code across *every* merchant in the area,
 *    so results must be filtered to Publix or the list fills with other
 *    shops' offers.
 *  - Titles arrive with the offer and footnote markers inline
 *    ("Campari Tomatoes† BOGO*"), which have to come off before the names can
 *    match the catalogue.
 */
async function fetchWeeklyAd(postal) {
  const merchants = selectRows(await getJson(`${FLIPP}/merchants?locale=en-us&postal_code=${postal}`));
  const publix = merchants.filter((m) =>
    /^publix$/i.test(String(m.name_identifier ?? '').trim()) ||
    /^publix\b/i.test(String(m.name ?? '').trim()),
  );
  if (!publix.length) {
    throw new Error(`no Publix merchant found among ${merchants.length} for postal code ${postal}`);
  }
  const ids = new Set(publix.map((m) => m.id));
  log(`  matched ${publix.length} Publix merchant(s): ${publix.map((m) => `${m.name}#${m.id}`).join(', ')}`);

  const items = selectRows(
    await getJson(`${FLIPP}/items/search?locale=en-us&postal_code=${postal}&q=bogo&limit=500`),
  );
  const mine = items.filter((i) => ids.has(i.merchant_id));
  log(`  ${items.length} rows in the area, ${mine.length} from Publix`);

  const deals = [];
  const seen = new Set();
  for (const row of mine) {
    const raw = pick(row, TITLE_KEYS);
    if (!raw || !isBogoText(decodeEntities(raw))) continue;
    const title = cleanTitle(raw);
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deals.push({
      id: String(row.flyer_item_id ?? row.id ?? key.replace(/[^a-z0-9]+/g, '-').slice(0, 60)),
      title,
      brand: null,
      category: 'Weekly ad',
      savings: 'BOGO',
    });
  }
  return deals;
}

async function main() {
  if (args.discover) {
    await discover();
    return;
  }

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

  // The weekly ad is the thing people mean by "the BOGOs", so try it first.
  if (POSTAL) {
    try {
      log(`fetching the weekly ad for postal code ${POSTAL} (from ${POSTAL_FROM})`);
      const deals = await fetchWeeklyAd(POSTAL);
      if (deals.length) results.push({ deals, url: `${FLIPP}/items/search`, name: 'weekly ad' });
      else failures.push('weekly ad: reached it, but no Publix BOGO rows');
    } catch (err) {
      failures.push(`weekly ad: ${err.message}`);
      log(`  → ${err.message}`);
    }
  } else {
    log('WARNING: no postal code, so the weekly ad — most of the BOGOs — was skipped.');
    log(`  Looked for: ${POSTAL_VARS.join(', ')}`);
    log('  Set it under Settings → Secrets and variables → Actions → the');
    log('  *Variables* tab (not Secrets), named PUBLIX_POSTAL_CODE.');
    console.log(
      '::warning title=No postal code::The weekly-ad BOGOs were skipped. Add a repository *variable* named PUBLIX_POSTAL_CODE.',
    );
  }

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
    const merged = [];
    const seen = new Set();
    for (const result of results) {
      for (const deal of result.deals) {
        const key = deal.title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(deal);
      }
    }
    log(`combined ${results.map((r) => `${r.name}: ${r.deals.length}`).join(', ')} → ${merged.length} unique`);
    await publish(merged, results.map((r) => r.url).join(' + '));
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
  if (report.keys.length) log(`  fields: ${report.keys.slice(0, 16).join(', ')}`);
  if (report.withCouponId || report.withWeeklyAdId) {
    log(`  ids: ${report.withCouponId} digital-coupon, ${report.withWeeklyAdId} weekly-ad`);
  }
  if (report.qualifiers?.length) {
    log(`  priceQualifier: ${report.qualifiers.map(([q, n]) => `${q}×${n}`).join(', ')}`);
  }
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
const SAVINGS_KEYS = [
  'savings', 'savingsText', 'promotionText', 'offerText', 'dealText',
  'priceQualifier', 'finalPrice', 'price', 'subtitle',
];
const DETAIL_KEYS = ['description', 'priceQualifier', 'terms', 'additionalSavings'];
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
  // No word boundary before "bogo": titles arrive as "Ramen BOGO*" and also
  // as "RamenBOGO*". The string is distinctive enough to match bare.
  if (/bogo|\bb1g1\b|buy\s*1\s*get\s*1/.test(t)) return true;
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
    [
      pick(row, TITLE_KEYS),
      pick(row, SAVINGS_KEYS),
      pick(row, BRAND_KEYS),
      pick(row, DETAIL_KEYS),
    ]
      .filter(Boolean)
      .join(' '),
  );
}

/**
 * Turn an arbitrary payload into deals, and report enough about what was seen
 * for the Action log to be diagnostic when the shape changes again.
 */
/** The array in an arbitrary payload most likely to be the list of records. */
function selectRows(payload) {
  const scored = collectArrays(payload)
    .map((arr) => {
      const objs = arr.filter((v) => v && typeof v === 'object' && !Array.isArray(v));
      return { arr: objs, score: objs.filter((o) => pick(o, TITLE_KEYS)).length };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].arr : [];
}

/**
 * Weekly-ad titles carry the offer and footnote markers inline —
 * "Campari Tomatoes† BOGO*". Strip those so the name matches the catalogue.
 */
function cleanTitle(title) {
  return decodeEntities(title)
    .replace(/\s*bogo\b\s*\*?/gi, ' ')
    .replace(/[†‡*]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalise(payload) {
  const report = { rows: 0, textBogo: 0, typedBogo: 0, skipped: [], keys: [] };
  const rows = selectRows(payload);
  if (!rows.length) return { deals: [], report };
  report.rows = rows.length;
  report.keys = Object.keys(rows[0] ?? {});

  // Publix tags rows with a digital-coupon id or a weekly-ad id. Knowing which
  // family came back is the difference between "the coupon gallery" and "the
  // weekly ad", and the counts say so at a glance.
  const has = (row, key) => {
    const found = Object.keys(row).find((k) => k.toLowerCase() === key);
    const value = found ? row[found] : null;
    return value !== null && value !== undefined && value !== '' && value !== 0;
  };
  report.withCouponId = rows.filter((r) => has(r, 'dcid')).length;
  report.withWeeklyAdId = rows.filter((r) => has(r, 'waid')).length;

  const qualifiers = new Map();
  for (const row of rows) {
    const q = pick(row, ['priceQualifier']) ?? '(none)';
    qualifiers.set(q, (qualifiers.get(q) ?? 0) + 1);
  }
  report.qualifiers = [...qualifiers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

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
      category: decodeEntities(pick(row, CATEGORY_KEYS) ?? '') || 'Digital coupon',
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
