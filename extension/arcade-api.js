/**
 * L.A.M.F.I. — global "Total Connections Made" counter client.
 *
 * Must run in a CONTENT SCRIPT on https://www.linkedin.com/*, not in the
 * background service worker: the Worker only accepts requests whose Origin is
 * https://www.linkedin.com, and content-script fetches carry the page's origin.
 *
 * Usage:
 *   ArcadeStats.init({ el: document.querySelector("#lamfi-global-count") });
 *   ArcadeStats.recordConnect();   // call right after a successful Connect click
 */
const ArcadeStats = (() => {
  const CONFIG = {
    // Replace with your deployed Worker URL (wrangler prints it on deploy).
    apiBase: "https://lamfi-arcade-stats.YOUR-SUBDOMAIN.workers.dev",
    // Poll for other users' connects. Matches the Worker's KV cache TTL.
    refreshMs: 60_000,
    cacheKey: "lamfi:lastKnownTotal",
    initialBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    // Guard against unbounded growth if the user goes on a spree while offline.
    maxQueued: 200,
  };

  let hudEl = null;
  let displayed = 0;
  let queued = 0;
  let draining = false;
  let backoffMs = CONFIG.initialBackoffMs;

  function render({ bump = false } = {}) {
    if (!hudEl) return;
    hudEl.textContent = displayed.toLocaleString();
    if (!bump) return;
    // Restart the CSS animation rather than letting a rapid second click be
    // swallowed by the still-running first one.
    hudEl.classList.remove("lamfi-bump");
    void hudEl.offsetWidth;
    hudEl.classList.add("lamfi-bump");
  }

  async function readCachedTotal() {
    try {
      const stored = await chrome.storage.local.get(CONFIG.cacheKey);
      return Number(stored?.[CONFIG.cacheKey]) || 0;
    } catch {
      // "storage" permission missing, or not in an extension context.
      return 0;
    }
  }

  function writeCachedTotal(total) {
    try {
      chrome.storage.local.set({ [CONFIG.cacheKey]: total });
    } catch {
      /* non-fatal */
    }
  }

  /**
   * Adopt an authoritative total from the server.
   * Never ticks the HUD backwards: our own optimistic increments may legitimately
   * be ahead of the server's cached value, and a number that drops reads as a bug.
   */
  function adoptTotal(total) {
    if (!Number.isFinite(total) || total <= displayed) return;
    displayed = total;
    render();
    writeCachedTotal(displayed);
  }

  async function fetchTotal() {
    const res = await fetch(`${CONFIG.apiBase}/count`, {
      method: "GET",
      // No credentials, no custom headers: keeps the request a CORS "simple"
      // request so there is no preflight on the hot path.
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`GET /count -> ${res.status}`);
    const { total } = await res.json();
    return total;
  }

  async function postIncrement() {
    const res = await fetch(`${CONFIG.apiBase}/count`, {
      method: "POST",
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`POST /count -> ${res.status}`);
    const { total } = await res.json();
    return total;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Flush queued increments one request at a time. The Worker deliberately
   * increments by exactly 1 per POST, so N queued connects mean N requests.
   */
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queued > 0) {
        try {
          const total = await postIncrement();
          queued -= 1;
          backoffMs = CONFIG.initialBackoffMs;
          adoptTotal(total);
        } catch (err) {
          console.warn("[LAMFI] increment failed, retrying:", err.message);
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, CONFIG.maxBackoffMs);
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    /**
     * @param {{ el: HTMLElement, apiBase?: string }} options
     */
    async init({ el, apiBase } = {}) {
      hudEl = el ?? null;
      if (apiBase) CONFIG.apiBase = apiBase;

      // Paint the last known value immediately so the HUD never shows a zero
      // while the network request is in flight.
      displayed = await readCachedTotal();
      render();

      try {
        adoptTotal(await fetchTotal());
      } catch (err) {
        console.warn("[LAMFI] could not load global count:", err.message);
      }

      setInterval(async () => {
        try {
          adoptTotal(await fetchTotal());
        } catch {
          /* transient; next tick will retry */
        }
      }, CONFIG.refreshMs);
    },

    /** Call after a Connect click actually succeeded. Optimistic + queued. */
    recordConnect() {
      // 1. Optimistic UI: bump the number now, before any network work.
      displayed += 1;
      render({ bump: true });
      writeCachedTotal(displayed);

      // 2. Reconcile with the server in the background.
      if (queued < CONFIG.maxQueued) queued += 1;
      drain();
    },

    getDisplayed() {
      return displayed;
    },
  };
})();
