/**
 * L.A.M.F.I. — Link All MotherFuckers In
 * Personal connection counter: one all-time total, persisted in
 * chrome.storage.local. No backend, no network, no CORS, no rate limits.
 *
 * manifest.json needs:
 *   "permissions": ["storage"]
 *   content_scripts.js: ["lamfi-count.js", "content.js"]   <- this file first
 *
 * Usage in content.js:
 *   await LamfiCount.init({ el: document.querySelector("#lamfi-count") });
 *   LamfiCount.bump();          // after a successful Connect click -> new total
 *   LamfiCount.read();          // -> 412
 *
 * To zero it out, from the DevTools console on a LinkedIn tab:
 *   chrome.storage.local.remove("lamfi:total")
 */
const LamfiCount = (() => {
  const KEY = "lamfi:total";

  let total = 0;
  let hudEl = null;
  let ready = false;

  // Writes are chained so that two rapid bumps can't land out of order and
  // persist a stale, lower total. Memory is the source of truth; every write
  // carries the full current value, so the last one to land is correct.
  let writeChain = Promise.resolve();

  function render({ bump = false } = {}) {
    if (!hudEl) return;
    hudEl.textContent = total.toLocaleString();
    if (!bump) return;
    // Restart the animation, otherwise a fast second click gets swallowed by
    // the still-running first one.
    hudEl.classList.remove("lamfi-bump");
    void hudEl.offsetWidth;
    hudEl.classList.add("lamfi-bump");
  }

  function persist() {
    writeChain = writeChain
      .then(() => chrome.storage.local.set({ [KEY]: total }))
      .catch((err) => console.warn("[LAMFI] save failed:", err));
    return writeChain;
  }

  // Keep multiple open LinkedIn tabs roughly in agreement. Each tab holds its
  // own in-memory total, so without this they'd drift apart and overwrite each
  // other. Adopting the higher value can still lose a count if two tabs bump
  // in the exact same instant — acceptable for a personal scoreboard.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[KEY]) return;
    const incoming = Number(changes[KEY].newValue) || 0;
    if (incoming > total) {
      total = incoming;
      render();
    }
  });

  return {
    /**
     * @param {{ el?: HTMLElement }} options
     * @returns {Promise<number>} the stored total
     */
    async init({ el } = {}) {
      hudEl = el ?? null;
      const stored = await chrome.storage.local.get(KEY);
      total = Number(stored?.[KEY]) || 0;
      ready = true;
      render();
      return total;
    },

    /**
     * Record one connection. Returns immediately with the new total — the disk
     * write happens in the background, so the HUD never waits on it.
     * @returns {number}
     */
    bump() {
      if (!ready) console.warn("[LAMFI] bump() before init(); total may be off");
      total += 1;
      render({ bump: true });
      persist();
      return total;
    },

    /** @returns {number} */
    read() {
      return total;
    },

    /** Await this if you need the pending write on disk (e.g. before a reload). */
    flush() {
      return writeChain;
    },
  };
})();
