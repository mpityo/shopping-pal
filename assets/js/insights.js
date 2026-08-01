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
