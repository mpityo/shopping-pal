import { h, clear, toast } from './util.js';
import * as store from './store.js';
import * as sync from './sync.js';
import { loadDeals, matchDealsToCatalog, isStale } from './deals-data.js';
import { renderList } from './views/list.js';
import { renderBrowse } from './views/browse.js';
import { renderDeals } from './views/deals.js';
import { renderTrends } from './views/trends.js';
import { renderSettings } from './views/settings.js';

const ROUTES = [
  { id: 'list', label: 'This week', render: renderList },
  { id: 'browse', label: 'Catalog', render: renderBrowse },
  { id: 'deals', label: 'BOGOs', render: renderDeals },
  { id: 'trends', label: 'Trends', render: renderTrends },
  { id: 'settings', label: 'Setup', render: renderSettings },
];

const ctx = {
  route: 'list',
  deals: { status: 'unavailable', deals: [] },
  go(route) {
    if (!ROUTES.some((r) => r.id === route)) route = 'list';
    location.hash = `#/${route}`;
  },
  rerender(opts) {
    render(opts);
  },
};

const app = document.getElementById('app');
const navHost = document.getElementById('nav');
const statusHost = document.getElementById('list-status');
const syncHost = document.getElementById('sync-status');

function currentRoute() {
  const match = /^#\/(\w+)/.exec(location.hash);
  const id = match?.[1];
  return ROUTES.some((r) => r.id === id) ? id : 'list';
}

// ── Render ───────────────────────────────────────────────────────────────

function render(opts = {}) {
  ctx.route = currentRoute();
  const route = ROUTES.find((r) => r.id === ctx.route);

  renderNav();
  renderStatus();
  renderSyncStatus();

  const active = document.activeElement;
  const focusId = opts.focus ?? (active?.id || null);
  const selectionStart = active?.selectionStart ?? null;

  clear(app);
  app.append(route.render(ctx));

  if (focusId) {
    const next = document.getElementById(focusId);
    if (next) {
      next.focus({ preventScroll: true });
      if (selectionStart != null && next.setSelectionRange && next.type !== 'number') {
        try {
          next.setSelectionRange(selectionStart, selectionStart);
        } catch {
          /* not a text input — nothing to restore */
        }
      }
    }
  }

  document.title = `${route.label} · Shopping Pal`;
}

function renderNav() {
  const state = store.getState();
  const listCount = store.listCount();
  const dealMatches = matchDealsToCatalog(ctx.deals, store.items(), state.manualDeals).length;

  clear(navHost).append(
    ...ROUTES.map((route) => {
      const badge =
        route.id === 'list' && listCount
          ? h('span', { class: 'nav__count' }, String(listCount))
          : route.id === 'deals' && dealMatches
            ? h('span', { class: 'nav__count nav__count--deal' }, String(dealMatches))
            : null;

      return h(
        'button',
        {
          class: 'nav__link',
          type: 'button',
          'aria-current': ctx.route === route.id ? 'page' : null,
          onClick: () => ctx.go(route.id),
        },
        route.label,
        badge,
      );
    }),
  );
}

function renderStatus() {
  const total = store.listCount();
  const done = store.checkedCount();
  const pct = total ? Math.round((done / total) * 100) : 0;

  clear(statusHost);
  if (!total) {
    statusHost.append(
      h('div', { class: 'progress__label' }, h('span', {}, 'Nothing on the list yet')),
    );
    return;
  }
  statusHost.append(
    h(
      'div',
      { class: 'progress__label' },
      h('span', {}, 'Picked up'),
      h('strong', {}, `${done} / ${total}`),
    ),
    h(
      'div',
      {
        class: 'progress__track',
        role: 'progressbar',
        'aria-valuenow': String(pct),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-label': 'Shopping progress',
      },
      h('div', { class: 'progress__fill', style: { width: `${pct}%` } }),
    ),
  );
}

function renderSyncStatus() {
  if (!syncHost) return;
  const status = sync.getStatus();
  clear(syncHost);
  if (status.state === 'off') return;

  const labels = {
    locked: 'Shared list — needs the invite link',
    syncing: 'Syncing…',
    ok: 'Shared list in sync',
    readonly: 'Shared list — read-only',
    error: 'Shared list — sync problem',
  };

  syncHost.append(
    h(
      'button',
      {
        type: 'button',
        title: status.message || '',
        onClick: () => ctx.go('settings'),
      },
      labels[status.state] ?? '',
    ),
  );
}

// ── Shared lists ─────────────────────────────────────────────────────────

function hashParams() {
  const raw = location.hash.split('?')[1];
  return new URLSearchParams(raw || '');
}

/**
 * Adopt the key from an invite link.
 *
 * The key is deliberately left in the address bar afterwards. It is the
 * credential, and stripping it would break Add to Home Screen: an installed
 * iOS web app gets its own storage container, so it has to receive the key
 * through the URL it was installed from rather than from Safari's storage.
 */
function consumeInviteKey() {
  const key = hashParams().get('k');
  if (!key) return false;
  const adopted = sync.adoptKey(key);
  if (adopted) toast('Opening the shared list…');
  return adopted;
}

/**
 * A `?share=` payload in the hash replaces the working list, so it asks first
 * rather than silently overwriting whatever the other person had going.
 */
function consumeSharedList() {
  const params = hashParams();
  const payload = params.get('share');
  if (!payload) return;

  // Drop only the share payload; an invite key in the same hash must survive.
  const key = params.get('k');
  history.replaceState(null, '', `${location.pathname}#/list${key ? `?k=${key}` : ''}`);

  const hasList = store.listCount() > 0;
  if (hasList && !confirm('Open the shared list? This replaces the list currently in this browser.')) {
    return;
  }
  try {
    store.clearList();
    const { applied, total } = store.decodeAndApplyList(payload);
    toast(
      applied === total
        ? `Shared list loaded — ${applied} items`
        : `Loaded ${applied} of ${total} items (${total - applied} are not in this catalog)`,
    );
  } catch {
    toast('That shared link could not be read');
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────

window.addEventListener('hashchange', () => {
  if (consumeInviteKey()) sync.resume();
  consumeSharedList();
  render();
  window.scrollTo({ top: 0 });
});

store.subscribe(() => {
  render();
  // Local edits are batched and pushed to the shared file; a merge coming the
  // other way is suppressed inside sync so this cannot loop.
  sync.schedulePush();
});

sync.subscribe(() => renderSyncStatus());

consumeInviteKey();
consumeSharedList();
render();

// Open the shared list: either from a key just handed over by an invite link,
// or one this device already had.
sync.resume().then((opened) => {
  if (opened) return;
  if (sync.needsUnlock()) {
    toast('The shared list needs its invite link on this device', {
      action: 'Open',
      onAction: () => ctx.go('settings'),
    });
  }
});

loadDeals().then((feed) => {
  ctx.deals = feed;
  render();
  if (feed.status === 'ok' && !isStale(feed)) {
    const matches = matchDealsToCatalog(feed, store.items(), store.getState().manualDeals);
    const seen = store.getState().prefs.lastSeenDeals;
    if (matches.length && seen !== feed.updated && ctx.route !== 'deals') {
      toast(`${matches.length} of your regulars are BOGO this week`, {
        action: 'See them',
        onAction: () => {
          store.setPref('lastSeenDeals', feed.updated);
          ctx.go('deals');
        },
      });
    }
  }
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    const swUrl = new URL('../../sw.js', import.meta.url);
    navigator.serviceWorker
      .register(swUrl, { scope: new URL('.', swUrl).pathname })
      .catch(() => {
        /* offline support is a bonus; the app works fine without it */
      });
  });
}
