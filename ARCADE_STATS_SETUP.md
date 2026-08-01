# L.A.M.F.I. — Global Connection Counter Setup

Backend: Cloudflare Worker + Durable Object (source of truth) + KV (read cache).

## 1. Deploy the backend

```bash
cd worker

# One-time: authenticate
npx wrangler login

# Create the KV namespace used as the read cache
npx wrangler kv namespace create ARCADE_STATS
```

That prints an `id`. Paste it into `wrangler.toml`, replacing `PASTE_YOUR_NAMESPACE_ID_HERE`.

> If your Wrangler is older than v3.60 the subcommand is colon-style:
> `npx wrangler kv:namespace create ARCADE_STATS`.

Then deploy:

```bash
npx wrangler deploy
```

Wrangler prints the deployed URL, e.g.
`https://lamfi-arcade-stats.<your-subdomain>.workers.dev`.

Optional — seed the counter so it doesn't start at zero:

```bash
npx wrangler kv key put --binding ARCADE_STATS "global:connections" "0"
```

## 2. Verify the backend

```bash
BASE=https://lamfi-arcade-stats.YOUR-SUBDOMAIN.workers.dev

# Should return {"total":0,...}
curl -H "Origin: https://www.linkedin.com" "$BASE/count"

# Should return {"total":1}
curl -X POST -H "Origin: https://www.linkedin.com" "$BASE/count"

# Should return 403 forbidden_origin
curl "$BASE/count"
```

Tail live logs while testing: `npx wrangler tail`.

## 3. Wire up the extension

Copy `extension/arcade-api.js` next to your existing content script, then set
`CONFIG.apiBase` at the top of that file to your deployed Worker URL.

### `manifest.json`

```jsonc
{
  "permissions": ["storage"],
  "host_permissions": [
    "https://lamfi-arcade-stats.YOUR-SUBDOMAIN.workers.dev/*"
  ],
  "content_scripts": [
    {
      "matches": ["https://www.linkedin.com/*"],
      // arcade-api.js MUST come first — content scripts from the same
      // extension share one isolated-world scope, so ArcadeStats needs to
      // be defined before content.js runs.
      "js": ["arcade-api.js", "content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

- `"storage"` powers the instant-paint cache (the HUD shows the last known
  total immediately instead of flashing `0`). Drop it and the code degrades
  gracefully — it's wrapped in try/catch.
- `host_permissions` isn't strictly required for a content-script `fetch`
  (CORS governs that, and the Worker sends the right headers), but include it
  so things keep working if you ever move the call into the background worker.

### `content.js` — two call sites

```js
// A) Once, after you build the HUD:
ArcadeStats.init({ el: document.querySelector("#lamfi-global-count") });

// B) Immediately after a Connect click succeeds:
connectButton.click();
ArcadeStats.recordConnect();   // optimistic bump now, network reconciles later
```

### HUD markup + the "satisfying" pop

```html
<div class="lamfi-hud">
  <span class="lamfi-label">LINKED WORLDWIDE</span>
  <span id="lamfi-global-count">0</span>
</div>
```

```css
@keyframes lamfi-bump {
  0%   { transform: scale(1); }
  40%  { transform: scale(1.35); }
  100% { transform: scale(1); }
}
/* overshoot easing — reads as arcade-y rather than linear */
.lamfi-bump { animation: lamfi-bump 260ms cubic-bezier(0.34, 1.56, 0.64, 1); }
```

## How the optimistic path behaves

| Moment | HUD | Network |
| --- | --- | --- |
| Connect clicked | `+1` instantly, pops | nothing yet |
| POST succeeds | adopts server total **if higher** | queue drains |
| POST fails | keeps the optimistic `+1` | retries, 1s → 30s backoff |
| Every 60s | adopts server total if higher | `GET /count` |

The HUD never counts **down**. Your local optimistic value can legitimately
lead the server's cached value, and a number that drops looks like a bug, so
`adoptTotal()` only ever moves the display upward.

## Things worth knowing

- **The counter is exact.** The Durable Object serializes every `+1`, so
  simultaneous connects from different users can't clobber each other. This is
  why the write path isn't plain KV: KV has no atomic increment, caps you at
  **1 write/sec per key** (free *and* paid), and allows only **1,000
  writes/day** on the free plan.
- **GETs can be up to ~60s stale.** They're served from the KV mirror, which
  the DO refreshes at most once a minute (`MIRROR_INTERVAL_MS`) to stay inside
  the free-plan KV write budget. Lower it on a paid plan for a fresher number.
- **The Origin check is a speed bump, not security.** Any `curl` can forge
  `Origin`. It stops casual spam from other websites. If you actually get
  abused, add a WAF Rate Limiting rule in the Cloudflare dashboard — that runs
  before your Worker and costs you nothing to execute.
- **One global DO lives in one region**, so `POST` latency from far away can be
  ~200ms+. Irrelevant here because the UI already updated optimistically. If
  you care, pass a `locationHint` when getting the stub.
- **Free-tier headroom:** 100k DO requests/day and 100k DO row writes/day.
  Each connect costs 1 request and ~2 row writes.
- **If `fetch` is blocked by LinkedIn's CSP**, content scripts run in an
  isolated world and are normally exempt — but if you do see CSP errors in the
  console, route the call through the background service worker via
  `chrome.runtime.sendMessage` and add `chrome-extension://<your-id>` to
  `ALLOWED_ORIGINS` in the Worker.
