import { h, pluralize, modal, toast } from '../util.js';
import * as store from '../store.js';
import { departmentName } from '../data/departments.js';
import { openImporter, aliasManager } from './receipts.js';
import { formatMoney } from '../receipts.js';
import {
  spendSummary,
  itemStats,
  topItems,
  tripSeries,
  departmentTotals,
  tripCadence,
  oneOffItems,
  dueItems,
  neverBought,
  formatLongDate,
  formatShortDate,
  relativeDays,
} from '../insights.js';
import * as ai from '../ai.js';

let sort = { key: 'count', dir: 'desc' };
let tableFilter = '';

export function renderTrends(ctx) {
  const state = store.getState();
  const trips = state.trips;

  if (!trips.length) {
    return h(
      'div',
      {},
      head(0),
      h(
        'div',
        { class: 'empty' },
        h('h3', {}, 'No trips recorded yet'),
        h(
          'p',
          {},
          'Trends come from finished trips, so there is nothing to chart until you check items off and tap “Finish trip”. The quickest way to get real history is to import a few old receipts — that fills in what you bought, when, and what it cost.',
        ),
        h(
          'div',
          { class: 'btn-row', style: { justifyContent: 'center' } },
          h('button', { class: 'btn btn--primary', onClick: () => openImporter(ctx) }, 'Import a receipt'),
          h('button', { class: 'btn btn--ghost', onClick: () => backfill(ctx) }, 'Log a past trip'),
          h('button', { class: 'btn btn--ghost', onClick: () => ctx.go('list') }, 'Go to the list'),
        ),
      ),
    );
  }

  const stats = itemStats(trips);
  const series = tripSeries(trips);
  const allLines = trips.reduce((n, t) => n + t.items.length, 0);
  const cadence = tripCadence(trips);
  const lastTrip = trips[trips.length - 1];

  return h(
    'div',
    {},
    head(trips.length),

    h(
      'div',
      { class: 'stat-grid' },
      stat(trips.length, 'Trips recorded'),
      stat(allLines, 'Items bought'),
      stat(stats.size, 'Distinct items'),
      stat(Math.round(allLines / trips.length), 'Avg items per trip'),
      stat(cadence ? `${cadence}d` : '—', 'Between trips'),
    ),

    h(
      'div',
      { class: 'notice' },
      h('strong', {}, `Last trip: ${formatLongDate(lastTrip.date)}`),
      `${pluralize(lastTrip.items.length, 'item')} — ${relativeDays(
        Math.round((Date.now() - new Date(`${lastTrip.date}T12:00:00`)) / 86_400_000),
      )}.`,
    ),

    h(
      'div',
      { class: 'cols cols--2' },
      topItemsCard(trips),
      departmentCard(trips),
    ),

    narrativeCard(ctx, trips, stats),
    spendCard(ctx, trips),
    tripsCard(series),
    cadenceTable(ctx, stats),
    pruneCard(trips),
    historyCard(ctx, trips),
  );
}

function head(count) {
  return h(
    'div',
    { class: 'page-head' },
    h('p', { class: 'eyebrow' }, 'Insights'),
    h('h2', {}, 'Trends'),
    h(
      'p',
      {},
      count
        ? `What you actually buy, drawn from ${pluralize(count, 'recorded trip')}.`
        : 'What you actually buy, once there are trips to draw from.',
    ),
  );
}

function stat(value, label) {
  return h(
    'div',
    { class: 'stat' },
    h('div', { class: 'stat__value' }, String(value)),
    h('div', { class: 'stat__label' }, label),
  );
}

function topItemsCard(trips) {
  const top = topItems(trips, 12);
  const max = Math.max(...top.map((t) => t.count), 1);

  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'card__head' }, h('h3', {}, 'Top items')),
    h(
      'div',
      { class: 'card__body' },
      h(
        'ul',
        { class: 'bars' },
        top.map((s) =>
          h(
            'li',
            { class: 'bar' },
            h('span', { class: 'bar__label', title: s.name }, s.name),
            h(
              'span',
              { class: 'bar__track' },
              h('span', { class: 'bar__fill', style: { width: `${(s.count / max) * 100}%` } }),
            ),
            h('span', { class: 'bar__value' }, String(s.count)),
          ),
        ),
      ),
    ),
  );
}

function departmentCard(trips) {
  const totals = [...departmentTotals(trips).entries()]
    .map(([dept, count]) => ({ dept, count }))
    .sort((a, b) => b.count - a.count);
  const max = Math.max(...totals.map((t) => t.count), 1);

  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'card__head' }, h('h3', {}, 'Where the trip goes')),
    h(
      'div',
      { class: 'card__body' },
      h(
        'ul',
        { class: 'bars' },
        totals.map((t) =>
          h(
            'li',
            { class: 'bar' },
            h('span', { class: 'bar__label' }, departmentName(t.dept)),
            h(
              'span',
              { class: 'bar__track' },
              h('span', { class: 'bar__fill bar__fill--deal', style: { width: `${(t.count / max) * 100}%` } }),
            ),
            h('span', { class: 'bar__value' }, String(t.count)),
          ),
        ),
      ),
    ),
  );
}

// ── The written read ─────────────────────────────────────────────────────

const NARRATIVE_SLOT = 'shopping-pal.ai-narrative';

/**
 * A stable signature of the history the read was written from, so a cached
 * paragraph is only ever shown next to the numbers it actually describes. Any
 * new trip, or any change to one, invalidates it.
 */
function narrativeSignature(trips) {
  const lines = trips.reduce((n, t) => n + t.items.length, 0);
  const priced = trips.reduce(
    (n, t) => n + t.items.filter((i) => i.priceCents != null).length,
    0,
  );
  return `${trips.length}:${trips[trips.length - 1]?.date}:${lines}:${priced}`;
}

function readNarrative(signature) {
  try {
    const cached = JSON.parse(localStorage.getItem(NARRATIVE_SLOT) || 'null');
    return cached?.signature === signature ? cached : null;
  } catch {
    return null;
  }
}

function writeNarrative(signature, result) {
  try {
    localStorage.setItem(
      NARRATIVE_SLOT,
      JSON.stringify({ signature, ...result, at: new Date().toISOString() }),
    );
  } catch {
    /* the read still displays, it just will not survive a reload */
  }
}

/**
 * Everything Claude is allowed to talk about, already worked out.
 *
 * Money arrives pre-formatted and counts arrive as finished integers, because
 * the one thing this feature must never do is put a number on screen that the
 * app did not calculate. Give the model figures to copy, not figures to
 * combine.
 */
function narrativeFacts(trips, stats) {
  const state = store.getState();
  const listIds = new Set(Object.keys(state.list));
  const spend = spendSummary(trips);
  const all = [...stats.values()];

  const describe = (s) => ({
    item: s.name,
    timesBought: s.count,
    typicalGapDays: s.cadence,
    daysSinceLastBought: s.daysSince,
    firstBought: s.first,
  });

  return {
    tripsRecorded: trips.length,
    firstTrip: trips[0]?.date,
    lastTrip: trips[trips.length - 1]?.date,
    typicalDaysBetweenTrips: tripCadence(trips),
    distinctItemsEverBought: stats.size,

    spend: spend.hasPrices
      ? {
          note: spend.fromPrintedTotals
            ? 'Totals are what the receipts actually charged.'
            : 'Totals are summed shelf prices, not printed receipt totals.',
          basedOn: `${spend.pricedTrips} of ${spend.totalTrips} trips have prices`,
          total: formatMoney(spend.totalCents),
          averagePerTrip: formatMoney(spend.avgTripCents),
          byStore: spend.byStore.map(([name, cents]) => ({
            store: name,
            total: formatMoney(cents),
          })),
          topDepartments: spend.byDept
            .slice(0, 6)
            .map(([dept, cents]) => ({ department: departmentName(dept), total: formatMoney(cents) })),
        }
      : 'No prices recorded yet — do not discuss money.',

    boughtMostOften: all
      .sort((a, b) => b.count - a.count)
      .slice(0, 12)
      .map(describe),

    /** Bought repeatedly, but only since recently — the "becoming a regular" case. */
    newlyRegular: all
      .filter((s) => s.count >= 2 && s.daysSince != null && daysAgo(s.first) <= 90)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
      .map(describe),

    overdueAndNotOnTheList: dueItems(trips, listIds, 10).map(describe),

    boughtOnceAndNotSince: oneOffItems(trips).slice(0, 10).map(describe),

    inTheCatalogButNeverBought: neverBought(trips, store.items())
      .slice(0, 15)
      .map((i) => i.name),
  };
}

function daysAgo(iso) {
  if (!iso) return Infinity;
  return Math.round((Date.now() - new Date(`${iso}T12:00:00`)) / 86_400_000);
}

/**
 * Claude's read of the numbers above.
 *
 * Deliberately opt-in per refresh rather than automatic: it costs money, and a
 * paragraph that silently re-bills every time the tab is opened is not a
 * feature. The cached copy is shown until the history actually changes.
 */
function narrativeCard(ctx, trips, stats) {
  if (!ai.hasKey()) return null;

  const signature = narrativeSignature(trips);
  const cached = readNarrative(signature);
  const body = h('div', { class: 'card__body' });
  const actions = h('div', { class: 'btn-row' });

  function renderResult(result, at) {
    body.replaceChildren(
      h('p', { style: { fontWeight: '700', fontSize: '1.05rem', margin: '0 0 0.6rem' } }, result.headline),
      h(
        'ul',
        { class: 'plain-list' },
        (result.points ?? []).map((point) => h('li', {}, point)),
      ),
      h(
        'p',
        { class: 'dept-note', style: { marginTop: '0.75rem' } },
        `Written by ${ai.MODELS.narrate} from the figures on this page${at ? ` on ${formatLongDate(at.slice(0, 10))}` : ''}. Every number here is the app's own — Claude was given them, not asked to work them out.`,
      ),
    );
  }

  async function run() {
    body.replaceChildren(h('p', { class: 'dept-note' }, 'Reading the numbers…'));
    actions.replaceChildren();
    try {
      const result = await ai.narrateTrends(narrativeFacts(trips, stats));
      writeNarrative(signature, result);
      renderResult(result, new Date().toISOString());
      actions.replaceChildren(button('Read it again', run));
    } catch (err) {
      body.replaceChildren(
        h(
          'div',
          { class: 'notice notice--warn' },
          h('strong', {}, 'Could not reach Claude'),
          err.message,
        ),
      );
      actions.replaceChildren(button('Try again', run));
    }
  }

  function button(label, onClick) {
    return h('button', { class: 'btn btn--sm btn--ghost', onClick }, label);
  }

  if (cached) {
    renderResult(cached, cached.at);
    actions.append(button('Read it again', run));
  } else {
    body.replaceChildren(
      h(
        'p',
        { class: 'dept-note' },
        `A written read of the figures below — what is becoming a regular, what has quietly stopped, what is overdue. Costs a fraction of a cent, and only re-runs when you ask or when there is a new trip.`,
      ),
    );
    actions.append(h('button', { class: 'btn btn--primary btn--sm', onClick: run }, 'Ask Claude to read this'));
  }

  return h(
    'section',
    { class: 'card card--accent' },
    h(
      'div',
      { class: 'card__head' },
      h('h3', {}, 'The short version'),
      h('span', { class: 'spacer' }),
      actions,
    ),
    body,
  );
}

function spendCard(ctx, trips) {
  const spend = spendSummary(trips);
  if (!spend.hasPrices) {
    return h(
      'section',
      { class: 'card' },
      h('div', { class: 'card__head' }, h('h3', {}, 'Spending')),
      h(
        'div',
        { class: 'card__body' },
        h(
          'p',
          { class: 'dept-note' },
          'No prices recorded yet. Importing a receipt captures what each item cost, which is what fills this in.',
        ),
        h('button', { class: 'btn btn--sm btn--primary', onClick: () => openImporter(ctx) }, 'Import a receipt'),
      ),
    );
  }

  const maxStore = Math.max(...spend.byStore.map(([, c]) => c), 1);
  const maxDept = Math.max(...spend.byDept.map(([, c]) => c), 1);

  return h(
    'section',
    { class: 'card card--accent' },
    h(
      'div',
      { class: 'card__head' },
      h('h3', {}, 'Spending'),
      h('span', { class: 'spacer' }),
      h(
        'span',
        { class: 'dept-note' },
        spend.pricedTrips === spend.totalTrips
          ? `all ${pluralize(spend.totalTrips, 'trip')}`
          : `${spend.pricedTrips} of ${spend.totalTrips} trips have prices`,
      ),
    ),
    h(
      'div',
      { class: 'stat-grid', style: { margin: 0, border: 0, borderRadius: 0 } },
      stat(formatMoney(spend.totalCents), spend.fromPrintedTotals ? 'Total paid' : 'Total recorded'),
      stat(formatMoney(spend.avgTripCents), 'Average trip'),
      stat(String(spend.byStore.length), spend.byStore.length === 1 ? 'Store' : 'Stores'),
    ),
    h(
      'div',
      { class: 'card__body' },
      spend.byStore.length > 1
        ? h(
            'div',
            { style: { marginBottom: '1.25rem' } },
            h('p', { class: 'eyebrow' }, 'By store'),
            h(
              'ul',
              { class: 'bars' },
              spend.byStore.map(([name, cents]) =>
                h(
                  'li',
                  { class: 'bar' },
                  h('span', { class: 'bar__label' }, name),
                  h(
                    'span',
                    { class: 'bar__track' },
                    h('span', { class: 'bar__fill', style: { width: `${(cents / maxStore) * 100}%` } }),
                  ),
                  h('span', { class: 'bar__value' }, formatMoney(cents)),
                ),
              ),
            ),
          )
        : null,
      h('p', { class: 'eyebrow' }, 'By department'),
      h(
        'p',
        { class: 'dept-note', style: { marginTop: '-0.2rem' } },
        `Shelf prices, before tax and savings — ${formatMoney(spend.lineCents)} in total.`,
      ),
      h(
        'ul',
        { class: 'bars' },
        spend.byDept.slice(0, 10).map(([dept, cents]) =>
          h(
            'li',
            { class: 'bar' },
            h('span', { class: 'bar__label' }, departmentName(dept)),
            h(
              'span',
              { class: 'bar__track' },
              h('span', { class: 'bar__fill bar__fill--deal', style: { width: `${(cents / maxDept) * 100}%` } }),
            ),
            h('span', { class: 'bar__value' }, formatMoney(cents)),
          ),
        ),
      ),
    ),
  );
}

function tripsCard(series) {
  const max = Math.max(...series.map((s) => s.count), 1);
  const recent = series.slice(-26);

  return h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card__head' },
      h('h3', {}, 'Trip size over time'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'dept-note' }, `last ${pluralize(recent.length, 'trip')}`),
    ),
    h(
      'div',
      { class: 'card__body' },
      h(
        'div',
        { class: 'spark' },
        recent.map((s) =>
          h(
            'div',
            { class: 'spark__col', title: `${s.label}: ${pluralize(s.count, 'item')}` },
            h('span', { class: 'spark__bar', style: { height: `${(s.count / max) * 100}%` } }),
            h('span', { class: 'spark__tick' }, s.label.replace(' ', ' ')),
          ),
        ),
      ),
    ),
  );
}

// ── Sortable cadence table ───────────────────────────────────────────────

const COLUMNS = [
  { key: 'name', label: 'Item', align: 'left' },
  { key: 'dept', label: 'Aisle', align: 'left' },
  { key: 'count', label: 'Times', align: 'num' },
  { key: 'qty', label: 'Units', align: 'num' },
  { key: 'cadence', label: 'Every', align: 'num' },
  { key: 'daysSince', label: 'Last bought', align: 'num' },
  { key: 'dueRatio', label: 'Status', align: 'left' },
];

function cadenceTable(ctx, stats) {
  const rows = [...stats.values()].filter((s) =>
    tableFilter ? s.name.toLowerCase().includes(tableFilter.toLowerCase()) : true,
  );

  rows.sort((a, b) => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const av = a[sort.key];
    const bv = b[sort.key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });

  return h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card__head' },
      h('h3', {}, 'How often you buy things'),
      h('span', { class: 'spacer' }),
      h('input', {
        type: 'search',
        id: 'trend-filter',
        placeholder: 'Filter…',
        value: tableFilter,
        style: { width: '11rem', padding: '0.3rem 0.5rem', fontSize: '0.85rem' },
        'aria-label': 'Filter the table',
        onInput: (e) => {
          tableFilter = e.target.value;
          ctx.rerender({ focus: 'trend-filter' });
        },
      }),
    ),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            COLUMNS.map((col) =>
              h(
                'th',
                {},
                h(
                  'button',
                  {
                    type: 'button',
                    style: {
                      background: 'none',
                      border: 0,
                      font: 'inherit',
                      color: 'inherit',
                      cursor: 'pointer',
                      padding: 0,
                      textTransform: 'inherit',
                      letterSpacing: 'inherit',
                    },
                    'aria-label': `Sort by ${col.label}`,
                    onClick: () => {
                      sort =
                        sort.key === col.key
                          ? { key: col.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
                          : { key: col.key, dir: col.key === 'name' ? 'asc' : 'desc' };
                      ctx.rerender();
                    },
                  },
                  col.label,
                  sort.key === col.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '',
                ),
              ),
            ),
          ),
        ),
        h(
          'tbody',
          {},
          rows.map((s) =>
            h(
              'tr',
              {},
              h('td', {}, s.name),
              h('td', {}, departmentName(s.dept)),
              h('td', { class: 'num' }, String(s.count)),
              h('td', { class: 'num' }, String(s.qty)),
              h('td', { class: 'num' }, s.cadence ? `${s.cadence}d` : '—'),
              h('td', { class: 'num' }, s.daysSince === 0 ? 'today' : `${s.daysSince}d`),
              h('td', {}, dueBadge(s)),
            ),
          ),
        ),
      ),
    ),
    rows.length === 0
      ? h('div', { class: 'card__body' }, h('p', { class: 'dept-note' }, 'Nothing matches that filter.'))
      : null,
  );
}

function dueBadge(s) {
  if (s.cadence === null) return h('span', { class: 'badge badge--plain' }, 'Bought once');
  if (s.dueRatio >= 1.5) return h('span', { class: 'badge badge--due' }, 'Overdue');
  if (s.dueRatio >= 0.85) return h('span', { class: 'badge badge--deal' }, 'Due now');
  return h('span', { class: 'badge badge--plain' }, `in ~${Math.max(0, s.dueInDays)}d`);
}

// ── Prune & history ──────────────────────────────────────────────────────

function pruneCard(trips) {
  const oneOffs = oneOffItems(trips, 60);
  if (!oneOffs.length) return null;

  return h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card__head' },
      h('h3', {}, 'Bought once, a long time ago'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'dept-note' }, 'candidates to drop from the catalog'),
    ),
    h(
      'ul',
      { class: 'rows' },
      oneOffs.slice(0, 10).map((s) =>
        h(
          'li',
          { class: 'row' },
          h(
            'div',
            { class: 'row__main' },
            h('div', { class: 'row__name' }, s.name),
            h('div', { class: 'row__meta' }, `once, ${relativeDays(s.daysSince)}`),
          ),
          h(
            'button',
            {
              class: 'btn btn--sm btn--ghost',
              onClick: () => {
                store.archiveItem(s.id);
                toast(`${s.name} removed from the catalog`);
              },
            },
            'Remove from catalog',
          ),
        ),
      ),
    ),
  );
}

function historyCard(ctx, trips) {
  return h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card__head' },
      h('h3', {}, 'Trip history'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--sm btn--primary', onClick: () => openImporter(ctx) }, 'Import a receipt'),
      h('button', { class: 'btn btn--sm btn--ghost', onClick: () => backfill(ctx) }, 'Log a past trip'),
      h('button', { class: 'btn btn--sm btn--ghost', onClick: () => aliasManager(ctx) }, 'Learned names'),
    ),
    h(
      'ul',
      { class: 'rows' },
      [...trips].reverse().map((trip) =>
        h(
          'li',
          { class: 'row' },
          h(
            'div',
            { class: 'row__main' },
            h(
              'div',
              { class: 'row__name' },
              formatLongDate(trip.date),
              trip.totalCents != null &&
                h('span', { class: 'badge badge--plain' }, formatMoney(trip.totalCents)),
              ...(trip.stores ?? []).map((s) => h('span', { class: 'badge badge--person' }, s)),
            ),
            h(
              'div',
              { class: 'row__meta' },
              `${pluralize(trip.items.length, 'item')} — ${trip.items
                .slice(0, 6)
                .map((i) => i.name)
                .join(', ')}${trip.items.length > 6 ? '…' : ''}`,
            ),
          ),
          h(
            'button',
            {
              class: 'icon-btn',
              type: 'button',
              title: 'Delete this trip',
              'aria-label': `Delete the trip on ${formatShortDate(trip.date)}`,
              onClick: () => {
                if (confirm(`Delete the trip on ${formatLongDate(trip.date)}? This changes your trends.`)) {
                  store.deleteTrip(trip.id);
                }
              },
            },
            '✕',
          ),
        ),
      ),
    ),
  );
}

/**
 * Record a trip that already happened. Handy for seeding a few weeks of
 * history from memory so the cadence maths has something to work with.
 */
function backfill(ctx) {
  const items = store.items();
  const dateInput = h('input', {
    type: 'date',
    id: 'backfill-date',
    value: new Date().toISOString().slice(0, 10),
    max: new Date().toISOString().slice(0, 10),
  });
  const search = h('input', {
    type: 'search',
    placeholder: 'Filter items…',
    style: { marginBottom: '0.5rem' },
    'aria-label': 'Filter items',
  });

  const picked = new Set();
  const listHost = h('div', {
    style: { maxHeight: '40vh', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: '4px' },
  });

  function paint() {
    const q = search.value.toLowerCase();
    const shown = items.filter((i) => !q || i.name.toLowerCase().includes(q)).slice(0, 200);
    listHost.replaceChildren(
      h(
        'ul',
        { class: 'rows' },
        shown.map((item) =>
          h(
            'li',
            { class: 'row' },
            h('input', {
              type: 'checkbox',
              class: 'check',
              checked: picked.has(item.id),
              'aria-label': item.name,
              onChange: (e) => {
                if (e.target.checked) picked.add(item.id);
                else picked.delete(item.id);
                count.textContent = `${picked.size} selected`;
              },
            }),
            h(
              'div',
              { class: 'row__main' },
              h('div', { class: 'row__name' }, item.name),
              h('div', { class: 'row__meta' }, departmentName(item.dept)),
            ),
          ),
        ),
      ),
    );
  }

  const count = h('span', { class: 'dept-note' }, '0 selected');
  search.addEventListener('input', paint);
  paint();

  const dialog = modal(
    'Log a past trip',
    h(
      'form',
      {
        onSubmit: (e) => {
          e.preventDefault();
          if (!picked.size) return;
          const date = dateInput.value;
          const trip = store.addTrip({ date, itemIds: [...picked] });
          dialog.close();
          if (trip) {
            toast(`Logged ${pluralize(trip.items.length, 'item')} on ${formatShortDate(date)}`);
          }
        },
      },
      h(
        'p',
        { class: 'hint' },
        'Adding a few past trips from memory gives the cadence and “probably due” suggestions something to work from.',
      ),
      h('div', { class: 'field' }, h('label', { for: 'backfill-date' }, 'Trip date'), dateInput),
      h('div', { class: 'field' }, h('label', {}, 'What was bought'), search, listHost),
      h('div', { style: { margin: '0.5rem 0' } }, count),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn btn--primary', type: 'submit' }, 'Save trip'),
        h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
      ),
    ),
    { wide: true },
  );
}
