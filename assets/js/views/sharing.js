/**
 * Setup UI for the shared, passphrase-encrypted list.
 *
 * Two deliberate pieces of friction live here: the passphrase strength gate,
 * and the plain warning about what putting a token in the vault means. The
 * file is public and permanent, so both matter more than they would behind a
 * login.
 */
import { h, modal, toast } from '../util.js';
import * as sync from '../sync.js';
import * as vault from '../crypto.js';

export function sharingCard(ctx) {
  const cfg = sync.getConfig();
  const status = sync.getStatus();

  if (!vault.isSupported()) {
    return h(
      'section',
      { class: 'card' },
      h('div', { class: 'card__head' }, h('h3', {}, 'Shared list')),
      h(
        'div',
        { class: 'card__body' },
        h(
          'div',
          { class: 'notice notice--warn' },
          h('strong', {}, 'Encryption is not available here'),
          'Web Crypto needs a secure context. Open the site over https:// rather than as a local file.',
        ),
      ),
    );
  }

  return h(
    'section',
    { class: 'card card--accent' },
    h(
      'div',
      { class: 'card__head' },
      h('h3', {}, 'Shared list'),
      h('span', { class: 'spacer' }),
      statusBadge(status),
    ),
    h('div', { class: 'card__body' }, cfg.enabled ? connected(ctx, cfg, status) : notConnected(ctx)),
  );
}

function statusBadge(status) {
  const map = {
    off: ['badge--plain', 'Not set up'],
    locked: ['badge--due', 'Locked'],
    syncing: ['badge--plain', 'Syncing…'],
    ok: ['badge--person', 'In sync'],
    readonly: ['badge--deal', 'Read-only'],
    error: ['badge--due', 'Problem'],
  };
  const [cls, label] = map[status.state] ?? map.off;
  return h('span', { class: `badge ${cls}` }, label);
}

// ── Not connected ────────────────────────────────────────────────────────

function notConnected(ctx) {
  const { owner, repo } = sync.detectRepo();

  return h(
    'div',
    {},
    h(
      'p',
      {},
      'Keep one list across every phone in the house. The list, catalog and trip history are encrypted in the browser with a passphrase you choose, and stored as a single file in this repo.',
    ),
    h(
      'div',
      { class: 'notice' },
      h('strong', {}, 'This repo is public'),
      'Anyone can download the encrypted file. They cannot read it without the passphrase, but they can try to guess it for as long as they like — so use a long one. Nobody who lacks the passphrase learns anything about your list.',
    ),
    owner && repo
      ? h('p', { class: 'dept-note' }, `Detected repo: ${owner}/${repo}`)
      : h(
          'div',
          { class: 'notice notice--warn' },
          h('strong', {}, 'Could not detect the repo'),
          'This page is not being served from github.io, so the owner and repo have to be entered by hand below.',
        ),
    h(
      'div',
      { class: 'btn-row' },
      h('button', { class: 'btn btn--primary', onClick: () => createDialog(ctx) }, 'Create the shared list'),
      h('button', { class: 'btn btn--ghost', onClick: () => joinDialog(ctx) }, 'Join an existing one'),
    ),
  );
}

// ── Connected ────────────────────────────────────────────────────────────

function connected(ctx, cfg, status) {
  const locked = status.state === 'locked';

  return h(
    'div',
    {},
    locked
      ? h(
          'div',
          {},
          h('p', {}, 'The shared list is set up on this device but locked. Enter the passphrase to open it.'),
          h(
            'div',
            { class: 'btn-row' },
            h('button', { class: 'btn btn--primary', onClick: () => joinDialog(ctx) }, 'Unlock'),
            h('button', { class: 'btn btn--ghost', onClick: () => disconnect(ctx) }, 'Forget on this device'),
          ),
        )
      : h(
          'div',
          {},
          h(
            'p',
            { class: 'dept-note' },
            `${cfg.owner}/${cfg.repo} · ${cfg.path}`,
            status.lastSync ? ` · last synced ${new Date(status.lastSync).toLocaleString()}` : '',
          ),
          status.message ? h('p', {}, status.message) : null,
          status.state === 'readonly'
            ? h(
                'div',
                { class: 'notice notice--warn' },
                h('strong', {}, 'Read-only on this device'),
                'Changes are saved here but not shared, because there is no GitHub token. Add one below to save for everyone.',
              )
            : null,
          status.state === 'error'
            ? h('div', { class: 'notice notice--warn' }, h('strong', {}, 'Last sync failed'), status.message)
            : null,
          cfg.tokenInVault
            ? h(
                'div',
                { class: 'notice' },
                h('strong', {}, 'Passphrase grants editing'),
                'The access token is stored inside the encrypted file, so anyone with the passphrase can edit the list. Rotate the token if the passphrase ever gets out.',
              )
            : null,
          h(
            'div',
            { class: 'btn-row' },
            h(
              'button',
              {
                class: 'btn btn--ghost',
                onClick: async () => {
                  await sync.pull();
                  toast('Checked for changes');
                  ctx.rerender();
                },
              },
              'Sync now',
            ),
            h(
              'button',
              {
                class: 'btn btn--ghost',
                onClick: async () => {
                  const ok = await sync.push();
                  toast(ok ? 'Saved to the shared list' : 'Could not save — see the message above');
                  ctx.rerender();
                },
              },
              'Save now',
            ),
            h('button', { class: 'btn btn--ghost', onClick: () => tokenDialog(ctx) }, 'Access token'),
            h('button', { class: 'btn btn--danger', onClick: () => disconnect(ctx) }, 'Forget on this device'),
          ),
        ),
  );
}

function disconnect(ctx) {
  if (
    !confirm(
      'Forget the shared list on this device? Your local list and history stay exactly as they are, and the shared file is not deleted.',
    )
  ) {
    return;
  }
  sync.disconnect();
  toast('Disconnected from the shared list');
  ctx.rerender();
}

// ── Shared form pieces ───────────────────────────────────────────────────

function passphraseField(id, label, onRate) {
  const input = h('input', {
    type: 'password',
    id,
    autocomplete: 'new-password',
    required: true,
    onInput: onRate,
  });
  return { input, node: h('div', { class: 'field' }, h('label', { for: id }, label), input) };
}

function repoFields(cfg) {
  const detected = sync.detectRepo();
  const owner = h('input', { type: 'text', id: 'sync-owner', value: detected.owner ?? '' });
  const repo = h('input', { type: 'text', id: 'sync-repo', value: detected.repo ?? '' });
  const branch = h('input', { type: 'text', id: 'sync-branch', value: cfg.branch || 'main' });
  const path = h('input', { type: 'text', id: 'sync-path', value: cfg.path || 'data/vault.json' });

  const node = h(
    'details',
    { style: { marginBottom: '0.9rem' } },
    h('summary', { style: { cursor: 'pointer', fontSize: '0.85rem', fontWeight: '700' } }, 'Repo settings'),
    h('div', { style: { paddingTop: '0.6rem' } },
      h('div', { class: 'field' }, h('label', { for: 'sync-owner' }, 'Owner'), owner),
      h('div', { class: 'field' }, h('label', { for: 'sync-repo' }, 'Repo'), repo),
      h('div', { class: 'field' }, h('label', { for: 'sync-branch' }, 'Branch'), branch),
      h('div', { class: 'field' }, h('label', { for: 'sync-path' }, 'File path'), path),
    ),
  );

  return { node, values: () => ({ owner: owner.value.trim(), repo: repo.value.trim(), branch: branch.value.trim(), path: path.value.trim() }) };
}

function tokenHelp() {
  return h(
    'p',
    { class: 'hint' },
    'Create one at GitHub → Settings → Developer settings → Fine-grained tokens. Give it access to this repository only, with ',
    h('strong', {}, 'Contents: Read and write'),
    ' — nothing else. Set an expiry you are willing to renew.',
  );
}

function busy(button, label) {
  button.disabled = true;
  button.textContent = label;
}

// ── Create ───────────────────────────────────────────────────────────────

function createDialog(ctx) {
  const cfg = sync.getConfig();
  const rating = h('p', { class: 'hint' }, 'Use four random words, or a long phrase only you would say.');

  const pass = passphraseField('vault-pass', 'Passphrase', (e) => {
    const result = vault.ratePassphrase(e.target.value);
    rating.textContent = result.message;
    rating.style.color =
      result.level === 'strong' ? 'var(--brand)' : result.level === 'fair' ? 'var(--ink-2)' : 'var(--alert)';
  });
  const confirmInput = h('input', { type: 'password', id: 'vault-pass2', autocomplete: 'new-password', required: true });
  const tokenInput = h('input', { type: 'password', id: 'vault-token', autocomplete: 'off', required: true });
  const inVault = h('input', { type: 'checkbox', id: 'vault-token-shared', checked: true });
  const repo = repoFields(cfg);
  const submit = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Create shared list');
  const error = h('p', { class: 'hint', style: { color: 'var(--alert)' } });

  const dialog = modal(
    'Create the shared list',
    h(
      'form',
      {
        onSubmit: async (e) => {
          e.preventDefault();
          error.textContent = '';

          const quality = vault.ratePassphrase(pass.input.value);
          if (!quality.ok) {
            error.textContent = `Pick a stronger passphrase — ${quality.message}`;
            return;
          }
          if (pass.input.value !== confirmInput.value) {
            error.textContent = 'The two passphrases do not match.';
            return;
          }

          busy(submit, 'Creating…');
          try {
            await sync.createVault({
              passphrase: pass.input.value,
              token: tokenInput.value.trim(),
              tokenInVault: inVault.checked,
              ...repo.values(),
            });
            dialog.close();
            toast('Shared list created — share the passphrase with the household');
            ctx.rerender();
          } catch (err) {
            error.textContent = err.message;
            submit.disabled = false;
            submit.textContent = 'Create shared list';
          }
        },
      },
      h(
        'p',
        { class: 'hint' },
        'Everything is encrypted in this browser before it leaves. The passphrase is never sent anywhere and cannot be recovered — if it is lost, the shared list is unreadable.',
      ),
      pass.node,
      rating,
      h('div', { class: 'field' }, h('label', { for: 'vault-pass2' }, 'Passphrase again'), confirmInput),
      h('div', { class: 'field' }, h('label', { for: 'vault-token' }, 'GitHub access token'), tokenHelp(), tokenInput),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          { style: { display: 'flex', gap: '0.5rem', alignItems: 'flex-start' } },
          inVault,
          h(
            'label',
            { for: 'vault-token-shared', style: { margin: 0, fontWeight: '400' } },
            'Store the token inside the encrypted file, so anyone with the passphrase can edit',
          ),
        ),
        h(
          'p',
          { class: 'hint' },
          'On: everyone just needs the passphrase. Off: the passphrase gives read access, and each person adds their own token to edit. Leaving it on means a guessed passphrase also yields a token that can write to this repo — which is why the passphrase check above is strict.',
        ),
      ),
      repo.node,
      error,
      h(
        'div',
        { class: 'btn-row' },
        submit,
        h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
      ),
    ),
    { wide: true },
  );
}

// ── Join / unlock ────────────────────────────────────────────────────────

function joinDialog(ctx) {
  const cfg = sync.getConfig();
  const passInput = h('input', { type: 'password', id: 'join-pass', autocomplete: 'current-password', required: true });
  const tokenInput = h('input', { type: 'password', id: 'join-token', autocomplete: 'off' });
  const remember = h('input', { type: 'checkbox', id: 'join-remember', checked: true });
  const repo = repoFields(cfg);
  const submit = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Open shared list');
  const error = h('p', { class: 'hint', style: { color: 'var(--alert)' } });

  const dialog = modal(
    'Open the shared list',
    h(
      'form',
      {
        onSubmit: async (e) => {
          e.preventDefault();
          error.textContent = '';
          busy(submit, 'Opening…');
          try {
            await sync.unlock({
              passphrase: passInput.value,
              token: tokenInput.value.trim() || undefined,
              remember: remember.checked,
              ...repo.values(),
            });
            dialog.close();
            toast('Shared list opened');
            ctx.rerender();
          } catch (err) {
            error.textContent = err.message;
            submit.disabled = false;
            submit.textContent = 'Open shared list';
          }
        },
      },
      h(
        'p',
        { class: 'hint' },
        'Anything already on this device is merged with the shared list rather than replaced.',
      ),
      h('div', { class: 'field' }, h('label', { for: 'join-pass' }, 'Passphrase'), passInput),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'join-token' }, 'GitHub access token (optional)'),
        h(
          'p',
          { class: 'hint' },
          'Only needed if the shared list does not carry its own token. Without one this device can read but not save for everyone.',
        ),
        tokenInput,
      ),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          { style: { display: 'flex', gap: '0.5rem', alignItems: 'center' } },
          remember,
          h(
            'label',
            { for: 'join-remember', style: { margin: 0, fontWeight: '400' } },
            'Stay unlocked on this device',
          ),
        ),
        h(
          'p',
          { class: 'hint' },
          'Off means typing the passphrase each visit. On stores it in this browser — fine for a personal phone, not for a shared computer.',
        ),
      ),
      repo.node,
      error,
      h(
        'div',
        { class: 'btn-row' },
        submit,
        h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
      ),
    ),
    { wide: true },
  );
}

// ── Token ────────────────────────────────────────────────────────────────

function tokenDialog(ctx) {
  const tokenInput = h('input', { type: 'password', id: 'set-token', autocomplete: 'off' });
  const remember = h('input', { type: 'checkbox', id: 'set-token-remember', checked: true });

  const dialog = modal(
    'Access token for this device',
    h(
      'form',
      {
        onSubmit: (e) => {
          e.preventDefault();
          sync.setDeviceToken(tokenInput.value.trim(), { remember: remember.checked });
          dialog.close();
          toast(tokenInput.value.trim() ? 'Token saved on this device' : 'Token cleared');
          ctx.rerender();
        },
      },
      h(
        'p',
        { class: 'hint' },
        'Stored in this browser only, never in the shared file. Leave blank and save to remove it.',
      ),
      tokenHelp(),
      h('div', { class: 'field' }, h('label', { for: 'set-token' }, 'Token'), tokenInput),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          { style: { display: 'flex', gap: '0.5rem', alignItems: 'center' } },
          remember,
          h('label', { for: 'set-token-remember', style: { margin: 0, fontWeight: '400' } }, 'Remember on this device'),
        ),
      ),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn btn--primary', type: 'submit' }, 'Save'),
        h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => dialog.close() }, 'Cancel'),
      ),
    ),
  );
}
