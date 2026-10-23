/**
 * L.A.M.F.I. — dashboard.
 *
 * Reads the CRM straight from chrome.storage.local (and re-renders on every
 * change, so a run on another tab updates this live). Writes go through the
 * background worker like everything else.
 */
(() => {
  const $ = (sel) => document.querySelector(sel);

  async function send(msg) {
    const reply = await chrome.runtime.sendMessage(msg);
    if (!reply?.ok) throw new Error(reply?.error ?? "no reply");
    return reply.result;
  }

  let contacts = {};
  let events = [];
  let settings = {};
  const selected = new Set();
  const DAY = 86_400_000;

  const fmtDate = (ts) =>
    ts ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
  const lastActivity = (c) => Math.max(c.messagedAt ?? 0, c.invitedAt ?? 0, c.capturedAt ?? 0, c.updatedAt ?? 0);

  // ---------------------------------------------------------------- tiles

  function renderTiles() {
    const now = Date.now();
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    const weekAgo = now - 7 * DAY;
    const count = (kind, since = 0) => events.filter((e) => e.kind === kind && e.ts >= since).length;
    const list = Object.values(contacts);
    const tiles = [
      ["🤝", "Invites today", count("invite", startOfToday), true],
      ["📅", "Invites, 7 days", count("invite", weekAgo)],
      ["🏆", "Invites, all time", count("invite")],
      ["💌", "Messages sent", count("message")],
      ["📇", "Contacts", list.length],
      ["📧", "Emails found", list.filter((c) => c.email).length],
    ];
    $("#tiles").replaceChildren(
      ...tiles.map(([e, k, v, hero]) => {
        const t = document.createElement("div");
        t.className = hero ? "tile hero" : "tile";
        t.innerHTML = `<div class="e">${e}</div><div class="v">${v.toLocaleString()}</div><div class="k">${k}</div>`;
        return t;
      }),
    );
  }

  // ---------------------------------------------------------------- chart

  function renderChart() {
    const svg = $("#chart");
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const ts = Date.now() - i * DAY;
      days.push({ key: dayKey(ts), ts, invite: 0, message: 0 });
    }
    const byKey = Object.fromEntries(days.map((d) => [d.key, d]));
    for (const e of events) {
      const d = byKey[dayKey(e.ts)];
      if (d && d[e.kind] !== undefined) d[e.kind] += 1;
    }

    const W = svg.clientWidth || 800;
    const H = 220;
    const pad = { t: 10, r: 8, b: 24, l: 32 };
    const max = Math.max(1, ...days.map((d) => d.invite + d.message));
    const step = Math.max(1, Math.ceil(max / 4));
    const top = Math.ceil(max / step) * step;
    const x = (i) => pad.l + (i / days.length) * (W - pad.l - pad.r);
    const bw = (W - pad.l - pad.r) / days.length;
    const y = (v) => pad.t + (1 - v / top) * (H - pad.t - pad.b);

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    let out = "";
    for (let v = 0; v <= top; v += step) {
      out += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>`;
      out += `<text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    }
    days.forEach((d, i) => {
      const bx = x(i) + bw * 0.2;
      const w = Math.max(2, bw * 0.6);
      // Messages sit on top of invites; a 2px surface gap separates the segments.
      if (d.invite) out += `<rect class="inv" x="${bx}" y="${y(d.invite)}" width="${w}" height="${y(0) - y(d.invite)}" rx="2"/>`;
      if (d.message) {
        const y1 = y(d.invite + d.message);
        const h = y(d.invite) - y1 - (d.invite ? 2 : 0);
        out += `<rect class="msg" x="${bx}" y="${y1}" width="${w}" height="${Math.max(0, h)}" rx="2"/>`;
      }
      out += `<rect class="bar-hit" data-i="${i}" x="${x(i)}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}"/>`;
      if (i % 5 === 0) out += `<text class="axis" x="${x(i) + bw / 2}" y="${H - 6}" text-anchor="middle">${fmtDate(d.ts)}</text>`;
    });
    svg.innerHTML = out;

    const tip = $("#tooltip");
    svg.onmousemove = (e) => {
      const hit = e.target.closest(".bar-hit");
      if (!hit) return (tip.hidden = true);
      const d = days[Number(hit.dataset.i)];
      tip.textContent = `${fmtDate(d.ts)} · ${d.invite} invite${d.invite === 1 ? "" : "s"} · ${d.message} message${d.message === 1 ? "" : "s"}`;
      tip.hidden = false;
      tip.style.left = `${x(Number(hit.dataset.i)) + bw / 2}px`;
      tip.style.top = `${y(d.invite + d.message) - 4}px`;
    };
    svg.onmouseleave = () => (tip.hidden = true);

    $("#legend").innerHTML =
      `<span><i style="background:var(--series-1)"></i>Invites</span>` +
      `<span><i style="background:var(--series-2)"></i>Messages</span>`;
  }

  // ------------------------------------------------------------- contacts

  function visibleContacts() {
    const q = $("#search").value.trim().toLowerCase();
    const st = $("#status-filter").value;
    const unexported = $("#unexported").checked;
    return Object.values(contacts)
      .filter((c) => !st || c.status === st)
      .filter((c) => !unexported || !c.exportedAt)
      .filter(
        (c) =>
          !q ||
          [c.name, c.company, c.headline, c.email, c.location].some((v) => (v ?? "").toLowerCase().includes(q)),
      )
      .sort((a, b) => lastActivity(b) - lastActivity(a));
  }

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

  const PILLS = { captured: "📇 Saved", invited: "🤝 Invited", messaged: "💌 Messaged" };

  // Same person, same colour, every time.
  const AVATAR_COLORS = ["#0a66c2", "#057642", "#915907", "#8344cc", "#c37d16", "#b24020", "#0e7a8a"];
  function avatar(c) {
    const initials = ((c.first?.[0] ?? "") + (c.last?.[0] ?? "")).toUpperCase() || "?";
    let h = 0;
    for (const ch of c.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `<span class="avatar" style="background:${AVATAR_COLORS[h % AVATAR_COLORS.length]}">${esc(initials)}</span>`;
  }

  function renderContacts() {
    const rows = visibleContacts();
    $("#contact-count").textContent = `· ${rows.length} of ${Object.keys(contacts).length}`;
    $("#empty").hidden = Object.keys(contacts).length > 0;
    const tbody = $("#table tbody");
    tbody.innerHTML = rows
      .map(
        (c) => `
      <tr data-id="${esc(c.id)}" class="${selected.has(c.id) ? "selected" : ""}">
        <td class="sel"><input type="checkbox" ${selected.has(c.id) ? "checked" : ""}></td>
        <td class="name"><div class="who">${avatar(c)}<div><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name || c.id)}</a><small>${esc(c.location ?? "")}</small></div></div></td>
        <td>${esc(c.company ?? "")}</td>
        <td class="headline">${esc(c.headline ?? "")}</td>
        <td class="email">${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ""}</td>
        <td><span class="pill ${esc(c.status ?? "")}">${PILLS[c.status] ?? esc(c.status ?? "")}</span></td>
        <td>${fmtDate(lastActivity(c))}</td>
        <td class="muted">${c.exportedAt ? fmtDate(c.exportedAt) : "—"}</td>
      </tr>`,
      )
      .join("");
    renderSelection();
  }

  function renderSelection() {
    const n = selected.size;
    $("#selection").textContent = n ? `${n} selected` : "";
    $("#select-all").checked = n > 0 && visibleContacts().every((c) => selected.has(c.id));
  }

  /** Selected rows if any, else everything visible. */
  const targets = () => {
    const vis = visibleContacts();
    return selected.size ? vis.filter((c) => selected.has(c.id)) : vis;
  };

  const oneLine = (s) => String(s ?? "").replace(/\s*\n\s*/g, " / ").replace(/\|/g, "\\|").trim();

  function toMarkdown(list) {
    const head = ["Name", "Company", "Headline", "Email", "Location", "LinkedIn", "Status", "Last activity", "Message"];
    const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
    for (const c of list) {
      lines.push(
        `| ${[c.name, c.company, c.headline, c.email, c.location, c.url, c.status, new Date(lastActivity(c)).toISOString().slice(0, 10), c.message]
          .map(oneLine)
          .join(" | ")} |`,
      );
    }
    return lines.join("\n");
  }

  function toCsv(list) {
    const cols = ["name", "first", "last", "company", "headline", "email", "phone", "location", "url", "status", "invitedAt", "messagedAt", "message"];
    const cell = (v) => {
      if (typeof v === "number") return new Date(v).toISOString();
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.join(","), ...list.map((c) => cols.map((k) => cell(c[k])).join(","))].join("\n");
  }

  async function copy(text, label) {
    await navigator.clipboard.writeText(text);
    flash(`📋 ${label} copied — ${targets().length} contact${targets().length === 1 ? "" : "s"}`);
  }

  let flashTimer;
  function flash(text) {
    const el = $("#selection");
    el.textContent = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(renderSelection, 2500);
  }

  // ------------------------------------------------------------- settings

  function renderSettings() {
    const form = $("#settings-form");
    for (const [k, v] of Object.entries(settings)) {
      const field = form.elements[k];
      if (!field) continue;
      if (field.type === "checkbox") field.checked = Boolean(v);
      else field.value = v ?? "";
    }
  }

  // ----------------------------------------------------------------- wire

  async function load() {
    const got = await chrome.storage.local.get(["contacts", "events", "settings"]);
    contacts = got.contacts ?? {};
    events = got.events ?? [];
    settings = { ...(await send({ type: "settings:get" })) };
    for (const id of selected) if (!contacts[id]) selected.delete(id);
    renderTiles();
    renderChart();
    renderContacts();
  }

  document.addEventListener("DOMContentLoaded", async () => {
    await load();
    renderSettings();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.contacts || changes.events) load();
    });
    window.addEventListener("resize", renderChart);

    for (const id of ["search", "status-filter", "unexported"]) $(`#${id}`).addEventListener("input", renderContacts);

    $("#table").addEventListener("change", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (!tr) return;
      if (e.target.checked) selected.add(tr.dataset.id);
      else selected.delete(tr.dataset.id);
      tr.classList.toggle("selected", e.target.checked);
      renderSelection();
    });
    $("#select-all").addEventListener("change", (e) => {
      for (const c of visibleContacts()) e.target.checked ? selected.add(c.id) : selected.delete(c.id);
      renderContacts();
    });

    $("#copy-md").addEventListener("click", () => copy(toMarkdown(targets()), "Markdown"));
    $("#copy-csv").addEventListener("click", () => copy(toCsv(targets()), "CSV"));
    $("#copy-json").addEventListener("click", () => copy(JSON.stringify(targets(), null, 2), "JSON"));
    $("#mark-exported").addEventListener("click", async () => {
      const ids = targets().map((c) => c.id);
      await send({ type: "contacts:exported", ids });
      flash(`✅ ${ids.length} marked exported`);
    });
    $("#delete").addEventListener("click", async () => {
      const ids = targets().map((c) => c.id);
      if (!ids.length || !confirm(`Delete ${ids.length} contact${ids.length === 1 ? "" : "s"}? Events stay in the history.`)) return;
      await send({ type: "contacts:remove", ids });
      for (const id of ids) selected.delete(id);
    });

    $("#settings-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const patch = {};
      for (const el of form.elements) {
        if (!el.name) continue;
        patch[el.name] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
      }
      settings = await send({ type: "settings:set", patch });
      $("#saved").textContent = "✅ Saved";
      setTimeout(() => ($("#saved").textContent = ""), 2000);
    });
  });
})();
