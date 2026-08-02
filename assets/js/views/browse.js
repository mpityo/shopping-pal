import { h, matchScore, modal, toast, pluralize } from '../util.js';
import * as store from '../store.js';
import { itemStats, relativeDays } from '../insights.js';
import { departmentHint } from './ai-hints.js';

let query = '';
let filter = { type: 'all', value: null };
let groupBy = 'section';

export function renderBrowse(ctx) {
  const state = store.getState();
  const items = store.items();
  const depts = store.departments();
  const stats = itemStats(state.trips);
  const onList = new Set(Object.keys(state.list));

  const scored = query
    ? items
        .map((item) => ({
          item,
          score:
            matchScore(item.name, query) * 2 +
            matchScore(`${item.sub} ${item.section} ${item.note ?? ''}`, query),
        }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.item)
    : items;

  const filtered = scored.filter((item) => {
    if (filter.type === 'section') return item.section === filter.value;
    if (filter.type === 'dept') return item.dept === filter.value;
    if (filter.type === 'person') return item.person === filter.value;
    if (filter.type === 'favorite') return Boolean(item.favorite);
    if (filter.type === 'onlist') return onList.has(item.id);
    return true;
  });

  const sections = [...new Set(items.map((i) => i.section))];

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'page-head' },
      h('p', { class: 'eyebrow' }, 'Catalog'),
      h('h2', {}, 'Everything you buy'),
      h(
        'p',
        {},
        `${pluralize(items.length, 'item')} carried over from the Notes list. Tap to put something on this week's list, or edit where it lives in the store.`,
      ),
    ),

    h(
      'div',
      { class: 'searchbar' },
      h('input', {
        type: 'search',
        id: 'browse-search',
        placeholder: 'Search the catalog…',
        value: query,
        autocomplete: 'off',
        'aria-label': 'Search the catalog',
        onInput: (e) => {
          query = e.target.value;
          ctx.rerender({ focus: 'browse-search' });
        },
      }),
      query &&
        h(
          'button',
          {
            class: 'searchbar__clear',
            type: 'button',
            'aria-label': 'Clear search',
            onClick: () => {
              query = '';
              ctx.rerender({ focus: 'browse-search' });
            },
          },
          '✕',
        ),
    ),

    h(
      'div',
      { class: 'toolbar' },
      h(
        'div',
        { class: 'toolbar__group' },
        h('span', { class: 'toolbar__label' }, 'Filter'),
        h(
          'div',
          { class: 'chips' },
          filterChip(ctx, 'All', { type: 'all', value: null }),
          filterChip(ctx, 'On the list', { type: 'onlist', value: null }),
          filterChip(ctx, 'Favorites', { type: 'favorite', value: null }),
          sections.map((s) => filterChip(ctx, s, { type: 'section', value: s })),
          store.people().map((p) => filterChip(ctx, p.name, { type: 'person', value: p.id })),
        ),
      ),
      h(
        'div',
        { class: 'toolbar__group' },
        h('span', { class: 'toolbar__label' }, 'Group by'),
        h(
          'div',
          { class: 'chips' },
          [
            ['section', 'Notes sections'],
            ['dept', 'Store route'],
          ].map(([value, label]) =>
            h(
              'button',
              {
                class: 'chip',
                type: 'button',
                'aria-pressed': String(groupBy === value),
                onClick: () => {
                  groupBy = value;
                  ctx.rerender();
                },
              },
              label,
            ),
          ),
        ),
      ),
      h(
        'button',
        { class: 'btn btn--sm btn--ghost', onClick: () => openEditor(ctx, null) },
        '+ New item',
      ),
    ),

    filtered.length === 0
      ? h(
          'div',
          { class: 'empty' },
          h('h3', {}, 'Nothing matches'),
          h('p', {}, query ? `No catalog item matches “${query}”.` : 'No items in this filter.'),
          query &&
            h(
              'button',
              { class: 'btn btn--primary', onClick: () => openEditor(ctx, null, query) },
              `Create “${query}”`,
            ),
        )
      : renderGroups(ctx, filtered, depts, stats, onList),
  );
}

function filterChip(ctx, label, spec) {
  const active = filter.type === spec.type && filter.value === spec.value;
  return h(
    'button',
    {
      class: 'chip',
      type: 'button',
      'aria-pressed': String(active),
      onClick: () => {
        filter = active ? { type: 'all', value: null } : spec;
        ctx.rerender();
      },
    },
    label,
  );
}

function renderGroups(ctx, items, depts, stats, onList) {
  const buckets = new Map();
  const meta = new Map();

  for (const item of items) {
    let key;
    let label;
    let tag;
    if (groupBy === 'dept') {
      const dept = depts.find((d) => d.id === item.dept) ?? depts[depts.length - 1];
      key = dept.id;
      label = dept.name;
      tag = dept.aisle;
    } else {
      key = `${item.section} — ${item.sub}`;
      label = item.sub;
      tag = null;
    }
    if (!buckets.has(key)) {
      buckets.set(key, []);
      meta.set(key, { label, tag, section: item.section });
    }
    buckets.get(key).push(item);
  }

  // Keep department groups in walking order; keep Notes groups in seed order.
  const keys = [...buckets.keys()];
  if (groupBy === 'dept') {
    const order = new Map(depts.map((d, i) => [d.id, i]));
    keys.sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
  }

  return h(
    'div',
    {},
    keys.map((key) => {
      const group = buckets.get(key);
      const { label, tag, section } = meta.get(key);
      return h(
        'section',
        { class: 'card' },
        h(
          'div',
          { class: 'card__head' },
          tag && h('span', { class: 'aisle-tag' }, tag),
          h('h3', {}, label),
          groupBy === 'section' && h('span', { class: 'dept-note' }, section),
          h('span', { class: 'spacer' }),
          h('span', { class: 'dept-note' }, pluralize(group.length, 'item')),
        ),
        h(
          'ul',
          { class: 'rows' },
          group.map((item) => catalogRow(ctx, item, stats.get(item.id), onList.has(item.id))),
        ),
      );
    }),
  );
}

function catalogRow(ctx, item, stat, isOnList) {
  return h(
    'li',
    { class: 'row' },
    h(
      'div',
      { class: 'row__main' },
      h(
        'div',
        { class: 'row__name' },
        item.name,
        item.favorite && h('span', { class: 'badge badge--plain' }, '★ Regular'),
        item.person && h('span', { class: 'badge badge--person' }, personName(item.person)),
        item.dealOnly && h('span', { class: 'badge badge--deal' }, 'Only if BOGO'),
      ),
      h(
        'div',
        { class: 'row__meta' },
        item.note && h('span', {}, item.note),
        stat
          ? h('span', {}, `bought ${pluralize(stat.count, 'time')} · last ${relativeDays(stat.daysSince)}`)
          : h('span', {}, 'never recorded'),
      ),
    ),
    h(
      'div',
      { class: 'row__actions' },
      h(
        'button',
        {
          class: `icon-btn${item.favorite ? ' icon-btn--on' : ''}`,
          type: 'button',
          title: item.favorite ? 'Remove from regulars' : 'Mark as a regular',
          'aria-label': item.favorite ? `Unmark ${item.name} as a regular` : `Mark ${item.name} as a regular`,
          onClick: () => store.toggleFavorite(item.id),
        },
        item.favorite ? '★' : '☆',
      ),
      h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          title: 'Edit item',
          'aria-label': `Edit ${item.name}`,
          onClick: () => openEditor(ctx, item),
        },
        '✎',
      ),
      h(
        'button',
        {
          class: `btn btn--sm ${isOnList ? 'btn--ghost' : 'btn--primary'}`,
          onClick: () => {
            store.toggleOnList(item.id);
            toast(isOnList ? `Removed ${item.name} from the list` : `Added ${item.name}`);
          },
        },
        isOnList ? 'On list ✓' : 'Add',
      ),
    ),
  );
}

function openEditor(ctx, item, prefillName = '') {
  const depts = store.departments();
  const isNew = !item;

  const nameInput = h('input', {
    type: 'text',
    id: 'edit-name',
    value: item?.name ?? prefillName,
    required: true,
  });
  const deptSelect = h(
    'select',
    { id: 'edit-dept' },
    depts.map((d) =>
      h('option', { value: d.id, selected: d.id === (item?.dept ?? 'other') }, `${d.name} — ${d.aisle}`),
    ),
  );
  const noteInput = h('input', { type: 'text', id: 'edit-note', value: item?.note ?? '' });
  const personSelect = h(
    'select',
    { id: 'edit-person' },
    h('option', { value: '', selected: !item?.person }, 'Everyone'),
    store.people().map((p) => h('option', { value: p.id, selected: item?.person === p.id }, p.name)),
  );

  // Only for something new. An existing item already has a department someone
  // chose, and second-guessing it would undo a deliberate correction.
  const deptHint = isNew ? departmentHint(deptSelect) : { node: null, ask: () => {} };
  if (isNew) {
    if (prefillName) deptHint.ask(prefillName);
    // The name is editable here, so re-ask once it settles.
    nameInput.addEventListener('change', () => deptHint.ask(nameInput.value));
    nameInput.addEventListener('blur', () => deptHint.ask(nameInput.value));
  }

  const dialog = modal(
    isNew ? 'New item' : `Edit ${item.name}`,
    h(
      'form',
      {
        onSubmit: (e) => {
          e.preventDefault();
          const patch = {
            name: nameInput.value.trim(),
            dept: deptSelect.value,
            note: noteInput.value.trim(),
            person: personSelect.value || null,
          };
          if (!patch.name) return;
          if (isNew) {
            const id = store.addCustomItem(patch);
            store.addToList(id);
            toast(`Added ${patch.name} to the catalog and this week's list`);
          } else {
            store.updateItem(item.id, patch);
            toast('Item updated');
          }
          dialog.close();
          ctx.rerender();
        },
      },
      h('div', { class: 'field' }, h('label', { for: 'edit-name' }, 'Name'), nameInput),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'edit-dept' }, 'Department / aisle'),
        h('p', { class: 'hint' }, 'Sets where this appears on the shopping route.'),
        deptSelect,
        deptHint.node,
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'edit-note' }, 'Note'),
        h('p', { class: 'hint' }, 'Brand, size, or what it is for — e.g. “2 bunches”.'),
        noteInput,
      ),
      h('div', { class: 'field' }, h('label', { for: 'edit-person' }, 'For'), personSelect),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn btn--primary', type: 'submit' }, isNew ? 'Add item' : 'Save'),
        h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
        !isNew &&
          h(
            'button',
            {
              class: 'btn btn--danger',
              type: 'button',
              onClick: () => {
                store.archiveItem(item.id);
                dialog.close();
                toast(`${item.name} removed from the catalog`);
                ctx.rerender();
              },
            },
            'Remove',
          ),
      ),
    ),
  );
}

function personName(id) {
  return store.personName(id) ?? id;
}
