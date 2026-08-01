/**
 * Passphrase encryption for the shared list file.
 *
 * The repo is public, so `data/vault.json` is readable by anyone. Everything
 * inside it is encrypted in the browser with a key derived from the household
 * passphrase — the passphrase itself is never sent anywhere, and there is no
 * server that could reveal it.
 *
 * AES-256-GCM for content (authenticated: a wrong passphrase fails to decrypt
 * rather than returning garbage), PBKDF2-HMAC-SHA-256 for key derivation.
 *
 * The honest limit of this design: the ciphertext is public and permanent, so
 * its security rests entirely on the passphrase being long and unguessable.
 * Anyone can take a copy and grind at it offline for as long as they like.
 * That is why setup insists on a real passphrase rather than a word.
 */

const KDF_ITERATIONS = 600_000; // OWASP guidance for PBKDF2-HMAC-SHA256
const SALT_BYTES = 16;
const IV_BYTES = 12;

export const VAULT_VERSION = 1;

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

// ── base64 ───────────────────────────────────────────────────────────────

export function toBase64(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(text) {
  const bin = atob(text);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ── keys ─────────────────────────────────────────────────────────────────

async function deriveKey(passphrase, salt, iterations) {
  const material = await subtle().importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ── vault ────────────────────────────────────────────────────────────────

/**
 * Encrypt a payload into a vault envelope.
 *
 * Reuses the salt of an existing vault when given one, so unlocking stays a
 * single key derivation per session instead of one per save.
 */
export async function seal(payload, passphrase, previous = null) {
  const salt = previous?.kdf?.salt
    ? fromBase64(previous.kdf.salt)
    : globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iterations = previous?.kdf?.iterations ?? KDF_ITERATIONS;
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, iterations);

  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  return {
    version: VAULT_VERSION,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations,
      salt: toBase64(salt),
    },
    cipher: { name: 'AES-GCM', iv: toBase64(iv) },
    ciphertext: toBase64(ciphertext),
    updatedAt: new Date().toISOString(),
  };
}

export async function open(vault, passphrase) {
  if (!vault?.ciphertext || !vault?.kdf?.salt || !vault?.cipher?.iv) {
    throw new Error('That file is not a Shopping Pal vault.');
  }
  if (vault.version > VAULT_VERSION) {
    throw new Error('This vault was written by a newer version of the app.');
  }

  const key = await deriveKey(
    passphrase,
    fromBase64(vault.kdf.salt),
    vault.kdf.iterations,
  );

  let plaintext;
  try {
    plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64(vault.cipher.iv) },
      key,
      fromBase64(vault.ciphertext),
    );
  } catch {
    // GCM authentication failed — almost always the wrong passphrase.
    throw new Error('Wrong passphrase.');
  }

  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ── passphrase quality ───────────────────────────────────────────────────

const COMMON = [
  'password', 'passphrase', 'letmein', 'groceries', 'grocery', 'shopping',
  'qwerty', 'welcome', 'iloveyou', 'admin', 'changeme', '123456', 'abc123',
];

/**
 * Rough strength check. The point is to block the passphrases that make an
 * offline attack on a public file trivial, not to score entropy precisely.
 */
export function ratePassphrase(value) {
  const text = value.trim();
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);

  if (text.length < 12) {
    return { ok: false, level: 'weak', message: 'Use at least 12 characters.' };
  }
  if (COMMON.some((c) => lower.includes(c))) {
    return {
      ok: false,
      level: 'weak',
      message: 'Contains a very common word — an attacker tries these first.',
    };
  }
  if (/^(.)\1+$/.test(text)) {
    return { ok: false, level: 'weak', message: 'That is a single repeated character.' };
  }

  const variety =
    (/[a-z]/.test(text) ? 1 : 0) +
    (/[A-Z]/.test(text) ? 1 : 0) +
    (/[0-9]/.test(text) ? 1 : 0) +
    (/[^a-zA-Z0-9]/.test(text) ? 1 : 0);

  if (words.length >= 4 || (text.length >= 20 && variety >= 2)) {
    return { ok: true, level: 'strong', message: 'Strong.' };
  }
  if (text.length >= 16 || variety >= 3) {
    return {
      ok: true,
      level: 'fair',
      message: 'Usable. Four random words would be stronger.',
    };
  }
  return {
    ok: false,
    level: 'weak',
    message: 'Too guessable. Try four random words, or add length and variety.',
  };
}
