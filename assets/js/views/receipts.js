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
import {
  parseReceipt,
  matchLines,
  formatMoney,
  aliasKey,
  receiptFingerprint,
  classifyAgainstTrip,
} from '../receipts.js';
import * as ocr from '../ocr.js';
import * as pdf from '../pdf.js';
import * as ai from '../ai.js';
import { itemPicker } from './item-picker.js';
import { departmentHint } from './ai-hints.js';

const STORES = ['Publix', 'Walmart', 'Target', 'Aldi', 'Costco', 'Other'];

/**
 * Turn whatever was handed over — PDF, photo, or plain text — into receipt
 * text. PDFs try their text layer first and fall back to OCR when there is
 * none, which is what a scanned receipt looks like.
 */
export async function extractText(file, onStatus = () => {}) {
  if (!file) return '';

  if (typeof file === 'string') return file;

  if (file.type?.startsWith('text/')) {
    onStatus('Reading…');
    return file.text();
  }

  if (pdf.isPdf(file)) {
    onStatus('Opening the PDF…');
    const { text, scanned } = await pdf.readPdf(file, {
      ocr,
      onProgress: (_, message) => onStatus(message),
    });
    if (scanned) toast('That PDF was a scan, so it was read as an image — check the lines');
    return text;
  }

  onStatus('Preparing the image…');
  const prepared = await ocr.prepareImage(file);
  onStatus('Downloading the reader (first time only)…');
  return ocr.readImage(prepared, (p) => onStatus(`Reading the receipt… ${Math.round(p * 100)}%`));
}

export function openImporter(ctx, { initialFile = null, initialText = '' } = {}) {
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
    accept: 'application/pdf,image/*,text/plain',
    onChange: (e) => e.target.files?.[0] && readFile(e.target.files[0]),
  });

  const status = h('p', { class: 'hint' });
  const error = h('p', { class: 'hint', style: { color: 'var(--alert)' } });

  async function readFile(file) {
    error.textContent = '';
    try {
      const text = await extractText(file, (message) => {
        status.textContent = message;
      });
      status.textContent = '';
      if (!text.trim()) {
        error.textContent =
          'Nothing readable came out of that. Try better light for a photo, or paste the text instead.';
        return;
      }
      textarea.value = text;
      toast('Receipt read — check the text, then continue');
    } catch (err) {
      status.textContent = '';
      error.textContent = err.message;
    }
  }

  if (initialFile) readFile(initialFile);
  if (initialText) textarea.value = initialText;

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
        h('label', { for: 'receipt-photo' }, '…or choose a PDF or photo'),
        h(
          'p',
          { class: 'hint' },
          'Emailed receipts are usually PDFs, and their text is read directly — as accurate as pasting. Photos of thermal paper need correcting more often. On Android you can share a receipt straight into this app from the share menu.',
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
  let catalog = store.items();
  const aliases = store.getState().aliases;
  const matched = matchLines(parsed.lines, catalog, aliases);

  const fingerprint = receiptFingerprint(parsed);
  const alreadyImported = store.receiptAlreadyImported(fingerprint);
  const initialDate = parsed.date ?? new Date().toISOString().slice(0, 10);

  const dateInput = h('input', {
    type: 'date',
    id: 'receipt-date',
    value: initialDate,
    max: new Date().toISOString().slice(0, 10),
    onChange: () => refreshDuplicates(),
  });
  const storeSelect = h(
    'select',
    { id: 'receipt-store', onChange: () => refreshDuplicates() },
    STORES.map((s) => h('option', { value: s, selected: s === parsed.store }, s)),
  );

  /** One row of editable state per parsed line. */
  const rows = matched.map((m) => ({
    ...m,
    include: true,
    qty: m.line.qty,
    status: 'new',
    // Remember whether the mapping was chosen by hand, so only real decisions
    // are learned as aliases.
    taught: false,
  }));

  const summary = h('p', { class: 'dept-note' });
  const dupNotice = h('div', {});
  const tableBody = h('tbody', {});
  const aiNotice = h('div', {});

  /**
   * Re-check the parsed lines against whatever is already recorded for the
   * chosen date. Sharing the same receipt twice is easy to do from a phone,
   * and appending a second Walmart run to an existing trip is a normal thing
   * to want — so duplicates are flagged and pre-excluded rather than either
   * silently doubled or silently dropped.
   */
  function refreshDuplicates() {
    const existing = store.tripLinesOn(dateInput.value);
    const { rows: flagged, uncovered } = classifyAgainstTrip(
      rows.map((r) => ({ ...r, store: storeSelect.value })),
      existing,
    );

    const counts = { enrich: 0, duplicate: 0, new: 0 };
    flagged.forEach((f, i) => {
      const row = rows[i];
      const changed = row.status !== f.status;
      row.status = f.status;
      counts[f.status]++;
      // Only auto-toggle when the classification actually changed, so a
      // deliberate override survives the next refresh.
      if (changed) {
        row.include = f.status !== 'duplicate';
        const box = tableBody.children[i]?.querySelector('input[type="checkbox"]');
        if (box) box.checked = row.include;
        if (tableBody.children[i]) {
          tableBody.children[i].style.opacity = row.include ? '1' : '0.45';
        }
      }
      if (tableBody.children[i]) {
        tableBody.children[i].style.background =
          f.status === 'duplicate'
            ? 'var(--alert-tint)'
            : !settled(row)
              ? 'var(--deal-tint)'
              : '';
      }
      const note = tableBody.children[i]?.querySelector('[data-note]');
      if (note) note.textContent = noteFor(row);
    });

    const messages = [];
    if (counts.enrich) {
      messages.push(
        h(
          'div',
          { class: 'notice' },
          h(
            'strong',
            {},
            `${pluralize(counts.enrich, 'line')} ${counts.enrich === 1 ? 'matches' : 'match'} what you checked off`,
          ),
          'Those already count as bought — the receipt is filling in what they cost, not adding them again.',
        ),
      );
    }
    if (counts.duplicate) {
      messages.push(
        h(
          'div',
          { class: 'notice notice--warn' },
          h(
            'strong',
            {},
            `${pluralize(counts.duplicate, 'line')} already recorded with a price`,
          ),
          'Unticked below. Tick one only if you genuinely bought it twice.',
        ),
      );
    }
    if (uncovered.length) {
      messages.push(
        h(
          'div',
          { class: 'notice' },
          h(
            'strong',
            {},
            `${pluralize(uncovered.length, 'checked-off item')} not on this receipt`,
          ),
          `${uncovered
            .slice(0, 8)
            .map((l) => l.name)
            .join(', ')}${uncovered.length > 8 ? '…' : ''} — left as they are. If it was a two-shop trip, share the other receipt too.`,
        ),
      );
    }
    dupNotice.replaceChildren(...messages);
    refreshSummary();
  }

  /** A mapping nobody needs to look at again: exact, taught, or just created. */
  function settled(row) {
    return ['high', 'alias', 'created'].includes(row.confidence);
  }

  function noteFor(row) {
    if (row.status === 'duplicate') return 'already recorded with a price';
    if (row.status === 'enrich') return 'you checked this off — adding the price';
    if (row.confidence === 'created') return 'new catalog item';
    if (row.confidence === 'alias') return 'learned previously';
    if (row.confidence === 'high') return 'matched';
    if (row.confidence === 'ai-high') return 'read by Claude — worth a glance';
    if (row.confidence === 'ai-low') return 'Claude’s best guess — please check';
    if (row.confidence === 'low') return 'unsure — please check';
    return 'no match — pick one';
  }

  /** Rows the fuzzy matcher could not place, and so worth spending a call on. */
  function unresolved() {
    return rows.map((row, index) => ({ row, index })).filter(({ row }) => !row.itemId);
  }

  /**
   * Hand the leftovers to Claude.
   *
   * Only the lines the local matcher gave up on are sent, which is the whole
   * economy of this: a receipt whose names already resolve costs nothing. What
   * comes back is a suggestion in the same table as everything else — it is
   * pre-selected, never auto-imported, and the row says where it came from so
   * a wrong guess is obvious rather than silent.
   */
  async function askClaude() {
    const pending = unresolved();
    if (!pending.length) return;

    aiNotice.replaceChildren(
      h(
        'div',
        { class: 'notice' },
        h('strong', {}, `Reading ${pluralize(pending.length, 'unmatched line')} with Claude…`),
        'Only the line text and your catalog names are sent. Prices, totals and the receipt itself stay here.',
      ),
    );

    try {
      const suggestions = await ai.matchReceiptLines(
        pending.map(({ row }) => row.line),
        catalog,
      );

      let applied = 0;
      suggestions.forEach((suggestion, offset) => {
        const target = pending[offset];
        if (!target) return;
        target.row.itemId = suggestion.itemId;
        target.row.confidence = suggestion.confidence === 'high' ? 'ai-high' : 'ai-low';
        target.row.picker?.setValue(suggestion.itemId);
        applied++;
      });

      aiNotice.replaceChildren(
        applied
          ? h(
              'div',
              { class: 'notice notice--deal' },
              h(
                'strong',
                {},
                `Claude matched ${applied} of ${pluralize(pending.length, 'unmatched line')}`,
              ),
              'Highlighted below. Check them before importing — a wrong match quietly skews every trend, and the ones you keep are remembered for next time.',
            )
          : h(
              'div',
              { class: 'notice' },
              h('strong', {}, 'Claude could not place those lines either'),
              'Pick them by hand below, or leave them out. Whatever you pick is remembered.',
            ),
      );

      refreshDuplicates();
    } catch (err) {
      aiNotice.replaceChildren(
        h(
          'div',
          { class: 'notice notice--warn' },
          h('strong', {}, 'Claude could not be reached'),
          `${err.message} Match the remaining lines by hand — nothing else is affected.`,
        ),
      );
    }
  }

  function refreshSummary() {
    const kept = rows.filter((r) => r.include && r.itemId);
    const cents = kept.reduce((sum, r) => sum + r.line.priceCents, 0);
    const unmatched = rows.filter((r) => r.include && !r.itemId).length;
    const adding = kept.filter((r) => r.status === 'new').length;
    const pricing = kept.filter((r) => r.status === 'enrich').length;
    summary.replaceChildren(
      h(
        'span',
        { dataset: { summary: '1' } },
        `${pluralize(kept.length, 'line')} ready · ${formatMoney(cents)}`,
        pricing ? ` · ${pricing} pricing what you checked off` : '',
        adding ? ` · ${adding} new to the trip` : '',
        unmatched ? ` · ${unmatched} still need an item` : '',
      ),
    );
  }

  /** Catalog entries shaped for the picker, with the aisle as the tiebreaker. */
  function pickerOptions() {
    const deptNames = new Map(store.departments().map((d) => [d.id, d.name]));
    return catalog.map((item) => ({
      id: item.id,
      name: item.name,
      meta: [deptNames.get(item.dept), item.note].filter(Boolean).join(' · '),
    }));
  }

  function buildPicker(row) {
    const picker = itemPicker({
      options: pickerOptions(),
      // Seeded with what the receipt said, so opening the list already shows
      // the plausible answers rather than the alphabet.
      seed: row.line.name,
      value: row.itemId,
      label: `Item for ${row.line.name}`,
      onPick: (id) => {
        row.itemId = id;
        row.taught = Boolean(id);
        refreshSummary();
        refreshDuplicates();
      },
      onCreate: (name) => createItemFor(row, name),
    });
    // Kept so a suggestion arriving later can move the control the user is
    // already looking at, and so a new item can be added to every row's list.
    row.picker = picker;
    return picker.node;
  }

  /**
   * Add something the catalog has never had, without losing the import.
   *
   * "Not in the catalog" is a normal outcome rather than a failure: whole
   * carrots when only shredded and baby are listed, or something the house
   * has just started buying. Forcing it into the nearest wrong item is how
   * the trends quietly become fiction, and skipping it loses the purchase
   * altogether.
   */
  function createItemFor(row, prefill) {
    const nameInput = h('input', {
      type: 'text',
      id: 'new-item-name',
      value: prefill || row.line.name,
      required: true,
    });
    const deptSelect = h(
      'select',
      { id: 'new-item-dept' },
      store.departments().map((d) => h('option', { value: d.id }, `${d.name} — ${d.aisle}`)),
    );
    const noteInput = h('input', { type: 'text', id: 'new-item-note', placeholder: 'Brand, size…' });
    const personSelect = h(
      'select',
      { id: 'new-item-person' },
      h('option', { value: '' }, 'Everyone'),
      store.people().map((p) => h('option', { value: p.id }, p.name)),
    );

    const hint = departmentHint(deptSelect);
    hint.ask(nameInput.value);
    nameInput.addEventListener('change', () => hint.ask(nameInput.value));

    const dialog = modal(
      'Add to the catalog',
      h(
        'form',
        {
          onSubmit: (e) => {
            e.preventDefault();
            const name = nameInput.value.trim();
            if (!name) return;
            const id = store.addCustomItem({
              name,
              dept: deptSelect.value,
              note: noteInput.value.trim(),
              person: personSelect.value || null,
            });
            // The catalog changed underneath every open picker.
            catalog = store.items();
            const options = pickerOptions();
            for (const other of rows) other.picker?.setOptions(options);

            row.itemId = id;
            row.taught = true;
            row.confidence = 'created';
            row.picker?.setValue(id);
            dialog.close();
            refreshSummary();
            refreshDuplicates();
            toast(`${name} added to the catalog`);
          },
        },
        h(
          'p',
          { class: 'hint' },
          `The receipt says “${row.line.name}”. Adding it here records this purchase and matches it automatically on every future receipt.`,
        ),
        h('div', { class: 'field' }, h('label', { for: 'new-item-name' }, 'Name'), nameInput),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'new-item-dept' }, 'Where is it in the store?'),
          deptSelect,
          hint.node,
        ),
        h('div', { class: 'field' }, h('label', { for: 'new-item-note' }, 'Note (optional)'), noteInput),
        h('div', { class: 'field' }, h('label', { for: 'new-item-person' }, 'For (optional)'), personSelect),
        h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn btn--primary', type: 'submit' }, 'Add and use it'),
          h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
        ),
      ),
    );
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
        h('div', { class: 'dept-note', dataset: { note: '1' } }, noteFor(row)),
      ),
      h('td', { class: 'num' }, String(row.qty)),
      h('td', { class: 'num' }, formatMoney(row.line.priceCents)),
      h('td', { style: { minWidth: '16rem' } }, buildPicker(row)),
    );
    if (!settled(row)) {
      tr.style.background = 'var(--deal-tint)';
    }
    tr.dataset.line = String(row.line.priceCents);
    tableBody.append(tr);
  }
  refreshSummary();
  refreshDuplicates();
  if (ai.hasKey() && store.getState().prefs.aiMatch !== false) askClaude();

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
      alreadyImported
        ? h(
            'div',
            { class: 'notice notice--warn' },
            h('strong', {}, 'This exact receipt has been imported before'),
            `It went in on ${alreadyImported.date}${alreadyImported.store ? ` as ${alreadyImported.store}` : ''}. Importing it again would double those items, so every line matching what is already recorded is unticked below.`,
          )
        : null,
      reconcile,
      aiNotice,
      dupNotice,
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

              // Lines going in without a home are not simply discarded. The
              // third time one shows up it is worth saying so, and by then
              // the purchases can be backfilled from what was recorded here.
              store.noteUnmatched(
                rows
                  .filter((r) => !r.itemId)
                  .map((r) => ({
                    name: r.line.name,
                    date: dateInput.value,
                    store: storeSelect.value,
                    priceCents: r.line.priceCents,
                    qty: r.qty,
                  })),
              );
              const learned = {};
              for (const row of kept) {
                // A confident match left untouched in this table has been
                // confirmed by the person reading it, whether it came from the
                // fuzzy matcher or from Claude. A hedged one has not, so it is
                // used for this import but not remembered.
                if (row.taught || row.confidence === 'high' || row.confidence === 'ai-high') {
                  learned[aliasKey(row.line.name)] = row.itemId;
                }
              }
              const count = store.learnAliases(learned);

              const trip = store.importReceipt({
                date: dateInput.value,
                store: storeSelect.value,
                totalCents: parsed.totalCents,
                fingerprint,
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
