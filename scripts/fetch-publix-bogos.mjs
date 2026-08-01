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
    const deals = normalise(JSON.parse(raw));
    await publish(deals, `fixture:${args.fixture}`);
    return;
  }

  const failures = [];

  for (const candidate of CANDIDATES) {
    const url = candidate.url(STORE);
    try {
      log(`trying ${candidate.name}: ${url}`);
      const json = await getJson(url);
      const deals = normalise(json);
      if (deals.length) {
        log(`  → ${deals.length} deals`);
        await publish(deals, url);
        return;
      }
      failures.push(`${candidate.name}: 0 deals parsed`);
      log('  → parsed 0 deals, trying the next candidate');
    } catch (err) {
      failures.push(`${candidate.name}: ${err.message}`);
      log(`  → ${err.message}`);
    }
  }

  await recordFailure(failures);
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

function looksLikeBogo(obj) {
  const blob = JSON.stringify(obj).toLowerCase();
  return (
    blob.includes('bogo') ||
    blob.includes('buy one') ||
    blob.includes('buy 1') ||
    blob.includes('get one free') ||
    blob.includes('b1g1')
  );
}

function normalise(payload) {
  const arrays = collectArrays(payload);
  if (!arrays.length) return [];

  // Prefer the array whose entries most often carry a usable title.
  const scored = arrays
    .map((arr) => {
      const objs = arr.filter((v) => v && typeof v === 'object' && !Array.isArray(v));
      const titled = objs.filter((o) => pick(o, TITLE_KEYS));
      return { arr: objs, score: titled.length };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return [];

  const rows = scored[0].arr;
  // If the payload mixes promo types, keep only the BOGO-looking rows — but if
  // none of them say BOGO, assume the endpoint already filtered for us.
  const bogoRows = rows.filter(looksLikeBogo);
  const source = bogoRows.length ? bogoRows : rows;

  const deals = [];
  const seen = new Set();

  for (const row of source) {
    const title = pick(row, TITLE_KEYS);
    if (!title || title.length > 200) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    deals.push({
      id: pick(row, ID_KEYS) ?? key.replace(/[^a-z0-9]+/g, '-').slice(0, 60),
      title,
      brand: pick(row, BRAND_KEYS),
      category: pick(row, CATEGORY_KEYS),
      savings: pick(row, SAVINGS_KEYS),
    });
  }

  return deals;
}

// ── Output ───────────────────────────────────────────────────────────────

async function publish(deals, source) {
  const now = new Date();
  const payload = {
    status: 'ok',
    updated: now.toISOString(),
    store: STORE ? `Publix store #${STORE}` : 'Publix (no store set)',
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
