import { h, matchScore, modal, toast, pluralize } from '../util.js';
import * as store from '../store.js';
import { allDeals, matchDealsToCatalog, feedAgeDays, isStale } from '../deals-data.js';
import { formatLongDate } from '../insights.js';

let query = '';
let onlyMatches = false;

export function renderDeals(ctx) {
  const state = store.getState();
  const feed = ctx.deals;
  const catalog = store.items();
  const matches = matchDealsToCatalog(feed, catalog, state.manualDeals);
  const matchByDealKey = new Map(matches.map((m) => [dealKey(m.deal), m]));
  const onList = new Set(Object.keys(state.list));

  const deals = allDeals(feed, state.manualDeals).filter((d) => {
    if (onlyMatches && !matchByDealKey.has(dealKey(d))) return false;
    if (!query) return true;
    return matchScore(`${d.title} ${d.brand ?? ''} ${d.category ?? ''}`, query) > 0;
  });

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'page-head' },
      h('p', { class: 'eyebrow' }, 'Publix'),
      h('h2', {}, 'This week’s BOGOs'),
      h(
        'p',
        {},
        'Buy-one-get-one deals from the Publix weekly ad, cross-referenced against the things you actually buy.',
      ),
    ),

    feedStatus(feed, state),

    matches.length
      ? h(
          'section',
          { class: 'card card--deal' },
          h(
            'div',
            { class: 'card__head' },
            h('h3', {}, `${pluralize(matches.length, 'item')} you buy ${matches.length === 1 ? 'is' : 'are'} BOGO`),
          ),
          h(
            'ul',
            { class: 'rows' },
            matches.map((m) =>
              h(
                'li',
                { class: 'row' },
                h(
                  'div',
                  { class: 'row__main' },
                  h(
                    'div',
                    { class: 'row__name' },
                    m.item.name,
                    m.deal.origin === 'manual' && h('span', { class: 'badge badge--plain' }, 'Added by hand'),
                  ),
                  h('div', { class: 'row__meta' }, m.deal.title, m.deal.savings && h('span', {}, m.deal.savings)),
                ),
                h(
                  'button',
                  {
                    class: `btn btn--sm ${onList.has(m.item.id) ? 'btn--ghost' : 'btn--primary'}`,
                    onClick: () => {
                      if (onList.has(m.item.id)) store.removeFromList(m.item.id);
                      else {
                        store.addToList(m.item.id, { note: 'BOGO at Publix' });
                        toast(`Added ${m.item.name}`);
                      }
                    },
                  },
                  onList.has(m.item.id) ? 'On list ✓' : 'Add',
                ),
              ),
            ),
          ),
        )
      : null,

    h(
      'div',
      { class: 'toolbar' },
      h(
        'div',
        { class: 'searchbar', style: { flex: '1 1 16rem', marginBottom: 0 } },
        h('input', {
          type: 'search',
          id: 'deal-search',
          placeholder: 'Search the BOGO list…',
          value: query,
          'aria-label': 'Search deals',
          onInput: (e) => {
            query = e.target.value;
            ctx.rerender({ focus: 'deal-search' });
          },
        }),
      ),
      h(
        'button',
        {
          class: 'chip',
          type: 'button',
          'aria-pressed': String(onlyMatches),
          onClick: () => {
            onlyMatches = !onlyMatches;
            ctx.rerender();
          },
        },
        'Only things we buy',
      ),
      h('button', { class: 'btn btn--sm btn--ghost', onClick: () => addDealByHand(ctx) }, '+ Add a deal'),
    ),

    deals.length
      ? h(
          'section',
          { class: 'card' },
          h(
            'div',
            { class: 'card__head' },
            h('h3', {}, 'All BOGO deals'),
            h('span', { class: 'spacer' }),
            h('span', { class: 'dept-note' }, pluralize(deals.length, 'deal')),
          ),
          h(
            'ul',
            { class: 'rows' },
            deals.map((deal) => dealRow(ctx, deal, matchByDealKey.get(dealKey(deal)), onList)),
          ),
        )
      : emptyDeals(feed),
  );
}

function dealRow(ctx, deal, match, onList) {
  return h(
    'li',
    { class: 'row' },
    h(
      'div',
      { class: 'row__main' },
      h(
        'div',
        { class: 'row__name' },
        deal.title,
        match && h('span', { class: 'badge badge--deal' }, 'You buy this'),
        deal.origin === 'manual' && h('span', { class: 'badge badge--plain' }, 'By hand'),
      ),
      h(
        'div',
        { class: 'row__meta' },
        deal.brand && h('span', {}, deal.brand),
        deal.category && h('span', {}, deal.category),
        deal.savings && h('span', {}, deal.savings),
      ),
    ),
    h(
      'div',
      { class: 'row__actions' },
      deal.origin === 'manual' &&
        h(
          'button',
          {
            class: 'icon-btn',
            type: 'button',
            'aria-label': `Delete ${deal.title}`,
            title: 'Delete',
            onClick: () => store.removeManualDeal(deal.id),
          },
          '✕',
        ),
      match
        ? h(
            'button',
            {
              class: `btn btn--sm ${onList.has(match.item.id) ? 'btn--ghost' : 'btn--primary'}`,
              onClick: () => {
                if (onList.has(match.item.id)) store.removeFromList(match.item.id);
                else {
                  store.addToList(match.item.id, { note: 'BOGO at Publix' });
                  toast(`Added ${match.item.name}`);
                }
              },
            },
            onList.has(match.item.id) ? 'On list ✓' : `Add ${match.item.name}`,
          )
        : h(
            'button',
            {
              class: 'btn btn--sm btn--ghost',
              onClick: () => addAsNewItem(ctx, deal),
            },
            'Add to list',
          ),
    ),
  );
}

function feedStatus(feed, state) {
  const age = feedAgeDays(feed);
  const manualCount = state.manualDeals.length;

  if (feed.status === 'ok' && !isStale(feed)) {
    return h(
      'div',
      { class: 'notice notice--deal' },
      h('strong', {}, `Ad updated ${formatLongDate(feed.updated.slice(0, 10))}`),
      [
        feed.store ? `Store: ${feed.store}.` : null,
        feed.validThrough ? `Valid through ${feed.validThrough}.` : null,
        `${pluralize(feed.deals.length, 'BOGO deal')} in the feed.`,
        manualCount ? `${pluralize(manualCount, 'deal')} added by hand.` : null,
      ]
        .filter(Boolean)
        .join(' '),
    );
  }

  if (feed.status === 'ok' && isStale(feed)) {
    return h(
      'div',
      { class: 'notice notice--warn' },
      h('strong', {}, `The BOGO feed is ${age} days old`),
      'The deals below may have expired — check the ad in store, or add this week’s deals by hand.',
      lastAttemptLine(feed),
    );
  }

  return h(
    'div',
    { class: 'notice notice--warn' },
    h('strong', {}, 'No BOGO feed yet'),
    'Nothing has been published to data/bogos.json. The “Refresh Publix BOGOs” workflow writes that file; until it succeeds, deals can be added by hand and everything else here still works.',
    lastAttemptLine(feed),
  );
}

/** Surfaces why the scheduled refresh is not producing fresh deals. */
function lastAttemptLine(feed) {
  if (!feed.lastAttempt) return null;
  return h(
    'p',
    { class: 'dept-note', style: { marginTop: '0.5rem', marginBottom: 0 } },
    `Last refresh attempt ${formatLongDate(feed.lastAttempt.slice(0, 10))}`,
    feed.lastError ? ` — it failed: ${feed.lastError}` : '.',
  );
}

function emptyDeals(feed) {
  return h(
    'div',
    { class: 'empty' },
    h('h3', {}, feed.status === 'ok' ? 'No deals match' : 'No deals loaded'),
    h(
      'p',
      {},
      feed.status === 'ok'
        ? 'Try clearing the search or the “only things we buy” filter.'
        : 'Once the refresh workflow runs, this week’s BOGOs appear here automatically.',
    ),
    h(
      'a',
      { class: 'btn btn--ghost', href: 'https://www.publix.com/savings/weekly-ad', target: '_blank', rel: 'noopener' },
      'Open the Publix weekly ad',
    ),
  );
}

function addDealByHand(ctx) {
  const title = h('input', { type: 'text', id: 'deal-title', required: true, placeholder: 'e.g. Cascadian Farm Cereal' });
  const savings = h('input', { type: 'text', id: 'deal-savings', placeholder: 'e.g. BOGO, save up to $4.99' });

  const dialog = modal(
    'Add a deal by hand',
    h(
      'form',
      {
        onSubmit: (e) => {
          e.preventDefault();
          if (!title.value.trim()) return;
          store.addManualDeal({ title: title.value.trim(), savings: savings.value.trim() });
          dialog.close();
          toast('Deal added');
          ctx.rerender();
        },
      },
      h(
        'p',
        { class: 'hint' },
        'For deals spotted in the paper ad or in store. These are matched against your catalog the same way the fetched ones are.',
      ),
      h('div', { class: 'field' }, h('label', { for: 'deal-title' }, 'What’s on offer'), title),
      h('div', { class: 'field' }, h('label', { for: 'deal-savings' }, 'Details (optional)'), savings),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn btn--primary', type: 'submit' }, 'Add deal'),
        h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
      ),
    ),
  );
}

/** A deal with no catalog match can still go on the list as a new item. */
function addAsNewItem(ctx, deal) {
  const depts = store.departments();
  const name = h('input', { type: 'text', id: 'deal-item-name', value: deal.title, required: true });
  const dept = h(
    'select',
    { id: 'deal-item-dept' },
    depts.map((d) => h('option', { value: d.id }, `${d.name} — ${d.aisle}`)),
  );

  const dialog = modal(
    'Add this deal to the list',
    h(
      'form',
      {
        onSubmit: (e) => {
          e.preventDefault();
          const id = store.addCustomItem({ name: name.value.trim(), dept: dept.value, note: 'BOGO at Publix' });
          store.addToList(id, { note: 'BOGO at Publix' });
          dialog.close();
          toast(`Added ${name.value.trim()}`);
          ctx.rerender();
        },
      },
      h('p', { class: 'hint' }, 'This is not in your catalog yet — give it a name you’d recognize and an aisle.'),
      h('div', { class: 'field' }, h('label', { for: 'deal-item-name' }, 'Name'), name),
      h('div', { class: 'field' }, h('label', { for: 'deal-item-dept' }, 'Department / aisle'), dept),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn btn--primary', type: 'submit' }, 'Add to list'),
        h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
      ),
    ),
  );
}

function dealKey(deal) {
  return deal.id ?? deal.title;
}
