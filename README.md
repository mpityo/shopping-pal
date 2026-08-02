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
- **One list for everyone.** An encrypted file in this repo, opened by an
  invite link — every phone in the house sees the same list.
- **Receipt import.** Paste or photograph a receipt to record a trip, with
  prices, so the trends have real history and real spend behind them.
- **Claude, optionally.** Reads receipt abbreviations, picks the aisle for an
  unfamiliar item, and writes the short version of the trends. Off until you
  add a key.

## Using it

| Tab | What it does |
| --- | --- |
| **This week** | The working list. Type to add, check things off in the store, tap **Finish trip** when you are done. |
| **Catalog** | All 171 items from the Notes list. Search, filter, edit an item's aisle, add new ones. |
| **BOGOs** | The Publix ad, with your regulars called out. |
| **Trends** | Everything computed from finished trips. |
| **Setup** | Who's in the household, the shared list, Claude, the store route, and export/import of your data. |

## Importing receipts

Three ways in:

- **Share it from Android.** Once the app is installed to the home screen it
  appears in the system share sheet. Share a receipt PDF straight from Gmail or
  the store's app and the importer opens with it already loaded.
- **Trends → Import a receipt**, then choose a PDF or photo. Emailed receipts
  are usually text PDFs, and their text is read directly — as accurate as
  pasting.
- **Paste the text.** Always works, needs nothing downloaded.

Everything is read on your device. PDFs and photos are never uploaded, and
nothing is written to the repo except the extracted lines, inside the encrypted
vault.

Every line is reviewed before anything is recorded. That is deliberate: trips
are the only source for every trend, so one mis-parsed line quietly corrupts
the numbers the app exists to produce. The review screen shows what was matched
confidently, what it is unsure about, and what needs picking.

**Corrections are remembered.** `GV SHRD MOZZ` is never going to fuzzy-match
shredded cheese, so fix it once and every future receipt maps it automatically.
Setup lists what has been learned, in case something needs unlearning. With a
Claude key added, the abbreviations are read for you and you mostly stop doing
this by hand — see [Claude](#claude).

**Two stores, one trip.** Importing a second receipt with the same date merges
into that trip rather than creating another, so a Publix run and a Walmart run
count as one outing — with each line tagged by store and spend split between
them.

**Shop with the list, then share the receipt.** This is the normal way round,
and it is handled properly: items you checked off already count as bought, so a
receipt line matching one of them fills in what it cost rather than recording
the purchase twice. Lines the receipt has and the list did not are added.
Things you checked off that are not on this receipt are named and left alone —
usually the other shop's half of the trip.

**Nothing gets double-counted.** Sharing the same receipt twice is easy to do
from a phone, so each one is fingerprinted: re-importing says so plainly. Lines
already recorded *with a price* are flagged and unticked, and you can tick one
back on if you really did buy two.

Before importing, the app checks its own arithmetic: items, minus savings, plus
tax should equal the printed total. If it doesn't, it says so, because that
usually means a line was misread.

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

## Claude

Optional, off by default, and useless to steal from the repo — the key lives on
your phone, not in this project.

### What it does, and what it deliberately does not

Three jobs, all of them things arithmetic cannot do:

- **Reads receipt abbreviations.** `GV SHRD MOZZ` is never going to fuzzy-match
  shredded cheese. Only the lines the local matcher gave up on are sent, so a
  receipt whose names already resolve costs nothing. Suggestions land in the
  same review table as everything else, labelled as Claude's, and still have to
  be confirmed. Confident matches are then remembered as aliases, so the same
  wording is free forever after.
- **Picks the aisle for a new item.** Add "tahini" and the department dropdown
  fills itself in. Constrained to your actual department list, so the worst case
  is a wrong answer in a dropdown you already have open.
- **Writes the short version of the trends.** What is becoming a regular, what
  quietly stopped, what is overdue — in sentences.

**It is never asked to count.** Every figure in this app — how often something
is bought, its typical gap, what is overdue, what a trip cost — is computed in
`insights.js` and stays there. The trends read-out is handed those finished
numbers and told to write prose over them, not to work anything out. A language
model is worse at counting than `Math.round` is, and would sometimes be
confidently wrong. So the division is strict: the app does the arithmetic,
Claude does the language.

### The key

**One per device, pasted into Setup → Claude.** It is kept in its own storage
slot, deliberately outside the application state object — which means there is
no code path, now or later, that can sweep it into the shared vault or into an
exported backup. Both of those end up somewhere world-readable, and unlike the
GitHub token this key is billable.

That is why it is not shared the way the list is: a stray invite link should
cost you a grocery list, not a bill. The price of that choice is that each
phone needs its own key, and a phone without one simply gets the fuzzy matcher
and no trends read-out. Nothing here is load-bearing.

Get one from [console.anthropic.com](https://console.anthropic.com). Setup
shows a running tally of requests, tokens and rough spend, so a billable
feature is never invisible.

### What leaves the device

| Sent | Never sent |
| --- | --- |
| Unmatched receipt line text | The receipt PDF or photo |
| Your catalog item names | Prices, totals, tax, what you paid |
| A new item's name | Anything about who is in the household |
| Trend figures the app computed | The vault, the key, or the GitHub token |

Requests go straight from your browser to Anthropic. Nothing passes through
this repo, and nothing is written back to it.

### Models

| Job | Model | Why |
| --- | --- | --- |
| Receipt lines | `claude-haiku-4-5` | Runs on every import — this is the volume path, and it is a constrained extraction task |
| New item's aisle | `claude-haiku-4-5` | Interactive; latency matters more than nuance |
| Trends read-out | `claude-sonnet-5` | Once a week over a few hundred tokens, so the better writer is effectively free |

Both are set in one place, `MODELS` at the top of `assets/js/ai.js`.

## The shared list

Without it, each phone keeps its own copy in browser storage. Turn it on and
every phone reads and writes one file, `data/vault.json`, in this repo.

Set it up once from **Setup → Shared list → Create the shared list**: paste a
GitHub token, and the app hands you an **invite link**. Send that link to
everyone in the house. Opening it puts the list on their phone; Add to Home
Screen from there and it keeps working. Edits are merged, not overwritten —
two people in different aisles can both add to the list, a check on one phone
shows up on the other, and a deletion is not resurrected by the other device's
copy.

### How it is protected

The app generates a random 256-bit key. There is no passphrase to invent,
remember, or type. The list is encrypted in the browser with AES-256-GCM under
that key, and the file in the repo contains an IV and ciphertext — nothing
else.

The key travels in the **fragment** of the invite link (`#/list?k=…`). Browsers
never put the fragment in an HTTP request, so it does not reach GitHub's
servers, the Pages CDN, or anything in between.

**Why generated and not chosen.** The repo is public, so the ciphertext can be
downloaded by anyone and attacked offline forever, with no rate limit to slow
it down. That makes the secret's entropy the entire defence:

| Secret | Time to break offline (1 GPU) |
| --- | --- |
| A phrase someone invented | hours |
| Four genuinely random words | thousands of years |
| Generated 256-bit key | not possible, at any budget |

A password field cannot tell the difference between the first two rows, which
is why there isn't one.

**The trade this makes:** possession of the link is access to the list. Send it
through something private — a message to the household, AirDrop, a password
manager — not a public channel. The key stays in the address bar so that Add to
Home Screen works (an installed iOS web app has its own storage and has to
receive the key through the URL it was installed from), so treat a screen-share
of Setup the way you'd treat one of your password manager.

If a link ever goes astray: **Setup → Shared list → Rotate key** re-encrypts
under a fresh key and kills every existing link, including your own. Nothing on
the list is lost.

### Why a token is also needed

Reading takes only the link. Writing means committing to the repo, which GitHub
requires authentication for, and a static page has nowhere safe to keep a
shared secret. Two options at setup:

- **Token inside the encrypted file** (default) — the invite link alone lets
  anyone in the household edit. This is only sound because the key is
  generated: with a typed passphrase, cracking it would also hand over a token
  that can write to this repo.
- **Token per device** — the link grants read access, and each person adds
  their own token in Setup to save. Worth it if you'd rather one lost phone not
  carry write access for everybody.

Either way, use a **fine-grained** token scoped to this repository only, with
**Contents: Read and write** and nothing else, and set an expiry.

If you'd rather not use any of this: skip it. The app is fully functional as a
local-only list, and **Setup → Export a backup** moves data between phones by
hand.

## Where the data comes from

Being straight about this, because two of the three are approximations:

**Your catalog** — transcribed from the Notes list, including the per-person
items (bagels, snacks, soda, cereal, La Croix) and notes like "2 bunches" and
"only if BOGO". Your edits are stored as a layer on top of the shipped seed, so
updating the site never overwrites them.

**Publix BOGOs** — refreshed by [a scheduled Action](.github/workflows/refresh-bogos.yml)
that commits `data/bogos.json`; the page just reads that file. It cannot be
fetched live from the browser, because neither source sends CORS headers.

Two sources are combined:

- **The weekly ad** — the shelf BOGOs, fetched from the circular platform that
  renders Publix's ad. Keyed by **postal code**, and filtered to Publix, since
  the search covers every merchant in the area.
- **Digital coupons** — from `services.publix.com`, keyed by store number. Only
  the genuine buy-one-get-one offers are kept; the plain "Save $1.00" coupons
  that make up most of that feed are skipped.

> Publix publishes no documented API, so both endpoints were found by probing.
> If either shape changes, run the workflow with **discover** ticked: it tries
> a spread of endpoints and reports what each returns — row counts, field
> names, how many rows look like BOGOs, sample titles, and for the ad page,
> which platform renders it. One log usually says what to change.
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
3. Set two repository variables (Settings → Secrets and variables → Actions):
   `PUBLIX_POSTAL_CODE` for the weekly-ad BOGOs, and `PUBLIX_STORE_NUMBER` for
   store-specific digital coupons. Without the postal code the weekly ad — the
   shelf BOGOs, and the bulk of the deals — cannot be fetched.
4. Optional: open the site, go to **Setup → Household** and name everyone, then
   **Setup → Shared list** to put the list on every phone via an invite link.

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
assets/js/receipts.js          receipt parsing, matching, reconciliation
assets/js/ocr.js               optional photo OCR, loaded only when used
assets/js/pdf.js               PDF text extraction, loaded only when used
assets/js/crypto.js            key generation + encryption for the shared list
assets/js/sync.js              reading/writing the shared file on GitHub
assets/js/ai.js                optional Claude calls, key kept per device
assets/js/data/catalog.js      the seed list from Notes
assets/js/data/departments.js  the store route
assets/js/views/               one module per tab
assets/js/views/ai-hints.js    view glue for Claude's suggestions
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
