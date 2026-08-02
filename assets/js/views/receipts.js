/**
 * Receipt import.
 *
 * Every line is reviewed before anything is written. Trips are the only source
 * for every trend in the app, so a mis-parsed line does not just look untidy —
 * it quietly corrupts the numbers the app exists to produce. Nothing here
 * imports without a human looking at it.
 *
 * Corrections are remembered. "GV SHRD MOZZ" will never fuzzy-match shredded
 * cheese, so the review step doubles as teaching: fix it once and every future
 * receipt maps it without asking.
 */
import { h, modal, toast, pluralize, matchScore } from '../util.js';
import * as store from '../store.js';
import { parseReceipt, matchLines, formatMoney, aliasKey } from '../receipts.js';
import * as ocr from '../ocr.js';

const STORES = ['Publix', 'Walmart', 'Target', 'Aldi', 'Costco', 'Other'];

export function openImporter(ctx) {
  const textarea = h('textarea', {
    id: 'receipt-text',
    rows: 10,
    placeholder:
      'Paste the receipt text here.\n\nPublix and Walmart both email receipts, and both apps show them — copy the whole thing, including the totals.',
    style: { fontFamily: 'var(--mono)', fontSize: '0.8rem' },
  });

  const fileInput = h('input', {
    type: 'file',
    id: 'receipt-photo',
    accept: 'image/*',
    capture: 'environment',
    onChange: (e) => e.target.files?.[0] && runOcr(e.target.files[0]),
  });

  const status = h('p', { class: 'hint' });
  const error = h('p', { class: 'hint', style: { color: 'var(--alert)' } });

  async function runOcr(file) {
    error.textContent = '';
    status.textContent = 'Preparing the image…';
    try {
      const prepared = await ocr.prepareImage(file);
      status.textContent = 'Downloading the reader (first time only)…';
      const text = await ocr.readImage(prepared, (p) => {
        status.textContent = `Reading the receipt… ${Math.round(p * 100)}%`;
      });
      status.textContent = '';
      if (!text.trim()) {
        error.textContent = 'Nothing readable came out of that photo. Try better light, or paste the text instead.';
        return;
      }
      textarea.value = text;
      toast('Photo read — check the text, then continue');
    } catch (err) {
      status.textContent = '';
      error.textContent = err.message;
    }
  }

  const dialog = modal(
    'Import a receipt',
    h(
      'div',
      {},
      h(
        'p',
        { class: 'hint' },
        'Turns a receipt into a recorded trip, so the trends have real history to work from. Photos are read on your device and never uploaded.',
      ),
      h('div', { class: 'field' }, h('label', { for: 'receipt-text' }, 'Receipt text'), textarea),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'receipt-photo' }, '…or photograph a paper receipt'),
        h(
          'p',
          { class: 'hint' },
          'Pasted text is far more accurate. Photos of thermal paper need correcting more often.',
        ),
        fileInput,
      ),
      status,
      error,
      h(
        'div',
        { class: 'btn-row' },
        h(
          'button',
          {
            class: 'btn btn--primary',
            onClick: () => {
              const parsed = parseReceipt(textarea.value);
              if (!parsed.lines.length) {
                error.textContent =
                  'No item lines found. Make sure the text includes the item names with their prices.';
                return;
              }
              dialog.close();
              openReview(ctx, parsed);
            },
          },
          'Read the receipt',
        ),
        h('button', { class: 'btn btn--ghost', onClick: () => dialog.close() }, 'Cancel'),
      ),
    ),
    { wide: true },
  );
}

// ── Review ───────────────────────────────────────────────────────────────

function openReview(ctx, parsed) {
  const catalog = store.items();
  const aliases = store.getState().aliases;
  const matched = matchLines(parsed.lines, catalog, aliases);

  const dateInput = h('input', {
    type: 'date',
    id: 'receipt-date',
    value: parsed.date ?? new Date().toISOString().slice(0, 10),
    max: new Date().toISOString().slice(0, 10),
  });
  const storeSelect = h(
    'select',
    { id: 'receipt-store' },
    STORES.map((s) => h('option', { value: s, selected: s === parsed.store }, s)),
  );

  /** One row of editable state per parsed line. */
  const rows = matched.map((m) => ({
    ...m,
    include: true,
    qty: m.line.qty,
    // Remember whether the mapping was chosen by hand, so only real decisions
    // are learned as aliases.
    taught: false,
  }));

  const summary = h('p', { class: 'dept-note' });
  const tableBody = h('tbody', {});

  function refreshSummary() {
    const kept = rows.filter((r) => r.include && r.itemId);
    const cents = kept.reduce((sum, r) => sum + r.line.priceCents, 0);
    const unmatched = rows.filter((r) => r.include && !r.itemId).length;
    summary.replaceChildren(
      h(
        'span',
        {},
        `${pluralize(kept.length, 'line')} ready · ${formatMoney(cents)}`,
        unmatched ? ` · ${unmatched} still need an item` : '',
      ),
    );
  }

  function itemPicker(row) {
    // Candidates first, then everything else, so the likely answer is at hand
    // without hiding the rest of the catalog.
    const ranked = [
      ...row.candidates,
      ...catalog
        .filter((i) => !row.candidates.some((c) => c.id === i.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ];
    const select = h(
      'select',
      {
        'aria-label': `Item for ${row.line.name}`,
        onChange: (e) => {
          row.itemId = e.target.value || null;
          row.taught = Boolean(e.target.value);
          refreshSummary();
        },
      },
      h('option', { value: '' }, '— skip this line —'),
      ranked.map((item) =>
        h(
          'option',
          { value: item.id, selected: item.id === row.itemId },
          row.candidates.some((c) => c.id === item.id) ? `★ ${item.name}` : item.name,
        ),
      ),
    );
    return select;
  }

  for (const row of rows) {
    const tr = h(
      'tr',
      {},
      h(
        'td',
        {},
        h('input', {
          type: 'checkbox',
          class: 'check',
          checked: true,
          'aria-label': `Include ${row.line.name}`,
          style: { width: '20px', height: '20px' },
          onChange: (e) => {
            row.include = e.target.checked;
            tr.style.opacity = e.target.checked ? '1' : '0.45';
            refreshSummary();
          },
        }),
      ),
      h(
        'td',
        { style: { whiteSpace: 'normal', maxWidth: '14rem' } },
        h('div', {}, row.line.name),
        h(
          'div',
          { class: 'dept-note' },
          row.confidence === 'alias'
            ? 'learned previously'
            : row.confidence === 'high'
              ? 'matched'
              : row.confidence === 'low'
                ? 'unsure — please check'
                : 'no match — pick one',
        ),
      ),
      h('td', { class: 'num' }, String(row.qty)),
      h('td', { class: 'num' }, formatMoney(row.line.priceCents)),
      h('td', { style: { minWidth: '15rem' } }, itemPicker(row)),
    );
    if (row.confidence !== 'high' && row.confidence !== 'alias') {
      tr.style.background = 'var(--deal-tint)';
    }
    tableBody.append(tr);
  }
  refreshSummary();

  const reconcile =
    parsed.totalCents == null
      ? null
      : h(
          'div',
          { class: `notice${parsed.reconciles ? '' : ' notice--warn'}` },
          h(
            'strong',
            {},
            parsed.reconciles
              ? `Lines add up to the printed total, ${formatMoney(parsed.totalCents)}`
              : `Lines do not add up to the printed total`,
          ),
          `${formatMoney(parsed.itemsCents)} in items` +
            (parsed.discountCents ? ` − ${formatMoney(parsed.discountCents)} savings` : '') +
            (parsed.taxCents ? ` + ${formatMoney(parsed.taxCents)} tax` : '') +
            ` = ${formatMoney(parsed.itemsCents - parsed.discountCents + parsed.taxCents)}` +
            (parsed.reconciles
              ? '.'
              : `, but the receipt says ${formatMoney(parsed.totalCents)}. Something was probably misread — worth checking the lines below.`),
        );

  const dialog = modal(
    'Check before importing',
    h(
      'div',
      {},
      reconcile,
      h(
        'div',
        { class: 'cols cols--2' },
        h('div', { class: 'field' }, h('label', { for: 'receipt-date' }, 'Trip date'), dateInput),
        h('div', { class: 'field' }, h('label', { for: 'receipt-store' }, 'Store'), storeSelect),
      ),
      h(
        'p',
        { class: 'hint' },
        'Importing a second receipt with the same date merges into that trip — the Publix run and the Walmart run count as one outing.',
      ),
      h(
        'div',
        { class: 'table-wrap', style: { maxHeight: '45vh', overflowY: 'auto' } },
        h(
          'table',
          {},
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', {}, ''),
              h('th', {}, 'On the receipt'),
              h('th', {}, 'Qty'),
              h('th', {}, 'Price'),
              h('th', {}, 'Is this…'),
            ),
          ),
          tableBody,
        ),
      ),
      h('div', { style: { margin: '0.75rem 0' } }, summary),
      h(
        'div',
        { class: 'btn-row' },
        h(
          'button',
          {
            class: 'btn btn--primary',
            onClick: () => {
              const kept = rows.filter((r) => r.include && r.itemId);
              if (!kept.length) {
                toast('Nothing selected to import');
                return;
              }
              const learned = {};
              for (const row of kept) {
                if (row.taught || row.confidence === 'high') {
                  learned[aliasKey(row.line.name)] = row.itemId;
                }
              }
              const count = store.learnAliases(learned);

              const trip = store.importReceipt({
                date: dateInput.value,
                store: storeSelect.value,
                totalCents: parsed.totalCents,
                lines: kept.map((r) => ({
                  itemId: r.itemId,
                  qty: r.qty,
                  priceCents: r.line.priceCents,
                })),
              });
              dialog.close();
              if (trip) {
                toast(
                  `Imported ${pluralize(kept.length, 'item')} into ${trip.date}` +
                    (count ? ` · learned ${pluralize(count, 'name')}` : ''),
                );
              }
              ctx.rerender();
            },
          },
          'Import into the trip',
        ),
        h('button', { class: 'btn btn--ghost', onClick: () => dialog.close() }, 'Cancel'),
      ),
    ),
    { wide: true },
  );
}

/** Lets a mis-taught mapping be undone without digging through a backup. */
export function aliasManager(ctx) {
  const aliases = store.getState().aliases;
  const byId = new Map(store.items().map((i) => [i.id, i]));
  const entries = Object.entries(aliases);

  modal(
    'Learned receipt names',
    entries.length
      ? h(
          'div',
          {},
          h(
            'p',
            { class: 'hint' },
            'What the app has been taught receipt wording means. Remove one to be asked again next time.',
          ),
          h(
            'ul',
            { class: 'rows' },
            entries
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([key, id]) =>
                h(
                  'li',
                  { class: 'row' },
                  h(
                    'div',
                    { class: 'row__main' },
                    h('div', { class: 'row__name' }, key),
                    h('div', { class: 'row__meta' }, `→ ${byId.get(id)?.name ?? '(removed item)'}`),
                  ),
                  h(
                    'button',
                    {
                      class: 'icon-btn',
                      type: 'button',
                      'aria-label': `Forget ${key}`,
                      onClick: (e) => {
                        store.forgetAlias(key);
                        e.target.closest('li').remove();
                      },
                    },
                    '✕',
                  ),
                ),
              ),
          ),
        )
      : h('p', {}, 'Nothing learned yet. Import a receipt and correct any wrong matches — those corrections land here.'),
    { wide: true },
  );
}
