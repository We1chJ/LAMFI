/**
 * L.A.M.F.I. — content script.
 *
 * No on-page UI. Everything is driven from the right-click menu, which the
 * background worker owns; this file just wires that to the click engine and
 * reports state back so the menu label and toolbar badge stay accurate.
 *
 * Progress goes to the console. Escape still stops a run from anywhere.
 */
(async () => {
  // No element passed: the counter runs headless and just persists the total.
  await LamfiCount.init({});

  // Non-blocking — if sync isn't configured or the network is down, counting
  // carries on regardless.
  LamfiSync.init();

  let lastReported = null;

  function report() {
    const running = LamfiAuto.isRunning();
    const sent = LamfiAuto.sessionCount();
    const signature = `${running}:${sent}`;
    if (signature === lastReported) return;
    lastReported = signature;
    chrome.runtime
      .sendMessage({ type: "lamfi:state", running, sent })
      .catch(() => {
        /* service worker asleep; next tick will retry */
      });
  }

  // The engine stops on its own (caps, no buttons left, LinkedIn cutting us
  // off), so poll rather than assuming the last command reflects reality.
  setInterval(report, 500);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "lamfi:toggle") return;

    // No status callback: the engine already console.logs every status line,
    // and passing one here would double every message.
    if (LamfiAuto.isRunning()) LamfiAuto.stop();
    else LamfiAuto.start();
    report();
    sendResponse({ running: LamfiAuto.isRunning() });
    return true;
  });

  report();
})();
