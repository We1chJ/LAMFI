<p align="center">
  <img src="extension/icons/icon128.png" width="112" alt="L.A.M.F.I. icon">
</p>

# L.A.M.F.I. — Link All MotherFuckers In

Chrome extension (MV3) that automates LinkedIn connection requests and keeps a
personal running total, optionally synced across devices via Cloudflare.

> **[Risks](#risks) first.** This automates activity LinkedIn's User Agreement
> prohibits. Consequences land on your account.

| Path | What |
| --- | --- |
| `extension/` | auto-connect + counter |
| `worker/` | Cloudflare Worker for cross-device sync (optional) |

---

## Install

`chrome://extensions` → **Developer mode** → **Load unpacked** → `extension/`

After any edit: click ↻ **and** hard-reload the page (`Cmd/Ctrl+Shift+R`).
Skipping the reload leaves an orphaned content script that logs
`chrome-extension://invalid/` and silently does nothing.

## Use

A HUD sits on the page edge — drag it anywhere and it snaps to the nearest
vertical edge; the `›`/`‹` arrow collapses it to a tab. Position persists.

Start a run from **START**, or right-click → **Connect with everyone on this
page**. The toolbar badge shows live progress while collapsed.

Works on any LinkedIn surface with Connect controls — My Network, people search,
profiles, company **People** tabs — including lists inside a modal, such as a
post's reactions, which it scrolls in place instead of closing. It matches the
control by its label or its visible text, not by the URL, and skips the
neighbours (Message, Follow, Pending/Withdraw, and incoming Accept/Ignore).

Two things vary by surface and both are handled: the control is a `<button>` on
My Network and in "People also viewed", but an `<a>` on search results and on
the profile header. And LinkedIn's current shell scrolls `<main id="workspace">`
rather than the window, so `window.scrollBy()` does nothing there — the engine
finds whatever actually scrolls.

LinkedIn does not always render a Connect control on search results; when it
renders none, there is nothing to click and the run ends on "no more Connect
buttons found".

There are no volume caps of its own — a run goes until something stops it.

When a page runs dry it turns to the next one and keeps going, until there are
no more pages (or 100 of them). LinkedIn pages these lists in place — the
document survives, the URL changes by pushState — so the run just continues.
The "Next" control is only trusted when numbered `Page N` buttons sit alongside
it: My Network has a puzzle carousel whose button is also labelled "Next", and
clicking that would spin a carousel while the run believed it was paging.

**Stops on:** Escape · STOP · LinkedIn's invite-limit notice · 5 consecutive
failures · no more pages · a dialog that won't close.

**Skips** anyone behind a modal it can't answer honestly — the email-verification
gate ("To verify this member knows you, please enter their email to connect")
and "How do you know this person?" are dismissed rather than guessed at. Modal
copy is matched against whitespace-normalised text, because `textContent` wraps
sentences across source lines and a pattern written the way the sentence reads
on screen otherwise misses. Closing is confirmed, not assumed: dismiss control,
then Escape, then report failure.

Only *visible* dialogs count as blocking. LinkedIn doesn't remove a dismissed
modal, it hides it and leaves it in the DOM — so treating "a dialog element
exists" as "a dialog is in the way" means re-handling the same corpse every
iteration until the stuck-dialog guard stops the run. That looks exactly like a
modal refusing to close, and it isn't one. Email gates don't count toward the 5-failure
brake, since they're an expected outcome rather than a sign something broke.

Per invite: find control → activate → wait for proof → resolve the modal →
count → wait 0.8–2s. Roughly 1.5s each on a
surface where pressing works; a surface that needs its link followed costs two
page loads instead.

"Activate" is a ladder, because clicking isn't one operation. A `<button>` wired
to onClick responds to `element.click()`; a control whose handler listens on
`pointerdown` does not, and fails *silently*. So it tries `click()`, checks
whether anything happened, and escalates to the underlying event sequence if
not. Whichever worked is remembered per control shape (`BUTTON`, `A[href]`), not
per URL — the same search URL serves different markup between loads, so a
page-keyed rule breaks the moment LinkedIn varies its response.

If both in-page rungs fail and the control is a link, it stops trying to click
and simply **goes where the link points** — LinkedIn's own invite page, which
renders the modal by itself. That needs no synthetic input at all, but it does
mean leaving the page, so the run keeps its place (who's been tried, how many
sent) in `sessionStorage` and picks itself up on the far side: send → back to
the list → carry on. Costs two page loads per invite, so it's the last resort
rather than the default.

"Proof" is an invite modal appearing, or the control leaving the page *while
the rest of the list stays put*. That second clause matters: LinkedIn re-renders
these lists on its own, and a re-render takes every control with it — so
"my control vanished" on its own is not evidence of anything. When the page
reshuffles, the run records nothing and moves on rather than guessing. Without
proof, nothing is counted. This matters more than it sounds: the previous version
assumed the click landed, so when LinkedIn silently ignored it the counter still
climbed and no invite went out.

## Config

Top of `extension/auto-connect.js`:

```js
delayMinMs: 800,  delayMaxMs: 2000,  // gap between invites
dialogGraceMs: 60,                   // modal glance
settleMs: 100,                       // floor — see below
skipDialogs: false,
maxConsecutiveFailures: 5,           // the only automatic brake
```

`settleMs` < ~100ms and `dialogGraceMs` < ~40ms are **correctness floors** — go
lower and you click faster than LinkedIn's list re-renders, hitting the wrong
row or nothing.

`skipDialogs: true` is fastest but counts every click as a send; on accounts
that show "Add a note?" it sends nothing and stalls while the counter climbs.

## Sync (optional)

Works fine without it — the count just stays on one machine.

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create CONNECTION_STATS   # paste id into wrangler.toml
openssl rand -hex 32                                # token
npx wrangler secret put SYNC_TOKEN
npx wrangler deploy
```

Then **once, on any one device**, in the console on a LinkedIn tab:

```js
LamfiSync.configure("https://connection-stats.YOUR-SUBDOMAIN.workers.dev", "YOUR_TOKEN")
```

That writes to `chrome.storage.sync`, so it rides your Google account to every
signed-in Chrome — **other devices need nothing but the extension**. The token
can't live in Cloudflare, since it's what gets you into Cloudflare.

> Never commit your token or Worker URL. This repo is public.

**API** — all routes need `Authorization: Bearer <token>`:
`GET /count` · `POST /count {total}` (stores the max) · `DELETE /count`

### How it flows

Local storage is authoritative; Cloudflare is a mirror.

```
sent → lamfi:total += 1 → HUD updates instantly
                        → debounce 10s → POST {total} → KV max(incoming, stored)
```

Pushes carry the **absolute total**, not a delta, so retries can't double-count
and a stale device can't stomp a higher number. The debounce resets on every
change — a 50-invite run is one POST, not fifty. Necessary because KV allows
1 write/sec per key and runs send 2–4/sec.

**Non-obvious:** pull happens on page load only, so two open tabs don't track
each other.

## Risks

LinkedIn's User Agreement forbids "software, scripts, bots, browser plugins, or
extensions" that automate activity. This is that.

Enforcement escalates: warning → invite block (1–7 days) → read-only restriction
(24–72h) → permanent. Volume (~100/week) and automation detection are
**separate triggers** — you can be flagged by the second while under the first.
Browser extensions specifically were targeted in LinkedIn's early-2026
escalation.

Invites are irreversible and go to real people; ignored invites throttle you
faster than raw volume. Published limits are unofficial, personalised, and
change — treat every number here as approximate.

## Known limitations

LinkedIn's DOM is obfuscated and shifts without notice. Check what the current
page offers with:

```js
[...document.querySelectorAll('button,[role="button"],a')]
  .filter((b) => /connect/i.test(b.getAttribute("aria-label") ?? b.textContent)).length
```

Zero on a page that visibly has Connect buttons means `isConnectButton()` needs
updating. Simultaneous bumps in two tabs can lose a count
(reconciled by taking the higher value). Remote reads lag a local bump by up to
the 10s debounce.

## Development

No build step. Content scripts share one scope, so `manifest.json` load order
matters:

```
config.local.js → lamfi-count.js → lamfi-sync.js → auto-connect.js → hud.js → content.js
```

`lamfi-sync.js` watches `chrome.storage.onChanged` rather than importing the
counter — the storage key is the interface.
