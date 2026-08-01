# L.A.M.F.I. — Link All MotherFuckers In

A Chrome extension (Manifest V3) that automates LinkedIn connection requests
and keeps a running total of how many you've sent, optionally synced across
your devices via Cloudflare.

> **Read the [Risks](#risks) section before using this.** It automates activity
> that LinkedIn's User Agreement prohibits, and the consequences land on your
> account, not on this code.

---

## What's in here

| Path | What it is |
| --- | --- |
| `extension/` | The L.A.M.F.I. extension — auto-connect + counter |
| `quicklinks/` | A separate, unrelated extension: hotkeys that paste fixed links |
| `worker/` | Cloudflare Worker backing the cross-device counter (optional) |

`extension/` and `quicklinks/` are deliberately separate. QuickLinks needs
`<all_urls>` to work everywhere, and that permission has no business being
granted to the LinkedIn automation.

---

## Install

Both extensions load the same way:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select `extension/`
4. Repeat for `quicklinks/`

After editing any file, click the ↻ icon on the extension's card, then reload
the page.

---

## Using L.A.M.F.I.

There is no on-page UI. Everything runs from the right-click menu.

1. Go to a LinkedIn page with Connect buttons — `linkedin.com/mynetwork/grow/`
   or any search results page
2. Right-click anywhere on the page
3. Choose **"Connect with everyone on this page"**

The menu item becomes **"Stop connecting"** while a run is active. The toolbar
badge shows the live count for that tab. Detailed progress goes to the DevTools
console.

### Stopping a run

| Trigger | Effect |
| --- | --- |
| **Escape** key, anywhere on the page | immediate stop |
| Right-click → **Stop connecting** | immediate stop |
| Weekly cap reached (default 90) | stop |
| LinkedIn shows an invite-limit dialog | hard stop |
| 5 invites in a row fail to confirm | stop |
| No Connect buttons after 5 scroll attempts | stop |
| A dialog won't close after 3 attempts | stop |

### What one invite actually does

Find the next Connect button → scroll to it → click → glance ~60ms for the
invite modal → click "Send without a note" → count it → wait 150–350ms →
repeat. Roughly 250–510ms per invite.

If a modal appears *later* than the glance window, it's caught at the top of
the next iteration — before the next click, which is the only moment a stray
modal matters, since an open modal swallows every click behind it. A send is
only counted once its modal resolves, so the total can't drift from reality.

Unrecognised modals (usually "How do you know this person?") are dismissed and
that person is skipped. It never guesses an answer — a wrong guess sends a
real, irreversible invite with a false claim attached.

---

## Configuration

All knobs are at the top of `extension/auto-connect.js`:

```js
delayMinMs: 150,            // gap between invites
delayMaxMs: 350,
dialogGraceMs: 60,          // how long to glance for the invite modal
settleMs: 100,              // hard floor — see below
skipDialogs: false,         // true = never look for modals (see below)
sessionCap: Infinity,       // invites per run
dailyCap: Infinity,         // invites per day
weeklyCap: 90,              // invites per rolling 7 days
maxConsecutiveFailures: 5,
```

**`settleMs` is a correctness floor, not caution.** Below ~100ms you click
faster than LinkedIn's React list repositions itself, so you start hitting the
wrong row or nothing at all. Same for `dialogGraceMs` below ~40ms.

**`skipDialogs: true`** is the fastest possible mode and counts every click as
a send. On any account where LinkedIn shows the "Add a note?" step it sends
nothing, stalls behind the first dialog, and the counter climbs anyway. Off by
default for that reason.

**`weeklyCap` is a rolling 7-day window, not a calendar week** — LinkedIn's own
limit works that way, so a Monday reset would let you send 90 Sunday and 90
Monday and still hit their wall. Sends are stored as timestamps
(`lamfi:sendLog`) rather than a tally, because a tally can't tell you which
sends have aged out.

---

## Cross-device counter (optional)

Everything works without this — the counter just stays local to one browser
profile. Set it up only if you want the number to follow you across machines.

Single user means no write contention, so it's plain KV with no Durable
Object. The extension keeps the authoritative count locally and pushes its
**absolute total** on a 10s debounce; the Worker stores `max(incoming, stored)`.
That makes writes idempotent — a retry can't double-count, and a device that's
behind can't stomp a higher number.

The debounce isn't cosmetic: auto-connect sends 2–4 invites/second and KV
allows **1 write/sec to a key**, so pushing per-bump would just produce 429s.

### Deploy

```bash
cd worker

npx wrangler login
npx wrangler kv namespace create CONNECTION_STATS   # paste id into wrangler.toml

openssl rand -hex 32                                # your token
npx wrangler secret put SYNC_TOKEN                  # paste it here

npx wrangler deploy
```

### Point the extension at it

Once per device, in the DevTools console on a LinkedIn tab:

```js
LamfiSync.configure("https://connection-stats.YOUR-SUBDOMAIN.workers.dev", "YOUR_TOKEN")
```

Credentials live in `chrome.storage.local` and in Cloudflare's secret store —
never in this repo. **Do not commit your token or your Worker URL.**

### API

All routes require `Authorization: Bearer <token>`; anything else gets `401`.

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/count` | `{ total, updatedAt }` |
| `POST` | `/count` | body `{ total }`; stores the max; returns the new total |
| `DELETE` | `/count` | resets to 0 |

```bash
curl -H "Authorization: Bearer $TOKEN" https://your-worker.workers.dev/count
```

---

## QuickLinks

A separate extension: global hotkeys that drop a fixed link wherever your
cursor is.

| Shortcut | Action |
| --- | --- |
| `Alt+Shift+L` | insert LinkedIn link |
| `Alt+Shift+G` | insert GitHub link |

Inserts at the cursor in any text field or contenteditable. If nothing is
focused, it copies to the clipboard instead. It dispatches an `input` event
after inserting, otherwise React-based sites overwrite what was just typed.

**Set your URLs** in `quicklinks/background.js`.

Rebind at `chrome://extensions/shortcuts`.

Limitations, all imposed by Chrome:

- The Windows/Super key can't be bound — only Ctrl, Alt, Shift, and Command (Mac)
- Nothing fires on `chrome://` pages, the Web Store, the PDF viewer, or other
  extensions' pages
- Maximum 4 shortcuts with suggested keys

---

## Risks

Stated plainly, once.

**LinkedIn's User Agreement forbids** using "software, scripts, bots, browser
plugins, or extensions" to automate activity on the service. This is exactly
that.

**Enforcement is graduated:** warning → invite block (1–7 days) → temporary
account restriction (read-only, 24–72h) → permanent restriction. Permanent
bans on a first offence are uncommon; where people actually lose accounts is
doing it again after reinstatement.

**Two independent triggers.** Volume (roughly 100 invites/week) and automation
detection. You can be flagged by the second while well under the first —
the offence is *how* you clicked, not how much.

**Browser extensions specifically** were targeted in LinkedIn's early-2026
enforcement escalation. That is this architecture.

**Invites are irreversible** and go to real people. Acceptance rate feeds into
throttling, so a pile of ignored invites restricts you faster than raw volume.

Published limits are unofficial. LinkedIn doesn't publish thresholds, they're
personalised, and they change. Treat every number here as approximate.

---

## Known limitations

- **The Connect-button selectors are unverified.** `aria-label*="Invite"` is a
  best guess that has never been tested against a live logged-in page.
  If a run does nothing at all, check with:

  ```js
  document.querySelectorAll('button[aria-label*="Invite"][aria-label*="connect"]').length
  ```

  Zero means the selector needs updating for current LinkedIn markup.

- LinkedIn's DOM is obfuscated and changes without notice. Expect the selectors
  to break periodically.
- Two tabs bumping the counter in the same instant can lose a count. The
  storage listener reconciles by taking the higher value, which is good enough
  for a personal scoreboard but is not exact.
- `GET /count` can be up to ~60s stale relative to a very recent local bump,
  because of the push debounce.

---

## Development

No build step, no dependencies. Edit the files, reload the extension.

The Worker can be tested without deploying by stubbing the KV binding — see the
route table above for expected responses.
