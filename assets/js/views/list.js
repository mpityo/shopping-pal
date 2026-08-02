import { h, toast, matchScore, modal } from '../util.js';
import * as store from '../store.js';
import { dueItems, relativeDays } from '../insights.js';
import { matchDealsToCatalog } from '../deals-data.js';
import { departmentHint } from './ai-hints.js';

/** Kept outside render so a re-render doesn't wipe what's being typed. */
let quickQuery = '';
let quickOpen = false;

export function renderList(ctx) {
  const state = store.getState();
  const entries = store.listEntries();
  const prefs = state.prefs;
  const depts = store.departments();

  const visible = entries.filter((e) => {
    if (prefs.hideChecked && e.checked) return false;
    // Filtering by person keeps that person's items plus anything shared.
    if (prefs.person !== 'all' && e.person && e.person !== prefs.person) return false;
    return true;
  });

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'page-head' },
      h('p', { class: 'eyebrow' }, 'This week'),
      h('h2', {}, 'Shopping list'),
      h(
        'p',
        {},
        entries.length
          ? `${entries.length} item${entries.length === 1 ? '' : 's'} on the list, ordered by the route through the store.`
          : 'Nothing on the list yet. Search below or open the Catalog to add your regulars.',
      ),
    ),

    quickAdd(ctx),
    suggestions(ctx, entries),

    entries.length ? toolbar(prefs) : null,

    entries.length === 0
      ? h(
          'div',
          { class: 'empty' },
          h('h3', {}, 'The list is empty'),
          h(
            'p',
            {},
            'Start typing above to add anything from the catalog, or browse the full list by department.',
          ),
          h(
            'button',
            { class: 'btn btn--primary', onClick: () => ctx.go('browse') },
            'Browse the catalog',
          ),
        )
      : groups(visible, prefs, depts),

    entries.length ? actionBar(ctx, entries) : null,
  );
}

// ── Quick add ────────────────────────────────────────────────────────────

function quickAdd(ctx) {
  const results = quickQuery ? searchCatalog(quickQuery, 7) : [];

  const input = h('input', {
    type: 'search',
    id: 'quick-add',
    placeholder: 'Add an item — start typing…',
    autocomplete: 'off',
    value: quickQuery,
    'aria-label': 'Add an item to the list',
    onInput: (e) => {
      quickQuery = e.target.value;
      quickOpen = true;
      ctx.rerender({ focus: 'quick-add' });
    },
    onKeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (results.length) add(results[0].id);
        else if (quickQuery.trim()) createNew(quickQuery.trim(), ctx);
      } else if (e.key === 'Escape') {
        quickQuery = '';
        quickOpen = false;
        ctx.rerender();
      }
    },
  });

  function add(id) {
    store.addToList(id);
    const item = store.itemById(id);
    quickQuery = '';
    quickOpen = false;
    toast(`Added ${item.name}`, {
      action: 'Undo',
      onAction: () => store.removeFromList(id),
    });
    ctx.rerender({ focus: 'quick-add' });
  }

  const onList = new Set(Object.keys(store.getState().list));

  return h(
    'div',
    { class: 'card card--accent' },
    h(
      'div',
      { class: 'card__body' },
      h('div', { class: 'searchbar', style: { marginBottom: quickOpen && quickQuery ? '0.75rem' : '0' } },
        input,
        quickQuery &&
          h(
            'button',
            {
              class: 'searchbar__clear',
              type: 'button',
              'aria-label': 'Clear',
              onClick: () => {
                quickQuery = '';
                quickOpen = false;
                ctx.rerender({ focus: 'quick-add' });
              },
            },
            '✕',
          ),
      ),
      quickOpen && quickQuery
        ? h(
            'ul',
            { class: 'rows', style: { border: '1px solid var(--line)', borderRadius: '4px' } },
            results.map((item) =>
              h(
                'li',
                { class: 'row' },
                h(
                  'div',
                  { class: 'row__main' },
                  h(
                    'div',
                    { class: 'row__name' },
                    item.name,
                    onList.has(item.id) && h('span', { class: 'badge badge--plain' }, 'On list'),
                    item.person && h('span', { class: 'badge badge--person' }, personName(item.person)),
                  ),
                  h('div', { class: 'row__meta' }, `${item.section} · ${item.sub}`),
                ),
                h(
                  'button',
                  {
                    class: 'btn btn--sm btn--primary',
                    disabled: onList.has(item.id),
                    onClick: () => add(item.id),
                  },
                  onList.has(item.id) ? 'Added' : 'Add',
                ),
              ),
            ),
            h(
              'li',
              { class: 'row' },
              h(
                'div',
                { class: 'row__main' },
                h('div', { class: 'row__meta' }, results.length ? 'Not what you meant?' : 'No match in the catalog'),
              ),
              h(
                'button',
                {
                  class: 'btn btn--sm btn--ghost',
                  onClick: () => createNew(quickQuery.trim(), ctx),
                },
                `Create “${quickQuery.trim()}”`,
              ),
            ),
          )
        : null,
    ),
  );
}

function searchCatalog(query, limit) {
  return store
    .items()
    .map((item) => ({
      item,
      score:
        matchScore(item.name, query) * 2 +
        matchScore(`${item.sub} ${item.section}`, query),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.item);
}

function createNew(name, ctx) {
  if (!name) return;
  const depts = store.departments();
  const select = h(
    'select',
    { id: 'new-dept' },
    depts.map((d) => h('option', { value: d.id }, `${d.name} — ${d.aisle}`)),
  );
  const noteInput = h('input', { type: 'text', id: 'new-note', placeholder: 'e.g. 2 bunches' });
  const personSelect = h(
    'select',
    { id: 'new-person' },
    h('option', { value: '' }, 'Everyone'),
    store.people().map((p) => h('option', { value: p.id }, p.name)),
  );
  const deptHint = departmentHint(select);
  deptHint.ask(name);

  const dialog = modal(
    'Add a new item',
    h(
      'form',
      {
        onSubmit: (e) => {
          e.preventDefault();
          const id = store.addCustomItem({
            name,
            dept: select.value,
            note: noteInput.value,
            person: personSelect.value || null,
          });
          store.addToList(id);
          quickQuery = '';
          quickOpen = false;
          dialog.close();
          toast(`Added ${name} to the catalog and this week's list`);
          ctx.rerender();
        },
      },
      h('div', { class: 'field' }, h('label', {}, 'Item'), h('input', { type: 'text', value: name, readonly: true })),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'new-dept' }, 'Where is it in the store?'),
        h('p', { class: 'hint' }, 'This sets where it appears on the shopping route.'),
        select,
        deptHint.node,
      ),
      h('div', { class: 'field' }, h('label', { for: 'new-note' }, 'Note (optional)'), noteInput),
      h('div', { class: 'field' }, h('label', { for: 'new-person' }, 'For (optional)'), personSelect),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn btn--primary', type: 'submit' }, 'Add item'),
        h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
      ),
    ),
  );
}

// ── Suggestions ──────────────────────────────────────────────────────────

function suggestions(ctx, entries) {
  const state = store.getState();
  const listIds = new Set(entries.map((e) => e.id));
  const due = dueItems(state.trips, listIds, 6);
  const deals = matchDealsToCatalog(
    ctx.deals,
    store.items(),
    state.manualDeals,
  ).filter((m) => !listIds.has(m.item.id));

  if (!due.length && !deals.length) return null;

  return h(
    'div',
    { class: 'cols cols--2' },
    due.length
      ? h(
          'div',
          { class: 'card' },
          h(
            'div',
            { class: 'card__head' },
            h('h3', {}, 'Probably due'),
            h('span', { class: 'spacer' }),
            h('span', { class: 'dept-note' }, 'based on how often you buy them'),
          ),
          h(
            'ul',
            { class: 'rows' },
            due.map((s) =>
              h(
                'li',
                { class: 'row' },
                h(
                  'div',
                  { class: 'row__main' },
                  h('div', { class: 'row__name' }, s.name),
                  h(
                    'div',
                    { class: 'row__meta' },
                    `every ~${s.cadence} days`,
                    `last bought ${relativeDays(s.daysSince)}`,
                  ),
                ),
                h(
                  'button',
                  {
                    class: 'btn btn--sm btn--ghost',
                    onClick: () => {
                      store.addToList(s.id);
                      toast(`Added ${s.name}`);
                    },
                  },
                  'Add',
                ),
              ),
            ),
          ),
        )
      : null,
    deals.length
      ? h(
          'div',
          { class: 'card card--deal' },
          h(
            'div',
            { class: 'card__head' },
            h('h3', {}, 'Your regulars are BOGO'),
            h('span', { class: 'spacer' }),
            h('span', { class: 'badge badge--deal' }, 'Publix'),
          ),
          h(
            'ul',
            { class: 'rows' },
            deals.slice(0, 6).map((m) =>
              h(
                'li',
                { class: 'row' },
                h(
                  'div',
                  { class: 'row__main' },
                  h('div', { class: 'row__name' }, m.item.name),
                  h('div', { class: 'row__meta' }, m.deal.title),
                ),
                h(
                  'button',
                  {
                    class: 'btn btn--sm btn--ghost',
                    onClick: () => {
                      store.addToList(m.item.id, { note: 'BOGO at Publix' });
                      toast(`Added ${m.item.name}`);
                    },
                  },
                  'Add',
                ),
              ),
            ),
          ),
          deals.length > 6
            ? h(
                'div',
                { class: 'card__body' },
                h(
                  'button',
                  { class: 'btn btn--sm btn--ghost', onClick: () => ctx.go('deals') },
                  `See all ${deals.length} matches`,
                ),
              )
            : null,
        )
      : null,
  );
}

// ── Toolbar ──────────────────────────────────────────────────────────────

function toolbar(prefs) {
  const groupings = [
    ['dept', 'Store route'],
    ['section', 'Notes sections'],
    ['person', 'Who it’s for'],
    ['none', 'Flat list'],
  ];

  return h(
    'div',
    { class: 'toolbar' },
    h(
      'div',
      { class: 'toolbar__group' },
      h('span', { class: 'toolbar__label' }, 'Group by'),
      h(
        'div',
        { class: 'chips' },
        groupings.map(([value, label]) =>
          h(
            'button',
            {
              class: 'chip',
              type: 'button',
              'aria-pressed': String(prefs.groupBy === value),
              onClick: () => store.setPref('groupBy', value),
            },
            label,
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'toolbar__group' },
      h('span', { class: 'toolbar__label' }, 'Show'),
      h(
        'div',
        { class: 'chips' },
        h(
          'button',
          {
            class: 'chip',
            type: 'button',
            'aria-pressed': String(prefs.hideChecked),
            onClick: () => store.setPref('hideChecked', !prefs.hideChecked),
          },
          'Hide picked up',
        ),
        store.people().map((p) =>
          h(
            'button',
            {
              class: 'chip',
              type: 'button',
              'aria-pressed': String(prefs.person === p.id),
              onClick: () =>
                store.setPref('person', prefs.person === p.id ? 'all' : p.id),
            },
            p.name,
          ),
        ),
      ),
    ),
  );
}

// ── Grouped rows ─────────────────────────────────────────────────────────

function groups(entries, prefs, depts) {
  if (!entries.length) {
    return h(
      'div',
      { class: 'empty' },
      h('h3', {}, 'Everything here is picked up'),
      h('p', {}, 'Turn off “Hide picked up” to see the whole list, or finish the trip below.'),
    );
  }

  const buckets = new Map();
  const meta = new Map();

  for (const entry of entries) {
    let key;
    let label;
    let tag;
    if (prefs.groupBy === 'dept') {
      const dept = depts.find((d) => d.id === entry.dept) ?? depts[depts.length - 1];
      key = dept.id;
      label = dept.name;
      tag = dept.aisle;
    } else if (prefs.groupBy === 'section') {
      key = entry.section;
      label = entry.section;
      tag = null;
    } else if (prefs.groupBy === 'person') {
      key = entry.person ?? 'shared';
      label = entry.person ? personName(entry.person) : 'For the house';
      tag = null;
    } else {
      key = 'all';
      label = 'All items';
      tag = null;
    }
    if (!buckets.has(key)) {
      buckets.set(key, []);
      meta.set(key, { label, tag });
    }
    buckets.get(key).push(entry);
  }

  return h(
    'div',
    {},
    [...buckets.entries()].map(([key, items]) => {
      const { label, tag } = meta.get(key);
      const done = items.filter((i) => i.checked).length;
      return h(
        'section',
        { class: 'card' },
        h(
          'div',
          { class: 'card__head' },
          tag && h('span', { class: 'aisle-tag' }, tag),
          h('h3', {}, label),
          h('span', { class: 'spacer' }),
          h('span', { class: 'dept-note' }, `${done}/${items.length}`),
        ),
        h('ul', { class: 'rows' }, items.map(listRow)),
      );
    }),
  );
}

function listRow(entry) {
  return h(
    'li',
    { class: `row${entry.checked ? ' row--checked' : ''}` },
    h('input', {
      type: 'checkbox',
      class: 'check',
      // The id lets the re-render put keyboard focus back where it was.
      id: `check-${entry.id}`,
      checked: entry.checked,
      'aria-label': `Picked up ${entry.name}`,
      onChange: () => store.toggleChecked(entry.id),
    }),
    h(
      'div',
      { class: 'row__main' },
      h(
        'div',
        { class: 'row__name' },
        entry.name,
        entry.person && h('span', { class: 'badge badge--person' }, personName(entry.person)),
        /bogo/i.test(entry.note || '') && h('span', { class: 'badge badge--deal' }, 'BOGO'),
      ),
      entry.note && !/bogo/i.test(entry.note)
        ? h('div', { class: 'row__meta' }, entry.note)
        : null,
    ),
    h(
      'div',
      { class: 'row__actions' },
      h(
        'div',
        { class: 'stepper' },
        h(
          'button',
          {
            type: 'button',
            'aria-label': `Fewer ${entry.name}`,
            onClick: () => store.setQty(entry.id, (entry.qty ?? 1) - 1),
          },
          '−',
        ),
        h('span', {}, entry.qty ?? 1),
        h(
          'button',
          {
            type: 'button',
            'aria-label': `More ${entry.name}`,
            onClick: () => store.setQty(entry.id, (entry.qty ?? 1) + 1),
          },
          '+',
        ),
      ),
      h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          'aria-label': `Remove ${entry.name} from the list`,
          title: 'Remove from list',
          onClick: () => {
            const snapshot = { ...entry };
            store.removeFromList(entry.id);
            toast(`Removed ${entry.name}`, {
              action: 'Undo',
              onAction: () =>
                store.addToList(snapshot.id, {
                  qty: snapshot.qty,
                  note: snapshot.note,
                  checked: snapshot.checked,
                }),
            });
          },
        },
        '✕',
      ),
    ),
  );
}

// ── Action bar ───────────────────────────────────────────────────────────

function actionBar(ctx, entries) {
  const checked = entries.filter((e) => e.checked).length;

  return h(
    'div',
    { class: 'actionbar' },
    h(
      'span',
      { class: 'actionbar__summary' },
      checked
        ? `${checked} of ${entries.length} picked up`
        : `${entries.length} to go`,
    ),
    h(
      'button',
      { class: 'btn btn--ghost btn--sm', onClick: () => shareList() },
      'Share',
    ),
    h(
      'button',
      { class: 'btn btn--ghost btn--sm', onClick: () => window.print() },
      'Print',
    ),
    checked > 0 &&
      h(
        'button',
        { class: 'btn btn--ghost btn--sm', onClick: () => store.uncheckAll() },
        'Uncheck all',
      ),
    h(
      'button',
      {
        class: 'btn btn--primary',
        disabled: checked === 0,
        onClick: () => finishTrip(ctx, checked, entries.length),
      },
      `Finish trip${checked ? ` (${checked})` : ''}`,
    ),
  );
}

function finishTrip(ctx, checked, total) {
  const remaining = total - checked;
  const dialog = modal(
    'Finish this trip?',
    h(
      'div',
      {},
      h(
        'p',
        {},
        `${checked} item${checked === 1 ? '' : 's'} will be recorded as bought today and cleared from the list.`,
      ),
      remaining > 0
        ? h(
            'div',
            { class: 'notice' },
            h('strong', {}, `${remaining} unchecked item${remaining === 1 ? '' : 's'} will stay on the list`),
            'Nothing you did not check gets recorded as bought.',
          )
        : null,
      h(
        'p',
        {},
        'This history is what powers the trends — top items, how often you buy them, and what is due next.',
      ),
      h(
        'div',
        { class: 'btn-row' },
        h(
          'button',
          {
            class: 'btn btn--primary',
            onClick: () => {
              const trip = store.finishTrip();
              dialog.close();
              if (trip) {
                toast(`Trip recorded — ${trip.items.length} items`, {
                  action: 'View trends',
                  onAction: () => ctx.go('trends'),
                });
              }
            },
          },
          'Record trip',
        ),
        h('button', { class: 'btn btn--ghost', onClick: () => dialog.close() }, 'Not yet'),
      ),
    ),
  );
}

async function shareList() {
  const url = `${location.origin}${location.pathname}#/list?share=${store.encodeList()}`;
  const text = store
    .listEntries()
    .map((e) => `• ${e.name}${(e.qty ?? 1) > 1 ? ` ×${e.qty}` : ''}${e.note ? ` (${e.note})` : ''}`)
    .join('\n');

  if (navigator.share) {
    try {
      await navigator.share({ title: 'Grocery list', text, url });
      return;
    } catch {
      /* user dismissed the share sheet — fall through to copy */
    }
  }
  try {
    await navigator.clipboard.writeText(`${text}\n\n${url}`);
    toast('List copied to the clipboard');
  } catch {
    modal('Share this list', h('textarea', { readonly: true, value: `${text}\n\n${url}`, rows: 12 }));
  }
}

function personName(id) {
  return store.personName(id) ?? id;
}
