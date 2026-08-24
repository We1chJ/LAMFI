/**
 * L.A.M.F.I. — wiring.
 *
 * LamfiHud owns the panel (drag, snap, collapse); this file connects it to the
 * click engine, the counter, and the right-click menu.
 */
(async () => {
  function toggleRun() {
    if (LamfiAuto.isRunning()) LamfiAuto.stop();
    else LamfiAuto.start(LamfiHud.setStatus);
  }

  const { countEl } = await LamfiHud.create({
    onToggleRun: toggleRun,
    onCollapse: () => report(true),
  });

  await LamfiCount.init({ el: countEl });

  // Following a Connect link leaves the page, which tears this script down and
  // reloads it here. If a run was mid-flight, pick it up rather than sitting
  // idle on an invite page the user never asked to see.
  LamfiAuto.resumeIfNeeded(LamfiHud.setStatus);

  // Non-blocking: if sync isn't configured or the network is down, the local
  // counter carries on regardless.
  LamfiSync.init();

  let lastReported = null;
  function report(force = false) {
    const running = LamfiAuto.isRunning();
    const sent = LamfiAuto.sessionCount();
    const collapsed = LamfiHud.isCollapsed();
    const signature = `${running}:${sent}:${collapsed}`;
    if (!force && signature === lastReported) return;
    lastReported = signature;
    chrome.runtime
      .sendMessage({ type: "lamfi:state", running, sent, collapsed })
      .catch(() => {
        /* service worker asleep; next tick retries */
      });
  }

  // The engine stops on its own (no buttons left, LinkedIn cutting us off), so
  // poll rather than trusting the last command.
  setInterval(() => {
    LamfiHud.setRunning(LamfiAuto.isRunning());
    report();
  }, 400);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "lamfi:toggle") {
      toggleRun();
      report(true);
      sendResponse({ running: LamfiAuto.isRunning() });
      return true;
    }
    if (msg?.type === "lamfi:toggleHud") {
      LamfiHud.toggleCollapsed();
      sendResponse({ collapsed: LamfiHud.isCollapsed() });
      return true;
    }
  });

  report(true);
})();
