/**
 * L.A.M.F.I. — the on-page HUD.
 *
 * Drag it anywhere; it snaps to the nearer vertical edge. The arrow collapses
 * it to a tab. Position persists.
 *
 * Two rows always: run controls and status. On a profile page a third row
 * offers Reach out / Save contact, and a preview panel opens for the message
 * before anything is sent.
 */
const LamfiHud = (() => {
  const POS_KEY = "hud";
  const MARGIN = 8;

  let hud, arrowBtn, runBtn, countEl, statusEl, moodEl, profileRow, preview;
  let side = "right";
  let y = 120;
  let collapsed = false;

  const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  /** A face for the status line, picked from what the line says. First match wins. */
  const MOODS = [
    [/limit/i, "🛑"],
    [/sent to|invite \+ note sent|message sent/i, "💌"],
    [/^sent \d+/i, "🎉"],
    [/asking ai/i, "✨"],
    [/reading|contact info/i, "🔍"],
    [/^saved/i, "📇"],
    [/next page/i, "📄"],
    [/looking for more/i, "👀"],
    [/resumed|back at the list|opening invite/i, "🏃"],
    [/started/i, "🚀"],
    [/stopped|cancelled/i, "✋"],
    [/not sent|couldn't|no |never|wouldn't|failed|declined|skipped|stayed/i, "😕"],
    [/sending/i, "📨"],
    [/^idle$/i, "😴"],
  ];
  const moodFor = (text) => MOODS.find(([re]) => re.test(text))?.[1] ?? "💬";

  function clampY(value) {
    const max = Math.max(MARGIN, window.innerHeight - (hud?.offsetHeight || 60) - MARGIN);
    return Math.min(Math.max(value, MARGIN), max);
  }

  function place() {
    hud.dataset.side = side;
    hud.classList.toggle("lamfi-collapsed", collapsed);
    arrowBtn.textContent = side === "right" ? (collapsed ? "‹" : "›") : collapsed ? "›" : "‹";
    y = clampY(y);
    hud.style.top = `${y}px`;
    // Anchor on `left` only — CSS can't transition to `auto`.
    hud.style.left = side === "right" ? `${window.innerWidth - hud.offsetWidth}px` : "0px";
  }

  const persist = () => chrome.storage.local.set({ [POS_KEY]: { side, y, collapsed } }).catch(() => {});

  function startDrag(event) {
    if (event.target.closest("button,textarea,input,a")) return;
    event.preventDefault();
    const rect = hud.getBoundingClientRect();
    const dx = event.clientX - rect.left;
    const dy = event.clientY - rect.top;
    hud.classList.add("lamfi-dragging");
    hud.style.left = `${rect.left}px`;
    hud.setPointerCapture(event.pointerId);

    const onMove = (e) => {
      hud.style.left = `${e.clientX - dx}px`;
      hud.style.top = `${e.clientY - dy}px`;
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
    async create({ onToggleRun, onReach, onCapture, onDashboard }) {
      const logo = el("img", {
        className: "lamfi-logo",
        src: chrome.runtime.getURL("icons/icon48.png"),
        alt: "",
        draggable: false,
      });
      countEl = el("span", { className: "lamfi-count", textContent: "0" });
      const counter = el("div", { className: "lamfi-counter-block" }, [
        countEl,
        el("span", { className: "lamfi-sub", textContent: "connected" }),
      ]);
      runBtn = el("button", { type: "button", className: "lamfi-primary", textContent: "🚀 Start" });
      const dashBtn = el("button", {
        type: "button",
        className: "lamfi-icon-btn",
        textContent: "📊",
        title: "Open dashboard",
      });
      arrowBtn = el("button", { type: "button", className: "lamfi-arrow" });

      moodEl = el("span", { className: "lamfi-mood", textContent: "😴" });
      statusEl = el("span", { textContent: "idle" });
      const statusRow = el("div", { className: "lamfi-status" }, [moodEl, statusEl]);

      const reachBtn = el("button", { type: "button", className: "lamfi-primary", textContent: "💌 Reach out" });
      const captureBtn = el("button", { type: "button", className: "lamfi-secondary", textContent: "📇 Save contact" });
      profileRow = el("div", { className: "lamfi-row lamfi-profile", hidden: true }, [reachBtn, captureBtn]);

      preview = el("div", { className: "lamfi-preview", hidden: true });

      hud = el("div", { className: "lamfi-hud" }, [
        arrowBtn,
        el("div", { className: "lamfi-body" }, [
          el("div", { className: "lamfi-row" }, [logo, counter, runBtn, dashBtn]),
          statusRow,
          profileRow,
          preview,
        ]),
      ]);
      document.body.append(hud);

      const saved = (await chrome.storage.local.get(POS_KEY))?.[POS_KEY];
      if (saved) {
        side = saved.side === "left" ? "left" : "right";
        y = Number(saved.y) || y;
        collapsed = Boolean(saved.collapsed);
      }
      place();

      arrowBtn.addEventListener("click", () => {
        collapsed = !collapsed;
        place();
        persist();
      });
      runBtn.addEventListener("click", () => onToggleRun?.());
      dashBtn.addEventListener("click", () => onDashboard?.());
      reachBtn.addEventListener("click", () => onReach?.());
      captureBtn.addEventListener("click", () => onCapture?.());
      hud.addEventListener("pointerdown", startDrag);
      window.addEventListener("resize", place);
    },

    setStatus(text) {
      statusEl.textContent = text;
      moodEl.textContent = moodFor(text);
    },

    setCount(n) {
      if (countEl.textContent === String(n)) return;
      countEl.textContent = String(n);
      // Restart the pop, otherwise a fast second send is swallowed by the first.
      countEl.classList.remove("lamfi-bump");
      void countEl.offsetWidth;
      countEl.classList.add("lamfi-bump");
    },

    setRunning(running) {
      runBtn.textContent = running ? "✋ Stop" : "🚀 Start";
      runBtn.classList.toggle("lamfi-running", running);
    },

    showProfileTools(show) {
      profileRow.hidden = !show;
      if (!show) preview.hidden = true;
      place();
    },

    /**
     * Show the drafted message for editing.
     * @returns {Promise<{action:"send"|"regen"|"cancel", text:string}>}
     */
    preview({ title, text, limit }) {
      preview.replaceChildren();
      preview.hidden = false;
      const box = el("textarea", { value: text, rows: limit ? 5 : 8 });
      const counter = el("span", { className: "lamfi-chars" });
      const update = () => {
        const n = box.value.length;
        counter.textContent = limit ? `${n}/${limit}` : `${n} chars`;
        counter.classList.toggle("lamfi-over", Boolean(limit) && n > limit);
      };
      box.addEventListener("input", update);
      update();

      return new Promise((resolve) => {
        const done = (action) => {
          preview.hidden = true;
          preview.replaceChildren();
          place();
          resolve({ action, text: box.value.trim() });
        };
        const send = el("button", { type: "button", className: "lamfi-primary", textContent: "Send ✈️" });
        const regen = el("button", { type: "button", className: "lamfi-secondary", textContent: "✨ New hook" });
        const cancel = el("button", { type: "button", className: "lamfi-text-btn", textContent: "Cancel" });
        send.addEventListener("click", () => done("send"));
        regen.addEventListener("click", () => done("regen"));
        cancel.addEventListener("click", () => done("cancel"));
        preview.append(
          el("div", { className: "lamfi-preview-title", textContent: title }),
          box,
          el("div", { className: "lamfi-row" }, [counter, cancel, regen, send]),
        );
        place();
        box.focus();
      });
    },
  };
})();
