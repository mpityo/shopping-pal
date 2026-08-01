/**
 * Encryption for the shared list file.
 *
 * The repo is public, so `data/vault.json` is readable by anyone. Everything
 * inside it is encrypted in the browser with AES-256-GCM under a key that the
 * app generates — 32 random bytes from the OS CSPRNG, never a passphrase
 * anyone typed.
 *
 * That distinction is the whole security argument. A human-invented phrase is
 * worth maybe 30 bits, and the ciphertext here is public and permanent, so it
 * can be attacked offline forever at no cost — hours of GPU time to break. A
 * generated 256-bit key cannot be searched at all, at any budget, ever. The
 * key travels as part of an invite link and is never sent to a server: URL
 * fragments are not transmitted in HTTP requests.
 *
 * The trade this makes is explicit: possession of the link is possession of
 * the list. Guard the link like a house key, and rotate it (Setup → Shared
 * list → Rotate key) if it ever goes somewhere it shouldn't.
 *
 * Vault v1 used PBKDF2 over a passphrase. It is still readable here so nobody
 * can be locked out of an early vault, and the app re-keys it to v2 on open.
 */

const IV_BYTES = 12;
const KEY_BYTES = 32;
const V1_KDF_ITERATIONS = 600_000;

export const VAULT_VERSION = 2;

function subtle() {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      'This browser cannot encrypt here. Web Crypto needs a secure context — ' +
        'use the https:// site rather than opening the file directly.',
    );
  }
  return globalThis.crypto.subtle;
}

export function isSupported() {
  return Boolean(globalThis.crypto?.subtle);
}

// ── Encoding ─────────────────────────────────────────────────────────────

export function toBase64(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(text) {
  const bin = atob(text);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** URL-safe, unpadded — the key has to survive being pasted into a link. */
function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  return fromBase64(text.replace(/-/g, '+').replace(/_/g, '/'));
}

// ── Keys ─────────────────────────────────────────────────────────────────

/** A fresh 256-bit key, as a 43-character URL-safe string. */
export function generateKey() {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

export function isValidKey(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(trimmed)) return false;
  try {
    return fromBase64Url(trimmed).length === KEY_BYTES;
  } catch {
    return false;
  }
}

async function importKey(keyString) {
  const trimmed = String(keyString).trim();
  if (!isValidKey(trimmed)) {
    throw new Error('That is not a valid list key.');
  }
  return subtle().importKey('raw', fromBase64Url(trimmed), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** v1 only: derive a key from a passphrase, so old vaults can still be read. */
async function deriveLegacyKey(passphrase, salt, iterations) {
  const material = await subtle().importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations: iterations ?? V1_KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

// ── Vault ────────────────────────────────────────────────────────────────

export async function seal(payload, keyString) {
  const key = await importKey(keyString);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  return {
    version: VAULT_VERSION,
    cipher: { name: 'AES-GCM', iv: toBase64(iv) },
    ciphertext: toBase64(ciphertext),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Decrypt a vault. Pass `{ key }` for v2, or `{ passphrase }` for a v1 vault.
 * AES-GCM is authenticated, so the wrong key fails loudly rather than
 * returning plausible nonsense.
 */
export async function open(vault, { key: keyString, passphrase } = {}) {
  if (!vault?.ciphertext || !vault?.cipher?.iv) {
    throw new Error('That file is not a Shopping Pal vault.');
  }
  if (vault.version > VAULT_VERSION) {
    throw new Error('This vault was written by a newer version of the app.');
  }

  let key;
  if (isLegacyVault(vault)) {
    if (!passphrase) {
      throw new Error(
        'This shared list was created by the older passphrase version. Enter its passphrase to open and upgrade it.',
      );
    }
    key = await deriveLegacyKey(passphrase, fromBase64(vault.kdf.salt), vault.kdf.iterations);
  } else {
    key = await importKey(keyString);
  }

  let plaintext;
  try {
    plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64(vault.cipher.iv) },
      key,
      fromBase64(vault.ciphertext),
    );
  } catch {
    // GCM authentication failed: wrong key, or the file was tampered with.
    throw new Error(
      isLegacyVault(vault) ? 'Wrong passphrase.' : 'That key does not open this list.',
    );
  }

  return JSON.parse(new TextDecoder().decode(plaintext));
}

export function isLegacyVault(vault) {
  return Boolean(vault?.kdf?.salt) && (vault.version ?? 1) < 2;
}
