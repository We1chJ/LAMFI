/**
 * L.A.M.F.I. — HUD and controls.
 *
 * The panel can be hidden with its × button, and brought back from the
 * right-click menu — which is the only way back, since hiding removes the
 * last on-page control. The hidden state persists across reloads.
 */
(async () => {
  const HIDDEN_KEY = "lamfi:hudHidden";
  const el = (tag, props) => Object.assign(document.createElement(tag), props);

  const countEl = el("span", { id: "lamfi-count", textContent: "0" });
  const statusEl = el("span", { className: "lamfi-status", textContent: "idle" });
  const runBtn = el("button", { type: "button", textContent: "START" });
  const hideBtn = el("button", {
    type: "button",
    textContent: "×",
    className: "lamfi-hide",
    title: "Hide — right-click the page to bring it back",
  });

  const hud = el("div", { className: "lamfi-hud" });
  const row = el("div", { className: "lamfi-row" });
  row.append(
    el("span", { className: "lamfi-label", textContent: "LINKED" }),
    countEl,
    runBtn,
    hideBtn,
  );
  hud.append(row, statusEl);
  document.body.append(hud);

  let hidden = Boolean((await chrome.storage.local.get(HIDDEN_KEY))?.[HIDDEN_KEY]);
  const applyHidden = () => hud.classList.toggle("lamfi-hidden", hidden);
  applyHidden();

  async function setHidden(value) {
    hidden = value;
    applyHidden();
    await chrome.storage.local.set({ [HIDDEN_KEY]: hidden });
    report(true);
  }

  await LamfiCount.init({ el: countEl });
  const { week } = await LamfiAuto.stats();
  statusEl.textContent = `${week}/${LamfiAuto.CONFIG.weeklyCap} this week`;

  // Non-blocking: if sync isn't configured or the network is down, the local
  // counter carries on regardless.
  LamfiSync.init();

  const setStatus = (message) => {
    statusEl.textContent = message;
  };

  function toggleRun() {
    if (LamfiAuto.isRunning()) LamfiAuto.stop();
    else LamfiAuto.start(setStatus);
  }

  let lastReported = null;
  function report(force = false) {
    const running = LamfiAuto.isRunning();
    const sent = LamfiAuto.sessionCount();
    const signature = `${running}:${sent}:${hidden}`;
    if (!force && signature === lastReported) return;
    lastReported = signature;
    chrome.runtime
      .sendMessage({ type: "lamfi:state", running, sent, hidden })
      .catch(() => {
        /* service worker asleep; next tick retries */
      });
  }

  hideBtn.addEventListener("click", () => setHidden(true));
  runBtn.addEventListener("click", toggleRun);

  // The engine stops on its own (caps, no buttons left, LinkedIn cutting us
  // off), so poll rather than trusting the last command.
  setInterval(() => {
    const running = LamfiAuto.isRunning();
    runBtn.textContent = running ? "STOP" : "START";
    runBtn.classList.toggle("lamfi-running", running);
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
      setHidden(!hidden);
      sendResponse({ hidden });
      return true;
    }
  });

  report(true);
})();
