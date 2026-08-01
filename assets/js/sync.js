/**
 * Shared list over a public repo.
 *
 * The household list lives in one encrypted file in this repo. Reading it
 * needs only the passphrase. Writing it needs a GitHub token as well, because
 * committing to a repo is an authenticated operation and there is no server
 * here to hold a secret on everyone's behalf.
 *
 * The token can be supplied two ways, chosen at setup:
 *   - stored inside the encrypted vault, so the passphrase alone grants edit
 *     access to anyone in the household (convenient, and the token is only as
 *     safe as the passphrase — see the warnings in Setup and the README)
 *   - stored only in each person's browser, so the passphrase grants read and
 *     each editor brings their own token (safer, slightly more setup)
 *
 * Everything here degrades: with no passphrase the app is purely local, with a
 * passphrase but no token it is read-only, and with no network it uses the
 * last state it saw.
 */
import * as crypto from './crypto.js';
import * as store from './store.js';

const CONFIG_KEY = 'shopping-pal.sync';
const API = 'https://api.github.com';
const DEFAULT_PATH = 'data/vault.json';

const listeners = new Set();

let config = loadConfig();
/** Passphrase and token live in memory; persisted only if "remember" is on. */
let session = {
  passphrase: config.passphrase ?? null,
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
    passphrase: null,
    token: null,
    tokenInVault: false,
    lastSync: null,
  };
}

function saveConfig() {
  const toStore = { ...config };
  if (!config.remember) {
    toStore.passphrase = null;
    toStore.token = null;
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify(toStore));
}

export function getConfig() {
  return { ...config, hasPassphrase: Boolean(session.passphrase), hasToken: Boolean(writeToken()) };
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
 * Create the shared file for the first time. Requires a token — the file has
 * to be committed before anyone can read it.
 */
export async function createVault({ passphrase, token, tokenInVault, owner, repo, branch, path }) {
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
  session.passphrase = passphrase;
  session.token = token;

  const existing = await fetchVault();
  if (existing.vault) {
    throw new Error(
      'A shared list already exists in this repo. Use “Join the shared list” with its passphrase instead.',
    );
  }

  const vault = await crypto.seal(buildPayload(), passphrase);
  const result = await putVault(vault, null, 'chore: create shared list');
  if (result.conflict) throw new Error('Someone created the shared list at the same moment. Reload and join it.');

  lastVault = vault;
  lastSha = result.sha;
  config.passphrase = passphrase;
  config.token = token;
  config.lastSync = new Date().toISOString();
  saveConfig();
  status.lastSync = config.lastSync;
  setStatus('ok', 'Shared list created');
  startPolling();
  return true;
}

/** Unlock an existing shared list with the passphrase. */
export async function unlock({ passphrase, token, owner, repo, branch, path, remember = true }) {
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
  session.passphrase = passphrase;
  if (token) session.token = token;

  setStatus('syncing', 'Opening the shared list…');
  const { vault, sha } = await fetchVault();
  if (!vault) {
    setStatus('error', 'No shared list in this repo yet.');
    throw new Error('There is no shared list in this repo yet. Create one instead.');
  }

  const payload = await crypto.open(vault, passphrase);
  absorb(payload);

  lastVault = vault;
  lastSha = sha;
  config.passphrase = remember ? passphrase : null;
  config.token = remember ? session.token : null;
  config.lastSync = new Date().toISOString();
  saveConfig();
  status.lastSync = config.lastSync;
  setStatus(writeToken() ? 'ok' : 'readonly', writeToken() ? 'In sync' : 'Read-only — no token on this device');
  startPolling();
  return true;
}

/** Pull the latest shared state and merge it in. */
export async function pull({ quiet = false } = {}) {
  if (!config.enabled || !session.passphrase) return false;
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

    const payload = await crypto.open(vault, session.passphrase);
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
  if (!config.enabled || !session.passphrase) return false;
  if (!writeToken()) {
    setStatus('readonly', 'Read-only — changes stay on this device');
    return false;
  }

  setStatus('syncing', 'Saving…');
  try {
    const { vault, sha } = await fetchVault();
    if (vault && sha !== lastSha) {
      const payload = await crypto.open(vault, session.passphrase);
      absorb(payload);
      lastSha = sha;
    }

    const sealed = await crypto.seal(buildPayload(), session.passphrase, vault ?? lastVault);
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
  if (!config.enabled || !session.passphrase || !writeToken()) return;
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
  session = { passphrase: null, token: null, vaultToken: null };
  lastVault = null;
  lastSha = null;
  localStorage.removeItem(CONFIG_KEY);
  setStatus('off', '');
}

export function needsUnlock() {
  return config.enabled && !session.passphrase;
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
  if (document.visibilityState === 'visible' && config.enabled && session.passphrase) {
    pull({ quiet: true });
  }
});

/** Resume a session that was set up earlier on this device. */
export async function resume() {
  if (!config.enabled) return false;
  if (!session.passphrase) {
    setStatus('locked', 'Enter the passphrase to open the shared list');
    return false;
  }
  const ok = await pull({ quiet: true });
  if (ok) startPolling();
  return ok;
}
