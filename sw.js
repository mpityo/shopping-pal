/**
 * Offline support. Grocery stores eat mobile signal, so the app shell is
 * cached up front and served cache-first; the BOGO feed is network-first so a
 * fresh ad wins when there is signal, with the cached copy as the fallback.
 */
const VERSION = 'shopping-pal-v4';
/** Where a shared receipt is parked between the POST and the page load. */
const SHARE_CACHE = 'shopping-pal-shared';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/icon.svg',
  'assets/css/app.css',
  'assets/js/app.js',
  'assets/js/store.js',
  'assets/js/util.js',
  'assets/js/insights.js',
  'assets/js/deals-data.js',
  'assets/js/receipts.js',
  'assets/js/ocr.js',
  'assets/js/pdf.js',
  'assets/js/crypto.js',
  'assets/js/sync.js',
  'assets/js/ai.js',
  'assets/js/data/catalog.js',
  'assets/js/data/departments.js',
  'assets/js/views/list.js',
  'assets/js/views/browse.js',
  'assets/js/views/deals.js',
  'assets/js/views/trends.js',
  'assets/js/views/settings.js',
  'assets/js/views/sharing.js',
  'assets/js/views/receipts.js',
  'assets/js/views/ai-hints.js',
  'assets/js/views/item-picker.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((path) => new URL(path, self.registration.scope).href)))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // Keep the share cache: a receipt may be parked in it right now, and an
      // activation triggered by the share navigation itself would eat it.
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== VERSION && k !== SHARE_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * Android share target.
 *
 * The system delivers a shared file as a POST, which a page cannot receive
 * directly — so it is intercepted here, parked in a cache, and the browser is
 * redirected to the app with a claim ticket. The page collects the file on
 * load and opens the importer.
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const requestUrl = new URL(request.url);

  if (request.method === 'POST' && requestUrl.pathname.endsWith('/share-receipt')) {
    event.respondWith(receiveShare(event));
    return;
  }

  if (request.method !== 'GET') return;

  const url = requestUrl;
  // The shared vault is fetched from the GitHub API and must never be cached:
  // a stale copy would silently resurrect old list state.
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/data/bogos.json')) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event, request));
});

/**
 * Serve from cache for speed, then refresh the entry in the background so the
 * next load picks up a new deploy. Plain cache-first would pin phones to
 * whatever was cached the first time until this file's VERSION changed.
 */
async function receiveShare(event) {
  const scope = self.registration.scope;
  let ticket = null;

  try {
    const form = await event.request.formData();
    const file = form.get('receipt');
    const text = form.get('text') || form.get('url') || '';

    ticket = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cache = await caches.open(SHARE_CACHE);

    if (file && typeof file !== 'string' && file.size) {
      await cache.put(
        new Request(`${scope}shared/${ticket}`),
        new Response(file, {
          headers: {
            'content-type': file.type || 'application/octet-stream',
            'x-share-filename': encodeURIComponent(file.name || 'receipt'),
            'x-share-kind': 'file',
          },
        }),
      );
    } else if (String(text).trim()) {
      // Some apps share a receipt as plain text rather than a file.
      await cache.put(
        new Request(`${scope}shared/${ticket}`),
        new Response(String(text), {
          headers: { 'content-type': 'text/plain', 'x-share-kind': 'text' },
        }),
      );
    } else {
      ticket = null;
    }
  } catch (err) {
    ticket = null;
  }

  const target = new URL('index.html', scope);
  target.hash = ticket ? `#/trends?receipt=${ticket}` : '#/trends?receipt=failed';
  return Response.redirect(target.href, 303);
}

async function staleWhileRevalidate(event, request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) {
    event.waitUntil(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(VERSION);
            await cache.put(request, response.clone());
          }
        })
        .catch(() => {
          /* offline — the cached copy is still correct to serve */
        }),
    );
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // A navigation with no cache entry still gets the shell.
    if (request.mode === 'navigate') {
      const shell = await caches.match(new URL('index.html', self.registration.scope).href);
      if (shell) return shell;
    }
    throw new Error('Offline and not cached');
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    return new Response(JSON.stringify({ status: 'unavailable', deals: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  }
}
