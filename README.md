<img src="extension/icons/icon128.png" width="96" align="right" alt="L.A.M.F.I. icon">

# L.A.M.F.I. — Link All MotherFuckers In

A Chrome extension (Manifest V3) that automates LinkedIn connection requests
and keeps a personal running total, optionally synced across your devices via
Cloudflare.

> **Read [Risks](#risks) before using this.** It automates activity LinkedIn's
> User Agreement prohibits, and the consequences land on your account.

---

## What's in here

| Path | What it is |
| --- | --- |
| `extension/` | L.A.M.F.I. — auto-connect + counter |
| `quicklinks/` | A separate, unrelated extension: hotkeys that paste fixed links |
| `worker/` | Cloudflare Worker backing the cross-device counter (optional) |

They're separate on purpose. QuickLinks needs `<all_urls>`, and that permission
has no business being granted to the LinkedIn automation.

---

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `extension/`
3. Repeat for `quicklinks/` if you want it

After editing any file: click ↻ on the extension card, **then hard-reload the
page** (`Cmd/Ctrl+Shift+R`). Skipping the second step leaves an orphaned
content script running, which reports `chrome-extension://invalid/` in the
console and silently does nothing.

---

## Using it

### The panel

A HUD sits on the page edge showing your total, a START/STOP button, and your
weekly count.

- **Drag it** anywhere — on release it snaps to whichever vertical edge is nearer
- **Collapse it** with the `›`/`‹` arrow — it shrinks to a thin tab against the edge
- Position and collapsed state persist across reloads

### Starting a run

Any of:

- **START** on the panel
- **Right-click the page → "Connect with everyone on this page"**
- Leave the panel collapsed and drive it entirely from the right-click menu

The toolbar badge shows the live send count, which is the only progress signal
while the panel is collapsed.

### Stopping

| Trigger | Effect |
| --- | --- |
| **Escape**, anywhere on the page | immediate |
| STOP button, or right-click → Stop connecting | immediate |
| Weekly cap reached (default 90) | stop |
| LinkedIn shows an invite-limit dialog | hard stop |
| 5 invites in a row fail to confirm | stop |
| No Connect buttons after 5 scroll attempts | stop |
| A dialog won't close after 3 attempts | stop |

### What one invite does

Find the next Connect button → scroll to it → click → glance ≤60ms for the
invite modal → click "Send without a note" → count it → wait 150–350ms →
repeat. Roughly 250–510ms per invite.

A modal appearing *later* than the glance window is caught at the top of the
next iteration, before the next click — the only moment a stray modal matters,
since an open one swallows every click behind it. A send is counted only once
its modal resolves, so the total can't drift from reality.

Unrecognised modals (usually "How do you know this person?") are dismissed and
that person skipped. It never guesses an answer — a wrong guess sends a real,
irreversible invite with a false claim attached.

---

## How the count flows

Local storage is the source of truth. Cloudflare is a mirror.

```
click Connect → confirmed sent → lamfi:total += 1   (chrome.storage.local)
                                      ↓ instant
                                 HUD + badge update
                                      ↓ storage.onChanged
                                 debounce 10s
                                      ↓
                            POST {total} → Worker → KV stores max(incoming, stored)
```

On page load, the reverse: `GET /count`, and if the remote number is higher it's
written to `lamfi:total`, which the counter's own storage listener picks up.

Three reasons local is authoritative:

- **Speed** — the HUD updates instantly instead of waiting on a round trip
- **KV's write limit** — 1 write/sec to a key, while auto-connect sends 2–4/sec.
  Pushing per-bump would just produce 429s
- **Offline** — network down or Worker misconfigured, counting carries on

Pushes send the **absolute total**, never a delta, and the Worker stores the
max. That makes them idempotent: a retry can't double-count and a device that's
behind can't stomp a higher number.

**The debounce resets on every change**, so a 50-invite run produces one POST
after activity settles, not fifty. A `pagehide` flush with `keepalive` catches
the tail on a clean tab close.

### Known sync behaviour

- **Pull happens on page load only** — there's no polling. Two tabs open at once
  won't track each other until one reloads.
- **Only `lamfi:total` syncs.** `lamfi:sendLog` (weekly cap) and `lamfi:hudPos`
  stay local, so **the weekly cap is per-device, not pooled**.
- A crash can lose up to 10s of counts from the *remote* copy. Local stays
  correct and the next push repairs it.

### Local storage keys

| Key | Purpose | Synced |
| --- | --- | --- |
| `lamfi:total` | your count — authoritative | yes |
| `lamfi:sendLog` | send timestamps, drives the rolling weekly cap | no |
| `lamfi:hudPos` | panel side, height, collapsed state | no |

---

## Configuration

Knobs at the top of `extension/auto-connect.js`:

```js
delayMinMs: 150,            // gap between invites
delayMaxMs: 350,
dialogGraceMs: 60,          // how long to glance for the invite modal
settleMs: 100,              // hard floor — see below
skipDialogs: false,
sessionCap: Infinity,       // invites per run
dailyCap: Infinity,         // invites per day
weeklyCap: 90,              // invites per rolling 7 days
maxConsecutiveFailures: 5,
```

**`settleMs` is a correctness floor, not caution.** Below ~100ms you click
faster than LinkedIn's React list repositions itself and start hitting the wrong
row or nothing at all. Same for `dialogGraceMs` below ~40ms.

**`skipDialogs: true`** is the fastest mode and counts every click as a send. On
any account where LinkedIn shows the "Add a note?" step it sends nothing, stalls
behind the first dialog, and the counter climbs anyway.

**`weeklyCap` is a rolling 7-day window, not a calendar week** — LinkedIn's own
limit works that way, so a Monday reset would let you send 90 Sunday and 90
Monday and still hit their wall. Sends are stored as timestamps rather than a
tally, because a tally can't tell you which sends have aged out.

---

## Cross-device sync (optional)

Everything works without this; the counter just stays on one machine.

### 1. Deploy the Worker

```bash
cd worker

npx wrangler login
npx wrangler kv namespace create CONNECTION_STATS   # paste id into wrangler.toml

openssl rand -hex 32                                # your token
npx wrangler secret put SYNC_TOKEN                  # paste it here

npx wrangler deploy
```

### 2. Configure the extension — once, on any one device

In the DevTools console on a LinkedIn tab:

```js
LamfiSync.configure("https://connection-stats.YOUR-SUBDOMAIN.workers.dev", "YOUR_TOKEN")
```

This writes to **`chrome.storage.sync`**, so it rides your Google account to
every Chrome you're signed into. **Other devices need nothing but the
extension installed.**

Credentials can't live in Cloudflare — the token is what gets you *into*
Cloudflare, so it would need itself to fetch itself. Chrome Sync borrows
Google's auth to solve that bootstrap problem.

Config resolution, most specific first:

1. `config.local.js` — per-machine override, gitignored. Copy `config.example.js`
2. `chrome.storage.sync` — the normal path
3. `chrome.storage.local` — legacy; auto-migrated up to sync when found

> Never commit your token or Worker URL. This repo is public.

### API

All routes require `Authorization: Bearer <token>`; anything else returns `401`.

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/count` | `{ total, updatedAt }` |
| `POST` | `/count` | body `{ total }`; stores the max; returns the new total |
| `DELETE` | `/count` | resets to 0 |

```bash
curl -H "Authorization: Bearer $TOKEN" https://your-worker.workers.dev/count
```

The Worker uses plain KV with no Durable Object — single user means no write
contention to arbitrate.

---

## QuickLinks

Global hotkeys that drop a fixed link wherever your cursor is.

| Shortcut | Action |
| --- | --- |
| `Alt+Shift+L` | insert LinkedIn link |
| `Alt+Shift+G` | insert GitHub link |

Inserts at the cursor in any text field or contenteditable; if nothing is
focused it copies to the clipboard instead. It dispatches an `input` event after
inserting, otherwise React-based sites overwrite what was just typed.

**Set your URLs** in `quicklinks/background.js`. Rebind at
`chrome://extensions/shortcuts`.

Chrome-imposed limits:

- The Windows/Super key can't be bound — only Ctrl, Alt, Shift, Command (Mac)
- Nothing fires on `chrome://` pages, the Web Store, the PDF viewer, or other
  extensions' pages
- Maximum 4 shortcuts with suggested keys

---

## Risks

**LinkedIn's User Agreement forbids** using "software, scripts, bots, browser
plugins, or extensions" to automate activity. This is exactly that.

**Enforcement is graduated:** warning → invite block (1–7 days) → temporary
account restriction (read-only, 24–72h) → permanent restriction. Permanent bans
on a first offence are uncommon; where people lose accounts is doing it again
after reinstatement.

**Two independent triggers.** Volume (roughly 100 invites/week) and automation
detection. You can be flagged by the second while well under the first — the
offence is *how* you clicked, not how much.

**Browser extensions specifically** were targeted in LinkedIn's early-2026
enforcement escalation. That is this architecture.

**Invites are irreversible** and go to real people. Acceptance rate feeds into
throttling, so ignored invites restrict you faster than raw volume.

Published limits are unofficial, personalised, and change. Treat every number
here as approximate.

---

## Known limitations

- LinkedIn's DOM is obfuscated and changes without notice. The Connect selector
  (`aria-label*="Invite"`) works as of last testing, but expect it to break
  periodically. To check:

  ```js
  document.querySelectorAll('button[aria-label*="Invite"][aria-label*="connect"]').length
  ```

  Zero means it needs updating for current markup.

- Two tabs bumping the counter in the same instant can lose a count. The storage
  listener reconciles by taking the higher value — good enough for a personal
  scoreboard, not exact.
- The weekly cap is per-device. Two machines could each send 90 in a week.
- Remote reads can lag a recent local bump by up to the 10s push debounce.

---

## Development

No build step, no dependencies. Edit, reload the extension, hard-reload the page.

Content scripts share one scope, so load order in `manifest.json` matters —
each file's top-level `const` must exist before the next one runs:

```
config.local.js → lamfi-count.js → lamfi-sync.js → auto-connect.js → hud.js → content.js
```

`content.js` is last because it wires the others together. `lamfi-sync.js`
watches `chrome.storage.onChanged` rather than calling into `lamfi-count.js`,
so the two never import each other — the storage key is the interface.
