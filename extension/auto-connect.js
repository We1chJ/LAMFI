/**
 * L.A.M.F.I. — auto-connect engine.
 *
 * Clicks Connect buttons on the current LinkedIn page, handles the invite
 * modal, and reports each confirmed send to LamfiCount.
 *
 * Attended by design: Stop button, Escape key, session cap, daily cap, and a
 * hard stop the moment LinkedIn shows an invite-limit dialog.
 *
 * Dialog strategy: the loop does NOT block waiting for the invite modal. It
 * glances for one (dialogGraceMs, default 120ms) and otherwise moves straight
 * on. Anything that renders later gets caught at the top of the next
 * iteration, before the next Connect click — which is the only moment a stray
 * modal actually matters, since an open modal swallows every click behind it.
 * A send is only counted once its modal is resolved, so the total can't drift
 * from reality.
 */
const LamfiAuto = (() => {
  const CONFIG = {
    // Gap between one send and the next attempt.
    delayMinMs: 150,
    delayMaxMs: 350,
    // How long to glance for the invite modal before moving on. Safe to set
    // near 0: a late modal is picked up next iteration instead.
    dialogGraceMs: 60,
    // Let scrolling / modal transitions finish. This is the hard floor —
    // under ~100ms clicks land on elements React is still repositioning, so
    // you start hitting the wrong row or nothing at all.
    settleMs: 100,
    // Never look for modals at all. Fastest, and breaks on any account where
    // LinkedIn shows the "Add a note?" step: invites silently don't send and
    // the run stalls behind the first dialog. Off by default for that reason.
    skipDialogs: false,
    // Per-run and per-day caps removed by request. Set either to a number to
    // reinstate; previous defaults were 20 and 15.
    sessionCap: Infinity,
    dailyCap: Infinity,
    // Rolling 7-day cap — not a calendar week. LinkedIn's own limit is a
    // moving window, so resetting on Mondays would let you send 90 on Sunday
    // and 90 on Monday and still hit their wall.
    //
    // Their observed limit is ~100, but it's unpublished and personalised, so
    // 90 leaves headroom rather than discovering the real number by tripping it.
    weeklyCap: 90,
    // With no volume cap, this is the main automatic brake: if invites stop
    // confirming, something has changed (LinkedIn blocking, markup moved,
    // unexpected modals) and hammering it is the worst thing to do.
    maxConsecutiveFailures: 5,
    maxScrollAttempts: 5,
    scrollWaitMs: 1500,
  };

  const SELECTORS = {
    // LinkedIn labels these "Invite <Name> to connect".
    connect: 'button[aria-label*="Invite"][aria-label*="connect"]',
    dialog: 'div[role="dialog"]',
    dismiss: 'button[aria-label="Dismiss"]',
  };

  // Wording LinkedIn uses when you've run out of invites. Matching any of
  // these aborts the run immediately rather than hammering a closed door.
  const LIMIT_PATTERN =
    /weekly invitation limit|reached the weekly|you've reached|no invitations left|try again later/i;

  let running = false;
  let sentThisSession = 0;
  let onStatus = () => {};

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

  function status(message) {
    onStatus(message);
    console.log("[LAMFI]", message);
  }

  const SEND_LOG_KEY = "lamfi:sendLog";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * DAY_MS;

  /**
   * Timestamps of sent invites. Storing the times rather than a counter is
   * what makes a rolling window possible — a plain tally can't tell you which
   * sends have aged out.
   */
  async function loadLog() {
    const stored = await chrome.storage.local.get(SEND_LOG_KEY);
    const log = stored?.[SEND_LOG_KEY];
    if (!Array.isArray(log)) return [];
    // Prune on read so the array can't grow without bound.
    const cutoff = Date.now() - WEEK_MS;
    return log.filter((t) => typeof t === "number" && t > cutoff);
  }

  function saveLog(log) {
    return chrome.storage.local.set({ [SEND_LOG_KEY]: log });
  }

  function countWithin(log, windowMs) {
    const cutoff = Date.now() - windowMs;
    let n = 0;
    for (const t of log) if (t > cutoff) n += 1;
    return n;
  }

  /** Poll until `fn` returns something truthy, or time out. */
  async function waitFor(fn, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = fn();
      if (found) return found;
      if (Date.now() >= deadline) return null;
      await sleep(40);
    }
  }

  /**
   * Re-query every iteration rather than caching a list. The feed re-renders
   * after each invite, so cached button references go stale and silently
   * click nothing (or worse, the wrong row).
   */
  function findNextConnectButton() {
    for (const btn of document.querySelectorAll(SELECTORS.connect)) {
      if (btn.disabled) continue;
      const label = btn.getAttribute("aria-label") ?? "";
      if (/pending|withdraw/i.test(label)) continue;
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      return btn;
    }
    return null;
  }

  function closeDialog(dialog) {
    const dismiss = dialog.querySelector(SELECTORS.dismiss);
    if (dismiss) {
      dismiss.click();
      return;
    }
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  }

  /**
   * Resolve an already-open dialog.
   * @returns {Promise<"sent"|"limit"|string>} "sent" on a confirmed invite,
   *   "limit" if LinkedIn cut us off, otherwise a skip reason.
   */
  async function handleDialog(dialog) {
    if (LIMIT_PATTERN.test(dialog.textContent ?? "")) {
      closeDialog(dialog);
      return "limit";
    }

    const send =
      dialog.querySelector('button[aria-label="Send without a note"]') ??
      dialog.querySelector('button[aria-label="Send now"]') ??
      dialog.querySelector('button[aria-label="Send invitation"]');

    if (send && !send.disabled) {
      send.click();
      await sleep(CONFIG.settleMs);
      return "sent";
    }

    // Something we don't recognise — most often "How do you know this person?",
    // which needs a real answer. Never guess here: a wrong guess sends a real,
    // irreversible invite with a false claim attached. Back out and skip.
    closeDialog(dialog);
    await sleep(CONFIG.settleMs);
    return "unrecognised dialog, skipped";
  }

  const openDialog = () => document.querySelector(SELECTORS.dialog);

  async function run() {
    sentThisSession = 0;
    let log = await loadLog();
    let scrollAttempts = 0;
    // Guards against a modal we can't dismiss spinning the loop forever.
    let stuckDialogs = 0;
    // Invites that didn't confirm, back to back. Reset by any success.
    let consecutiveFailures = 0;
    // A Connect click whose modal (if any) hasn't been resolved yet. Counting
    // is deferred until we know, so the total never counts an unsent invite.
    let pendingSend = false;

    const countSend = async () => {
      sentThisSession += 1;
      log.push(Date.now());
      await saveLog(log);
      LamfiCount.bump();
      status(
        `sent ${sentThisSession} this run · ` +
          `${countWithin(log, WEEK_MS)}/${CONFIG.weeklyCap} this week`,
      );
    };

    status(
      `started — ${countWithin(log, WEEK_MS)}/${CONFIG.weeklyCap} this week, ` +
        `${countWithin(log, DAY_MS)} today`,
    );

    while (running) {
      if (sentThisSession >= CONFIG.sessionCap) {
        status(`stopped: session cap (${CONFIG.sessionCap}) reached`);
        break;
      }
      if (countWithin(log, DAY_MS) >= CONFIG.dailyCap) {
        status(`stopped: daily cap (${CONFIG.dailyCap}) reached`);
        break;
      }
      if (countWithin(log, WEEK_MS) >= CONFIG.weeklyCap) {
        status(`stopped: weekly cap (${CONFIG.weeklyCap}) reached`);
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
            status("STOPPED: LinkedIn says you're out of invites");
            break;
          }
          if (outcome === "sent") {
            if (pendingSend) await countSend();
            consecutiveFailures = 0;
          } else {
            status(outcome);
            if (++consecutiveFailures >= CONFIG.maxConsecutiveFailures) {
              status(`stopped: ${consecutiveFailures} invites in a row failed`);
              break;
            }
          }
          pendingSend = false;
          continue;
        }
        stuckDialogs = 0;
        // No modal showed up for the previous click, so it went straight out.
        if (pendingSend) {
          await countSend();
          pendingSend = false;
        }
      }

      const btn = findNextConnectButton();
      if (!btn) {
        if (scrollAttempts >= CONFIG.maxScrollAttempts) {
          status("stopped: no more Connect buttons found");
          break;
        }
        scrollAttempts += 1;
        status(`looking for more (scroll ${scrollAttempts})`);
        window.scrollBy(0, window.innerHeight * 0.8);
        await sleep(CONFIG.scrollWaitMs);
        continue;
      }
      scrollAttempts = 0;

      btn.scrollIntoView({ block: "center" });
      await sleep(CONFIG.settleMs);
      if (!running) break;

      btn.click();

      if (CONFIG.skipDialogs) {
        // No verification possible in this mode; trust the click.
        await countSend();
      } else {
        pendingSend = true;
        // Glance, don't block. A slower modal is caught next time round.
        const quick = await waitFor(openDialog, CONFIG.dialogGraceMs);
        if (quick) {
          const outcome = await handleDialog(quick);
          if (outcome === "limit") {
            status("STOPPED: LinkedIn says you're out of invites");
            break;
          }
          if (outcome === "sent") {
            await countSend();
            consecutiveFailures = 0;
          } else {
            status(outcome);
            if (++consecutiveFailures >= CONFIG.maxConsecutiveFailures) {
              status(`stopped: ${consecutiveFailures} invites in a row failed`);
              break;
            }
          }
          pendingSend = false;
        }
      }

      await sleep(rand(CONFIG.delayMinMs, CONFIG.delayMaxMs));
    }

    // Don't lose the last invite's count if the loop exited while one was open.
    if (pendingSend && !openDialog()) await countSend();

    running = false;
  }

  // Escape is a panic stop from anywhere on the page.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && running) {
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

    stop() {
      if (!running) return;
      running = false;
      status("stopped by user");
    },

    isRunning() {
      return running;
    },

    /** @returns {Promise<{ today: number, week: number }>} */
    async stats() {
      const log = await loadLog();
      return { today: countWithin(log, DAY_MS), week: countWithin(log, WEEK_MS) };
    },
  };
})();
