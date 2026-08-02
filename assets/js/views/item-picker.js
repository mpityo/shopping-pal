/**
 * Type-to-search item picker.
 *
 * Replaces a `<select>` carrying the whole catalog. At 171 items that control
 * is unusable for the job it has in the receipt review — finding the one right
 * answer for a line like "GV SHRD MOZZ" meant scrolling an alphabetical list
 * on a phone, which is worse than the problem it was solving.
 *
 * The list is seeded with the receipt line's own text, so opening it already
 * shows the plausible answers ranked; typing narrows from there. Crucially it
 * also offers **adding a new item**, because "not in the catalog yet" is a
 * normal outcome, not a failure — whole carrots when only shredded and baby
 * are listed, or something the household has just started buying.
 *
 * The dropdown is positioned `fixed` rather than absolute: it lives inside a
 * scrolling table inside a dialog, and any other scheme gets it clipped by an
 * ancestor's `overflow`.
 */
import { h, matchScore } from '../util.js';

const MAX_RESULTS = 8;

/**
 * @param options   [{ id, name, meta }] — meta is the small grey line, usually
 *                  the department, which is what distinguishes three kinds of
 *                  carrot from each other.
 * @param seed      Text to rank against when nothing has been typed, i.e. what
 *                  the receipt actually said.
 * @param value     Currently selected id, or null.
 * @param onPick    (id | null) => void
 * @param onCreate  () => void, or null to hide the "add a new item" action.
 */
export function itemPicker({
  options,
  seed = '',
  value = null,
  label = 'Item',
  onPick = () => {},
  onCreate = null,
}) {
  let list = options;
  let selected = value;
  let active = -1;
  let open = false;
  let rows = [];

  const input = h('input', {
    type: 'text',
    class: 'combo__input',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-autocomplete': 'list',
    'aria-label': label,
    placeholder: 'Search the catalog…',
    autocomplete: 'off',
    spellcheck: false,
  });

  const menu = h('div', { class: 'combo__list', role: 'listbox', hidden: true });
  const node = h('div', { class: 'combo' }, input, menu);

  function nameOf(id) {
    return list.find((o) => o.id === id)?.name ?? '';
  }

  function showSelection() {
    input.value = selected ? nameOf(selected) : '';
    input.classList.toggle('combo__input--empty', !selected);
  }

  function results() {
    const query = input.value.trim();
    // Before anything is typed, rank against the receipt wording; after, rank
    // against what is being typed. Both directions, since a catalog name is
    // often contained in a longer receipt name and vice versa.
    const against = query || seed;
    if (!against) return list.slice(0, MAX_RESULTS);
    return list
      .map((option) => ({
        option,
        score: Math.max(matchScore(option.name, against), matchScore(against, option.name)),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.option.name.localeCompare(b.option.name))
      .slice(0, MAX_RESULTS)
      .map((r) => r.option);
  }

  function place() {
    const box = input.getBoundingClientRect();
    // Flip above when there is not room below — the last rows of a long
    // receipt sit near the bottom of the screen.
    const below = window.innerHeight - box.bottom;
    menu.style.left = `${box.left}px`;
    menu.style.width = `${box.width}px`;
    if (below < 220 && box.top > below) {
      menu.style.top = 'auto';
      menu.style.bottom = `${window.innerHeight - box.top + 2}px`;
      menu.style.maxHeight = `${Math.min(300, box.top - 8)}px`;
    } else {
      menu.style.bottom = 'auto';
      menu.style.top = `${box.bottom + 2}px`;
      menu.style.maxHeight = `${Math.min(300, below - 8)}px`;
    }
  }

  function render() {
    const found = results();
    rows = [];
    menu.replaceChildren();

    for (const option of found) {
      const row = h(
        'div',
        {
          class: 'combo__opt',
          role: 'option',
          'aria-selected': option.id === selected ? 'true' : 'false',
          // mousedown, not click: blur fires first on click and would close
          // the menu out from under the tap.
          onMousedown: (e) => {
            e.preventDefault();
            pick(option.id);
          },
        },
        h('span', { class: 'combo__name' }, option.name),
        option.meta ? h('span', { class: 'combo__meta' }, option.meta) : null,
      );
      rows.push({ node: row, run: () => pick(option.id) });
      menu.append(row);
    }

    if (!found.length) {
      menu.append(h('div', { class: 'combo__empty' }, 'Nothing in the catalog matches.'));
    }

    if (onCreate) {
      const typed = input.value.trim();
      const label = typed || seed;
      const row = h(
        'div',
        {
          class: 'combo__opt combo__opt--action',
          role: 'option',
          onMousedown: (e) => {
            e.preventDefault();
            close();
            onCreate(label);
          },
        },
        h('span', { class: 'combo__name' }, label ? `Add “${label}” as a new item` : 'Add a new item'),
      );
      rows.push({ node: row, run: () => { close(); onCreate(label); } });
      menu.append(row);
    }

    if (selected) {
      const row = h(
        'div',
        {
          class: 'combo__opt combo__opt--action',
          role: 'option',
          onMousedown: (e) => {
            e.preventDefault();
            pick(null);
          },
        },
        h('span', { class: 'combo__name' }, 'Leave this line out'),
      );
      rows.push({ node: row, run: () => pick(null) });
      menu.append(row);
    }

    active = found.length ? 0 : -1;
    highlight();
    place();
  }

  function highlight() {
    rows.forEach((r, i) => r.node.classList.toggle('combo__opt--active', i === active));
    rows[active]?.node.scrollIntoView({ block: 'nearest' });
  }

  function show() {
    if (open) return;
    open = true;
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    render();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
  }

  function close() {
    if (!open) return;
    open = false;
    menu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    showSelection();
  }

  function pick(id) {
    selected = id;
    close();
    showSelection();
    onPick(id);
  }

  input.addEventListener('focus', () => {
    input.select();
    show();
  });
  input.addEventListener('input', () => {
    if (!open) show();
    else render();
  });
  input.addEventListener('blur', () => close());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return show();
      if (!rows.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      highlight();
    } else if (e.key === 'Enter') {
      if (!open || active < 0) return;
      e.preventDefault();
      rows[active].run();
    } else if (e.key === 'Escape') {
      if (!open) return;
      e.preventDefault();
      // Stop the dialog closing with it — one Escape, one dismissal.
      e.stopPropagation();
      close();
    }
  });

  showSelection();

  return {
    node,
    /** After a new item is created, the catalog has changed underneath us. */
    setOptions(next) {
      list = next;
      showSelection();
    },
    setValue(id) {
      selected = id;
      showSelection();
    },
    focus: () => input.focus(),
  };
}
