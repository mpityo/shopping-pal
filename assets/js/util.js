/** Small DOM + text helpers. No framework, no build step. */

/**
 * Build an element. Children may be nodes, strings, or nested arrays;
 * null/false/undefined children are skipped so `cond && node` works inline.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') el.innerHTML = value;
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value);
  }
  append(el, children);
  return el;
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

export function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Forgiving search: matches whole words, prefixes, and characters typed in
 * order (so "grktom" still finds "Grape tomatoes"). Higher score is better,
 * 0 means no match.
 */
export function matchScore(haystack, query) {
  const text = normalize(haystack);
  const q = normalize(query);
  if (!q) return 1;
  if (text === q) return 100;
  if (text.startsWith(q)) return 80;

  const words = text.split(' ');
  if (words.some((w) => w.startsWith(q))) return 60;
  if (text.includes(q)) return 40;

  // Every query term must prefix some word — handles "red pep" → red pepper.
  const terms = q.split(' ');
  if (terms.length > 1 && terms.every((t) => words.some((w) => w.startsWith(t)))) {
    return 35;
  }

  // Subsequence fallback, scored down by how spread out the match is.
  let i = 0;
  let gaps = 0;
  let lastHit = -1;
  for (let j = 0; j < text.length && i < q.length; j++) {
    if (text[j] === q[i]) {
      if (lastHit >= 0) gaps += j - lastHit - 1;
      lastHit = j;
      i++;
    }
  }
  if (i === q.length) return Math.max(5, 25 - gaps);
  return 0;
}

export function debounce(fn, ms = 150) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function pluralize(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

let toastTimer;
export function toast(message, { action, onAction } = {}) {
  const host = document.getElementById('toast-host');
  if (!host) return;
  clear(host);
  const node = h(
    'div',
    { class: 'toast', role: 'status' },
    h('span', {}, message),
    action &&
      h(
        'button',
        {
          class: 'toast__action',
          type: 'button',
          onClick: () => {
            onAction?.();
            clear(host);
          },
        },
        action,
      ),
  );
  host.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => clear(host), action ? 8000 : 3500);
}

/** Focus-trapped modal dialog. Returns the <dialog> element. */
export function modal(title, body, { wide = false } = {}) {
  const dialog = h(
    'dialog',
    { class: `modal${wide ? ' modal--wide' : ''}` },
    h(
      'div',
      { class: 'modal__head' },
      h('h2', { class: 'modal__title' }, title),
      h(
        'button',
        {
          class: 'modal__close',
          type: 'button',
          'aria-label': 'Close',
          onClick: () => dialog.close(),
        },
        '✕',
      ),
    ),
    h('div', { class: 'modal__body' }, body),
  );
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
