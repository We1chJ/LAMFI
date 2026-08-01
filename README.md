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

**Stops on:** Escape · STOP · weekly cap (90) · LinkedIn's invite-limit dialog ·
5 consecutive failures · no buttons after 5 scrolls · a dialog that won't close.

Per invite: find button → click → glance ≤60ms for the modal → "Send without a
note" → count → wait 150–350ms. About 250–510ms each. Unrecognised modals
(e.g. "How do you know this person?") are dismissed and skipped — it never
guesses an answer.

## Config

Top of `extension/auto-connect.js`:

```js
delayMinMs: 150,  delayMaxMs: 350,   // gap between invites
dialogGraceMs: 60,                   // modal glance
settleMs: 100,                       // floor — see below
skipDialogs: false,
sessionCap: Infinity,  dailyCap: Infinity,
weeklyCap: 90,                       // rolling 7 days, not calendar
maxConsecutiveFailures: 5,
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

**Non-obvious:** pull happens on page load only (no polling, so two open tabs
don't track each other), and `lamfi:sendLog` doesn't sync — so **the weekly cap
is per-device**.

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

LinkedIn's DOM is obfuscated and shifts without notice. Check the selector with:

```js
document.querySelectorAll('button[aria-label*="Invite"][aria-label*="connect"]').length
```

Zero means it needs updating. Simultaneous bumps in two tabs can lose a count
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
