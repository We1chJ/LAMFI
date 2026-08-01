/**
 * Temporary test harness for LamfiCount. Delete once the real content script
 * is wired up.
 *
 * Deliberately does NOT touch LinkedIn's Connect buttons — the "+1" button
 * stands in for a successful click, so you can verify the counter without
 * sending anyone a real invitation.
 */
(async () => {
  // Built with createElement rather than innerHTML so this can't trip over
  // Trusted Types if LinkedIn ever enforces it.
  const el = (tag, props) => Object.assign(document.createElement(tag), props);

  const countEl = el("span", { id: "lamfi-count", textContent: "0" });
  const bumpBtn = el("button", { type: "button", textContent: "+1" });
  const resetBtn = el("button", { type: "button", textContent: "reset" });

  const hud = el("div", { className: "lamfi-hud" });
  hud.append(
    el("span", { className: "lamfi-label", textContent: "LINKED" }),
    countEl,
    bumpBtn,
    resetBtn,
  );
  document.body.append(hud);

  const loaded = await LamfiCount.init({ el: countEl });
  console.log("[LAMFI] loaded total from storage:", loaded);

  bumpBtn.addEventListener("click", () => {
    console.log("[LAMFI] new total:", LamfiCount.bump());
  });

  resetBtn.addEventListener("click", async () => {
    await chrome.storage.local.remove("lamfi:total");
    location.reload();
  });
})();
