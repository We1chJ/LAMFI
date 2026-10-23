<p align="center">
  <img src="extension/icons/icon128.png" width="112" alt="L.A.M.F.I. icon">
</p>

# L.A.M.F.I. — Link All MotherFuckers In

Chrome extension (MV3) for LinkedIn outreach: auto-connect through a page of
people, send AI-personalised notes and messages from a profile, and keep a
local CRM of everyone you touched — with a dashboard you can copy straight
into Claude or Notion.

> **[Risks](#risks) first.** This automates activity LinkedIn's User Agreement
> prohibits. Consequences land on your account.

| Path | What |
| --- | --- |
| `extension/` | the extension — everything lives here |
| `worker/` | Cloudflare Worker from the old cross-device counter. Unused now. |

---

## Install

`chrome://extensions` → **Developer mode** → **Load unpacked** → `extension/`

After any edit: click ↻ **and** hard-reload the LinkedIn tab
(`Cmd/Ctrl+Shift+R`). Skipping the reload leaves an orphaned content script
that logs `chrome-extension://invalid/` and silently does nothing.

Then click the toolbar icon to open the dashboard and paste an Anthropic API
key under **Settings**. Without one, everything still works — the AI hook is
just left for you to type.

## The HUD

A panel sits on the page edge — drag it anywhere and it snaps to the nearest
vertical edge; `›`/`‹` collapses it to a tab. 📊 opens the dashboard.

**🚀 Start / ✋ Stop** runs auto-connect on whatever page you're on. Also available
from right-click → *Connect with everyone on this page*. The toolbar badge
shows the running count.

On a profile (`/in/<slug>`) the HUD adds **💌 Reach out** and **📇 Save contact**.

## Auto-connect

Works on any surface with Connect controls — My Network, people search,
profiles, company **People** tabs, lists inside a modal such as a post's
reactions. It matches the control by label or visible text, not the URL, and
skips the neighbours (Message, Follow, Pending/Withdraw, Accept/Ignore).

When a page runs dry it turns to the next one, up to 100 pages. "Next" is only
trusted beside numbered `Page N` buttons — My Network has a carousel whose
button is also labelled "Next".

Nothing is counted on faith. A press has to produce proof — an invite modal,
or the control leaving the page while the rest of the list stays put — before
it counts. A control that produces neither is retried with a different
activation strategy, and if it's a link, its link is followed (LinkedIn's own
invite page renders the modal). Links to LinkedIn's invite page skip the
in-page attempts entirely. Every such link on the page is queued, and the run
goes invite page → invite page → … returning to the list only once they're all
done: one page load per person.

People whose card shows **Follow** or **Message** instead of Connect are
invited too: Connect is still open to them, and the invite page needs only the
profile name from their card link. Skipped: 1st-degree (already connected),
pending, cards with no degree shown, and any card where the profile link names
a different person than the button.

Each confirmed invite logs the person into the CRM with what the list card
showed: name, headline, profile URL. No extra page visits.

**Stops on:** STOP · Escape · LinkedIn's invite-limit notice · 5 consecutive
failures · no more pages · a dialog that won't close. The email-verification
gate and "How do you know this person?" are dismissed, never guessed at.

There are no volume caps of its own.

## Reach out

On a profile, **💌 Reach out** does, in order:

1. Reads the top card (name, headline, location, company) and About.
2. Opens **Contact info** and takes email / phone / websites if they're shared.
   LinkedIn only shows these for connections who chose to share them, so
   often there's nothing.
3. Saves the contact.
4. Works out the relationship. Not connected → Connect **with a note**
   (300-char cap). Already connected → direct message. Pending → stops.
5. Asks Claude for `{{hook}}`: one or two sentences grounded in their profile,
   written to serve the goal you set in Settings. Email and phone are not sent
   to the API.
6. Renders your template and shows it in the HUD. Edit it, **✨ New hook** to
   regenerate, **Send** when it's right. (*Send without preview* is a setting,
   off by default — this goes out under your name.)
7. Sends, verifies the modal closed or the composer cleared, and logs the
   event with the message text.

**📇 Save contact** does steps 1–3.

If an account has no *Add a note* option (LinkedIn limits free notes per
month), nothing is sent and the HUD says so.

Templates use `{{first}}`, `{{last}}`, `{{name}}`, `{{company}}`,
`{{headline}}`, `{{location}}`, `{{hook}}`.

The profile scraper reads visible text, not class names — LinkedIn's markup is
obfuscated and shifts without notice. A wrong company or headline shows up in
the preview before anything is sent.

## Dashboard

Toolbar icon, 📊 on the HUD, or right-click → *Open L.A.M.F.I. dashboard*.

- **Tiles** — invites today / 7 days / all time, messages, contacts, emails found.
- **Chart** — invites and messages per day, last 30 days.
- **Contacts** — search, filter by status (`captured` → `invited` →
  `messaged`), tick rows, then **Copy for Claude / Notion** (a Markdown table that pastes cleanly
  into Claude or Notion), **Copy CSV** or **Copy JSON**. Buttons act on the
  selection, or on the whole filtered list when nothing is selected.
  **Mark exported** stamps them; **Not yet exported** then shows only what's
  new since.
- **Settings** — API key, model, your goal, both templates, auto-send, pacing.

Everything is in `chrome.storage.local` on this machine. The background
service worker is the only writer, so two LinkedIn tabs can't clobber each
other. Updates on one tab show on the dashboard live.

## Layout

```
extension/
  manifest.json
  background.js          CRM writes, Claude call, badge, menus, dashboard opener
  content/
    dom.js               what LinkedIn's markup looks like — the one place to fix
    connect.js           the run engine
    profile.js           scrape, contact info, note / DM sending
    hud.js, hud.css      the panel
    main.js              wiring
  dashboard/             the extension page
```

## Config

Pacing lives in Settings (`delayMinMs` / `delayMaxMs`, default 800–2000 ms
between invites). The rest is at the top of `content/connect.js`:

```js
confirmMs: 1200,             // wait for proof a press did something
settleMs: 200,               // floor — lower and you click mid-re-render
maxConsecutiveFailures: 5,   // the only automatic brake
maxPages: 100,
```

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

Zero on a page that visibly has Connect buttons means `isConnectButton()` in
`content/dom.js` needs updating. Only 1st-degree connections can be messaged
directly; anyone else gets a connect note. Email is only ever what the person
chose to share.
