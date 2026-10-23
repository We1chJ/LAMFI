/**
 * L.A.M.F.I. — the run engine.
 *
 * Clicks every Connect control on the current page, turns pages when one runs
 * dry, and logs each confirmed invite to the CRM with whatever the list card
 * showed (name, headline, profile URL).
 *
 * Surface-agnostic: it matches the control, not the page. Attended by design:
 * STOP, Escape, and a hard stop on LinkedIn's invite-limit notice.
 *
 * Nothing is counted on faith. Activating a control has to produce proof — an
 * invite modal, or the control leaving the page while the rest of the list
 * stays put — before it counts as a send.
 */
const LamfiRun = (() => {
  const D = LamfiDom;

  const CONFIG = {
    delayMinMs: 800,
    delayMaxMs: 2000,
    confirmMs: 1200,
    settleMs: 200,
    maxConsecutiveFailures: 5,
    invitePageWaitMs: 12000,
    maxHops: 300,
    pageWaitMs: 4000,
    maxPages: 100,
    maxScrollAttempts: 5,
    scrollWaitMs: 1000,
  };

  const SKIPPED_EMAIL = "needs their email, skipped";

  let running = false;
  let sent = 0;
  let onStatus = () => {};
  let onSend = async () => {};

  // Carried across the navigate-and-return cycle in sessionStorage: scoped to
  // this tab, survives navigation, dies with the tab.
  const RESUME_KEY = "lamfi:resume";
  let tried = new Set();
  let hops = 0;
  let pagesTurned = 0;
  let navigateShapes = new Set();

  const loadResume = () => {
    try {
      return JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? "null");
    } catch {
      return null;
    }
  };
  const saveResume = (extra) => {
    try {
      sessionStorage.setItem(
        RESUME_KEY,
        JSON.stringify({
          sent,
          tried: [...tried],
          hops,
          pagesTurned,
          navigateShapes: [...navigateShapes],
          ...extra,
        }),
      );
    } catch {
      /* private mode; run won't survive navigation */
    }
  };
  const clearResume = () => sessionStorage.removeItem(RESUME_KEY);

  function status(message) {
    onStatus(message);
    console.log("[LAMFI]", message);
  }

  // ------------------------------------------------------------ the card

  /**
   * What the list card around a Connect control says about the person. Walks
   * up until an ancestor holds a profile link; the name comes from the
   * control's own label when it has one ("Invite Jane Doe to connect").
   */
  function cardInfo(btn) {
    const l = D.label(btn);
    let name = l.replace(/^invite\s+|\s+to connect$/gi, "").replace(/^connect with\s+/i, "");
    if (/^connect$/i.test(name) || name === l) name = "";

    let card = btn;
    let link = null;
    for (let i = 0; i < 10 && card; i++) {
      link = [...card.querySelectorAll('a[href*="/in/"]')].find((a) => D.slugOf(a.href));
      if (link) break;
      card = card.parentElement;
    }
    const url = link ? link.href.split("?")[0] : btn.href?.includes("/in/") ? btn.href : "";
    const slug = D.slugOf(url) || D.slugOf(btn.getAttribute("href"));
    if (!name && link) name = D.textOf(link).split("\n")[0];

    let headline = "";
    if (card && link) {
      const lines = (card.innerText ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const noise = /^(connect|message|follow|pending|view profile|\d+(st|nd|rd|th)|•.*|·.*)$/i;
      headline =
        lines.find((s) => s !== name && !s.startsWith(name) && !noise.test(s) && s.length > 3 && s.length < 160) ??
        "";
    }

    const id = slug || (name ? `name:${name.toLowerCase().replace(/\s+/g, "-")}` : null);
    if (!id) return null;
    return { id, url, headline, ...D.splitName(name), source: "run" };
  }

  // ------------------------------------------------------------ dialogs

  /** @returns {Promise<"sent"|"limit"|string>} */
  async function handleDialog(dialog) {
    const text = D.textOf(dialog);
    if (D.LIMIT_PATTERN.test(text)) {
      await D.closeDialog(dialog);
      return "limit";
    }
    if (D.NEEDS_EMAIL.test(text)) {
      await D.closeDialog(dialog);
      return SKIPPED_EMAIL;
    }
    // First present-and-enabled label in preference order.
    for (const l of D.SEND_LABELS) {
      const candidate = dialog.querySelector(`button[aria-label="${l}"]`);
      if (D.isEnabled(candidate)) {
        candidate.click();
        await D.sleep(CONFIG.settleMs);
        return "sent";
      }
    }
    // "How do you know this person?" and friends — never guessed at.
    await D.closeDialog(dialog);
    return "unrecognised dialog, skipped";
  }

  // --------------------------------------------------------- activation

  const STRATEGIES = [
    { name: "click", press: (el) => el.click() },
    {
      name: "pointer",
      press(el) {
        const opts = { bubbles: true, cancelable: true, composed: true };
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new MouseEvent("mousedown", opts));
        el.focus?.();
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
        el.dispatchEvent(new MouseEvent("click", opts));
      },
    },
  ];

  // Keyed by control shape, not URL: the same URL serves different markup.
  const strategyByShape = new Map();
  const shapeOf = (el) => `${el.tagName}${el.hasAttribute("href") ? "[href]" : ""}`;

  const connectLabels = () =>
    D.queryAll(D.SELECTORS.clickable).filter(D.isConnectButton).map(D.label);

  /**
   * What "already tried" is keyed on. The aria-label when there is one;
   * otherwise the card's profile slug, so a list of bare "Connect" buttons
   * doesn't all collapse onto one key after the first press.
   */
  const keyOf = (btn) => D.label(btn) || cardInfo(btn)?.id || "";

  function findNextConnectButton() {
    return (
      D.queryAll(D.SELECTORS.clickable).find(
        (btn) => D.isConnectButton(btn) && D.isVisible(btn) && !tried.has(keyOf(btn)),
      ) ?? null
    );
  }

  /** @returns {Promise<"modal"|"gone"|"rerender"|null>} */
  async function confirmActivation(label, peers) {
    const deadline = Date.now() + CONFIG.confirmMs;
    for (;;) {
      if (D.openDialog()) return "modal";
      const now = new Set(connectLabels());
      if (!now.has(label)) {
        // Only a send if the rest of the list is still standing; a re-render
        // takes every label with it.
        const survivors = peers.filter((p) => now.has(p)).length;
        return peers.length === 0 || survivors * 2 >= peers.length ? "gone" : "rerender";
      }
      if (Date.now() >= deadline) return null;
      await D.sleep(50);
    }
  }

  async function activateControl(btn, contact) {
    const label = D.label(btn);
    const shape = shapeOf(btn);
    const href = btn.getAttribute("href");

    if (href && navigateShapes.has(shape)) {
      followInviteLink(btn, href, contact);
      return "navigating";
    }

    const known = strategyByShape.get(shape);
    const order = known ? [known, ...STRATEGIES.filter((s) => s !== known)] : STRATEGIES;
    const peers = connectLabels().filter((l) => l !== label);

    for (const strategy of order) {
      strategy.press(btn);
      const proof = await confirmActivation(label, peers);
      if (proof === "rerender") return "unclear";
      if (proof) {
        strategyByShape.set(shape, strategy);
        return proof;
      }
      if (!running) return null;
    }

    if (href) {
      if (!navigateShapes.has(shape)) {
        status(`${shape} needs its link followed`);
        navigateShapes.add(shape);
      }
      followInviteLink(btn, href, contact);
      return "navigating";
    }
    return null;
  }

  function followInviteLink(btn, href, contact) {
    tried.add(keyOf(btn));
    hops += 1;
    saveResume({ phase: "invite", returnUrl: location.href, contact });
    status(`opening invite page (${hops})`);
    location.href = new URL(href, location.origin).toString();
  }

  // --------------------------------------------------------------- paging

  /** "Next" is only trusted beside numbered "Page N" buttons. */
  function findNextPageControl() {
    if (!D.queryAll('button[aria-label^="Page "],a[aria-label^="Page "]').length) return null;
    return (
      D.queryAll(D.SELECTORS.clickable).find(
        (el) =>
          D.isVisible(el) && D.isEnabled(el) && (/^next$/i.test(D.label(el)) || /^next$/i.test(D.textOf(el))),
      ) ?? null
    );
  }

  async function turnPage() {
    const next = findNextPageControl();
    if (!next) return false;
    if (pagesTurned >= CONFIG.maxPages) {
      status(`stopped: reached the ${CONFIG.maxPages}-page limit`);
      return false;
    }
    pagesTurned += 1;
    saveResume({ phase: "return" });
    status(`next page (${pagesTurned + 1})`);
    next.click();
    await D.sleep(CONFIG.pageWaitMs);
    clearResume();
    return true;
  }

  // ----------------------------------------------------------------- run

  async function countSend(contact) {
    sent += 1;
    status(`sent ${sent} this run`);
    if (contact) await onSend(contact).catch((e) => console.warn("[LAMFI] log failed", e));
  }

  async function run(resumed = false) {
    if (!resumed) {
      sent = 0;
      tried = new Set();
      hops = 0;
      pagesTurned = 0;
      navigateShapes = new Set();
    }
    let scrollAttempts = 0;
    let stuckDialogs = 0;
    let failures = 0;

    const fail = (reason) => {
      if (reason === SKIPPED_EMAIL) return false;
      return ++failures >= CONFIG.maxConsecutiveFailures;
    };

    status(resumed ? `resumed — ${sent} sent so far` : "started");

    while (running) {
      if (D.limitNoticeVisible()) {
        status("STOPPED: LinkedIn weekly invitation limit reached");
        break;
      }

      const stray = D.openDialog();
      if (stray) {
        if (++stuckDialogs > 3) {
          status("stopped: a dialog won't close — clear it and restart");
          break;
        }
        const outcome = await handleDialog(stray);
        if (outcome === "limit") {
          status("STOPPED: LinkedIn weekly invitation limit reached");
          break;
        }
        if (outcome === "sent") {
          await countSend(null);
          failures = 0;
        } else {
          status(outcome);
          if (fail(outcome)) {
            status(`stopped: ${failures} invites in a row failed`);
            break;
          }
        }
        continue;
      }
      stuckDialogs = 0;

      const btn = findNextConnectButton();
      if (!btn) {
        if (scrollAttempts >= CONFIG.maxScrollAttempts) {
          if (await turnPage()) {
            scrollAttempts = 0;
            continue;
          }
          status("stopped: no more Connect buttons found");
          break;
        }
        scrollAttempts += 1;
        const where = D.scrollForMore();
        status(`looking for more (scroll ${scrollAttempts}, ${where})`);
        await D.sleep(CONFIG.scrollWaitMs);
        continue;
      }
      scrollAttempts = 0;

      btn.scrollIntoView({ block: "center" });
      await D.sleep(CONFIG.settleMs);
      if (!running) break;

      const contact = cardInfo(btn);
      const who = contact?.name || "this one";
      tried.add(keyOf(btn));
      const proof = await activateControl(btn, contact);

      if (D.limitNoticeVisible()) {
        status("STOPPED: LinkedIn weekly invitation limit reached");
        break;
      }
      if (proof === "navigating") return; // page is on its way out
      if (proof === "unclear") {
        status(`${who}: page reshuffled, moving on`);
        continue;
      }
      if (!proof) {
        status(`couldn't activate ${who}`);
        if (fail(null)) {
          status(`stopped: ${failures} in a row wouldn't activate`);
          break;
        }
        continue;
      }

      let outcome = "sent";
      if (proof === "modal") outcome = await handleDialog(D.openDialog());
      if (outcome === "limit") {
        status("STOPPED: LinkedIn weekly invitation limit reached");
        break;
      }
      if (outcome === "sent") {
        await countSend(contact);
        failures = 0;
      } else {
        status(`${who}: ${outcome}`);
        if (fail(outcome)) {
          status(`stopped: ${failures} invites in a row failed`);
          break;
        }
      }

      await D.sleep(D.rand(CONFIG.delayMinMs, CONFIG.delayMaxMs));
    }

    clearResume();
    running = false;
  }

  /** Called on every page load: pick a run back up after a navigation. */
  async function resumeIfNeeded(handlers) {
    const state = loadResume();
    if (!state) return false;
    bind(handlers);
    sent = state.sent ?? 0;
    tried = new Set(state.tried ?? []);
    hops = state.hops ?? 0;
    pagesTurned = state.pagesTurned ?? 0;
    navigateShapes = new Set(state.navigateShapes ?? []);

    if (hops > CONFIG.maxHops) {
      clearResume();
      status(`stopped: ${hops} page hops without finishing`);
      return false;
    }

    if (state.phase === "invite") {
      running = true;
      const dialog = await D.pollFor(D.openDialog, CONFIG.invitePageWaitMs);
      if (!dialog) status("invite page showed no modal — skipping");
      else {
        const outcome = await handleDialog(dialog);
        if (outcome === "sent") await countSend(state.contact);
        else if (outcome === "limit") {
          clearResume();
          running = false;
          status("STOPPED: LinkedIn weekly invitation limit reached");
          return false;
        } else status(outcome);
      }
      saveResume({ phase: "return" });
      location.href = state.returnUrl;
      return true;
    }

    if (state.phase === "return") {
      clearResume();
      running = true;
      status("back at the list");
      await D.sleep(CONFIG.settleMs);
      run(true);
      return true;
    }

    clearResume();
    return false;
  }

  function bind({ onStatus: s, onSend: o } = {}) {
    if (s) onStatus = s;
    if (o) onSend = o;
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && running) {
      clearResume();
      running = false;
      status("stopped by Escape");
    }
  });

  return {
    CONFIG,
    sessionCount: () => sent,
    isRunning: () => running,
    resumeIfNeeded,
    start(handlers) {
      if (running) return false;
      bind(handlers);
      running = true;
      run();
      return true;
    },
    stop() {
      clearResume();
      if (!running) return;
      running = false;
      status("stopped by user");
    },
  };
})();
