/**
 * L.A.M.F.I. — background service worker.
 *
 * The single writer for the CRM. Content scripts and the dashboard send
 * messages here; nothing else touches chrome.storage.local, so two LinkedIn
 * tabs can never interleave a read-modify-write and lose a contact.
 *
 * Also: the OpenAI call (the key never leaves this worker), the toolbar
 * badge, the right-click menu, and opening the dashboard.
 */

const KEYS = { contacts: "contacts", events: "events", settings: "settings" };

const DEFAULT_SETTINGS = {
  apiKey: "",
  // Small and cheap is plenty for one or two sentences. Any chat model name
  // OpenAI accepts works here.
  model: "gpt-4o-mini",
  // What the AI is told about *you* — it writes {{hook}} to serve this.
  goal:
    "I'm building my network with people in my field. Friendly, direct, no flattery, no sales pitch.",
  // Sent with a connection request. LinkedIn caps notes at 300 characters.
  noteTemplate: "Hi {{first}} — {{hook}} Would be glad to connect.",
  // Sent as a direct message to someone already in your network.
  messageTemplate:
    "Hi {{first}},\n\n{{hook}}\n\nWould you be open to a quick chat sometime?\n\nBest,\n",
  // Send straight away instead of showing the preview in the HUD.
  autoSend: false,
  delayMinMs: 800,
  delayMaxMs: 2000,
};

const HOOK_SYSTEM = `You write the personalised middle of a short LinkedIn outreach message.
Reply with ONE or TWO sentences of plain text: no greeting, no sign-off, no quotes, no markdown, no emoji.
Reference something specific and real from their profile (their role, company, or a line from their About). Never invent facts.
Keep it under 200 characters so it fits inside a 300-character connection note.
Write in the sender's voice and serve the sender's stated goal.`;

// ---------------------------------------------------------------- storage

// Every write goes through this chain so they land in order.
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));

async function read(...keys) {
  const got = await chrome.storage.local.get(keys);
  return keys.length === 1 ? got[keys[0]] : got;
}

async function getSettings() {
  const settings = { ...DEFAULT_SETTINGS, ...((await read(KEYS.settings)) ?? {}) };
  // Saved from when the hook came from Anthropic: neither works with OpenAI.
  if (/^claude-/.test(settings.model)) settings.model = DEFAULT_SETTINGS.model;
  if (/^sk-ant-/.test(settings.apiKey)) settings.apiKey = "";
  return settings;
}

/** Drop undefined / empty fields so a thin patch can't blank a rich record. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

function upsertContact(patch) {
  return serial(async () => {
    if (!patch?.id) throw new Error("contact needs an id");
    const contacts = (await read(KEYS.contacts)) ?? {};
    const now = Date.now();
    const prev = contacts[patch.id] ?? { createdAt: now };
    contacts[patch.id] = { ...prev, ...compact(patch), updatedAt: now };
    await chrome.storage.local.set({ [KEYS.contacts]: contacts });
    return contacts[patch.id];
  });
}

function addEvent(kind, id) {
  return serial(async () => {
    const events = (await read(KEYS.events)) ?? [];
    events.push({ ts: Date.now(), kind, id });
    await chrome.storage.local.set({ [KEYS.events]: events });
  });
}

/** Status only ever moves forward: captured → invited → messaged. */
const RANK = { captured: 0, invited: 1, messaged: 2 };
const bump = (prev, next) => (RANK[next] >= (RANK[prev] ?? -1) ? next : prev);

async function recordEvent({ kind, contact }) {
  const stamp = { invite: "invitedAt", message: "messagedAt", capture: "capturedAt" }[kind];
  const status = { invite: "invited", message: "messaged", capture: "captured" }[kind];
  const prev = ((await read(KEYS.contacts)) ?? {})[contact.id];
  const stored = await upsertContact({
    ...contact,
    [stamp]: Date.now(),
    status: bump(prev?.status, status),
  });
  await addEvent(kind, contact.id);
  return stored;
}

function removeContacts(ids) {
  return serial(async () => {
    const contacts = (await read(KEYS.contacts)) ?? {};
    for (const id of ids) delete contacts[id];
    await chrome.storage.local.set({ [KEYS.contacts]: contacts });
  });
}

function markExported(ids) {
  return serial(async () => {
    const contacts = (await read(KEYS.contacts)) ?? {};
    const now = Date.now();
    for (const id of ids) if (contacts[id]) contacts[id].exportedAt = now;
    await chrome.storage.local.set({ [KEYS.contacts]: contacts });
  });
}

function saveSettings(patch) {
  return serial(async () => {
    const settings = { ...(await getSettings()), ...patch };
    await chrome.storage.local.set({ [KEYS.settings]: settings });
    return settings;
  });
}

// ---------------------------------------------------------------- OpenAI

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

async function craftHook(profile) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("no OpenAI API key — set one in the dashboard");

  const { email, phone, websites, ...visible } = profile;
  const body = {
    model: settings.model,
    // max_completion_tokens, not max_tokens: newer models reject the old name.
    // No temperature either, for the same reason; the default is fine here.
    max_completion_tokens: 300,
    messages: [
      { role: "system", content: HOOK_SYSTEM },
      {
        role: "user",
        content: `Sender's goal:\n${settings.goal}\n\nTheir profile:\n${JSON.stringify(visible, null, 2)}`,
      },
    ],
  };

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`OpenAI API ${res.status}: ${detail}`);
  }
  const msg = (await res.json()).choices?.[0]?.message;
  if (msg?.refusal) throw new Error("the model declined to write this one");
  const text = (msg?.content ?? "").trim();
  if (!text) throw new Error("the model returned no text");
  return text;
}

// ---------------------------------------------------------------- routing

const HANDLERS = {
  "settings:get": () => getSettings(),
  "settings:set": ({ patch }) => saveSettings(patch),
  "contact:upsert": ({ contact }) => upsertContact(contact),
  "contact:event": ({ kind, contact }) => recordEvent({ kind, contact }),
  "contacts:remove": ({ ids }) => removeContacts(ids),
  "contacts:exported": ({ ids }) => markExported(ids),
  "ai:hook": ({ profile }) => craftHook(profile),
  "dashboard:open": () => openDashboard(),
  state: (msg, sender) => setBadge(msg, sender),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: err?.message ?? String(err) }));
  return true; // async response
});

// ---------------------------------------------------------------- UI glue

const DASHBOARD = chrome.runtime.getURL("dashboard/index.html");

async function openDashboard() {
  const [existing] = await chrome.tabs.query({ url: DASHBOARD });
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: DASHBOARD });
  }
}

chrome.action.onClicked.addListener(() => openDashboard());

const MENU_RUN = "lamfi-run";
const MENU_DASH = "lamfi-dashboard";

function setBadge({ running, sent }, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  chrome.action.setBadgeText({ tabId, text: running ? String(sent ?? "") : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#39ff14" });
  chrome.contextMenus.update(MENU_RUN, {
    title: running ? "Stop connecting" : "Connect with everyone on this page",
  });
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_RUN,
      title: "Connect with everyone on this page",
      contexts: ["page", "selection", "link"],
      documentUrlPatterns: ["https://www.linkedin.com/*"],
    });
    chrome.contextMenus.create({
      id: MENU_DASH,
      title: "Open L.A.M.F.I. dashboard",
      contexts: ["page", "selection", "link"],
      documentUrlPatterns: ["https://www.linkedin.com/*"],
    });
  });
}
chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_DASH) return openDashboard();
  if (info.menuItemId === MENU_RUN && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "lamfi:toggle" }).catch(() => {
      console.warn("[LAMFI] no content script in tab — reload the page");
    });
  }
});
