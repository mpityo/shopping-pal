/**
 * Trend maths. Everything here is derived from completed trips — no trips,
 * no numbers, and the views say so rather than inventing a baseline.
 */

const DAY = 86_400_000;

export function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / DAY);
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Per-item purchase history.
 * `cadence` is the mean gap in days between the trips that included the item,
 * and needs at least two purchases before it means anything.
 */
export function itemStats(trips) {
  const stats = new Map();

  for (const trip of trips) {
    for (const line of trip.items) {
      let s = stats.get(line.id);
      if (!s) {
        s = { id: line.id, name: line.name, dept: line.dept, dates: [], qty: 0 };
        stats.set(line.id, s);
      }
      s.dates.push(trip.date);
      s.qty += line.qty ?? 1;
      s.name = line.name;
      s.dept = line.dept;
    }
  }

  const now = today();
  for (const s of stats.values()) {
    s.dates.sort();
    s.count = s.dates.length;
    s.first = s.dates[0];
    s.last = s.dates[s.dates.length - 1];
    s.daysSince = daysBetween(s.last, now);

    if (s.count >= 2) {
      let total = 0;
      for (let i = 1; i < s.dates.length; i++) {
        total += daysBetween(s.dates[i - 1], s.dates[i]);
      }
      s.cadence = Math.max(1, Math.round(total / (s.count - 1)));
      s.dueRatio = s.daysSince / s.cadence;
      s.dueInDays = s.cadence - s.daysSince;
    } else {
      s.cadence = null;
      s.dueRatio = null;
      s.dueInDays = null;
    }
  }

  return stats;
}

export function topItems(trips, limit = 12) {
  return [...itemStats(trips).values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Items whose usual gap has elapsed and that are not already on the list.
 * Sorted by how far past due they are.
 */
export function dueItems(trips, listIds, limit = 20) {
  return [...itemStats(trips).values()]
    .filter((s) => s.cadence !== null && s.dueRatio >= 0.85 && !listIds.has(s.id))
    .sort((a, b) => b.dueRatio - a.dueRatio)
    .slice(0, limit);
}

export function tripSeries(trips) {
  return trips.map((t) => ({
    date: t.date,
    label: formatShortDate(t.date),
    count: t.items.length,
    units: t.items.reduce((n, i) => n + (i.qty ?? 1), 0),
  }));
}

export function departmentTotals(trips) {
  const totals = new Map();
  for (const trip of trips) {
    for (const line of trip.items) {
      totals.set(line.dept, (totals.get(line.dept) ?? 0) + 1);
    }
  }
  return totals;
}

/** Mean days between shopping trips — the household's shopping rhythm. */
export function tripCadence(trips) {
  if (trips.length < 2) return null;
  let total = 0;
  for (let i = 1; i < trips.length; i++) {
    total += daysBetween(trips[i - 1].date, trips[i].date);
  }
  return Math.round(total / (trips.length - 1));
}

/** Items bought exactly once, a while ago — candidates for pruning. */
export function oneOffItems(trips, minDays = 60) {
  return [...itemStats(trips).values()]
    .filter((s) => s.count === 1 && s.daysSince >= minDays)
    .sort((a, b) => b.daysSince - a.daysSince);
}

export function neverBought(trips, catalog) {
  const seen = itemStats(trips);
  return catalog.filter((i) => !seen.has(i.id));
}

// ── Spend ────────────────────────────────────────────────────────────────

/**
 * Spend figures, in integer cents.
 *
 * Only trips imported from receipts carry prices, so everything here reports
 * how much of the history it is actually based on. A spend chart drawn from
 * two of twenty trips would be worse than no chart at all.
 */
export function spendSummary(trips) {
  const priced = trips.filter(
    (t) => t.totalCents != null || t.items.some((i) => i.priceCents != null),
  );

  // Two different numbers live here and must not be conflated. What you paid
  // is the printed total: it includes tax and is net of savings. Line prices
  // are the only thing that can be broken down by department, but they sum to
  // something else. Report the printed total as the headline, and label the
  // breakdowns for what they are.
  let paidCents = 0;
  const paidByStore = new Map();
  const lineByStore = new Map();
  const byDept = new Map();
  let lineCents = 0;
  let lines = 0;

  for (const trip of priced) {
    const printed = trip.totalCents;
    const totals = trip.totalsByStore;
    if (printed != null) paidCents += printed;

    if (totals) {
      for (const [name, cents] of Object.entries(totals)) {
        paidByStore.set(name, (paidByStore.get(name) ?? 0) + cents);
      }
    }

    for (const item of trip.items) {
      if (item.priceCents == null) continue;
      lineCents += item.priceCents;
      lines++;
      const storeKey = item.store ?? 'Unrecorded';
      lineByStore.set(storeKey, (lineByStore.get(storeKey) ?? 0) + item.priceCents);
      byDept.set(item.dept, (byDept.get(item.dept) ?? 0) + item.priceCents);
    }

    if (printed == null) paidCents += trip.items.reduce((s, i) => s + (i.priceCents ?? 0), 0);
  }

  const byStore = paidByStore.size ? paidByStore : lineByStore;

  return {
    hasPrices: lines > 0 || paidCents > 0,
    /** True when the headline figure is what the receipts actually charged. */
    fromPrintedTotals: paidByStore.size > 0,
    pricedTrips: priced.length,
    totalTrips: trips.length,
    totalCents: paidCents,
    lineCents,
    avgTripCents: priced.length ? Math.round(paidCents / priced.length) : 0,
    byStore: [...byStore.entries()].sort((a, b) => b[1] - a[1]),
    byDept: [...byDept.entries()].sort((a, b) => b[1] - a[1]),
    series: priced.map((t) => ({
      date: t.date,
      label: formatShortDate(t.date),
      cents: t.totalCents ?? t.items.reduce((sum, i) => sum + (i.priceCents ?? 0), 0),
    })),
  };
}

/** What an item has cost over time, for the "am I paying more?" question. */
export function priceHistory(trips, itemId) {
  const points = [];
  for (const trip of trips) {
    for (const item of trip.items) {
      if (item.id !== itemId || item.priceCents == null) continue;
      const qty = item.qty || 1;
      points.push({ date: trip.date, unitCents: Math.round(item.priceCents / qty), store: item.store });
    }
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

export function formatShortDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatLongDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function relativeDays(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}
