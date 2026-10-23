/**
 * L.A.M.F.I. — wiring.
 *
 * Connects the HUD to the run engine, the profile flow, and the background
 * worker (which owns storage and the Claude call).
 */
(async () => {
  const D = LamfiDom;

  async function send(msg) {
    const reply = await chrome.runtime.sendMessage(msg);
    if (!reply?.ok) throw new Error(reply?.error ?? "no reply from background");
    return reply.result;
  }

  const status = (text) => LamfiHud.setStatus(text);

  // ------------------------------------------------------------- the run

  const runHandlers = {
    onStatus: status,
    onSend: (contact) => send({ type: "contact:event", kind: "invite", contact }),
  };

  function toggleRun() {
    if (LamfiRun.isRunning()) LamfiRun.stop();
    else LamfiRun.start(runHandlers);
  }

  // ------------------------------------------------------------ profiles

  const render = (template, fields) =>
    template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => fields[key] ?? "").replace(/[ \t]+\n/g, "\n");

  let busy = false;

  async function capture() {
    const profile = LamfiProfile.scrape();
    if (!profile.id || !profile.name) throw new Error("couldn't read this profile");
    status(`reading ${profile.first}'s contact info…`);
    Object.assign(profile, await LamfiProfile.contactInfo());
    await send({ type: "contact:event", kind: "capture", contact: profile });
    return profile;
  }

  async function captureOnly() {
    if (busy) return;
    busy = true;
    try {
      const p = await capture();
      status(`saved ${p.name}${p.email ? ` · ${p.email}` : ""}`);
    } catch (e) {
      status(e.message);
    } finally {
      busy = false;
    }
  }

  async function reachOut() {
    if (busy) return;
    busy = true;
    try {
      const profile = await capture();
      const rel = await LamfiProfile.relationship();
      if (rel === "pending") return status(`${profile.first}: invite already pending`);
      if (rel === "unknown") return status("no Connect or Message control found");

      const settings = await send({ type: "settings:get" });
      const isNote = rel === "connect";
      const template = isNote ? settings.noteTemplate : settings.messageTemplate;

      const hookFor = async () => {
        status("asking Claude for a hook…");
        try {
          return await send({ type: "ai:hook", profile });
        } catch (e) {
          status(`${e.message} — fill it in yourself`);
          return "";
        }
      };

      let hook = await hookFor();
      let text = render(template, { ...profile, hook });

      if (!settings.autoSend) {
        for (;;) {
          const r = await LamfiHud.preview({
            title: isNote ? `Connect + note → ${profile.name}` : `Message → ${profile.name}`,
            text,
            limit: isNote ? 300 : undefined,
          });
          if (r.action === "cancel") return status("cancelled");
          if (r.action === "send") {
            text = r.text;
            break;
          }
          hook = await hookFor();
          text = render(template, { ...profile, hook });
        }
      }
      if (!text) return status("empty message — nothing sent");

      status(isNote ? "sending invite with note…" : "sending message…");
      const result = isNote ? await LamfiProfile.sendNote(text) : await LamfiProfile.sendMessage(text);
      if (!result.ok) return status(`not sent: ${result.reason}`);

      await send({
        type: "contact:event",
        kind: isNote ? "invite" : "message",
        contact: { id: profile.id, message: text },
      });
      status(isNote ? `invite + note sent to ${profile.first}` : `message sent to ${profile.first}`);
    } catch (e) {
      status(e.message);
    } finally {
      busy = false;
    }
  }

  // ------------------------------------------------------------- boot

  await LamfiHud.create({
    onToggleRun: toggleRun,
    onReach: reachOut,
    onCapture: captureOnly,
    onDashboard: () => send({ type: "dashboard:open" }).catch(() => {}),
  });

  // A run that followed a Connect link reloads the page here — pick it up.
  LamfiRun.resumeIfNeeded(runHandlers);

  let lastSig = "";
  let lastPath = "";
  setInterval(() => {
    const running = LamfiRun.isRunning();
    const sent = LamfiRun.sessionCount();
    LamfiHud.setRunning(running);
    LamfiHud.setCount(sent);

    // LinkedIn navigates by pushState, so the page type can change under us.
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      LamfiHud.showProfileTools(LamfiProfile.isProfilePage());
    }

    const sig = `${running}:${sent}`;
    if (sig !== lastSig) {
      lastSig = sig;
      chrome.runtime.sendMessage({ type: "state", running, sent }).catch(() => {});
    }
  }, 400);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "lamfi:toggle") {
      toggleRun();
      sendResponse({ running: LamfiRun.isRunning() });
      return true;
    }
  });
})();
