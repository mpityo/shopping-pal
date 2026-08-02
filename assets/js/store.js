/**
 * All application state, persisted to localStorage.
 *
 * The seed catalog ships with the site and is never written to. User changes
 * are stored as a thin layer on top of it (overrides / customs / archived),
 * so a site update can add or fix seed items without clobbering edits.
 */
import { CATALOG, DEFAULT_PEOPLE } from './data/catalog.js';
import { DEPARTMENTS } from './data/departments.js';
import { normalize } from './util.js';

const KEY = 'shopping-pal.v1';
const listeners = new Set();

const defaultState = () => ({
  version: 1,
  /** id -> { qty, note, checked, addedAt, updatedAt } */
  list: {},
  /** id -> timestamp, so a removal on one phone is not undone by another */
  listRemoved: {},
  /** trip ids deleted locally, for the same reason */
  tripsRemoved: [],
  /** id -> { name?, dept?, note?, favorite? } */
  overrides: {},
  /** user-created catalog items */
  customs: [],
  /** seed ids the user removed from the catalog */
  archived: [],
  /** id -> { aisle?, name?, order? } */
  deptOverrides: {},
  /** completed shopping trips, oldest first */
  trips: [],
  /** manually entered deals, for when the Publix feed is unavailable */
  manualDeals: [],
  /** receipt text -> catalog item id, taught once in the import review */
  aliases: {},
  /** fingerprint -> { date, store, at }, so the same receipt is not imported twice */
  importedReceipts: {},
  /**
   * Receipt lines left out of an import because nothing in the catalog was
   * them. Keyed by normalized wording -> { name, seen: [{ date, store,
   * priceCents, qty }] }. Kept because buying something three times in a month
   * that the catalog has never heard of is exactly the signal worth surfacing,
   * and the purchases can be backfilled once it is adopted.
   */
  unmatched: {},
  /** Keys explicitly dismissed, so "no thanks" is not asked again. */
  unmatchedIgnored: [],
  /** household members, named in the app rather than in code */
  people: DEFAULT_PEOPLE.map((p) => ({ ...p })),
  peopleUpdatedAt: 0,
  prefs: {
    groupBy: 'dept',
    hideChecked: false,
    person: 'all',
    /**
     * Suggestions start folded away. They sat between the search box and the
     * list, so on a phone the list itself started below the fold — the one
     * thing the page exists to show. Opening them is one tap and the choice
     * sticks.
     */
    suggestionsOpen: false,
    theme: 'auto',
    lastSeenDeals: null,
    /**
     * Claude assistance, per device. Flat keys rather than a nested object so
     * they merge with the defaults on load. These only matter when a key has
     * been added in Setup; without one every feature is simply absent.
     */
    aiMatch: true,
    aiDept: true,
  },
});

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return {
      ...defaultState(),
      ...parsed,
      prefs: { ...defaultState().prefs, ...(parsed.prefs || {}) },
    };
  } catch {
    return defaultState();
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Could not save to localStorage', err);
  }
}

function emit() {
  persist();
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState() {
  return state;
}

// ── Derived data ─────────────────────────────────────────────────────────

/** The catalog the user actually sees: seed + customs, with overrides applied. */
export function items() {
  const archived = new Set(state.archived);
  const base = CATALOG.filter((i) => !archived.has(i.id));
  return [...base, ...state.customs].map((item) => ({
    ...item,
    ...(state.overrides[item.id] || {}),
  }));
}

export function itemById(id) {
  return items().find((i) => i.id === id) ?? null;
}

export function departments() {
  return DEPARTMENTS.map((d) => ({ ...d, ...(state.deptOverrides[d.id] || {}) }))
    .sort((a, b) => a.order - b.order);
}

/** Items currently on the shopping list, in the order the store is walked. */
export function listEntries() {
  const byId = new Map(items().map((i) => [i.id, i]));
  const order = new Map(departments().map((d, idx) => [d.id, idx]));
  return Object.entries(state.list)
    .map(([id, entry]) => {
      const item = byId.get(id);
      if (!item) return null;
      // The catalog note ("2 bunches") is the default until one is typed in
      // for this week, so it must not be clobbered by the entry's empty note.
      return { ...item, ...entry, id, note: entry.note || item.note || '' };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const da = order.get(a.dept) ?? 999;
      const db = order.get(b.dept) ?? 999;
      if (da !== db) return da - db;
      return a.name.localeCompare(b.name);
    });
}

export function listCount() {
  return Object.keys(state.list).length;
}

export function checkedCount() {
  return Object.values(state.list).filter((e) => e.checked).length;
}

// ── List actions ─────────────────────────────────────────────────────────

export function addToList(id, patch = {}) {
  const now = Date.now();
  if (state.list[id]) {
    state.list[id] = { ...state.list[id], ...patch, updatedAt: now };
  } else {
    state.list[id] = {
      qty: 1,
      note: '',
      checked: false,
      addedAt: now,
      ...patch,
      updatedAt: now,
    };
  }
  delete state.listRemoved[id];
  emit();
}

export function removeFromList(id) {
  delete state.list[id];
  state.listRemoved[id] = Date.now();
  emit();
}

export function toggleOnList(id) {
  if (state.list[id]) removeFromList(id);
  else addToList(id);
}

export function toggleChecked(id) {
  const entry = state.list[id];
  if (!entry) return;
  entry.checked = !entry.checked;
  entry.updatedAt = Date.now();
  emit();
}

export function setQty(id, qty) {
  const entry = state.list[id];
  if (!entry) return;
  entry.qty = Math.max(1, Math.min(99, qty));
  entry.updatedAt = Date.now();
  emit();
}

export function setEntryNote(id, note) {
  const entry = state.list[id];
  if (!entry) return;
  entry.note = note;
  entry.updatedAt = Date.now();
  emit();
}

export function uncheckAll() {
  const now = Date.now();
  for (const entry of Object.values(state.list)) {
    entry.checked = false;
    entry.updatedAt = now;
  }
  emit();
}

export function clearList() {
  const now = Date.now();
  for (const id of Object.keys(state.list)) state.listRemoved[id] = now;
  state.list = {};
  emit();
}

/**
 * Archive the checked items as a completed trip. That history is the only
 * source for every trend in Insights, so unchecked items are left on the list
 * rather than silently recorded as bought.
 */
export function finishTrip(date = new Date()) {
  const bought = listEntries().filter((e) => e.checked);
  if (!bought.length) return null;
  const trip = {
    id: `trip-${date.getTime()}`,
    date: date.toISOString().slice(0, 10),
    items: bought.map((e) => ({
      id: e.id,
      name: e.name,
      qty: e.qty ?? 1,
      dept: e.dept,
    })),
  };
  state.trips.push(trip);
  state.trips.sort((a, b) => a.date.localeCompare(b.date));
  const now = Date.now();
  for (const e of bought) {
    delete state.list[e.id];
    state.listRemoved[e.id] = now;
  }
  emit();
  return trip;
}

/** Record a trip that already happened, entered from memory. */
export function addTrip({ date, itemIds }) {
  const byId = new Map(items().map((i) => [i.id, i]));
  const lines = itemIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((item) => ({ id: item.id, name: item.name, qty: 1, dept: item.dept }));
  if (!lines.length) return null;

  const trip = {
    id: `trip-${date}-${Math.random().toString(36).slice(2, 7)}`,
    date,
    items: lines,
  };
  state.trips.push(trip);
  state.trips.sort((a, b) => a.date.localeCompare(b.date));
  emit();
  return trip;
}

/**
 * Fold a parsed receipt into the trip history.
 *
 * Trips are keyed by date rather than by receipt, because a single shopping
 * trip routinely spans two stores — the Publix receipt and the Walmart one
 * belong to the same outing. Importing a second receipt for a date that
 * already has a trip merges into it and records both stores, rather than
 * inventing a second trip that would halve the apparent trip size.
 */
/** The lines already recorded for a date, so an import can spot repeats. */
export function tripLinesOn(date) {
  return state.trips.find((t) => t.date === date)?.items ?? [];
}

export function receiptAlreadyImported(fingerprint) {
  return state.importedReceipts[fingerprint] ?? null;
}

export function importReceipt({ date, store, lines, totalCents = null, fingerprint = null }) {
  if (!date || !lines?.length) return null;
  const byId = new Map(items().map((i) => [i.id, i]));

  const bought = lines
    .map((line) => {
      const item = byId.get(line.itemId);
      if (!item) return null;
      return {
        id: item.id,
        name: item.name,
        qty: line.qty ?? 1,
        dept: item.dept,
        priceCents: line.priceCents ?? null,
        store: store || null,
      };
    })
    .filter(Boolean);
  if (!bought.length) return null;

  let trip = state.trips.find((t) => t.date === date);
  if (!trip) {
    trip = { id: `trip-${date}-${Math.random().toString(36).slice(2, 7)}`, date, items: [] };
    state.trips.push(trip);
  }

  for (const line of bought) {
    // An item checked off the list carries no price. The receipt is telling us
    // what that same purchase cost, so fill it in rather than recording the
    // thing twice — this is the shop-with-the-list-then-share-the-receipt path.
    const unpriced = trip.items.find((i) => i.id === line.id && i.priceCents == null);
    if (unpriced) {
      unpriced.priceCents = line.priceCents;
      unpriced.store = line.store;
      // The receipt is the authoritative record of how many were bought.
      unpriced.qty = line.qty;
    } else {
      trip.items.push(line);
    }
  }

  trip.stores = [...new Set(trip.items.map((i) => i.store).filter(Boolean))];
  if (totalCents != null) {
    trip.totalsByStore = { ...(trip.totalsByStore || {}), [store || 'Unknown']: totalCents };
    trip.totalCents = Object.values(trip.totalsByStore).reduce((a, b) => a + b, 0);
  }

  if (fingerprint) {
    state.importedReceipts[fingerprint] = {
      date,
      store: store || null,
      at: new Date().toISOString(),
    };
  }

  state.trips.sort((a, b) => a.date.localeCompare(b.date));
  emit();
  return trip;
}

// ── Bought, but not in the catalog ───────────────────────────────────────

/**
 * Remember a receipt line that was left out because nothing matched it.
 *
 * Dropping these silently is how "we've started buying Gatorade Zero" stays
 * invisible: the purchase never reaches a trip, so no trend can ever notice
 * it. Recording the sighting costs nothing and makes the pattern visible after
 * the second or third receipt.
 */
export function noteUnmatched(entries) {
  let changed = 0;
  for (const entry of entries) {
    const key = normalize(entry.name);
    if (!key || state.unmatchedIgnored.includes(key)) continue;
    const record = state.unmatched[key] ?? { name: entry.name, seen: [] };
    // One sighting per receipt date and store, so re-importing the same
    // receipt cannot inflate the count into a false pattern.
    const already = record.seen.some(
      (s) => s.date === entry.date && (s.store ?? null) === (entry.store ?? null),
    );
    if (already) continue;
    record.name = entry.name;
    record.seen.push({
      date: entry.date,
      store: entry.store ?? null,
      priceCents: entry.priceCents ?? null,
      qty: entry.qty ?? 1,
    });
    record.seen.sort((a, b) => a.date.localeCompare(b.date));
    state.unmatched[key] = record;
    changed++;
  }
  if (changed) emit();
  return changed;
}

/** What has been bought more than once without ever being in the catalog. */
export function unmatchedRepeats(minTimes = 2) {
  return Object.entries(state.unmatched)
    .map(([key, record]) => ({
      key,
      name: record.name,
      count: record.seen.length,
      first: record.seen[0]?.date,
      last: record.seen[record.seen.length - 1]?.date,
      seen: record.seen,
    }))
    .filter((r) => r.count >= minTimes)
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
}

export function ignoreUnmatched(key) {
  delete state.unmatched[key];
  if (!state.unmatchedIgnored.includes(key)) state.unmatchedIgnored.push(key);
  emit();
}

/**
 * Take an uncatalogued purchase into the catalog, and give it its history.
 *
 * Adding the item alone would only fix the future. The past sightings are
 * already known — date, store, price — and the trips they belong to already
 * exist, so backfilling them is what makes "bought three times this month"
 * true in the trends rather than merely remembered here. Without this, a newly
 * adopted item looks brand new and its cadence starts from nothing.
 */
export function adoptUnmatched(key, itemId) {
  const record = state.unmatched[key];
  const item = items().find((i) => i.id === itemId);
  if (!record || !item) return 0;

  let backfilled = 0;
  for (const sighting of record.seen) {
    const trip = state.trips.find((t) => t.date === sighting.date);
    if (!trip) continue;
    // The trip may already have it if the user matched a later receipt by
    // hand before adopting this one.
    const duplicate = trip.items.some(
      (i) =>
        i.id === itemId &&
        i.priceCents === sighting.priceCents &&
        (i.store ?? null) === (sighting.store ?? null),
    );
    if (duplicate) continue;
    trip.items.push({
      id: item.id,
      name: item.name,
      qty: sighting.qty ?? 1,
      dept: item.dept,
      priceCents: sighting.priceCents ?? null,
      store: sighting.store ?? null,
    });
    backfilled++;
  }

  state.aliases[key] = itemId;
  delete state.unmatched[key];
  emit();
  return backfilled;
}

/** Remember what a receipt's wording maps to, so the next one is automatic. */
export function learnAliases(map) {
  let learned = 0;
  for (const [key, itemId] of Object.entries(map)) {
    if (!key || !itemId) continue;
    if (state.aliases[key] === itemId) continue;
    state.aliases[key] = itemId;
    learned++;
  }
  if (learned) emit();
  return learned;
}

export function forgetAlias(key) {
  delete state.aliases[key];
  emit();
}

export function deleteTrip(id) {
  state.trips = state.trips.filter((t) => t.id !== id);
  if (!state.tripsRemoved.includes(id)) state.tripsRemoved.push(id);
  emit();
}

// ── Catalog actions ──────────────────────────────────────────────────────

export function addCustomItem({ name, dept, section, sub, note, person }) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  let id = base || `item-${Date.now()}`;
  const existing = new Set(items().map((i) => i.id));
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;

  state.customs.push({
    id,
    name: name.trim(),
    section: section || 'Added by us',
    sub: sub || 'Added by us',
    dept: dept || 'other',
    note: note || '',
    person: person || null,
    seed: false,
  });
  emit();
  return id;
}

export function updateItem(id, patch) {
  const custom = state.customs.find((c) => c.id === id);
  if (custom) Object.assign(custom, patch);
  else state.overrides[id] = { ...(state.overrides[id] || {}), ...patch };
  emit();
}

export function archiveItem(id) {
  const idx = state.customs.findIndex((c) => c.id === id);
  if (idx >= 0) state.customs.splice(idx, 1);
  else if (!state.archived.includes(id)) state.archived.push(id);
  delete state.list[id];
  emit();
}

export function restoreArchived() {
  state.archived = [];
  emit();
}

export function toggleFavorite(id) {
  const item = itemById(id);
  if (!item) return;
  updateItem(id, { favorite: !item.favorite });
}

export function setDepartment(deptId, patch) {
  state.deptOverrides[deptId] = {
    ...(state.deptOverrides[deptId] || {}),
    ...patch,
  };
  emit();
}

export function resetDepartments() {
  state.deptOverrides = {};
  emit();
}

// ── Household ────────────────────────────────────────────────────────────

export function people() {
  return state.people;
}

export function personName(id) {
  return state.people.find((p) => p.id === id)?.name ?? null;
}

/** True once the placeholder names have been replaced with real ones. */
export function householdNamed() {
  return !state.people.some((p) => /^Person \d+$/.test(p.name));
}

export function addPerson(name) {
  const trimmed = name.trim();
  if (!trimmed) return null;
  let n = state.people.length + 1;
  let id = `p${n}`;
  const taken = new Set(state.people.map((p) => p.id));
  while (taken.has(id)) id = `p${++n}`;
  state.people.push({ id, name: trimmed });
  state.peopleUpdatedAt = Date.now();
  emit();
  return id;
}

export function renamePerson(id, name) {
  const person = state.people.find((p) => p.id === id);
  if (!person || !name.trim()) return;
  person.name = name.trim();
  state.peopleUpdatedAt = Date.now();
  emit();
}

/** Removing someone untags their items rather than deleting them. */
export function removePerson(id) {
  state.people = state.people.filter((p) => p.id !== id);
  for (const custom of state.customs) {
    if (custom.person === id) custom.person = null;
  }
  for (const item of CATALOG) {
    const current = state.overrides[item.id]?.person ?? item.person;
    if (current === id) {
      state.overrides[item.id] = { ...(state.overrides[item.id] || {}), person: null };
    }
  }
  if (state.prefs.person === id) state.prefs.person = 'all';
  state.peopleUpdatedAt = Date.now();
  emit();
}

// ── Deals ────────────────────────────────────────────────────────────────

export function addManualDeal(deal) {
  state.manualDeals.push({
    id: `manual-${Date.now()}`,
    added: new Date().toISOString().slice(0, 10),
    ...deal,
  });
  emit();
}

export function removeManualDeal(id) {
  state.manualDeals = state.manualDeals.filter((d) => d.id !== id);
  emit();
}

// ── Prefs & data management ──────────────────────────────────────────────

export function setPref(key, value) {
  state.prefs[key] = value;
  emit();
}

export function exportData() {
  return JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
}

export function importData(json, { merge = false } = {}) {
  const incoming = JSON.parse(json);
  if (typeof incoming !== 'object' || incoming === null) {
    throw new Error('That file does not look like a Shopping Pal backup.');
  }
  if (merge) {
    const seen = new Set(state.trips.map((t) => t.id));
    const trips = [
      ...state.trips,
      ...(incoming.trips || []).filter((t) => !seen.has(t.id)),
    ].sort((a, b) => a.date.localeCompare(b.date));
    state = {
      ...state,
      ...incoming,
      list: { ...state.list, ...(incoming.list || {}) },
      overrides: { ...state.overrides, ...(incoming.overrides || {}) },
      customs: [...state.customs, ...(incoming.customs || [])].filter(
        (c, i, arr) => arr.findIndex((o) => o.id === c.id) === i,
      ),
      trips,
      prefs: { ...state.prefs, ...(incoming.prefs || {}) },
    };
  } else {
    state = { ...defaultState(), ...incoming };
  }
  emit();
}

export function resetEverything() {
  state = defaultState();
  emit();
}

// ── Shared-vault sync ────────────────────────────────────────────────────

/** The fields that belong to the household rather than to this device. */
const SHARED_FIELDS = [
  'list',
  'listRemoved',
  'tripsRemoved',
  'overrides',
  'customs',
  'archived',
  'deptOverrides',
  'trips',
  'manualDeals',
  'aliases',
  'importedReceipts',
  'unmatched',
  'unmatchedIgnored',
  'people',
  'peopleUpdatedAt',
];

export function sharedSnapshot() {
  return Object.fromEntries(SHARED_FIELDS.map((key) => [key, state[key]]));
}

/**
 * Merge a snapshot pulled from the shared vault into local state.
 *
 * Two people can be adding to the list in different aisles, so this is not a
 * blind overwrite in either direction:
 *   - list entries: whichever side touched an item most recently wins
 *   - removals: a tombstone newer than the entry keeps the item deleted
 *   - trips / customs: unioned by id, since they are append-only in practice
 *   - people: whole array from whichever side edited it last
 *   - overrides: shallow-merged, local winning on a genuine conflict
 * `prefs` is deliberately excluded — group-by and filters stay per device.
 */
export function mergeShared(remote) {
  if (!remote || typeof remote !== 'object') return;

  const listRemoved = { ...(remote.listRemoved || {}), ...state.listRemoved };
  for (const [id, ts] of Object.entries(remote.listRemoved || {})) {
    listRemoved[id] = Math.max(ts, state.listRemoved[id] ?? 0);
  }

  const list = {};
  const ids = new Set([...Object.keys(state.list), ...Object.keys(remote.list || {})]);
  for (const id of ids) {
    const mine = state.list[id];
    const theirs = remote.list?.[id];
    const winner =
      !mine ? theirs
      : !theirs ? mine
      : (theirs.updatedAt ?? theirs.addedAt ?? 0) > (mine.updatedAt ?? mine.addedAt ?? 0)
        ? theirs
        : mine;
    if (!winner) continue;
    // A removal only sticks if it happened after the surviving edit.
    const removedAt = listRemoved[id] ?? 0;
    if (removedAt > (winner.updatedAt ?? winner.addedAt ?? 0)) continue;
    list[id] = winner;
  }

  const tripsRemoved = [...new Set([...state.tripsRemoved, ...(remote.tripsRemoved || [])])];
  const tripsById = new Map();
  for (const trip of [...(remote.trips || []), ...state.trips]) tripsById.set(trip.id, trip);
  const trips = [...tripsById.values()]
    .filter((t) => !tripsRemoved.includes(t.id))
    .sort((a, b) => a.date.localeCompare(b.date));

  const customsById = new Map();
  for (const c of [...(remote.customs || []), ...state.customs]) customsById.set(c.id, c);

  const dealsById = new Map();
  for (const d of [...(remote.manualDeals || []), ...state.manualDeals]) dealsById.set(d.id, d);

  const remotePeopleNewer = (remote.peopleUpdatedAt ?? 0) > (state.peopleUpdatedAt ?? 0);

  // Uncatalogued sightings are per-purchase facts, so both phones' lists are
  // kept and the sightings unioned by date and store — two people importing
  // the two halves of one trip should add up, not overwrite each other. A
  // dismissal on either phone wins, and adoption on either removes the entry.
  const unmatchedIgnored = [
    ...new Set([...(remote.unmatchedIgnored || []), ...state.unmatchedIgnored]),
  ];
  const adopted = new Set(Object.keys({ ...(remote.aliases || {}), ...state.aliases }));
  const unmatched = {};
  for (const key of new Set([
    ...Object.keys(remote.unmatched || {}),
    ...Object.keys(state.unmatched),
  ])) {
    if (unmatchedIgnored.includes(key) || adopted.has(key)) continue;
    const merged = new Map();
    for (const sighting of [
      ...(remote.unmatched?.[key]?.seen ?? []),
      ...(state.unmatched[key]?.seen ?? []),
    ]) {
      merged.set(`${sighting.date}|${sighting.store ?? ''}`, sighting);
    }
    unmatched[key] = {
      name: state.unmatched[key]?.name ?? remote.unmatched[key].name,
      seen: [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  state = {
    ...state,
    list,
    listRemoved: pruneTombstones(listRemoved),
    tripsRemoved,
    trips,
    customs: [...customsById.values()],
    aliases: { ...(remote.aliases || {}), ...state.aliases },
    importedReceipts: { ...(remote.importedReceipts || {}), ...state.importedReceipts },
    unmatched,
    unmatchedIgnored,
    manualDeals: [...dealsById.values()],
    archived: [...new Set([...(remote.archived || []), ...state.archived])],
    overrides: { ...(remote.overrides || {}), ...state.overrides },
    deptOverrides: { ...(remote.deptOverrides || {}), ...state.deptOverrides },
    people: remotePeopleNewer ? remote.people : state.people,
    peopleUpdatedAt: Math.max(remote.peopleUpdatedAt ?? 0, state.peopleUpdatedAt ?? 0),
  };
  emit();
}

/** Tombstones only need to outlive the sync window; 30 days is generous. */
function pruneTombstones(removed) {
  const cutoff = Date.now() - 30 * 86_400_000;
  return Object.fromEntries(Object.entries(removed).filter(([, ts]) => ts > cutoff));
}

// ── Sharing ──────────────────────────────────────────────────────────────

/** Pack the current list into a URL-safe string so it can be texted over. */
export function encodeList() {
  const payload = listEntries().map((e) => [e.id, e.qty ?? 1, e.note || '']);
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeAndApplyList(encoded) {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const payload = JSON.parse(new TextDecoder().decode(bytes));
  const known = new Set(items().map((i) => i.id));
  let applied = 0;
  for (const [id, qty, note] of payload) {
    if (!known.has(id)) continue;
    state.list[id] = {
      qty: qty || 1,
      note: note || '',
      checked: false,
      addedAt: Date.now(),
    };
    applied++;
  }
  emit();
  return { applied, total: payload.length };
}
