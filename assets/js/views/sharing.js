/**
 * Setup UI for the shared, encrypted list.
 *
 * The key is generated, never typed, so there is no passphrase field and no
 * strength meter to argue with. What replaces them is being clear about what
 * the invite link *is*: possession of it is access to the list, so it gets
 * handled like a credential — revealed on request rather than sat on screen,
 * and rotatable in one click.
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
    locked: ['badge--due', 'Needs the link'],
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
      'Keep one list across every phone in the house. The list, catalog and trip history are encrypted in the browser and stored as a single file in this repo. Everyone gets in with one invite link.',
    ),
    h(
      'div',
      { class: 'notice' },
      h('strong', {}, 'How it is protected'),
      'The app generates a random 256-bit key — nothing you have to invent or remember. It rides in the link’s fragment, which browsers never send to a server. The repo is public, so anyone can download the encrypted file, but there is no guessing their way into it.',
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
      h('button', { class: 'btn btn--ghost', onClick: () => joinDialog(ctx) }, 'Open with a link'),
    ),
  );
}

// ── Connected ────────────────────────────────────────────────────────────

function connected(ctx, cfg, status) {
  if (status.state === 'locked') {
    return h(
      'div',
      {},
      h(
        'p',
        {},
        'The shared list is set up for this repo, but this device does not have the key. Open the invite link, or paste it below.',
      ),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn btn--primary', onClick: () => joinDialog(ctx) }, 'Paste the invite link'),
        h('button', { class: 'btn btn--ghost', onClick: () => disconnect(ctx) }, 'Forget on this device'),
      ),
    );
  }

  return h(
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
          h('strong', {}, 'The invite link grants editing'),
          'The access token is stored inside the encrypted file, so anyone holding the link can edit the list. Treat it like a house key — and rotate it below if it ever goes astray.',
        )
      : null,
    h(
      'div',
      { class: 'btn-row' },
      h('button', { class: 'btn btn--primary', onClick: () => showLink(ctx) }, 'Invite link'),
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
      h('button', { class: 'btn btn--danger', onClick: () => rotateDialog(ctx) }, 'Rotate key'),
      h('button', { class: 'btn btn--danger', onClick: () => disconnect(ctx) }, 'Forget device'),
    ),
  );
}

function disconnect(ctx) {
  if (
    !confirm(
      'Forget the shared list on this device? Your local list and history stay exactly as they are, and the shared file is not deleted. You will need the invite link to get back in.',
    )
  ) {
    return;
  }
  sync.disconnect();
  toast('Disconnected from the shared list');
  ctx.rerender();
}

// ── Invite link ──────────────────────────────────────────────────────────

/**
 * Shows the link behind an explicit action rather than printing it into the
 * page: it is the credential, and Setup gets left open on shared screens.
 */
function showLink(ctx, { title = 'Invite link', intro = null } = {}) {
  const link = sync.inviteLink();
  if (!link) {
    toast('This device does not have the key');
    return;
  }

  const field = h('textarea', {
    readonly: true,
    rows: 3,
    value: link,
    style: { fontFamily: 'var(--mono)', fontSize: '0.78rem' },
    onFocus: (e) => e.target.select(),
  });

  const dialog = modal(
    title,
    h(
      'div',
      {},
      intro,
      h(
        'p',
        {},
        'Send this to everyone in the house. Opening it puts the list on their phone — they can then use Add to Home Screen and it keeps working.',
      ),
      h(
        'div',
        { class: 'notice notice--warn' },
        h('strong', {}, 'This link is the key'),
        'Anyone who gets hold of it can read and edit the list. Send it through something private — a message to the household, AirDrop, a password manager — not a public channel. Rotate the key if it leaks.',
      ),
      h('div', { class: 'field' }, field),
      h(
        'div',
        { class: 'btn-row' },
        h(
          'button',
          {
            class: 'btn btn--primary',
            type: 'button',
            onClick: async () => {
              try {
                if (navigator.share) {
                  await navigator.share({ title: 'Shopping Pal', url: link });
                } else {
                  await navigator.clipboard.writeText(link);
                  toast('Invite link copied');
                }
              } catch {
                field.focus();
                field.select();
                toast('Copy the highlighted link');
              }
            },
          },
          navigator.share ? 'Send link' : 'Copy link',
        ),
        h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => dialog.close() }, 'Done'),
      ),
    ),
  );
  return dialog;
}

function rotateDialog(ctx) {
  const dialog = modal(
    'Rotate the key?',
    h(
      'div',
      {},
      h(
        'p',
        {},
        'This re-encrypts the shared list under a brand new key. Every existing invite link stops working immediately, including on your own other devices — you will need to send the new link to everyone again.',
      ),
      h('p', { class: 'hint' }, 'Nothing on the list is lost; outstanding changes are merged in first.'),
      h(
        'div',
        { class: 'btn-row' },
        h(
          'button',
          {
            class: 'btn btn--danger',
            onClick: async (e) => {
              e.target.disabled = true;
              e.target.textContent = 'Rotating…';
              try {
                await sync.rotateKey();
                dialog.close();
                showLink(ctx, {
                  title: 'New invite link',
                  intro: h(
                    'div',
                    { class: 'notice' },
                    h('strong', {}, 'Key rotated'),
                    'The old links are dead. This is the replacement.',
                  ),
                });
                ctx.rerender();
              } catch (err) {
                alert(err.message);
                e.target.disabled = false;
                e.target.textContent = 'Rotate the key';
              }
            },
          },
          'Rotate the key',
        ),
        h('button', { class: 'btn btn--ghost', onClick: () => dialog.close() }, 'Cancel'),
      ),
    ),
  );
}

// ── Shared form pieces ───────────────────────────────────────────────────

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
    h(
      'div',
      { style: { paddingTop: '0.6rem' } },
      h('div', { class: 'field' }, h('label', { for: 'sync-owner' }, 'Owner'), owner),
      h('div', { class: 'field' }, h('label', { for: 'sync-repo' }, 'Repo'), repo),
      h('div', { class: 'field' }, h('label', { for: 'sync-branch' }, 'Branch'), branch),
      h('div', { class: 'field' }, h('label', { for: 'sync-path' }, 'File path'), path),
    ),
  );

  return {
    node,
    values: () => ({
      owner: owner.value.trim(),
      repo: repo.value.trim(),
      branch: branch.value.trim(),
      path: path.value.trim(),
    }),
  };
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

// ── Create ───────────────────────────────────────────────────────────────

function createDialog(ctx) {
  const cfg = sync.getConfig();
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
          submit.disabled = true;
          submit.textContent = 'Creating…';
          try {
            await sync.createVault({
              token: tokenInput.value.trim(),
              tokenInVault: inVault.checked,
              ...repo.values(),
            });
            dialog.close();
            showLink(ctx, {
              title: 'Shared list created',
              intro: h(
                'div',
                { class: 'notice' },
                h('strong', {}, 'Here is the only way in'),
                'There is no password to recover and no reset. Save this link somewhere you trust before closing.',
              ),
            });
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
        'The app generates the encryption key for you — there is nothing to choose or remember. You will get an invite link to send to the household.',
      ),
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
            'Store the token inside the encrypted file, so the invite link alone allows editing',
          ),
        ),
        h(
          'p',
          { class: 'hint' },
          'On: everyone just needs the link. Off: the link gives read access, and each person adds their own token to edit — worth it if you would rather one person’s lost phone not carry write access for everybody.',
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

// ── Join ─────────────────────────────────────────────────────────────────

function joinDialog(ctx) {
  const cfg = sync.getConfig();
  const linkInput = h('textarea', {
    id: 'join-link',
    rows: 3,
    required: true,
    placeholder: 'Paste the invite link',
    style: { fontFamily: 'var(--mono)', fontSize: '0.78rem' },
  });
  const tokenInput = h('input', { type: 'password', id: 'join-token', autocomplete: 'off' });
  const remember = h('input', { type: 'checkbox', id: 'join-remember', checked: true });
  const legacy = h('input', { type: 'password', id: 'join-passphrase', autocomplete: 'off' });
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
          submit.disabled = true;
          submit.textContent = 'Opening…';
          try {
            const result = await sync.unlock({
              key: linkInput.value,
              passphrase: legacy.value.trim() || undefined,
              token: tokenInput.value.trim() || undefined,
              remember: remember.checked,
              ...repo.values(),
            });
            dialog.close();
            if (result.upgraded) {
              showLink(ctx, {
                title: 'Upgraded to a generated key',
                intro: h(
                  'div',
                  { class: 'notice' },
                  h('strong', {}, 'The passphrase no longer opens this list'),
                  'It was replaced with a generated key that cannot be guessed. Send this link to the household.',
                ),
              });
            } else {
              toast('Shared list opened');
            }
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
        'Normally you just open the invite link and this happens automatically. Paste it here if the link will not open directly. Anything already on this device is merged in rather than replaced.',
      ),
      h('div', { class: 'field' }, h('label', { for: 'join-link' }, 'Invite link or key'), linkInput),
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
          h('label', { for: 'join-remember', style: { margin: 0, fontWeight: '400' } }, 'Stay open on this device'),
        ),
      ),
      h(
        'details',
        { style: { marginBottom: '0.9rem' } },
        h(
          'summary',
          { style: { cursor: 'pointer', fontSize: '0.85rem', fontWeight: '700' } },
          'This list was made with a passphrase',
        ),
        h(
          'div',
          { style: { paddingTop: '0.6rem' } },
          h(
            'p',
            { class: 'hint' },
            'Only for lists created by the earlier version. Entering the passphrase opens it and replaces it with a generated key.',
          ),
          h('div', { class: 'field' }, h('label', { for: 'join-passphrase' }, 'Old passphrase'), legacy),
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
