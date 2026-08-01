/**
 * Publix BOGO feed.
 *
 * The page is static, and Publix does not allow cross-origin calls from a
 * browser, so nothing is fetched from Publix at run time. A GitHub Action
 * refreshes `data/bogos.json` in the repo on a schedule and the page just
 * reads that file — same origin, no key, works offline once cached.
 *
 * If the feed is missing or stale, that is shown honestly rather than hidden,
 * and deals can always be typed in by hand from the paper ad.
 */
import { normalize } from './util.js';

const FEED_URL = new URL('../../data/bogos.json', import.meta.url);

const EMPTY = {
  status: 'unavailable',
  updated: null,
  store: null,
  storeNumber: null,
  validThrough: null,
  source: null,
  lastAttempt: null,
  lastError: null,
  deals: [],
};

export async function loadDeals() {
  try {
    const res = await fetch(FEED_URL, { cache: 'no-cache' });
    if (!res.ok) return { ...EMPTY, error: `Feed returned ${res.status}` };
    const data = await res.json();
    return {
      ...EMPTY,
      ...data,
      deals: Array.isArray(data.deals) ? data.deals : [],
    };
  } catch (err) {
    return { ...EMPTY, error: err.message };
  }
}

/** Days since the feed was written, or null if it has never been written. */
export function feedAgeDays(feed) {
  if (!feed?.updated) return null;
  const then = new Date(feed.updated);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((Date.now() - then.getTime()) / 86_400_000);
}

export function isStale(feed) {
  const age = feedAgeDays(feed);
  return age === null || age > 8;
}

/** Everything shown on the Deals tab: the fetched feed plus manual entries. */
export function allDeals(feed, manualDeals = []) {
  const fetched = (feed?.deals ?? []).map((d) => ({ ...d, origin: 'publix' }));
  const manual = manualDeals.map((d) => ({ ...d, origin: 'manual' }));
  return [...manual, ...fetched];
}

/** Words too generic to justify a match on their own. */
const STOPWORDS = new Set([
  'the', 'and', 'or', 'of', 'with', 'for', 'in', 'a', 'an', 'free', 'buy',
  'one', 'get', 'bogo', 'sale', 'save', 'off', 'oz', 'ct', 'lb', 'pack',
  'assorted', 'varieties', 'selected', 'select', 'publix', 'brand', 'size',
  'family', 'value', 'fresh', 'new', 'all', 'natural', 'original', 'each',
]);

/**
 * Words that are real content but too generic to carry a match on their own —
 * they are usually the modifier in a compound, not the thing being sold.
 * Without this, "Bounty Paper Towels" matches Toilet paper and Parchment
 * paper, and "Barilla Penne Pasta" matches Pasta sauce.
 */
const WEAK_ALONE = new Set([
  'paper', 'plastic', 'pasta', 'sauce', 'mix', 'powder', 'spray', 'wipes',
  'bag', 'bags', 'towel', 'towels', 'cup', 'cups', 'roll', 'rolls', 'bar',
  'bars', 'sliced', 'ground', 'frozen', 'cooked', 'light', 'whole',
  // Category nouns that appear in half the ad. Real matches share more than
  // one word anyway — "Tostitos Tortilla Chips" still hits "tortilla chips" —
  // whereas alone these turned "DORITOS, CHEETOS or SUN CHIPS" into a match
  // for blue corn tortilla chips, and "Starbucks Coffee & Protein" into one
  // for protein salad mix.
  'chips', 'protein', 'coffee', 'juice', 'milk', 'cheese', 'bread', 'water',
  'snack', 'snacks', 'oatmeal', 'instant', 'single', 'drink', 'drinks',
  'soft', 'less', 'any',
]);

function contentWords(text) {
  return normalize(text)
    .split(' ')
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Link deals to catalog items by shared content words.
 *
 * Deliberately conservative: matching on a single short word turns "Bacon
 * bits" into a match for every bacon deal in the ad, so a match needs either a
 * multi-word overlap or one distinctive word of five characters or more.
 */
export function matchDealsToCatalog(feed, catalog, manualDeals = []) {
  const deals = allDeals(feed, manualDeals);
  if (!deals.length || !catalog.length) return [];

  // Item name only: including the subcategory made every item in "Pasta &
  // Sauces" match any deal with the word "pasta" in it.
  const indexed = catalog.map((item) => ({
    item,
    words: new Set(contentWords(item.name)),
  }));

  const matches = [];
  const seen = new Set();

  for (const deal of deals) {
    const dealWords = new Set(contentWords(`${deal.title} ${deal.brand ?? ''}`));
    if (!dealWords.size) continue;

    for (const { item, words } of indexed) {
      const shared = [...words].filter((w) => dealWords.has(w));
      if (!shared.length) continue;

      const strong = shared.some((w) => w.length >= 5 && !WEAK_ALONE.has(w));
      if (shared.length < 2 && !strong) continue;

      const key = `${item.id}::${deal.id ?? deal.title}`;
      if (seen.has(key)) continue;
      seen.add(key);

      matches.push({
        item,
        deal,
        score: shared.length * 10 + Math.max(...shared.map((w) => w.length)),
        shared,
      });
    }
  }

  // Keep only the best deal per catalog item so the list stays readable.
  const best = new Map();
  for (const m of matches.sort((a, b) => b.score - a.score)) {
    if (!best.has(m.item.id)) best.set(m.item.id, m);
  }
  return [...best.values()];
}
