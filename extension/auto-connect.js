/**
 * L.A.M.F.I. — auto-connect engine.
 *
 * Clicks Connect buttons on the current LinkedIn page, handles the invite
 * modal, and reports each confirmed send to LamfiCount.
 *
 * Surface-agnostic: it matches the button, not the page. Anywhere LinkedIn
 * renders a Connect control — My Network, people search, profiles, company
 * People tabs — is fair game, including lists inside a modal such as a post's
 * reactions, which are scrolled in place rather than dismissed.
 *
 * Frame-agnostic too. LinkedIn's shell puts the invite modal in a same-origin
 * <iframe src="/preload/...">, so every DOM query here spans the top document
 * and its reachable child frames. See reachableDocuments().
 *
 * Attended by design: Stop button, Escape key, and a hard stop the moment
 * LinkedIn shows an invite-limit notice. There are no volume caps of our own —
 * a run goes until LinkedIn says stop, the page runs out of buttons, or you do.
 *
 * Nothing is counted on faith. Activating a control has to produce proof —
 * an invite modal, or the control leaving the page — before the loop treats
 * it as a send, and a control that produces neither is retried with a
 * different activation strategy before being given up on. The alternative,
 * assuming a click landed, is how a counter climbs while nothing is sent.
 *
 * A modal it can't answer honestly (the email gate, "How do you know this
 * person?") is closed on sight rather than guessed at.
 */
const LamfiAuto = (() => {
  const CONFIG = {
    // Gap between one send and the next attempt. Deliberately unhurried: the
    // ~300ms this used to run at is nothing like a person working through a
    // list, and pace is one of the things LinkedIn watches. At this range a
    // full weekly allowance still takes well under ten minutes.
    delayMinMs: 3000,
    delayMaxMs: 7000,
    // How long to wait for proof that activating a control did something —
    // an invite modal, or the control disappearing. Returns as soon as either
    // shows, so the usual cost is well under this. Only a control that is
    // genuinely inert burns the whole window, and then only until a later
    // strategy works and gets remembered.
    confirmMs: 2500,
    // Let scrolling / modal transitions finish. This is the hard floor —
    // under ~100ms clicks land on elements React is still repositioning, so
    // you start hitting the wrong row or nothing at all.
    settleMs: 400,
    // Skip the between-invites sweep for a leftover modal. Sends are still
    // verified either way; this only trades a little safety for speed on
    // accounts that never show one. Off by default — a stray modal swallows
    // every click behind it.
    skipDialogs: false,
    // With no volume caps of our own, this is the main automatic brake: if
    // invites stop confirming, something has changed (LinkedIn blocking, markup
    // moved, unexpected modals) and hammering it is the worst thing to do.
    maxConsecutiveFailures: 5,
    // How long to wait for the invite modal after following a control's own
    // link. A whole page load, so far longer than an in-page modal needs.
    invitePageWaitMs: 12000,
    // Backstop on the navigate-and-return cycle: one hop per invite, so this
    // bounds a run that somehow never makes progress rather than letting it
    // bounce between two pages indefinitely.
    maxHops: 300,
    // After paging, results re-render from scratch and take their time — the
    // list is reliably still empty several seconds in.
    pageWaitMs: 4000,
    // Bound on how far a run will page. LinkedIn caps people search at 100
    // pages anyway; this stops a broken "Next" from looping forever.
    maxPages: 100,
    maxScrollAttempts: 5,
    scrollWaitMs: 1500,
  };

  /**
   * Confirm buttons, in the order we prefer them. A plain "Send" wins when
   * LinkedIn offers one; "Send without a note" is the label on the current
   * "Add a note to your invitation?" modal. "Add a note" is deliberately absent
   * — composing a note is never something to guess at.
   */
  const SEND_LABELS = [
    "Send",
    "Send without a note",
    "Send now",
    "Send invitation",
  ];

  const SELECTORS = {
    // Deliberately wide: every clickable on the page, narrowed by
    // isConnectButton() below. The Connect control is a <button> on My Network,
    // a <div role="button"> on some cards, and on people-search results a bare
    // <a href="/preload/search-custom-invite/?vanityName=...">  with no role at
    // all. Anchors are why this list can't just be 'button' — a button-only
    // scan finds zero on search and the run ends on "no Connect buttons found".
    clickable: 'button,[role="button"],a',
    dialog: 'div[role="dialog"]',
    dismiss:
      'button[aria-label="Dismiss"],' +
      'button[aria-label="Close"],' +
      'button[aria-label*="dismiss" i],' +
      'button[aria-label*="close" i]',
    send: SEND_LABELS.map((l) => `button[aria-label="${l}"]`).join(","),
  };

  /**
   * Connect controls, by surface:
   *   My Network / profile      <button> aria-label "Invite <Name> to connect"
   *   people search results     <a>      aria-label "Invite <Name> to connect"
   *   some cards, company People         aria-label "Connect with <Name>"
   *   compact rows, reaction lists       no aria-label, visible text "Connect"
   */
  const CONNECT_LABEL = (label) =>
    (/\binvite\b/i.test(label) && /\bconnect\b/i.test(label)) ||
    /^connect\b/i.test(label);

  /**
   * Neighbours of the Connect button that must never be clicked. "Message" and
   * "Follow" sit right beside it; "Pending"/"Withdraw" mean we already invited
   * them; "Ignore"/"Accept" belong to incoming invitations, and accepting one
   * by accident is not undoable.
   */
  const NOT_CONNECT =
    /pending|withdraw|following|follow|message|accept|ignore|remove|report|unfollow|invitation/i;

  function isConnectButton(el) {
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;

    const label = (el.getAttribute("aria-label") ?? "").trim();
    if (label) {
      if (NOT_CONNECT.test(label)) return false;
      return CONNECT_LABEL(label);
    }

    // No label — fall back to visible text, but only an exact match. Many
    // buttons pair an icon with a visually-hidden duplicate label, so
    // textContent reads "Connect Connect"; collapsing repeats handles that
    // while still rejecting "Connections", "Connect your calendar", etc.
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!text || text.length > 40) return false;
    const words = new Set(text.split(" "));
    return words.size === 1 && words.has("connect");
  }

  /**
   * LinkedIn's actual wording, observed:
   *   "Your invitation to Liv was not sent because you have reached the weekly
   *    limit for connection invitations. Please try again next week"
   *
   * Specific enough to scan broadly without tripping on ordinary page content.
   */
  const LIMIT_EXACT =
    /was not sent because you have reached the weekly limit|weekly limit for connection invitations/i;

  /** Looser — only applied inside dialogs, alerts and toasts. */
  const LIMIT_PATTERN =
    /weekly (invitation )?limit|reached the weekly|you've reached|no invitations left|try again (next week|later)/i;

  /**
   * Critically NOT dialog-only. LinkedIn delivers the limit notice as a toast
   * or inline banner, so a dialog-scoped check misses it entirely — and since
   * no modal appears, every subsequent click gets counted as a successful send.
   */
  const LIMIT_SCOPES =
    'div[role="dialog"],[role="alert"],[role="status"],.artdeco-toast-item,.artdeco-inline-feedback,.artdeco-notification';

  function limitNoticeVisible() {
    for (const node of queryAll(LIMIT_SCOPES)) {
      // textContent, not innerText: no layout flush on a hot loop.
      if (!isVisible(node)) continue;
      if (LIMIT_PATTERN.test(textOf(node))) return true;
    }
    for (const doc of reachableDocuments()) {
      if (LIMIT_EXACT.test(textOf(doc.body))) return true;
    }
    return false;
  }

  /**
   * Every document we can reach: this one, plus any same-origin child frame.
   *
   * LinkedIn's current shell renders the invite modal inside a full-page
   * <iframe src="/preload/?_bprMode=vanilla">, so a query against `document`
   * alone never sees it. The cost of missing it is worse than a stall: with no
   * dialog found, the loop credits the click as a send while "Send without a
   * note" is never pressed — the counter climbs and no invite goes out.
   *
   * Cross-origin frames throw on contentDocument; those aren't ours to read.
   */
  function reachableDocuments() {
    const docs = [document];
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch {
        // Cross-origin. Skip it.
      }
    }
    return docs;
  }

  /** querySelectorAll, across every reachable document. */
  function queryAll(selector) {
    const found = [];
    for (const doc of reachableDocuments()) {
      for (const el of doc.querySelectorAll(selector)) found.push(el);
    }
    return found;
  }

  let running = false;
  let sentThisSession = 0;
  let onStatus = () => {};

  /**
   * Following a control's link means leaving the page, which tears down this
   * script. sessionStorage is what carries the run across that: it is scoped
   * to this one tab, survives navigation, and dies with the tab — exactly the
   * lifetime a run has. chrome.storage would leak state between tabs, and a
   * plain variable wouldn't survive at all.
   */
  const RESUME_KEY = "lamfi:resume";

  function loadResume() {
    try {
      return JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? "null");
    } catch {
      return null;
    }
  }

  function saveResume(state) {
    try {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify(state));
    } catch {
      // Private mode or storage full. The run just won't survive navigation.
    }
  }

  function clearResume() {
    try {
      sessionStorage.removeItem(RESUME_KEY);
    } catch {
      /* nothing to clean up */
    }
  }

  /**
   * Who we've already had a go at this run. Without this, returning from an
   * invite page would find the same person still listed and go round forever.
   */
  let tried = new Set();
  let hops = 0;
  let pagesTurned = 0;

  /**
   * Whitespace-normalised text. Modal copy is laid out across elements and
   * source lines, so textContent comes back with newlines and runs of spaces
   * inside sentences. A pattern written against the sentence as it reads on
   * screen quietly fails to match without this — and for the email gate that
   * failure is expensive: the modal carries its own Send button, so a missed
   * match falls through to the send path.
   */
  const textOf = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

  function status(message) {
    onStatus(message);
    console.log("[LAMFI]", message);
  }

  /**
   * Re-query every iteration rather than caching a list. The feed re-renders
   * after each invite, so cached button references go stale and silently
   * click nothing (or worse, the wrong row).
   */
  function findNextConnectButton() {
    for (const btn of queryAll(SELECTORS.clickable)) {
      if (!isConnectButton(btn)) continue;
      if (tried.has(btn.getAttribute("aria-label") ?? "")) continue;
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      return btn;
    }
    return null;
  }

  /**
   * Close a modal and check that it went. Firing the close and hoping is what
   * lets a stuck modal sit there swallowing every click behind it, so try the
   * dismiss control, then Escape, and report whether it actually cleared.
   * @returns {Promise<boolean>}
   */
  async function closeDialog(dialog) {
    const escape = () =>
      (dialog.ownerDocument ?? document).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );

    for (const useEscape of [false, true]) {
      const dismiss = useEscape ? null : dialog.querySelector(SELECTORS.dismiss);
      if (dismiss) dismiss.click();
      else escape();
      await sleep(CONFIG.settleMs);
      // Gone from the DOM, or still there but hidden — either way it's shut.
      if (!isVisible(dialog)) return true;
    }
    return false;
  }

  /**
   * Resolve an already-open dialog.
   * @returns {Promise<"sent"|"limit"|string>} "sent" on a confirmed invite,
   *   "limit" if LinkedIn cut us off, otherwise a skip reason.
   */
  async function handleDialog(dialog) {
    if (LIMIT_PATTERN.test(textOf(dialog))) {
      await closeDialog(dialog);
      return "limit";
    }

    if (NEEDS_EMAIL.test(textOf(dialog))) {
      await closeDialog(dialog);
      return SKIPPED_EMAIL;
    }

    // First label that is present and enabled wins, in SEND_LABELS order —
    // a comma-joined querySelector would return whichever comes first in the
    // DOM instead, which is not the same thing. aria-disabled counts too:
    // LinkedIn greys buttons out that way and they stay clickable in the DOM.
    let send = null;
    for (const label of SEND_LABELS) {
      const candidate = dialog.querySelector(`button[aria-label="${label}"]`);
      if (
        candidate &&
        !candidate.disabled &&
        candidate.getAttribute("aria-disabled") !== "true"
      ) {
        send = candidate;
        break;
      }
    }

    if (send) {
      send.click();
      await sleep(CONFIG.settleMs);
      return "sent";
    }

    // Something we don't recognise — most often "How do you know this person?",
    // which needs a real answer. Never guess here: a wrong guess sends a real,
    // irreversible invite with a false claim attached. Back out and skip.
    await closeDialog(dialog);
    return "unrecognised dialog, skipped";
  }

  /**
   * "To verify this member knows you, please enter their email to connect."
   * Nothing to do but back out: the address isn't ours to supply, and guessing
   * one is both useless and rude. Checked before the Send lookup because this
   * modal carries its own Send button, which would otherwise fire on an empty
   * field.
   */
  const NEEDS_EMAIL =
    /enter (their|the|this member's) email|email address to connect|verify (this|that) member (knows|you)/i;

  /** Not a malfunction — just not this person. Excluded from the failure brake. */
  const SKIPPED_EMAIL = "needs their email, skipped";

  /**
   * On screen, not merely present. LinkedIn does not remove a dismissed modal
   * — it leaves it in the DOM and hides it. Treating "a dialog element exists"
   * as "a dialog is blocking us" means re-handling the same corpse every
   * iteration until the stuck-dialog guard stops the run, which reads exactly
   * like the modal refusing to close.
   */
  function isVisible(el) {
    if (!el?.isConnected) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const view = el.ownerDocument?.defaultView ?? window;
    const style = view.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  /** The invite modal proper — the one with a Send control. */
  const isInviteModal = (dialog) => dialog.querySelector(SELECTORS.send) !== null;

  /**
   * A modal we're working *inside* rather than one blocking us: a list of
   * people, full of Connect buttons. Reaction lists and "N connections" popups
   * are exactly this — dismissing one, which is the right move for a stray
   * invite modal, would throw away the very list being worked.
   */
  function isPeopleList(dialog) {
    if (isInviteModal(dialog)) return false;
    for (const el of dialog.querySelectorAll(SELECTORS.clickable)) {
      if (isConnectButton(el)) return true;
    }
    return false;
  }

  /**
   * A dialog that must be resolved before the next click — never a people
   * list. Anything unrecognised still counts: an unknown modal we can't
   * classify is blocking, and treating it as scenery would let every
   * subsequent click land on its overlay and be credited as a send.
   */
  function openDialog() {
    for (const dialog of queryAll(SELECTORS.dialog)) {
      if (!isVisible(dialog)) continue;
      if (!isPeopleList(dialog)) return dialog;
    }
    return null;
  }

  /** First scrollable descendant of `root`, or null. */
  function scrollableWithin(root) {
    for (const node of root.querySelectorAll("main,div,ul,section")) {
      if (node.scrollHeight <= node.clientHeight + 20) continue;
      if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
    }
    return null;
  }

  /**
   * Scroll whatever actually scrolls, and say what that was.
   *
   * Three cases, in priority order. A modal list we're working inside wins:
   * the page behind it doesn't move. Otherwise the window, when the document
   * really is the scroller. Failing that, hunt for the container — LinkedIn's
   * current shell puts the page inside <main id="workspace"> with
   * overflow-y:auto and leaves the document itself exactly viewport-height, so
   * window.scrollBy() is a silent no-op and the run ends on "no more Connect
   * buttons found" without ever loading the next batch.
   */
  function scrollForMore() {
    for (const dialog of queryAll(SELECTORS.dialog)) {
      if (isInviteModal(dialog)) continue;
      const inModal = scrollableWithin(dialog);
      if (inModal) {
        inModal.scrollTop += inModal.clientHeight * 0.8;
        return "in modal";
      }
    }

    if (document.documentElement.scrollHeight > window.innerHeight + 20) {
      window.scrollBy(0, window.innerHeight * 0.8);
      return "page";
    }

    for (const doc of reachableDocuments()) {
      const container = doc.body && scrollableWithin(doc.body);
      if (container) {
        container.scrollTop += container.clientHeight * 0.8;
        return container.id ? `#${container.id}` : "container";
      }
    }

    window.scrollBy(0, window.innerHeight * 0.8);
    return "page";
  }

  /**
   * The "Next" control of a real result pager.
   *
   * Guarded on numbered "Page N" buttons being present, because "Next" on its
   * own is not distinctive — My Network puts one on a puzzle carousel, and
   * clicking that would advance a carousel while the run believed it had
   * turned a page.
   */
  function findNextPageControl() {
    const paged = queryAll('button[aria-label^="Page "],a[aria-label^="Page "]');
    if (!paged.length) return null;

    for (const el of queryAll(SELECTORS.clickable)) {
      if (!isVisible(el)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      const label = (el.getAttribute("aria-label") ?? "").trim();
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (/^next$/i.test(label) || /^next$/i.test(text)) return el;
    }
    return null;
  }

  /**
   * Move to the next page of results.
   *
   * LinkedIn pages these lists in place — the document survives and the URL
   * changes by pushState — so normally this just returns and the loop carries
   * on. State is saved first anyway: if that ever becomes a real navigation,
   * the run resumes on the far side instead of dying silently. Reaching the
   * clear below proves we were never torn down.
   *
   * @returns {Promise<boolean>} whether a page was turned
   */
  async function turnPage() {
    const next = findNextPageControl();
    if (!next) return false;

    if (pagesTurned >= CONFIG.maxPages) {
      status(`stopped: reached the ${CONFIG.maxPages}-page limit`);
      return false;
    }

    pagesTurned += 1;
    saveResume({
      phase: "return",
      sent: sentThisSession,
      tried: [...tried],
      hops,
    });
    status(`next page (${pagesTurned + 1})`);
    next.click();
    await sleep(CONFIG.pageWaitMs);
    clearResume();
    return true;
  }

  /**
   * Ways to activate a Connect control, cheapest first.
   *
   * "Click it" is not one operation. A <button> wired to onClick responds to
   * element.click(); a control whose handler listens on pointerdown or
   * mousedown does not — click() fires an event nothing is listening for, and
   * nothing happens, silently. Rather than guess which kind a control is, try
   * and check.
   */
  const STRATEGIES = [
    {
      name: "click",
      press(el) {
        el.click();
      },
    },
    {
      name: "pointer",
      press(el) {
        // The events a pointer-driven handler actually listens for. Plain
        // properties only — this is about addressing the right event, not
        // about dressing the call up as something it isn't.
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

  /**
   * Which strategy worked last time, keyed by the shape of the control rather
   * than the page it was on. Keying on the URL would be wrong: the same search
   * URL serves different markup between loads, so a page-based rule breaks the
   * moment LinkedIn varies the response. Shape is what actually predicts
   * behaviour, and it means the probe cost is paid once, not per person.
   */
  const strategyByShape = new Map();
  const shapeOf = (el) =>
    `${el.tagName}${el.hasAttribute("href") ? "[href]" : ""}`;

  /**
   * Proof that activating a control did something.
   * @returns {Promise<"modal"|"gone"|null>}
   */
  /** Labels of every Connect control currently on the page. */
  function connectLabels() {
    return queryAll(SELECTORS.clickable)
      .filter(isConnectButton)
      .map((el) => el.getAttribute("aria-label") ?? "");
  }

  /**
   * Proof that activating a control did something.
   *
   * @param {string} label the control we pressed
   * @param {string[]} peers the other controls that were on the page beforehand
   * @returns {Promise<"modal"|"gone"|"rerender"|null>}
   */
  async function confirmActivation(label, peers) {
    const deadline = Date.now() + CONFIG.confirmMs;
    for (;;) {
      if (openDialog()) return "modal";

      const now = new Set(connectLabels());
      if (!now.has(label)) {
        // Our control went — but that only means a send if the rest of the
        // list is still standing. LinkedIn re-renders these lists on its own,
        // and a re-render takes every label with it, ours included. Reading
        // that as a successful send is exactly how a counter climbs while
        // nothing goes out.
        const survivors = peers.filter((p) => now.has(p)).length;
        if (peers.length === 0 || survivors * 2 >= peers.length) return "gone";
        return "rerender";
      }

      if (Date.now() >= deadline) return null;
      await sleep(50);
    }
  }

  /**
   * Activate one control, escalating until something demonstrably happens.
   * Nothing downstream counts a send without this returning non-null — which
   * is what stops the loop crediting invites that were never actually sent.
   * @returns {Promise<"modal"|"gone"|null>}
   */
  async function activateControl(btn) {
    const label = btn.getAttribute("aria-label") ?? "";
    const known = strategyByShape.get(shapeOf(btn));
    const order = known
      ? [known, ...STRATEGIES.filter((s) => s !== known)]
      : STRATEGIES;

    const peers = connectLabels().filter((l) => l !== label);

    for (const strategy of order) {
      strategy.press(btn);
      const proof = await confirmActivation(label, peers);

      // The page reshuffled under us. We can't tell whether the press landed,
      // so don't count it and don't press again — pressing again after a send
      // that we simply failed to observe is the worse of the two mistakes.
      if (proof === "rerender") return "unclear";

      if (proof) {
        if (!known) status(`activation: ${strategy.name} works here`);
        strategyByShape.set(shapeOf(btn), strategy);
        return proof;
      }
      if (!running) return null;
    }

    // Both in-page strategies failed. If the control carries its own
    // destination, go there — that is what following a link means, and it
    // needs no synthetic input at all. The page unloads, so this returns
    // nothing; resumeIfNeeded() picks the run back up on the other side.
    const href = btn.getAttribute("href");
    if (href) {
      followInviteLink(btn, href);
      return "navigating";
    }
    return null;
  }

  /** Hand the run over to the control's own invite page. */
  function followInviteLink(btn, href) {
    const label = btn.getAttribute("aria-label") ?? "";
    tried.add(label);
    hops += 1;
    saveResume({
      phase: "invite",
      returnUrl: location.href,
      sent: sentThisSession,
      tried: [...tried],
      hops,
    });
    status(`opening invite page (${hops})`);
    location.href = new URL(href, location.origin).toString();
  }

  /** Poll until `fn` returns something truthy, or time out. */
  async function pollFor(fn, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = fn();
      if (found) return found;
      if (Date.now() >= deadline) return null;
      await sleep(100);
    }
  }

  /**
   * Called on every page load. If a run was mid-flight when the page changed,
   * carry it on: resolve the invite modal we came here for, go back, continue.
   * @returns {Promise<boolean>} whether a run was resumed
   */
  async function resumeIfNeeded(statusCallback) {
    const state = loadResume();
    if (!state) return false;

    onStatus = statusCallback ?? (() => {});
    sentThisSession = state.sent ?? 0;
    tried = new Set(state.tried ?? []);
    hops = state.hops ?? 0;

    if (hops > CONFIG.maxHops) {
      clearResume();
      status(`stopped: ${hops} page hops without finishing`);
      return false;
    }

    if (state.phase === "invite") {
      running = true;
      const dialog = await pollFor(openDialog, CONFIG.invitePageWaitMs);
      if (!dialog) {
        status("invite page showed no modal — skipping");
      } else {
        const outcome = await handleDialog(dialog);
        if (outcome === "sent") countSend();
        else if (outcome === "limit") {
          clearResume();
          status("STOPPED: LinkedIn weekly invitation limit reached");
          running = false;
          return false;
        } else status(outcome);
      }
      saveResume({ ...state, phase: "return", sent: sentThisSession, tried: [...tried] });
      location.href = state.returnUrl;
      return true;
    }

    if (state.phase === "return") {
      clearResume();
      running = true;
      status("back at the list");
      await sleep(CONFIG.settleMs);
      run(true);
      return true;
    }

    clearResume();
    return false;
  }

  function countSend() {
    sentThisSession += 1;
    LamfiCount.bump();
    status(`sent ${sentThisSession} this run`);
  }

  async function run(resumed = false) {
    if (!resumed) {
      sentThisSession = 0;
      tried = new Set();
      hops = 0;
      pagesTurned = 0;
    }
    let scrollAttempts = 0;
    // Guards against a modal we can't dismiss spinning the loop forever.
    let stuckDialogs = 0;
    // Invites that didn't confirm, back to back. Reset by any success.
    let consecutiveFailures = 0;
    let limitHit = false;

    status(resumed ? `resumed — ${sentThisSession} sent so far` : "started");

    while (running) {
      // Checked every iteration: the notice is a toast, so there's no modal to
      // hang the check off, and without this the loop keeps clicking and
      // counting sends that LinkedIn is silently refusing.
      if (limitNoticeVisible()) {
        limitHit = true;
        status("STOPPED: LinkedIn weekly invitation limit reached");
        break;
      }

      // Clear anything left over from last iteration before it blocks a click.
      if (!CONFIG.skipDialogs) {
        const stray = openDialog();
        if (stray) {
          if (++stuckDialogs > 3) {
            status("stopped: a dialog won't close — clear it and restart");
            break;
          }
          const outcome = await handleDialog(stray);
          if (outcome === "limit") {
            limitHit = true;
            status("STOPPED: LinkedIn weekly invitation limit reached");
            break;
          }
          if (outcome === "sent") {
            countSend();
            consecutiveFailures = 0;
          } else {
            status(outcome);
            // An email gate is an expected outcome, not a sign anything broke.
            if (
              outcome !== SKIPPED_EMAIL &&
              ++consecutiveFailures >= CONFIG.maxConsecutiveFailures
            ) {
              status(`stopped: ${consecutiveFailures} invites in a row failed`);
              break;
            }
          }
          continue;
        }
        stuckDialogs = 0;
      }

      const btn = findNextConnectButton();
      if (!btn) {
        if (scrollAttempts >= CONFIG.maxScrollAttempts) {
          // Out of people here — try the next page before giving up.
          if (await turnPage()) {
            scrollAttempts = 0;
            continue;
          }
          status("stopped: no more Connect buttons found");
          break;
        }
        scrollAttempts += 1;
        const where = scrollForMore();
        status(`looking for more (scroll ${scrollAttempts}, ${where})`);
        await sleep(CONFIG.scrollWaitMs);
        continue;
      }
      scrollAttempts = 0;

      btn.scrollIntoView({ block: "center" });
      await sleep(CONFIG.settleMs);
      if (!running) break;

      const who = (btn.getAttribute("aria-label") ?? "this one").replace(
        /^Invite | to connect$/g,
        "",
      );
      tried.add(btn.getAttribute("aria-label") ?? "");
      const proof = await activateControl(btn);

      // The toast can appear with no modal at all, which would otherwise be
      // read as a clean send. Check before crediting anything.
      if (limitNoticeVisible()) {
        limitHit = true;
        status("STOPPED: LinkedIn weekly invitation limit reached");
        break;
      }

      if (proof === "navigating") {
        // The page is on its way out; the run continues after the load.
        return;
      }

      if (proof === "unclear") {
        // No evidence either way. Not a send, and not a malfunction either.
        status(`${who}: page reshuffled, moving on`);
        continue;
      }

      if (!proof) {
        // Every strategy ran and the page never reacted. Counting this would
        // be a lie, so don't — and let the brake catch a run of them.
        status(`couldn't activate ${who}`);
        if (++consecutiveFailures >= CONFIG.maxConsecutiveFailures) {
          status(`stopped: ${consecutiveFailures} in a row wouldn't activate`);
          break;
        }
        continue;
      }

      if (proof === "gone") {
        // No modal, and the control left the page: sent outright.
        countSend();
        consecutiveFailures = 0;
      } else {
        const outcome = await handleDialog(openDialog());
        if (outcome === "limit") {
          limitHit = true;
          status("STOPPED: LinkedIn weekly invitation limit reached");
          break;
        }
        if (outcome === "sent") {
          countSend();
          consecutiveFailures = 0;
        } else {
          status(`${who}: ${outcome}`);
          // An email gate is an expected outcome, not a sign anything broke.
          if (
            outcome !== SKIPPED_EMAIL &&
            ++consecutiveFailures >= CONFIG.maxConsecutiveFailures
          ) {
            status(`stopped: ${consecutiveFailures} invites in a row failed`);
            break;
          }
        }
      }

      await sleep(rand(CONFIG.delayMinMs, CONFIG.delayMaxMs));
    }

    clearResume();
    running = false;
  }

  // Escape is a panic stop from anywhere on the page.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && running) {
      clearResume();
      running = false;
      status("stopped by Escape");
    }
  });

  return {
    CONFIG,

    /** Invites sent in the current run — drives the toolbar badge. */
    sessionCount() {
      return sentThisSession;
    },

    start(statusCallback) {
      if (running) return false;
      onStatus = statusCallback ?? (() => {});

      running = true;
      run();
      return true;
    },

    /** Continue a run that a page navigation interrupted. */
    resumeIfNeeded,

    stop() {
      clearResume();
      if (!running) return;
      running = false;
      status("stopped by user");
    },

    isRunning() {
      return running;
    },
  };
})();
