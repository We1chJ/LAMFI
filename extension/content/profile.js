/**
 * L.A.M.F.I. — the profile flow.
 *
 * On a /in/<slug> page: read the top card and About, open Contact info for
 * email / phone / websites, work out whether we can Connect or Message, and
 * send a note or a DM.
 *
 * LinkedIn's profile markup is obfuscated and shifts without notice, so the
 * scraper is heuristic: it reads visible text lines, not class names. The HUD
 * preview exists so a wrong guess is caught before anything is sent.
 */
const LamfiProfile = (() => {
  const D = LamfiDom;

  const isProfilePage = () => /^\/in\/[^/]+\/?$/.test(location.pathname);

  const mainEl = () => document.querySelector("main") ?? document.body;

  const lines = (el) =>
    (el?.innerText ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

  /** The <section> whose heading reads `title` (About, Experience, …). */
  function section(title) {
    const re = new RegExp(`^${title}$`, "i");
    for (const h of mainEl().querySelectorAll("h2,h3")) {
      if (re.test(D.textOf(h))) return h.closest("section") ?? h.parentElement;
    }
    return null;
  }

  /**
   * The person's name heading. An <h1> on the older layout; the redesigned
   * profile has no <h1> at all and puts the name in the page's first <h2>.
   */
  const nameEl = () => {
    const main = mainEl();
    return main.querySelector("h1") ?? [...main.querySelectorAll("h2")].find((h) => D.textOf(h)) ?? null;
  };

  /** The top card: name, headline, location, chips and action buttons. */
  const topCard = () => {
    const h = nameEl();
    return h?.closest("section") ?? h?.parentElement?.parentElement ?? mainEl();
  };

  /** "(3) Jane Doe | LinkedIn" → "Jane Doe", for when no heading reads. */
  const nameFromTitle = () => document.title.replace(/^\(\d+\)\s*/, "").split(" | ")[0].trim();

  // -------------------------------------------------------------- scrape

  function scrape() {
    const main = mainEl();
    const name = D.textOf(nameEl()) || nameFromTitle();
    const url = location.origin + location.pathname.replace(/\/?$/, "/");
    const id = D.slugOf(url);

    // The top card as the eye reads it: name, pronouns, headline, location,
    // then the company/school chips and the connection count.
    const top = lines(topCard());
    const noise = /^(contact info|\d+\+? (connections|followers)|·|•|\d+(st|nd|rd|th)( degree)?|he\/him|she\/her|they\/them|\(.*\))$/i;
    const body = top.filter((s) => s !== name && !s.startsWith(name) && !noise.test(s));
    const headline = body[0] ?? "";
    const locationLine =
      body.find((s, i) => i > 0 && (/,\s*\S/.test(s) || /\b(area|region|united|kingdom|states)\b/i.test(s))) ?? "";

    let company = "";
    // "Current company: X. Click to…" on the older layout, "View company: X"
    // on the redesign.
    const chip = main.querySelector('[aria-label^="Current company" i],[aria-label^="View company:" i]');
    if (chip) {
      company = D.label(chip)
        .replace(/^(current company|view company):?\s*/i, "")
        .replace(/\.?\s*click.*$/i, "");
    }
    if (!company) {
      // First Experience entry: title, then "Company · Full-time".
      const exp = lines(section("Experience")).filter((s) => !/^experience$/i.test(s));
      company = (exp[1] ?? "").split(/\s[·•]\s/)[0];
    }

    const about = lines(section("About"))
      .filter((s) => !/^about$/i.test(s) && !/^…?see more$/i.test(s))
      .join(" ")
      .slice(0, 800);

    return {
      id,
      url,
      ...D.splitName(name),
      headline,
      location: locationLine,
      company,
      about,
      source: "profile",
    };
  }

  // -------------------------------------------------------- contact info

  function parseContact(root) {
    const out = { websites: [] };
    for (const a of root.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("mailto:")) out.email ??= href.slice(7).split("?")[0];
      else if (href.startsWith("tel:")) out.phone ??= href.slice(4);
      else if (/^https?:/.test(href) && !/linkedin\.com/.test(href)) out.websites.push(href);
    }
    if (!out.phone) {
      const m = /(\+?\d[\d\s().-]{7,}\d)/.exec(D.textOf(root).replace(/\d{4}-\d{2}-\d{2}/g, ""));
      if (m && /phone/i.test(D.textOf(root))) out.phone = m[1].trim();
    }
    return out;
  }

  function contactInfoControl() {
    const main = mainEl();
    return (
      main.querySelector("#top-card-text-details-contact-info") ??
      main.querySelector('a[href*="/overlay/contact-info"]') ??
      main.querySelector('a[href*="/overview/"]') ??
      [...main.querySelectorAll("a,button")].find((el) => /^contact info$/i.test(D.textOf(el))) ??
      null
    );
  }

  /** Open Contact info, read it, close it. Empty object when nothing's shared. */
  async function contactInfo() {
    const control = contactInfoControl();
    if (!control) return {};
    const before = location.pathname;
    control.click();
    // On the redesign the click pushes /overlay/contact-info/ but the page
    // stays put; the overlay is a <dialog> titled "Contact info".
    const dialog = await D.pollFor(
      () => D.queryAll(D.SELECTORS.dialog).find((d) => D.isVisible(d) && /contact info/i.test(D.textOf(d))) ?? null,
      4000,
    );

    if (dialog) {
      // The dialog opens before its contents load. Every version lists the
      // person's own profile link, so that showing up means the rest has too.
      await D.pollFor(() => dialog.querySelector('a[href*="/in/"]'), 3000);
      const info = parseContact(dialog);
      await D.closeDialog(dialog);
      return info;
    }
    // The link navigated to /overview/ instead of opening a modal.
    if (location.pathname !== before) {
      await D.sleep(1500);
      const info = parseContact(mainEl());
      history.back();
      await D.sleep(1000);
      return info;
    }
    return {};
  }

  // -------------------------------------------------------- relationship

  // Profile action buttons, not the "People also viewed" cards further down.
  const topControls = () => [...topCard().querySelectorAll(D.SELECTORS.clickable)].filter(D.isVisible);

  /** @returns {Promise<"connect"|"message"|"pending"|"unknown">} */
  async function relationship() {
    const classify = (els) => {
      if (els.some(D.isPendingButton)) return "pending";
      if (els.some(D.isConnectButton)) return "connect";
      if (els.some(D.isMessageButton)) return "message";
      return null;
    };
    const direct = classify(topControls());
    if (direct) return direct;

    // Connect may be tucked under "More" when Follow is the primary action.
    const more = topControls().find((el) => /^more( actions)?$/i.test(D.label(el) || D.textOf(el)));
    if (more) {
      more.click();
      await D.sleep(400);
      const menu = D.queryAll('[role="menu"],[role="listbox"],.artdeco-dropdown__content').find(D.isVisible);
      const found = menu ? classify([...menu.querySelectorAll(D.SELECTORS.clickable)]) : null;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (found) return found;
    }
    return "unknown";
  }

  async function pressTopControl(predicate) {
    let el = topControls().find(predicate);
    if (!el) {
      const more = topControls().find((e) => /^more( actions)?$/i.test(D.label(e) || D.textOf(e)));
      if (!more) return false;
      more.click();
      await D.sleep(400);
      el = D.queryAll(D.SELECTORS.clickable).filter(D.isVisible).find(predicate);
      if (!el) return false;
    }
    el.click();
    return true;
  }

  // ---------------------------------------------------------------- send

  const NOTE_SEND = ["Send invitation", "Send now", "Send"];

  /** Connect with a note. @returns {Promise<{ok:boolean, reason?:string}>} */
  async function sendNote(text) {
    if (text.length > 300) return { ok: false, reason: `note is ${text.length} chars; LinkedIn allows 300` };
    if (!(await pressTopControl(D.isConnectButton))) return { ok: false, reason: "no Connect control" };

    const dialog = await D.pollFor(D.openDialog, 6000);
    if (!dialog) return { ok: false, reason: "invite modal never appeared" };
    const copy = D.textOf(dialog);
    if (D.NEEDS_EMAIL.test(copy)) {
      await D.closeDialog(dialog);
      return { ok: false, reason: "LinkedIn wants their email to connect" };
    }
    if (D.LIMIT_PATTERN.test(copy)) {
      await D.closeDialog(dialog);
      return { ok: false, reason: "weekly invitation limit reached" };
    }

    const addNote = [...dialog.querySelectorAll("button")].find((b) =>
      /^add a (free )?note$/i.test(D.label(b) || D.textOf(b)),
    );
    if (!addNote) {
      await D.closeDialog(dialog);
      return { ok: false, reason: "no 'Add a note' option here (monthly note limit?) — nothing sent" };
    }
    addNote.click();
    const box = await D.pollFor(() => dialog.querySelector("textarea"), 4000);
    if (!box) {
      await D.closeDialog(dialog);
      return { ok: false, reason: "note box never appeared" };
    }
    D.setInputValue(box, text);
    await D.sleep(300);

    const send = await D.pollFor(() => {
      for (const l of NOTE_SEND) {
        const b = dialog.querySelector(`button[aria-label="${l}"]`);
        if (D.isEnabled(b)) return b;
      }
      return [...dialog.querySelectorAll("button")].find((b) => /^send$/i.test(D.textOf(b)) && D.isEnabled(b)) ?? null;
    }, 3000);
    if (!send) {
      await D.closeDialog(dialog);
      return { ok: false, reason: "Send stayed disabled" };
    }
    send.click();
    const closed = await D.pollFor(() => !D.isVisible(dialog), 5000);
    if (D.limitNoticeVisible()) return { ok: false, reason: "weekly invitation limit reached" };
    return closed ? { ok: true } : { ok: false, reason: "modal didn't close after Send" };
  }

  const composerSelector =
    'div.msg-form__contenteditable[contenteditable="true"],div[role="textbox"][contenteditable="true"]';

  /** Direct-message an existing connection. */
  async function sendMessage(text) {
    if (!(await pressTopControl(D.isMessageButton))) return { ok: false, reason: "no Message control" };

    const box = await D.pollFor(
      () => D.queryAll(composerSelector).find(D.isVisible) ?? null,
      6000,
    );
    if (!box) return { ok: false, reason: "message composer never appeared" };
    D.insertText(box, text);
    await D.sleep(400);

    const form = box.closest("form") ?? box.closest('[role="dialog"]') ?? box.parentElement?.parentElement;
    const send = await D.pollFor(() => {
      const scope = form ?? document;
      return (
        scope.querySelector("button.msg-form__send-button") ??
        [...scope.querySelectorAll('button[type="submit"],button')].find(
          (b) => /^send( message)?$/i.test(D.label(b) || D.textOf(b)) && D.isEnabled(b),
        ) ??
        null
      );
    }, 3000);
    if (!send || !D.isEnabled(send)) return { ok: false, reason: "Send stayed disabled" };
    send.click();

    const cleared = await D.pollFor(() => D.textOf(box).length === 0, 5000);
    return cleared ? { ok: true } : { ok: false, reason: "composer didn't clear after Send" };
  }

  return { isProfilePage, scrape, contactInfo, relationship, sendNote, sendMessage };
})();
