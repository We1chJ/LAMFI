/**
 * L.A.M.F.I. — LinkedIn DOM helpers shared by the run engine and the
 * profile flow.
 *
 * Everything that knows what LinkedIn's markup looks like lives here, so when
 * it shifts there is one place to fix.
 *
 * Frame-agnostic: LinkedIn's shell renders the invite modal inside a
 * same-origin <iframe src="/preload/...">, so every query spans the top
 * document and its reachable child frames.
 */
const LamfiDom = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

  /** Whitespace-normalised text. Modal copy wraps across source lines. */
  const textOf = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();

  const label = (el) => (el.getAttribute("aria-label") ?? "").trim();

  function reachableDocuments() {
    const docs = [document];
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch {
        // Cross-origin. Not ours.
      }
    }
    return docs;
  }

  function queryAll(selector, root = null) {
    if (root) return [...root.querySelectorAll(selector)];
    const found = [];
    for (const doc of reachableDocuments()) found.push(...doc.querySelectorAll(selector));
    return found;
  }

  /**
   * On screen, not merely present. LinkedIn hides a dismissed modal rather
   * than removing it, so "exists" is not "is in the way".
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

  const isEnabled = (el) =>
    el && !el.disabled && el.getAttribute("aria-disabled") !== "true";

  async function pollFor(fn, timeoutMs, stepMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = fn();
      if (found) return found;
      if (Date.now() >= deadline) return null;
      await sleep(stepMs);
    }
  }

  // ------------------------------------------------------------ controls

  const SELECTORS = {
    // Every clickable, narrowed by isConnectButton(). The Connect control is a
    // <button> on My Network, a <div role="button"> on some cards, and a bare
    // <a href="/preload/search-custom-invite/..."> on people search.
    clickable: 'button,[role="button"],a',
    // The older surfaces use <div role="dialog">; the redesigned profile page
    // uses native <dialog> elements with no role at all.
    dialog: '[role="dialog"],dialog[open]',
    dismiss:
      'button[aria-label="Dismiss"],button[aria-label="Close"],' +
      'button[aria-label*="dismiss" i],button[aria-label*="close" i]',
  };

  /** Confirm buttons, in preference order. "Add a note" is never guessed at. */
  const SEND_LABELS = ["Send", "Send without a note", "Send now", "Send invitation"];
  SELECTORS.send = SEND_LABELS.map((l) => `button[aria-label="${l}"]`).join(",");

  const CONNECT_LABEL = (l) =>
    (/\binvite\b/i.test(l) && /\bconnect\b/i.test(l)) || /^connect\b/i.test(l);

  /** Neighbours that must never be clicked. Accepting an invite is not undoable. */
  const NOT_CONNECT =
    /pending|withdraw|following|follow|message|accept|ignore|remove|report|unfollow|invitation/i;

  function isConnectButton(el) {
    if (!isEnabled(el)) return false;
    const l = label(el);
    if (l) return !NOT_CONNECT.test(l) && CONNECT_LABEL(l);
    // Icon + visually-hidden duplicate reads "Connect Connect"; collapse it.
    const text = textOf(el).toLowerCase();
    if (!text || text.length > 40) return false;
    const words = new Set(text.split(" "));
    return words.size === 1 && words.has("connect");
  }

  function isMessageButton(el) {
    if (!isEnabled(el)) return false;
    const l = label(el);
    if (l) return /^message\b/i.test(l) && !/messaging/i.test(l);
    const text = textOf(el).toLowerCase();
    const words = new Set(text.split(" "));
    return words.size === 1 && words.has("message");
  }

  const isPendingButton = (el) => /pending|withdraw/i.test(label(el) || textOf(el));

  // ------------------------------------------------------------- dialogs

  const isInviteModal = (dialog) => dialog.querySelector(SELECTORS.send) !== null;

  /** A people list we're working *inside* (reactions, "N connections"). */
  function isPeopleList(dialog) {
    if (isInviteModal(dialog)) return false;
    return queryAll(SELECTORS.clickable, dialog).some(isConnectButton);
  }

  /** The visible dialog that must be resolved before the next click, if any. */
  function openDialog() {
    for (const dialog of queryAll(SELECTORS.dialog)) {
      if (isVisible(dialog) && !isPeopleList(dialog)) return dialog;
    }
    return null;
  }

  /** Close a dialog and confirm it went: dismiss control, then Escape. */
  async function closeDialog(dialog) {
    for (const useEscape of [false, true]) {
      const dismiss = useEscape ? null : dialog.querySelector(SELECTORS.dismiss);
      if (dismiss) dismiss.click();
      else
        (dialog.ownerDocument ?? document).dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      await sleep(200);
      if (!isVisible(dialog)) return true;
    }
    return false;
  }

  /** "To verify this member knows you, please enter their email to connect." */
  const NEEDS_EMAIL =
    /enter (their|the|this member's) email|email address to connect|verify (this|that) member (knows|you)/i;

  const LIMIT_EXACT =
    /was not sent because you have reached the weekly limit|weekly limit for connection invitations/i;
  const LIMIT_PATTERN =
    /weekly (invitation )?limit|reached the weekly|you've reached|no invitations left|try again (next week|later)/i;
  const LIMIT_SCOPES =
    'div[role="dialog"],[role="alert"],[role="status"],.artdeco-toast-item,.artdeco-inline-feedback,.artdeco-notification';

  /** The limit notice is often a toast, not a modal — scan broadly. */
  function limitNoticeVisible() {
    for (const node of queryAll(LIMIT_SCOPES)) {
      if (isVisible(node) && LIMIT_PATTERN.test(textOf(node))) return true;
    }
    return reachableDocuments().some((doc) => LIMIT_EXACT.test(textOf(doc.body)));
  }

  // ----------------------------------------------------------- scrolling

  function scrollableWithin(root) {
    for (const node of root.querySelectorAll("main,div,ul,section")) {
      if (node.scrollHeight <= node.clientHeight + 20) continue;
      if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
    }
    return null;
  }

  /**
   * Scroll whatever actually scrolls. A modal list we're inside wins; then the
   * window; then the shell's <main id="workspace">, which is the real scroller
   * on current LinkedIn and makes window.scrollBy() a silent no-op.
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

  // --------------------------------------------------------------- input

  /** Set a React-controlled <input>/<textarea> so its handlers see the change. */
  function setInputValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
    el.focus();
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Type into a contenteditable the way a keyboard would, so editors notice. */
  function insertText(el, value) {
    el.focus();
    const doc = el.ownerDocument ?? document;
    const sel = doc.getSelection();
    sel.selectAllChildren(el);
    sel.collapseToEnd();
    const ok = doc.execCommand("insertText", false, value);
    if (!ok) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
    }
  }

  // --------------------------------------------------------- identities

  /** Profile slug from any /in/<slug> URL, or null. */
  function slugOf(href) {
    const m = /\/in\/([^/?#]+)/.exec(href ?? "");
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  }

  function splitName(name) {
    // "Erqi (Jack) Wei, PhD" → "Erqi Wei"
    const clean = (name ?? "").replace(/\(.*?\)/g, " ").replace(/,.*$/, "").replace(/\s+/g, " ").trim();
    const [first = "", ...rest] = clean.split(/\s+/);
    return { name: clean, first, last: rest.join(" ") };
  }

  return {
    sleep, rand, textOf, label, reachableDocuments, queryAll, isVisible, isEnabled,
    pollFor, SELECTORS, SEND_LABELS, isConnectButton, isMessageButton,
    isPendingButton, isInviteModal, isPeopleList, openDialog, closeDialog,
    NEEDS_EMAIL, LIMIT_PATTERN, limitNoticeVisible, scrollForMore,
    setInputValue, insertText, slugOf, splitName,
  };
})();
