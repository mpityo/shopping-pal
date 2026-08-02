/**
 * Optional Claude assistance.
 *
 * Three jobs only, and all three are things arithmetic cannot do: reading a
 * receipt abbreviation, guessing which aisle an unfamiliar item lives in, and
 * writing prose. Every number the app reports — how often something is bought,
 * what is due, what a trip cost — is computed in `insights.js` and stays
 * computed there. A language model is not asked to count, because it would be
 * worse at it than `Math.round` and would sometimes be confidently wrong.
 *
 * ── Where the key lives ─────────────────────────────────────────────────
 *
 * In its own localStorage entry, on this device, deliberately outside the
 * application state object. Everything in that object is a candidate for the
 * shared vault and for `Export a backup`; an API key is neither. Keeping it in
 * a separate slot means there is no code path — present or future — that can
 * sweep it into a file in a public repo. That is the whole reason for the
 * split, so do not move it into `state`.
 *
 * The trade this makes: each phone needs its own key, and a phone without one
 * simply gets the fuzzy matcher and no narrative. That is the intended
 * failure mode. Nothing here is load-bearing.
 */

/** Deliberately not part of the app state object. See the note above. */
const KEY_SLOT = 'shopping-pal.anthropic-key';
const USAGE_SLOT = 'shopping-pal.anthropic-usage';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export const MODELS = {
  /** Runs on every receipt import, so the cheap fast one. */
  match: 'claude-haiku-4-5',
  /** One item at a time, interactive — latency matters more than anything. */
  department: 'claude-haiku-4-5',
  /** Once a week over a few hundred tokens; the better writer is free here. */
  narrate: 'claude-sonnet-5',
};

/**
 * Dollars per million tokens, for the usage read-out in Setup.
 *
 * Shown as an estimate and labelled as one: these are list prices at the time
 * of writing, they are not read from your account, and Sonnet 5 is on
 * introductory pricing that ends. The real number is on the Anthropic console.
 */
const PRICES = {
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
  'claude-sonnet-5': { in: 2.0, out: 10.0 },
};

// ── The key ──────────────────────────────────────────────────────────────

export function getKey() {
  try {
    return localStorage.getItem(KEY_SLOT) || '';
  } catch {
    return '';
  }
}

export function setKey(key) {
  const trimmed = String(key ?? '').trim();
  try {
    if (trimmed) localStorage.setItem(KEY_SLOT, trimmed);
    else localStorage.removeItem(KEY_SLOT);
  } catch {
    /* private browsing — the feature just stays off */
  }
}

export function clearKey() {
  setKey('');
}

export function hasKey() {
  return Boolean(getKey());
}

/** A key looks roughly right — catches a pasted GitHub token by mistake. */
export function looksLikeKey(key) {
  return /^sk-ant-/.test(String(key ?? '').trim());
}

// ── Usage, so a billable feature is not invisible ────────────────────────

export function usage() {
  try {
    const raw = JSON.parse(localStorage.getItem(USAGE_SLOT) || '{}');
    return { calls: 0, inputTokens: 0, outputTokens: 0, byModel: {}, since: null, ...raw };
  } catch {
    return { calls: 0, inputTokens: 0, outputTokens: 0, byModel: {}, since: null };
  }
}

export function resetUsage() {
  try {
    localStorage.removeItem(USAGE_SLOT);
  } catch {
    /* nothing to clear */
  }
}

function recordUsage(model, u) {
  if (!u) return;
  const current = usage();
  const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0);
  const output = u.output_tokens ?? 0;
  const perModel = current.byModel[model] ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
  const next = {
    ...current,
    since: current.since ?? new Date().toISOString().slice(0, 10),
    calls: current.calls + 1,
    inputTokens: current.inputTokens + input,
    outputTokens: current.outputTokens + output,
    byModel: {
      ...current.byModel,
      [model]: {
        calls: perModel.calls + 1,
        inputTokens: perModel.inputTokens + input,
        outputTokens: perModel.outputTokens + output,
      },
    },
  };
  try {
    localStorage.setItem(USAGE_SLOT, JSON.stringify(next));
  } catch {
    /* not worth failing a request over */
  }
}

/** Rough spend so far, in whole cents. Labelled as an estimate wherever shown. */
export function estimatedCents(u = usage()) {
  let dollars = 0;
  for (const [model, counts] of Object.entries(u.byModel ?? {})) {
    const price = PRICES[model];
    if (!price) continue;
    dollars += (counts.inputTokens / 1e6) * price.in + (counts.outputTokens / 1e6) * price.out;
  }
  return Math.round(dollars * 100);
}

// ── The request ──────────────────────────────────────────────────────────

/**
 * One call to the Messages API.
 *
 * Raw `fetch` rather than the official SDK on purpose: this site has no build
 * step and no package manager, so there is nothing to bundle an npm package
 * with, and pulling one from a CDN would break both that constraint and the
 * offline service worker.
 *
 * `anthropic-dangerous-direct-browser-access` is what makes a browser call
 * possible at all — without it the API does not send CORS headers and the
 * request never leaves. The name is a fair warning: it is only acceptable here
 * because the key is per-device, typed in by its owner, and never committed.
 */
async function call({ model, system, prompt, schema, maxTokens = 1024, signal }) {
  const key = getKey();
  if (!key) throw new AiError('no-key', 'No Claude key on this device.');

  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  };
  if (schema) {
    body.output_config = { format: { type: 'json_schema', schema } };
  }

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new AiError('offline', 'Could not reach Claude — check the connection.');
  }

  if (!response.ok) throw await httpError(response);

  const data = await response.json();
  recordUsage(model, data.usage);

  if (data.stop_reason === 'max_tokens') {
    throw new AiError('truncated', 'Claude ran out of room before finishing.');
  }

  const text = (data.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  if (!schema) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError('bad-json', 'Claude returned something unreadable.');
  }
}

class AiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function httpError(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message ?? '';
  } catch {
    /* some errors are not JSON */
  }
  if (response.status === 401 || response.status === 403) {
    return new AiError('bad-key', 'That key was rejected. Check it in Setup.');
  }
  if (response.status === 400 && /credit|billing/i.test(detail)) {
    return new AiError('billing', 'The Anthropic account has no credit.');
  }
  if (response.status === 429) {
    return new AiError('rate-limit', 'Rate limited — try again in a moment.');
  }
  if (response.status >= 500) {
    return new AiError('server', 'Claude is unavailable right now.');
  }
  return new AiError('http', detail || `Claude returned ${response.status}.`);
}

/** Confirms a pasted key works, without spending anything meaningful. */
export async function testKey() {
  await call({
    model: MODELS.match,
    system: 'Reply with the single word OK.',
    prompt: 'ping',
    maxTokens: 8,
  });
  return true;
}

// ── Receipt line matching ────────────────────────────────────────────────

const MATCH_SYSTEM = `You map grocery receipt lines to items in a household's shopping catalog.

Receipt lines are abbreviated, truncated, and full of brand codes: "GV SHRD MOZZ" is Great Value shredded mozzarella, "PUB PNE PSTA" is Publix penne pasta, "HM BNLS SKNLS CHKN BRST" is boneless skinless chicken breast.

Rules:
- Only ever answer with an id from the catalog you are given. Never invent one.
- Match on what the product actually is, not on shared words. "Corn tortilla chips" is not corn. "Cream of mushroom soup" is not cream.
- A store's own brand prefix (GV, Great Value, Pub, Publix, HM, Marketside, Equate) is noise — ignore it and match the product.
- If nothing in the catalog is genuinely the same product, omit that line entirely. A wrong match costs the household more than no match, because it silently corrupts their purchase history.
- Use "high" confidence only when you are sure. Anything you would want a human to glance at is "low".`;

const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The receipt line number you were given' },
          itemId: { type: 'string', description: 'An id from the catalog, exactly as written' },
          confidence: { type: 'string', enum: ['high', 'low'] },
        },
        required: ['index', 'itemId', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['matches'],
  additionalProperties: false,
};

/**
 * Suggest catalog items for receipt lines the fuzzy matcher could not place.
 *
 * Returns a Map of line index -> { itemId, confidence }. Ids that are not in
 * the catalog are dropped rather than trusted: the model is a suggestion
 * engine here, and the review table is still the thing that decides.
 */
export async function matchReceiptLines(lines, catalog, { signal } = {}) {
  if (!lines.length) return new Map();

  const catalogText = catalog
    .map((item) => `${item.id}\t${item.name}${item.sub ? ` (${item.sub})` : ''}`)
    .join('\n');
  const linesText = lines.map((line, i) => `${i}\t${line.name}`).join('\n');

  const result = await call({
    model: MODELS.match,
    system: MATCH_SYSTEM,
    prompt: `Catalog (id, then name):\n${catalogText}\n\nReceipt lines to match (line number, then text):\n${linesText}`,
    schema: MATCH_SCHEMA,
    maxTokens: 4096,
    signal,
  });

  const known = new Set(catalog.map((item) => item.id));
  const out = new Map();
  for (const match of result?.matches ?? []) {
    if (!known.has(match.itemId)) continue;
    if (!Number.isInteger(match.index) || match.index < 0 || match.index >= lines.length) continue;
    out.set(match.index, {
      itemId: match.itemId,
      confidence: match.confidence === 'high' ? 'high' : 'low',
    });
  }
  return out;
}

// ── Department for a new item ────────────────────────────────────────────

/**
 * Which aisle a new item belongs in.
 *
 * Constrained to the real department ids by the schema's enum, so the worst
 * case is a wrong-but-valid answer the user corrects in the dropdown that is
 * already open in front of them.
 */
export async function suggestDepartment(name, departments, { signal } = {}) {
  if (!name?.trim() || !departments.length) return null;

  const schema = {
    type: 'object',
    properties: {
      departmentId: { type: 'string', enum: departments.map((d) => d.id) },
    },
    required: ['departmentId'],
    additionalProperties: false,
  };

  const list = departments.map((d) => `${d.id}\t${d.name} — ${d.signage}`).join('\n');
  const result = await call({
    model: MODELS.department,
    system:
      'You place a grocery item into the correct department of a supermarket. Answer with the single best department id. If it genuinely fits nowhere, use the closest general one.',
    prompt: `Departments:\n${list}\n\nWhich department is "${name.trim()}" in?`,
    schema,
    maxTokens: 128,
    signal,
  });

  const id = result?.departmentId;
  return departments.some((d) => d.id === id) ? id : null;
}

// ── The trends read-out ──────────────────────────────────────────────────

const NARRATE_SYSTEM = `You write a short, plain read of a household's grocery shopping habits.

You are given figures that have already been calculated. Your job is the prose, not the arithmetic.

Hard rules:
- Use only the numbers given to you. Never calculate a new one, never estimate, never round differently, and never state a figure that is not in the data above.
- If something is not in the data, do not mention it. Say less rather than guessing.
- No preamble, no sign-off, no "based on the data provided". Start with the observation.
- Plain British-neutral English. No exclamation marks, no emoji, no cheerleading, no "pro tip".
- Be specific and useful: what changed, what looks like it is becoming a regular, what was bought once and never again, what is overdue. Name the actual items.
- If the history is too thin to say anything meaningful, say exactly that instead of padding.`;

const NARRATE_SCHEMA = {
  type: 'object',
  properties: {
    headline: {
      type: 'string',
      description: 'One sentence, under 90 characters, no full stop needed',
    },
    points: {
      type: 'array',
      description: 'Two to five observations, one or two sentences each',
      items: { type: 'string' },
    },
  },
  required: ['headline', 'points'],
  additionalProperties: false,
};

/**
 * A written read of trends the app has already computed.
 *
 * Everything passed in is a finished number. The prompt forbids inventing
 * others, which is the only reason this is safe to show next to real figures:
 * if the model cannot count, it must not be given anything to count.
 */
export async function narrateTrends(facts, { signal } = {}) {
  return call({
    model: MODELS.narrate,
    system: NARRATE_SYSTEM,
    prompt: `Here is everything known about this household's shopping. Write the read.\n\n${JSON.stringify(facts, null, 2)}`,
    schema: NARRATE_SCHEMA,
    maxTokens: 1500,
    signal,
  });
}
