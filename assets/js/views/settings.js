import { h, toast, modal, pluralize } from '../util.js';
import * as store from '../store.js';
import { CATALOG } from '../data/catalog.js';
import { sharingCard } from './sharing.js';

export function renderSettings(ctx) {
  const state = store.getState();
  const depts = store.departments();

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'page-head' },
      h('p', { class: 'eyebrow' }, 'Setup'),
      h('h2', {}, 'Household, store layout & data'),
      h('p', {}, 'Who the list is for, how your store is laid out, and where the data lives.'),
    ),

    householdCard(ctx, state),
    sharingCard(ctx),
    aisleEditor(ctx, depts),
    dataCard(ctx, state),
    archivedCard(ctx, state),
    aboutCard(),
  );
}

// ── Household ────────────────────────────────────────────────────────────

function householdCard(ctx, state) {
  const people = store.people();
  const unnamed = !store.householdNamed();

  return h(
    'section',
    { class: `card${unnamed ? ' card--deal' : ''}` },
    h(
      'div',
      { class: 'card__head' },
      h('h3', {}, 'Household'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'dept-note' }, pluralize(people.length, 'person', 'people')),
    ),
    h(
      'div',
      { class: 'card__body' },
      unnamed
        ? h(
            'div',
            { class: 'notice notice--deal' },
            h('strong', {}, 'Set the names first'),
            'Items like bagels, snacks, soda and cereal are tagged per person. Rename the placeholders below and those tags follow.',
          )
        : h(
            'p',
            { class: 'dept-note' },
            'Items can be tagged for a person, which drives the per-person badges and filters.',
          ),
    ),
    h(
      'ul',
      { class: 'rows' },
      people.map((person) =>
        h(
          'li',
          { class: 'row' },
          h('input', {
            type: 'text',
            value: person.name,
            'aria-label': `Name for ${person.name}`,
            style: { maxWidth: '18rem' },
            onChange: (e) => {
              store.renamePerson(person.id, e.target.value);
              ctx.rerender();
            },
          }),
          h('div', { class: 'row__main' }),
          h(
            'button',
            {
              class: 'icon-btn',
              type: 'button',
              title: 'Remove this person',
              'aria-label': `Remove ${person.name}`,
              onClick: () => {
                if (
                  confirm(
                    `Remove ${person.name}? Their items stay in the catalog, just no longer tagged to anyone.`,
                  )
                ) {
                  store.removePerson(person.id);
                  ctx.rerender();
                }
              },
            },
            '✕',
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'card__body' },
      h(
        'button',
        {
          class: 'btn btn--sm btn--ghost',
          onClick: () => {
            const name = prompt('Name for the new person?');
            if (name?.trim()) {
              store.addPerson(name);
              ctx.rerender();
            }
          },
        },
        '+ Add a person',
      ),
    ),
  );
}

// ── Aisle editor ─────────────────────────────────────────────────────────

function aisleEditor(ctx, depts) {
  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= depts.length) return;
    const reordered = [...depts];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved);
    reordered.forEach((d, i) => store.setDepartment(d.id, { order: (i + 1) * 10 }));
  }

  return h(
    'section',
    { class: 'card card--accent' },
    h(
      'div',
      { class: 'card__head' },
      h('h3', {}, 'Shopping route'),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn btn--sm btn--ghost',
          onClick: () => {
            if (confirm('Reset every aisle name and number back to the default layout?')) {
              store.resetDepartments();
              toast('Route reset to the default layout');
            }
          },
        },
        'Reset to default',
      ),
    ),
    h(
      'div',
      { class: 'card__body' },
      h(
        'p',
        { class: 'dept-note', style: { marginBottom: '0.75rem' } },
        'The order below is the order the list is grouped in while you shop. Walmart publishes no per-store aisle data, so this starts from a typical Neighborhood Market layout — walk your store once and correct the aisle numbers here.',
      ),
    ),
    h(
      'ul',
      { class: 'rows' },
      depts.map((dept, index) =>
        h(
          'li',
          { class: 'row' },
          h(
            'div',
            { class: 'row__actions' },
            h(
              'button',
              {
                class: 'icon-btn',
                type: 'button',
                'aria-label': `Move ${dept.name} earlier`,
                disabled: index === 0,
                onClick: () => move(index, -1),
              },
              '↑',
            ),
            h(
              'button',
              {
                class: 'icon-btn',
                type: 'button',
                'aria-label': `Move ${dept.name} later`,
                disabled: index === depts.length - 1,
                onClick: () => move(index, 1),
              },
              '↓',
            ),
          ),
          h('input', {
            type: 'text',
            value: dept.aisle,
            'aria-label': `Aisle sign for ${dept.name}`,
            style: { width: '6.75rem', flex: 'none', fontFamily: 'var(--mono)', fontSize: '0.85rem' },
            onChange: (e) => store.setDepartment(dept.id, { aisle: e.target.value.trim() || '—' }),
          }),
          h(
            'div',
            { class: 'row__main' },
            h(
              'div',
              { class: 'row__name' },
              h('input', {
                type: 'text',
                value: dept.name,
                'aria-label': `Name for ${dept.name}`,
                style: { border: '1px solid transparent', background: 'transparent', fontWeight: '600', padding: '0.2rem 0.3rem' },
                onChange: (e) => store.setDepartment(dept.id, { name: e.target.value.trim() || dept.name }),
              }),
            ),
            h('div', { class: 'row__meta' }, dept.signage),
          ),
        ),
      ),
    ),
  );
}

// ── Data management ──────────────────────────────────────────────────────

function dataCard(ctx, state) {
  const itemCount = store.items().length;
  const tripCount = state.trips.length;

  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'card__head' }, h('h3', {}, 'Your data')),
    h(
      'div',
      { class: 'card__body' },
      h(
        'div',
        { class: 'notice' },
        h('strong', {}, 'Everything lives in this browser'),
        `${pluralize(itemCount, 'catalog item')}, ${pluralize(Object.keys(state.list).length, 'item')} on the list and ${pluralize(tripCount, 'recorded trip')} are stored in this browser's local storage. Nothing is uploaded anywhere. To use the same history on another phone, export here and import there — and export now and then as a backup.`,
      ),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn btn--primary', onClick: downloadBackup }, 'Export a backup'),
        h('button', { class: 'btn btn--ghost', onClick: () => importBackup(ctx) }, 'Import a backup'),
        h(
          'button',
          {
            class: 'btn btn--danger',
            onClick: () => {
              if (
                confirm(
                  'Erase the list, all catalog edits and every recorded trip from this browser? Export a backup first if you want to keep the history.',
                )
              ) {
                store.resetEverything();
                toast('Everything reset');
              }
            },
          },
          'Erase everything',
        ),
      ),
    ),
  );
}

function downloadBackup() {
  const blob = new Blob([store.exportData()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', {
    href: url,
    download: `shopping-pal-${new Date().toISOString().slice(0, 10)}.json`,
  });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Backup downloaded');
}

function importBackup(ctx) {
  const file = h('input', { type: 'file', accept: 'application/json,.json', id: 'import-file' });
  const mergeRadio = h('input', { type: 'radio', name: 'import-mode', value: 'merge', checked: true, id: 'mode-merge' });
  const replaceRadio = h('input', { type: 'radio', name: 'import-mode', value: 'replace', id: 'mode-replace' });

  const dialog = modal(
    'Import a backup',
    h(
      'form',
      {
        onSubmit: async (e) => {
          e.preventDefault();
          const chosen = file.files?.[0];
          if (!chosen) return;
          try {
            const text = await chosen.text();
            store.importData(text, { merge: mergeRadio.checked });
            dialog.close();
            toast(mergeRadio.checked ? 'Backup merged in' : 'Backup restored');
            ctx.rerender();
          } catch (err) {
            alert(`Could not import that file.\n\n${err.message}`);
          }
        },
      },
      h('div', { class: 'field' }, h('label', { for: 'import-file' }, 'Backup file'), file),
      h(
        'div',
        { class: 'field' },
        h('label', {}, 'How to apply it'),
        h(
          'div',
          { style: { display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.35rem' } },
          mergeRadio,
          h('label', { for: 'mode-merge', style: { margin: 0, fontWeight: '400' } }, 'Merge — keep what is here and add anything new'),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '0.5rem', alignItems: 'center' } },
          replaceRadio,
          h('label', { for: 'mode-replace', style: { margin: 0, fontWeight: '400' } }, 'Replace — wipe this browser and use the file'),
        ),
      ),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn btn--primary', type: 'submit' }, 'Import'),
        h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
      ),
    ),
  );
}

function archivedCard(ctx, state) {
  if (!state.archived.length) return null;
  const names = new Map(CATALOG.map((i) => [i.id, i.name]));

  return h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card__head' },
      h('h3', {}, 'Removed from the catalog'),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn btn--sm btn--ghost',
          onClick: () => {
            store.restoreArchived();
            toast('Removed items restored');
            ctx.rerender();
          },
        },
        'Restore all',
      ),
    ),
    h(
      'div',
      { class: 'card__body' },
      h(
        'p',
        { class: 'dept-note' },
        state.archived.map((id) => names.get(id) ?? id).join(' · '),
      ),
    ),
  );
}

function aboutCard() {
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'card__head' }, h('h3', {}, 'Where the data comes from')),
    h(
      'div',
      { class: 'card__body' },
      h(
        'dl',
        { style: { margin: 0 } },
        about(
          'Your catalog',
          'Transcribed from the Notes list. Every edit you make is layered on top, so site updates never overwrite your changes.',
        ),
        about(
          'Publix BOGOs',
          'A scheduled GitHub Action fetches the weekly ad and commits it to data/bogos.json; the page reads that file. Publix blocks cross-origin browser requests, so it cannot be fetched live from the page. If the fetch fails the page says so and you can enter deals by hand.',
        ),
        about(
          'Aisle layout',
          'A typical Walmart Neighborhood Market department order, editable above. Walmart has no public per-store aisle API, so this is a sensible default rather than live store data.',
        ),
        about(
          'Trends',
          'Computed entirely from the trips you finish in the app. No trips, no numbers — nothing here is estimated or filled in for you.',
        ),
        about(
          'The shared list',
          'One encrypted file in this repo, locked with a 256-bit key the app generates. Encryption and decryption happen in your browser; the key travels only in the fragment of the invite link, which browsers never send to a server. Nobody without the link can read the file, and nobody can guess their way in.',
        ),
      ),
    ),
  );
}

function about(term, description) {
  return h(
    'div',
    { style: { marginBottom: '0.85rem' } },
    h('dt', { style: { fontWeight: '700', fontSize: '0.9rem' } }, term),
    h('dd', { style: { margin: '0.15rem 0 0', color: 'var(--ink-2)', fontSize: '0.9rem' } }, description),
  );
}
