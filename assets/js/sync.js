/**
 * Shared list over a public repo.
 *
 * The household list lives in one encrypted file in this repo, opened with a
 * generated 256-bit key that travels in the fragment of an invite link. The
 * fragment is never sent to a server, and the key is never derived from
 * anything a person chose, so the public ciphertext is not brute-forceable.
 *
 * Writing also needs a GitHub token, because committing is an authenticated
 * operation and a static page has nowhere safe to keep a shared secret. By
 * default the token rides inside the encrypted vault, so holding the invite
 * link is all it takes to edit. That is only sound because the key is
 * generated: with a typed passphrase, cracking it would also yield the token.
 *
 * Everything here degrades: with no key the app is purely local, with a key
 * but no token it is read-only, and with no network it uses the last state it
 * saw.
 */
import * as crypto from './crypto.js';
import * as store from './store.js';

const CONFIG_KEY = 'shopping-pal.sync';
const API = 'https://api.github.com';
const DEFAULT_PATH = 'data/vault.json';

const listeners = new Set();

let config = loadConfig();
/** The list key and token, in memory; persisted unless "remember" is off. */
let session = {
  key: config.key ?? null,
  token: config.token ?? null,
  vaultToken: null,
};
let status = {
  state: config.enabled ? 'locked' : 'off',
  message: '',
  lastSync: config.lastSync ?? null,
  pending: false,
};
let lastVault = null;
let lastSha = null;
let pushTimer = null;
let pollTimer = null;

// ── Config ───────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    return { ...defaults(), ...JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}') };
  } catch {
    return defaults();
  }
}

function defaults() {
  return {
    enabled: false,
    owner: null,
    repo: null,
    branch: 'main',
    path: DEFAULT_PATH,
    remember: true,
    key: null,
    token: null,
    tokenInVault: false,
    lastSync: null,
  };
}

function saveConfig() {
  const toStore = { ...config };
  if (!config.remember) {
    toStore.key = null;
    toStore.token = null;
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify(toStore));
}

export function getConfig() {
  const { key, token, ...rest } = config;
  // The key and token are never handed to view code; only whether they exist.
  return { ...rest, hasKey: Boolean(session.key), hasToken: Boolean(writeToken()) };
}

/**
 * The link that grants access: the key rides in the fragment, which browsers
 * do not put in HTTP requests, so it never reaches GitHub's servers or any
 * proxy in between.
 */
export function inviteLink() {
  if (!session.key) return null;
  return `${location.origin}${location.pathname}#/list?k=${session.key}`;
}

/**
 * Work out which repo this page is served from, so the repo name never has to
 * be hard-coded. `owner.github.io/repo/` is the normal Pages layout; a custom
 * domain or local dev has to be filled in by hand at setup.
 */
export function detectRepo() {
  const host = location.hostname;
  const match = /^([\w-]+)\.github\.io$/i.exec(host);
  if (match) {
    const segment = location.pathname.split('/').filter(Boolean)[0];
    return {
      owner: match[1],
      // A user/organisation site is served from <owner>.github.io itself.
      repo: segment && !segment.includes('.') ? segment : `${match[1]}.github.io`,
    };
  }
  return { owner: config.owner, repo: config.repo };
}

// ── Status ───────────────────────────────────────────────────────────────

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getStatus() {
  return { ...status, canWrite: Boolean(writeToken()) };
}

function setStatus(state, message = '') {
  status = { ...status, state, message };
  for (const fn of listeners) fn(getStatus());
}

function writeToken() {
  return session.token || session.vaultToken || null;
}

// ── GitHub API ───────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...options.headers,
  };
  const token = writeToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, { ...options, headers });
  if (res.status === 401) throw new Error('GitHub rejected the token. It may be expired or revoked.');
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    throw new Error(
      remaining === '0'
        ? 'GitHub rate limit reached. Add a token in Setup, or try again shortly.'
        : 'GitHub refused the request. Check the token has Contents: read and write on this repo.',
    );
  }
  return res;
}

/** Reads the vault, preferring the API (fresh, gives the sha needed to write). */
async function fetchVault() {
  const { owner, repo } = detectRepo();
  if (!owner || !repo) throw new Error('Could not work out which repo to sync with.');

  const res = await api(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(config.path)}?ref=${encodeURIComponent(config.branch)}`,
    { cache: 'no-store' },
  );

  if (res.status === 404) return { vault: null, sha: null };
  if (!res.ok) throw new Error(`GitHub returned ${res.status} reading the shared list.`);

  const body = await res.json();
  const json = new TextDecoder().decode(crypto.fromBase64(body.content.replace(/\n/g, '')));
  return { vault: JSON.parse(json), sha: body.sha };
}

async function putVault(vault, sha, message) {
  const { owner, repo } = detectRepo();
  const token = writeToken();
  if (!token) throw new Error('No token, so this device cannot save to the shared list.');

  const content = crypto.toBase64(new TextEncoder().encode(`${JSON.stringify(vault, null, 2)}\n`));
  const res = await api(`/repos/${owner}/${repo}/contents/${encodeURIComponent(config.path)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content,
      branch: config.branch,
      ...(sha ? { sha } : {}),
    }),
  });

  if (res.status === 409 || res.status === 422) return { conflict: true };
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.message || `GitHub returned ${res.status} saving the shared list.`);
  }
  const body = await res.json();
  return { conflict: false, sha: body.content.sha };
}

// ── Vault payload ────────────────────────────────────────────────────────

function buildPayload() {
  return {
    data: store.sharedSnapshot(),
    // Whether the vault carries a token is a property of the vault, not of
    // this device: `tokenInVault` is refreshed from every payload read. Write
    // back the token that came with the vault, so a device that brought its
    // own token does not overwrite the household's shared one.
    writeToken: config.tokenInVault ? session.vaultToken || session.token : null,
    updatedAt: new Date().toISOString(),
  };
}

/** Set while remote state is being merged, so a pull cannot trigger a push. */
let applyingRemote = false;

function absorb(payload) {
  if (payload?.writeToken) {
    session.vaultToken = payload.writeToken;
  }
  // Learn from the file whether the household shares a token, so a device that
  // joined later does not strip it out the next time it saves.
  const carries = Boolean(payload?.writeToken);
  if (carries !== config.tokenInVault) {
    config.tokenInVault = carries;
    saveConfig();
  }
  if (!payload?.data) return;
  applyingRemote = true;
  try {
    store.mergeShared(payload.data);
  } finally {
    applyingRemote = false;
  }
}

// ── Public operations ────────────────────────────────────────────────────

/**
 * Create the shared file for the first time, with a freshly generated key.
 * Requires a token — the file has to be committed before anyone can read it.
 */
export async function createVault({ token, tokenInVault, owner, repo, branch, path }) {
  const detected = detectRepo();
  config = {
    ...config,
    enabled: true,
    owner: owner || detected.owner,
    repo: repo || detected.repo,
    branch: branch || config.branch,
    path: path || config.path,
    tokenInVault: Boolean(tokenInVault),
  };
  session.key = crypto.generateKey();
  session.token = token;

  const existing = await fetchVault();
  if (existing.vault) {
    throw new Error(
      'A shared list already exists in this repo. Open it with its invite link instead, or rotate its key from a device that already has access.',
    );
  }

  const vault = await crypto.seal(buildPayload(), session.key);
  const result = await putVault(vault, null, 'chore: create shared list');
  if (result.conflict) {
    throw new Error('Someone created the shared list at the same moment. Reload and open it with their link.');
  }

  lastVault = vault;
  lastSha = result.sha;
  config.key = session.key;
  config.token = token;
  config.lastSync = new Date().toISOString();
  saveConfig();
  status.lastSync = config.lastSync;
  setStatus('ok', 'Shared list created');
  startPolling();
  return inviteLink();
}

/** Accept a key pulled out of an invite link, or pasted by hand. */
export function extractKey(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (crypto.isValidKey(text)) return text;
  // Tolerate a whole invite link, with the key in the fragment or the query.
  const match = /[?&#]k=([A-Za-z0-9_-]{43})/.exec(text);
  return match && crypto.isValidKey(match[1]) ? match[1] : null;
}

/**
 * Open an existing shared list with its key.
 *
 * `passphrase` is only for upgrading a vault written by the older
 * passphrase-based version; such a vault is re-keyed to a generated key on
 * open, and the new invite link is returned.
 */
export async function unlock({ key, token, passphrase, owner, repo, branch, path, remember = true }) {
  const detected = detectRepo();
  config = {
    ...config,
    enabled: true,
    owner: owner || detected.owner,
    repo: repo || detected.repo,
    branch: branch || config.branch,
    path: path || config.path,
    remember,
  };
  if (token) session.token = token;

  setStatus('syncing', 'Opening the shared list…');
  const { vault, sha } = await fetchVault();
  if (!vault) {
    setStatus('error', 'No shared list in this repo yet.');
    throw new Error('There is no shared list in this repo yet. Create one instead.');
  }

  const legacy = crypto.isLegacyVault(vault);
  const candidate = legacy ? null : extractKey(key);
  if (!legacy && !candidate) {
    setStatus('error', 'That key is not valid.');
    throw new Error('That does not look like a list key or an invite link.');
  }

  const payload = await crypto.open(vault, { key: candidate, passphrase });
  session.key = candidate;
  absorb(payload);

  lastVault = vault;
  lastSha = sha;
  config.lastSync = new Date().toISOString();

  if (legacy) {
    // Replace the passphrase-derived vault with a generated key, once.
    session.key = crypto.generateKey();
    const upgraded = await crypto.seal(buildPayload(), session.key);
    const result = await putVault(upgraded, sha, 'chore: re-key shared list');
    if (!result.conflict) {
      lastVault = upgraded;
      lastSha = result.sha;
    }
  }

  config.key = remember ? session.key : null;
  config.token = remember ? session.token : null;
  saveConfig();
  status.lastSync = config.lastSync;
  setStatus(writeToken() ? 'ok' : 'readonly', writeToken() ? 'In sync' : 'Read-only — no token on this device');
  startPolling();
  return { upgraded: legacy, link: inviteLink() };
}

/**
 * Re-encrypt under a brand new key. Every existing invite link stops working,
 * which is the answer to a link that went somewhere it should not have.
 */
export async function rotateKey() {
  if (!config.enabled || !session.key) throw new Error('The shared list is not open on this device.');
  if (!writeToken()) throw new Error('Rotating the key needs write access, and this device has no token.');

  const { vault, sha } = await fetchVault();
  if (!vault) throw new Error('The shared list file is missing from the repo.');

  // Merge in anything outstanding first, so rotation never drops an edit.
  absorb(await crypto.open(vault, { key: session.key }));

  session.key = crypto.generateKey();
  const sealed = await crypto.seal(buildPayload(), session.key);
  const result = await putVault(sealed, sha, 'chore: rotate shared list key');
  if (result.conflict) throw new Error('The list changed mid-rotation. Try again.');

  lastVault = sealed;
  lastSha = result.sha;
  config.key = config.remember ? session.key : null;
  config.lastSync = new Date().toISOString();
  saveConfig();
  status.lastSync = config.lastSync;
  setStatus('ok', 'Key rotated — old invite links no longer work');
  return inviteLink();
}

/** Pull the latest shared state and merge it in. */
export async function pull({ quiet = false } = {}) {
  if (!config.enabled || !session.key) return false;
  if (!quiet) setStatus('syncing', 'Checking for changes…');

  try {
    const { vault, sha } = await fetchVault();
    if (!vault) {
      setStatus('error', 'The shared list file is gone from the repo.');
      return false;
    }
    if (sha === lastSha) {
      setStatus(writeToken() ? 'ok' : 'readonly', 'Up to date');
      return true;
    }

    const payload = await crypto.open(vault, { key: session.key });
    absorb(payload);
    lastVault = vault;
    lastSha = sha;
    config.lastSync = new Date().toISOString();
    status.lastSync = config.lastSync;
    saveConfig();
    setStatus(writeToken() ? 'ok' : 'readonly', 'Updated from the shared list');
    return true;
  } catch (err) {
    setStatus('error', err.message);
    return false;
  }
}

/**
 * Save local state to the shared file. Re-reads and merges first, so a change
 * made on another phone in the meantime is never dropped.
 */
export async function push({ attempt = 0 } = {}) {
  if (!config.enabled || !session.key) return false;
  if (!writeToken()) {
    setStatus('readonly', 'Read-only — changes stay on this device');
    return false;
  }

  setStatus('syncing', 'Saving…');
  try {
    const { vault, sha } = await fetchVault();
    if (vault && sha !== lastSha) {
      const payload = await crypto.open(vault, { key: session.key });
      absorb(payload);
      lastSha = sha;
    }

    const sealed = await crypto.seal(buildPayload(), session.key);
    const result = await putVault(sealed, sha, 'chore: update shared list');

    if (result.conflict) {
      if (attempt >= 2) {
        setStatus('error', 'Could not save — the shared list kept changing. Try again.');
        return false;
      }
      return push({ attempt: attempt + 1 });
    }

    lastVault = sealed;
    lastSha = result.sha;
    config.lastSync = new Date().toISOString();
    status.lastSync = config.lastSync;
    saveConfig();
    setStatus('ok', 'Saved');
    return true;
  } catch (err) {
    setStatus('error', err.message);
    return false;
  }
}

/** Called on every local change; batches rapid edits into one commit. */
export function schedulePush() {
  if (applyingRemote) return;
  if (!config.enabled || !session.key || !writeToken()) return;
  status.pending = true;
  clearTimeout(pushTimer);
  // Every save is a commit, so batch generously — checking a dozen items off
  // in an aisle should be one commit, not a dozen.
  pushTimer = setTimeout(() => {
    status.pending = false;
    push();
  }, 5000);
}

export function setDeviceToken(token, { remember = true } = {}) {
  session.token = token || null;
  config.token = remember ? token || null : null;
  config.remember = remember;
  saveConfig();
  setStatus(writeToken() ? 'ok' : 'readonly', writeToken() ? 'Token saved' : 'Token cleared');
}

/** Forget the shared list on this device. Local data is untouched. */
export function disconnect() {
  clearTimeout(pushTimer);
  clearInterval(pollTimer);
  config = defaults();
  session = { key: null, token: null, vaultToken: null };
  lastVault = null;
  lastSha = null;
  localStorage.removeItem(CONFIG_KEY);
  setStatus('off', '');
}

export function needsUnlock() {
  return config.enabled && !session.key;
}

/**
 * Adopt a key handed over in an invite link. Returns true when this is a key
 * the device did not already have, so the caller knows to open the list.
 */
export function adoptKey(rawKey) {
  const key = extractKey(rawKey);
  if (!key || key === session.key) return false;
  session.key = key;
  config.enabled = true;
  if (config.remember) config.key = key;
  saveConfig();
  return true;
}

// ── Polling ──────────────────────────────────────────────────────────────

function startPolling() {
  clearInterval(pollTimer);
  // Authenticated requests get a generous rate limit; anonymous ones do not.
  const interval = writeToken() ? 45_000 : 150_000;
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') pull({ quiet: true });
  }, interval);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && config.enabled && session.key) {
    pull({ quiet: true });
  }
});

/** Resume a session that was set up earlier on this device. */
export async function resume() {
  if (!config.enabled) return false;
  if (!session.key) {
    setStatus('locked', 'Open the invite link, or paste the key, to see the shared list');
    return false;
  }
  const ok = await pull({ quiet: true });
  if (ok) startPolling();
  return ok;
}
