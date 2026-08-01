# Shopping Pal

The weekly grocery list, moved out of Notes. A static site — no server, no
accounts, no build step — hosted on GitHub Pages.

It answers the things Notes could not:

- **Sort by anything.** The list groups by the route through the store, by the
  original Notes sections, by who an item is for, or flat.
- **Aisle order.** Every item is assigned to a department, and the list is
  ordered the way you actually walk a Walmart Neighborhood Market.
- **Trends.** Top items, how often you buy each thing, what is overdue, where
  the trip goes by department, trip size over time.
- **Publix BOGOs.** This week's buy-one-get-one deals, cross-referenced against
  the things you actually buy.
- **One list for everyone.** An encrypted file in this repo, opened with a
  passphrase — every phone in the house sees the same list.

## Using it

| Tab | What it does |
| --- | --- |
| **This week** | The working list. Type to add, check things off in the store, tap **Finish trip** when you are done. |
| **Catalog** | All 171 items from the Notes list. Search, filter, edit an item's aisle, add new ones. |
| **BOGOs** | The Publix ad, with your regulars called out. |
| **Trends** | Everything computed from finished trips. |
| **Setup** | Who's in the household, the shared list, the store route, and export/import of your data. |

**Finishing a trip is what makes the trends work.** Checked items are recorded
as bought and cleared; unchecked items stay on the list. Nothing you did not
check is ever recorded as bought. With no history yet, the fastest way to get
useful numbers is **Trends → Log a past trip** a few times from memory.

It installs to a phone home screen (Add to Home Screen) and works offline —
useful, since stores eat signal.

**Household names are set in the app**, not in code: Setup → Household. Two
placeholders ship with it; rename them, add more, or remove them. Items like
bagels, snacks, soda, cereal and La Croix are tagged per person, and those tags
follow whatever you name people.

## The shared list

Without it, each phone keeps its own copy in browser storage. Turn it on and
every phone reads and writes one file, `data/vault.json`, in this repo.

Set it up once from **Setup → Shared list → Create the shared list**: pick a
passphrase and paste a GitHub token. Everyone else picks **Join an existing
one** and types the passphrase. Edits are merged, not overwritten — two people
in different aisles can both add to the list, a check on one phone shows up on
the other, and a deletion is not resurrected by the other device's copy.

### How it is protected

The list is encrypted **in the browser** with AES-256-GCM, using a key derived
from the passphrase with PBKDF2-HMAC-SHA-256 at 600,000 iterations. The
passphrase is never uploaded, and there is no server that could read it. The
file in the repo contains a salt, an IV, and ciphertext — nothing else.

**Be honest with yourself about the tradeoff:** this repo is public, so the
encrypted file can be downloaded by anyone, kept forever, and attacked offline
at their leisure. There is no rate limit and no lockout to save you. Its
security is exactly the strength of the passphrase — which is why setup refuses
short or common ones. Four random words is the easy way to get this right.

### Why a token is also needed

Reading takes only the passphrase. Writing means committing to the repo, which
GitHub requires authentication for, and a static page has nowhere safe to keep
a shared secret. So setup offers two options:

- **Token stored inside the encrypted file** (default) — the passphrase alone
  lets anyone in the household edit. Simplest, and the one most people want.
  It also means a cracked passphrase yields a token that can write to this
  repo, so treat the passphrase as the real credential and rotate the token if
  it ever leaks.
- **Token per device** — the passphrase grants read-only access, and each
  person adds their own token in Setup to be able to save. More setup, smaller
  blast radius.

Either way, use a **fine-grained** token scoped to this repository only, with
**Contents: Read and write** and nothing else, and set an expiry.

If you would rather not use any of this: skip it entirely. The app is fully
functional as a local-only list, and **Setup → Export a backup** moves data
between phones by hand.

## Where the data comes from

Being straight about this, because two of the three are approximations:

**Your catalog** — transcribed from the Notes list, including the per-person
items (bagels, snacks, soda, cereal, La Croix) and notes like "2 bunches" and
"only if BOGO". Your edits are stored as a layer on top of the shipped seed, so
updating the site never overwrites them.

**Publix BOGOs** — refreshed by [a scheduled Action](.github/workflows/refresh-bogos.yml)
that commits `data/bogos.json`; the page just reads that file. It cannot be
fetched live from the browser, because Publix sends no CORS headers.

> Publix publishes no documented API and the endpoints their own site uses
> move around, so `scripts/fetch-publix-bogos.mjs` tries several candidates and
> parses whatever JSON comes back. **This has not been confirmed against the
> live site** — the network here could not reach publix.com. Run the workflow
> manually once (Actions → Refresh Publix BOGOs → Run workflow) and check the
> log. If every candidate fails, update `CANDIDATES` in that script with the
> URL the Publix site actually calls (DevTools → Network on
> publix.com/savings/weekly-ad).
>
> A failed fetch is not fatal: the job stays green, records the failed attempt
> in `data/bogos.json`, and the app says plainly that the feed is stale — and
> deals can always be added by hand on the BOGOs tab.

**Aisle layout** — a typical Walmart Neighborhood Market department order.
Walmart has no public per-store aisle API, so this is a sensible default, not
your store. Walk the store once and correct the aisle numbers in **Setup**;
they are yours from then on.

**Trends** — computed entirely from trips you finish in the app. No trips, no
numbers. Nothing is estimated or filled in for you.

## Setup

1. **Settings → Pages → Source: GitHub Actions.** Pushing to `main` deploys.
2. **Settings → Actions → General → Workflow permissions: Read and write**, so
   the BOGO job can commit the refreshed feed.
3. Optional: set a repository variable `PUBLIX_STORE_NUMBER` to your store's
   number for store-specific deals.
4. Optional: open the site, go to **Setup → Household** and name everyone, then
   **Setup → Shared list** to put the list on every phone.

The repo owner and name are read from the page's own URL, so nothing needs
configuring in code. On a custom domain, fill them in under "Repo settings"
when creating or joining the shared list.

## Development

No toolchain — open `index.html` through any static server:

```sh
python3 -m http.server 8000     # then http://localhost:8000
```

Test the BOGO parser without hitting the network:

```sh
node scripts/fetch-publix-bogos.mjs --fixture sample.json --dry-run
node scripts/fetch-publix-bogos.mjs --store 1394            # real fetch
```

### Layout

```
index.html                     shell
assets/css/app.css             all styles
assets/js/app.js               router + shell rendering
assets/js/store.js             state, persistence, actions
assets/js/insights.js          cadence and trend maths
assets/js/deals-data.js        BOGO feed loading + catalog matching
assets/js/crypto.js            passphrase encryption for the shared list
assets/js/sync.js              reading/writing the shared file on GitHub
assets/js/data/catalog.js      the seed list from Notes
assets/js/data/departments.js  the store route
assets/js/views/               one module per tab
scripts/fetch-publix-bogos.mjs the Action's fetcher
data/bogos.json                written by the Action, read by the page
data/vault.json                the encrypted shared list (created from the app)
sw.js                          offline caching
```

## Design

Flat surfaces, hairline rules, one accent color, squared corners, heavy type
and very visible focus rings — closer to a modern government design system than
a consumer app, because the job is legibility at arm's length in a store aisle.
Aisle codes are set in mono like wayfinding signage. Dark mode follows the
system. It prints cleanly, if you would rather carry paper.
