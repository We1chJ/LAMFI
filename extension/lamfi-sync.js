/**
 * L.A.M.F.I. — cross-device sync for the personal counter.
 *
 * The local count stays authoritative and instant. This module mirrors it to
 * the Cloudflare Worker on a debounce, and pulls on startup.
 *
 * It watches chrome.storage.onChanged rather than calling into LamfiCount, so
 * lamfi-count.js needs no changes and neither module knows about the other.
 *
 * The debounce is not cosmetic: auto-connect can send 2-4 invites/second, and
 * KV allows 1 write/sec to a key. Pushing per-bump would produce 429s.
 *
 * Credentials live in chrome.storage.local, never in the repo. Set them once
 * from the DevTools console on a LinkedIn tab:
 *   LamfiSync.configure("https://lamfi-counter.YOUR-SUBDOMAIN.workers.dev", "YOUR_TOKEN")
 */
const LamfiSync = (() => {
  const COUNT_KEY = "lamfi:total";
  const CONFIG_KEY = "lamfi:sync";
  const DEBOUNCE_MS = 10_000;

  let config = null;
  let timer = null;
  let inFlight = false;

  async function loadConfig() {
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    const c = stored?.[CONFIG_KEY];
    return c?.url && c?.token ? c : null;
  }

  async function localTotal() {
    const stored = await chrome.storage.local.get(COUNT_KEY);
    return Number(stored?.[COUNT_KEY]) || 0;
  }

  async function api(method, body, { keepalive = false } = {}) {
    const res = await fetch(`${config.url.replace(/\/$/, "")}/count`, {
      method,
      keepalive,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401) throw new Error("bad token");
    if (!res.ok) throw new Error(`${method} /count -> ${res.status}`);
    return res.json();
  }

  /**
   * Adopt a remote value only when it's ahead. Writing it back to
   * chrome.storage.local is enough — lamfi-count.js already listens for that
   * and moves its HUD up.
   */
  async function adopt(remoteTotal) {
    if (remoteTotal > (await localTotal())) {
      await chrome.storage.local.set({ [COUNT_KEY]: remoteTotal });
      return true;
    }
    return false;
  }

  async function push({ keepalive = false } = {}) {
    if (!config || inFlight) return null;
    inFlight = true;
    try {
      const total = await localTotal();
      const remote = await api("POST", { total }, { keepalive });
      await adopt(Number(remote.total) || 0);
      return remote;
    } catch (err) {
      console.warn("[LAMFI sync] push failed:", err.message);
      return null;
    } finally {
      inFlight = false;
    }
  }

  function schedulePush() {
    if (!config) return;
    clearTimeout(timer);
    timer = setTimeout(() => push(), DEBOUNCE_MS);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[COUNT_KEY]) schedulePush();
  });

  // A run can end with up to DEBOUNCE_MS of un-pushed counts. keepalive lets
  // the request outlive the page.
  window.addEventListener("pagehide", () => {
    if (config && !inFlight) push({ keepalive: true });
  });

  return {
    /** Store the Worker URL and token. Run once per device. */
    async configure(url, token) {
      if (!url || !token) throw new Error("configure(url, token) needs both");
      await chrome.storage.local.set({ [CONFIG_KEY]: { url, token } });
      config = { url, token };
      console.log("[LAMFI sync] configured:", url);
      return this.init();
    },

    /** Pull remote, reconcile with local, push if we're ahead. */
    async init() {
      config = await loadConfig();
      if (!config) {
        console.log(
          '[LAMFI sync] not configured — run LamfiSync.configure("<worker-url>", "<token>")',
        );
        return { configured: false };
      }
      try {
        const remote = await api("GET");
        const remoteTotal = Number(remote.total) || 0;
        const adopted = await adopt(remoteTotal);
        const local = await localTotal();
        if (local > remoteTotal) await push();
        return { configured: true, remote: remoteTotal, local, adopted };
      } catch (err) {
        console.warn("[LAMFI sync] init failed:", err.message);
        return { configured: true, error: err.message };
      }
    },

    /** Force an immediate push, skipping the debounce. */
    pushNow() {
      clearTimeout(timer);
      return push();
    },

    /** Reset both sides to zero. */
    async reset() {
      if (!config) throw new Error("not configured");
      clearTimeout(timer);
      await api("DELETE");
      await chrome.storage.local.set({ [COUNT_KEY]: 0 });
      console.log("[LAMFI sync] reset local and remote to 0");
    },
  };
})();
