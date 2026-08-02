/**
 * View-layer glue for Claude's suggestions.
 *
 * Kept apart from `ai.js` so that module stays a plain API client with no DOM
 * in it, and apart from the individual views so the same behaviour is not
 * written twice.
 *
 * The rule everywhere here: a suggestion moves a control the user is already
 * looking at, and never one they have touched. Claude filling in a field
 * before you get to it is helpful; Claude overwriting a choice you just made
 * is not, so a single interaction with the control ends the offer for good.
 */
import { h } from '../util.js';
import * as store from '../store.js';
import * as ai from '../ai.js';

/**
 * Fill in the department for a new item.
 *
 * Returns a hint element to place under the dropdown, plus `ask(name)` to
 * trigger a lookup. Does nothing at all without a device key, so the caller
 * can wire it unconditionally.
 */
export function departmentHint(deptSelect) {
  const hint = h('p', { class: 'hint' });
  if (!ai.hasKey() || store.getState().prefs.aiDept === false) {
    return { node: null, ask: () => {} };
  }

  let touched = false;
  let inFlight = null;
  let lastAsked = '';

  deptSelect.addEventListener('change', () => {
    touched = true;
    hint.textContent = '';
  });

  async function ask(rawName) {
    const name = String(rawName ?? '').trim();
    if (touched || name.length < 2 || name === lastAsked) return;
    lastAsked = name;

    // A second lookup while the first is still out would race to set the
    // dropdown, and the older answer could win.
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    hint.textContent = 'Asking Claude where this goes…';
    try {
      const deptId = await ai.suggestDepartment(name, store.departments(), {
        signal: controller.signal,
      });
      if (controller.signal.aborted || touched) return;
      if (!deptId) {
        hint.textContent = '';
        return;
      }
      deptSelect.value = deptId;
      const dept = store.departments().find((d) => d.id === deptId);
      hint.textContent = `Claude put this in ${dept?.name ?? deptId}. Change it if that is not where your store keeps it.`;
    } catch (err) {
      if (err?.name === 'AbortError') return;
      // A failed guess is not worth a warning: the dropdown already works.
      hint.textContent = '';
    }
  }

  return { node: hint, ask };
}
