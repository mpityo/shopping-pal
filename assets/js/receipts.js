/**
 * Receipt parsing and line matching.
 *
 * Receipts are messy in predictable ways, so the parser is deliberately
 * format-agnostic rather than templated per store: find the money amount at
 * the end of a line, treat what precedes it as the item, and throw away the
 * furniture (totals, tax, tender, store numbers). That survives both Publix's
 * plain "NAME    3.99" and Walmart's "NAME  007874203877  F   2.48 O", and it
 * degrades gracefully on OCR output where a stray character lands mid-line.
 *
 * Money is handled in integer cents throughout. Summing dollars as floats
 * drifts, and a receipt importer that cannot reproduce its own total is not
 * worth having.
 */
import { normalize, matchScore } from './util.js';

/** Lines that are receipt furniture rather than things you bought. */
const NOT_AN_ITEM =
  /^(?:order|grand|store|purchase|net)?\s*(sub\s*total|total\b|balance|tax\b|sales\s+tax|change\b|tender|cash\b|debit|credit|visa|mastercard|amex|discover|ebt|savings|you\s+saved|total\s+savings|coupon|items?\s+sold|# ?items|ref\s*#|st\s*#|op\s*#|te\s*#|tr\s*#|aid\b|approval|auth\b|account|card\b|thank\s+you|survey|manager|store\s+\d|www\.|tel\b|phone|receipt|order\s+#|terminal)/i;

/** A trailing money amount, optionally negative or flagged. */
const TRAILING_MONEY = /(-?)\$?\s*(\d{1,4}\.\d{2})\s*[A-Z]?\s*$/;

/** "2 @ 1.99" or "1.48 lb @ 0.58 /lb" — belongs to the line above. */
const QTY_LINE = /^\s*(\d+(?:\.\d+)?)\s*(?:lb|kg|oz|ea)?\s*@\s*\$?\s*(\d+(?:\.\d+)?)/i;

const DATE_PATTERNS = [
  /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
  /\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/,
  /\b(\d{4})-(\d{2})-(\d{2})\b/,
];

export function toCents(text) {
  const n = Math.round(Number.parseFloat(text) * 100);
  return Number.isFinite(n) ? n : null;
}

export function formatMoney(cents) {
  if (cents == null) return '';
  return `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function detectStore(text) {
  if (/\bpublix\b/i.test(text)) return 'Publix';
  if (/\bwal[\s-]?mart\b/i.test(text)) return 'Walmart';
  if (/\btarget\b/i.test(text)) return 'Target';
  if (/\baldi\b/i.test(text)) return 'Aldi';
  if (/\bcostco\b/i.test(text)) return 'Costco';
  return null;
}

function detectDate(text) {
  for (const pattern of DATE_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    let [, a, b, c] = m;
    if (pattern === DATE_PATTERNS[2]) return `${a}-${b}-${c}`;
    let year = Number(c);
    if (year < 100) year += 2000;
    const month = String(Number(a)).padStart(2, '0');
    const day = String(Number(b)).padStart(2, '0');
    const iso = `${year}-${month}-${day}`;
    // Reject nonsense so a phone number never becomes a trip date.
    if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31) {
      return iso;
    }
  }
  return null;
}

function detectTotal(text) {
  const lines = text.split(/\r?\n/);
  let best = null;
  for (const line of lines) {
    if (!/(grand\s+total|^\s*total\b|order\s+total|balance\s+due)/i.test(line)) continue;
    if (/sub\s*total/i.test(line)) continue;
    const m = TRAILING_MONEY.exec(line);
    if (m) best = toCents(m[2]);
  }
  return best;
}

/**
 * Strip the codes receipts pack around the product name: UPCs, tax flags,
 * quantity prefixes and the single-letter markers Walmart appends.
 */
function cleanName(raw) {
  let name = raw
    .replace(/\b\d{9,14}\b/g, ' ')
    .replace(/\s+[A-Z]\s*$/, ' ')
    .replace(/^\s*\d+\s+(?=[A-Za-z])/, '')
    .replace(/[*#]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Receipts shout; sentence case is easier to scan in the review table.
  if (name === name.toUpperCase() && /[A-Z]{3}/.test(name)) {
    name = name
      .toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  return name;
}

function detectTax(text) {
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*(sales\s+)?tax\b/i.test(line)) continue;
    const m = TRAILING_MONEY.exec(line);
    if (m) total += toCents(m[2]) ?? 0;
  }
  return total;
}

export function parseReceipt(text) {
  const rawLines = String(text ?? '').split(/\r?\n/);
  const lines = [];
  let skipped = 0;
  let discountCents = 0;

  for (const rawLine of rawLines) {
    const line = rawLine.replace(/\t/g, '  ').trimEnd();
    if (!line.trim()) continue;

    // A quantity/unit-price line refines the item above it.
    const qty = QTY_LINE.exec(line);
    if (qty && lines.length) {
      const previous = lines[lines.length - 1];
      const count = Number.parseFloat(qty[1]);
      if (Number.isFinite(count) && count > 0 && count < 100 && Number.isInteger(count)) {
        previous.qty = count;
      }
      continue;
    }

    if (NOT_AN_ITEM.test(line.trim())) {
      skipped++;
      continue;
    }

    const money = TRAILING_MONEY.exec(line);
    if (!money) {
      skipped++;
      continue;
    }

    const priceCents = toCents(money[2]) * (money[1] === '-' ? -1 : 1);
    const name = cleanName(line.slice(0, money.index));

    // Discounts and coupons come through as negatives. They are not items,
    // but they are needed to reconcile the lines against the printed total.
    if (priceCents < 0) {
      discountCents += -priceCents;
      continue;
    }
    if (priceCents === 0 || !name || name.length < 2) {
      skipped++;
      continue;
    }
    // A bare number with no name is a stray OCR artefact.
    if (!/[a-z]/i.test(name)) {
      skipped++;
      continue;
    }

    lines.push({ raw: line.trim(), name, qty: 1, priceCents });
  }

  const itemsCents = lines.reduce((sum, l) => sum + l.priceCents, 0);
  const taxCents = detectTax(text);
  const totalCents = detectTotal(text);

  return {
    store: detectStore(text),
    date: detectDate(text),
    totalCents,
    taxCents,
    discountCents,
    itemsCents,
    lines,
    skipped,
    /**
     * Whether the parsed lines add up to the printed total. A clean
     * reconciliation is the strongest signal that nothing was missed or
     * double-counted, and it is worth showing before anything is imported.
     */
    reconciles:
      totalCents == null ? null : itemsCents - discountCents + taxCents === totalCents,
  };
}

// ── Matching receipt lines to catalog items ──────────────────────────────

export function aliasKey(name) {
  return normalize(name);
}

/**
 * Suggest a catalog item for each parsed line.
 *
 * A remembered alias always wins: receipt abbreviations ("GV SHRD MOZZ") are
 * never going to fuzzy-match well, so the point of the review step is to teach
 * the mapping once and have it stick.
 */
export function matchLines(lines, catalog, aliases = {}) {
  return lines.map((line) => {
    const key = aliasKey(line.name);
    const aliasId = aliases[key];
    if (aliasId && catalog.some((i) => i.id === aliasId)) {
      return { line, itemId: aliasId, confidence: 'alias', candidates: [] };
    }

    const scored = catalog
      .map((item) => ({
        item,
        score: Math.max(
          matchScore(item.name, line.name),
          matchScore(line.name, item.name),
        ),
      }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    const [top, runnerUp] = scored;
    // Only auto-select when the winner is both strong and clearly ahead:
    // "Corn Tortilla Chips" should not silently pick Corn over Corn tortillas.
    const decisive = top && (!runnerUp || top.score - runnerUp.score >= 15);
    const confidence = !top
      ? 'none'
      : top.score >= 60 && decisive
        ? 'high'
        : top.score >= 35
          ? 'low'
          : 'none';
    return {
      line,
      itemId: confidence === 'high' ? top.item.id : null,
      confidence,
      candidates: scored.map((c) => c.item),
    };
  });
}

/**
 * A stable identifier for a receipt.
 *
 * Sharing the same PDF twice — easy to do from a phone — must not double the
 * trip. Store, date, printed total and the item lines together identify a
 * shopping run precisely enough: two genuine visits to the same shop on the
 * same day would have to ring up an identical basket to collide.
 */
export function receiptFingerprint(parsed) {
  const lines = parsed.lines
    .map((l) => `${normalize(l.name)}:${l.priceCents}:${l.qty}`)
    .sort()
    .join('|');
  return [
    parsed.store ?? 'unknown',
    parsed.date ?? 'undated',
    parsed.totalCents ?? 'nototal',
    parsed.lines.length,
    hash(lines),
  ].join('/');
}

/** Small non-cryptographic hash; this only needs to detect accidental repeats. */
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Flag lines that already appear in the trip being appended to.
 *
 * Same item, same store, same price is treated as the same purchase rather
 * than a second one — the common case is re-importing a receipt, not buying
 * two identical things at identical prices and having them ring up separately.
 */
export function markDuplicates(rows, existingLines) {
  const seen = new Map();
  for (const line of existingLines ?? []) {
    const key = `${line.id}:${line.store ?? ''}:${line.priceCents ?? ''}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return rows.map((row) => {
    if (!row.itemId) return { ...row, duplicate: false };
    const key = `${row.itemId}:${row.store ?? ''}:${row.line.priceCents}`;
    const remaining = seen.get(key) ?? 0;
    if (remaining > 0) {
      seen.set(key, remaining - 1);
      return { ...row, duplicate: true };
    }
    return { ...row, duplicate: false };
  });
}

export function sumCents(lines) {
  return lines.reduce((total, l) => total + (l.priceCents ?? 0) * 1, 0);
}
