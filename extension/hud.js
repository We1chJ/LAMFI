/**
 * L.A.M.F.I. — draggable, edge-snapping, collapsible HUD.
 *
 * Drag it anywhere; on release it snaps to whichever vertical edge is nearer
 * and keeps its height. Collapsing shrinks it to a thin tab flush against that
 * edge, with an arrow pointing the way it will expand.
 *
 * Position (side + y) and collapsed state persist in chrome.storage.local.
 */
const LamfiHud = (() => {
  const POS_KEY = "lamfi:hudPos";
  const MARGIN = 8;

  let hud, body, arrowBtn, runBtn, countEl, statusEl;
  let side = "right";
  let y = 120;
  let collapsed = false;
  let onCollapseChange = () => {};

  const el = (tag, props) => Object.assign(document.createElement(tag), props);

  function clampY(value) {
    const height = hud?.offsetHeight || 60;
    const max = Math.max(MARGIN, window.innerHeight - height - MARGIN);
    return Math.min(Math.max(value, MARGIN), max);
  }

  /** Arrow points toward the edge when open (to collapse), away when closed. */
  function arrowGlyph() {
    if (side === "right") return collapsed ? "‹" : "›";
    return collapsed ? "›" : "‹";
  }

  function place() {
    hud.dataset.side = side;
    hud.classList.toggle("lamfi-collapsed", collapsed);
    arrowBtn.textContent = arrowGlyph();
    arrowBtn.title = collapsed ? "Expand" : "Collapse to edge";

    y = clampY(y);
    hud.style.top = `${y}px`;
    // Position on `left` only, never `right`. CSS can't transition to `auto`,
    // so mixing the two anchors would make the snap jump instead of glide.
    // offsetWidth is read after the collapsed class is applied, so the docked
    // edge stays flush at either width.
    hud.style.left =
      side === "right" ? `${window.innerWidth - hud.offsetWidth}px` : "0px";
  }

  function persist() {
    chrome.storage.local
      .set({ [POS_KEY]: { side, y, collapsed } })
      .catch(() => {});
  }

  function setCollapsed(value) {
    collapsed = value;
    place();
    persist();
    onCollapseChange(collapsed);
  }

  /**
   * Free drag, then magnetic snap. During the drag we switch to explicit
   * left/top and kill the transition, otherwise every pointermove would
   * animate and the panel would lag the cursor.
   */
  function startDrag(event) {
    if (event.target.closest("button")) return;
    event.preventDefault();

    const rect = hud.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;

    hud.classList.add("lamfi-dragging");
    hud.style.left = `${rect.left}px`;
    hud.setPointerCapture(event.pointerId);

    const onMove = (e) => {
      hud.style.left = `${e.clientX - offsetX}px`;
      hud.style.top = `${e.clientY - offsetY}px`;
    };

    const onUp = (e) => {
      hud.releasePointerCapture(e.pointerId);
      hud.removeEventListener("pointermove", onMove);
      hud.removeEventListener("pointerup", onUp);
      hud.classList.remove("lamfi-dragging");

      const box = hud.getBoundingClientRect();
      side = box.left + box.width / 2 < window.innerWidth / 2 ? "left" : "right";
      y = box.top;
      place();
      persist();
    };

    hud.addEventListener("pointermove", onMove);
    hud.addEventListener("pointerup", onUp);
  }

  return {
    async create({ onToggleRun, onCollapse } = {}) {
      onCollapseChange = onCollapse ?? (() => {});

      countEl = el("span", { id: "lamfi-count", textContent: "0" });
      statusEl = el("span", { className: "lamfi-status", textContent: "idle" });
      runBtn = el("button", { type: "button", textContent: "START" });
      arrowBtn = el("button", { type: "button", className: "lamfi-arrow" });

      const row = el("div", { className: "lamfi-row" });
      row.append(
        el("span", { className: "lamfi-label", textContent: "LINKED" }),
        countEl,
        runBtn,
      );

      body = el("div", { className: "lamfi-body" });
      body.append(row, statusEl);

      hud = el("div", { className: "lamfi-hud" });
      hud.append(arrowBtn, body);
      document.body.append(hud);

      const saved = (await chrome.storage.local.get(POS_KEY))?.[POS_KEY];
      if (saved) {
        side = saved.side === "left" ? "left" : "right";
        y = Number(saved.y) || y;
        collapsed = Boolean(saved.collapsed);
      }
      place();

      arrowBtn.addEventListener("click", () => setCollapsed(!collapsed));
      runBtn.addEventListener("click", () => onToggleRun?.());
      hud.addEventListener("pointerdown", startDrag);
      // Re-clamp rather than letting the panel strand itself off-screen.
      window.addEventListener("resize", place);

      return { countEl };
    },

    setStatus(text) {
      if (statusEl) statusEl.textContent = text;
    },

    setRunning(running) {
      if (!runBtn) return;
      runBtn.textContent = running ? "STOP" : "START";
      runBtn.classList.toggle("lamfi-running", running);
    },

    toggleCollapsed() {
      setCollapsed(!collapsed);
    },

    isCollapsed() {
      return collapsed;
    },
  };
})();
