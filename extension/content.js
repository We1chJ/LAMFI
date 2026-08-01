/**
 * L.A.M.F.I. — HUD and controls.
 *
 * Builds the on-page panel, wires it to LamfiCount (the counter) and
 * LamfiAuto (the click engine).
 */
(async () => {
  const el = (tag, props) => Object.assign(document.createElement(tag), props);

  const countEl = el("span", { id: "lamfi-count", textContent: "0" });
  const statusEl = el("span", { className: "lamfi-status", textContent: "idle" });
  const runBtn = el("button", { type: "button", textContent: "START" });
  const scanBtn = el("button", {
    type: "button",
    textContent: "scan",
    title: "Count the Connect buttons on this page without clicking any",
  });

  const hud = el("div", { className: "lamfi-hud" });
  const row = el("div", { className: "lamfi-row" });
  row.append(
    el("span", { className: "lamfi-label", textContent: "LINKED" }),
    countEl,
    runBtn,
    scanBtn,
  );
  hud.append(row, statusEl);
  document.body.append(hud);

  await LamfiCount.init({ el: countEl });
  const { week } = await LamfiAuto.stats();
  statusEl.textContent = `${week}/${LamfiAuto.CONFIG.weeklyCap} this week`;

  // Non-blocking: if sync isn't configured or the network is down, the local
  // counter carries on regardless.
  LamfiSync.init();

  const setStatus = (message) => {
    statusEl.textContent = message;
  };

  // The engine can stop on its own (caps, no buttons left, LinkedIn cutting us
  // off), so poll rather than assuming the button reflects reality.
  setInterval(() => {
    const on = LamfiAuto.isRunning();
    runBtn.textContent = on ? "STOP" : "START";
    runBtn.classList.toggle("lamfi-running", on);
  }, 300);

  runBtn.addEventListener("click", () => {
    if (LamfiAuto.isRunning()) {
      LamfiAuto.stop();
    } else {
      LamfiAuto.start(setStatus);
    }
  });

  scanBtn.addEventListener("click", () => {
    const { matched, usable } = LamfiAuto.scan();
    setStatus(`${usable} usable of ${matched} found`);
  });
})();
