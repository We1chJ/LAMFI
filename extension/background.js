/**
 * L.A.M.F.I. — background service worker.
 *
 * Owns the right-click menu. Context menus can only be created from a
 * background context, not a content script, which is why this file exists.
 *
 * Two items: a run toggle, and a show/hide toggle for the HUD. The second one
 * matters — hiding the panel removes the last on-page control, so this menu is
 * the only way to get it back.
 */

const MENU_RUN = "lamfi-toggle";
const MENU_HUD = "lamfi-hud";
const LINKEDIN = "https://www.linkedin.com/*";

const TITLE_IDLE = "Connect with everyone on this page";
const TITLE_RUNNING = "Stop connecting";
const TITLE_HIDE = "Collapse counter";
const TITLE_SHOW = "Expand counter";

function createMenus() {
  // removeAll first so a reload can't leave duplicates behind.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_RUN,
      title: TITLE_IDLE,
      contexts: ["page", "selection", "link"],
      documentUrlPatterns: [LINKEDIN],
    });
    chrome.contextMenus.create({
      id: MENU_HUD,
      title: TITLE_HIDE,
      contexts: ["page", "selection", "link"],
      documentUrlPatterns: [LINKEDIN],
    });
  });
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const type =
    info.menuItemId === MENU_RUN
      ? "lamfi:toggle"
      : info.menuItemId === MENU_HUD
        ? "lamfi:toggleHud"
        : null;
  if (!type) return;

  chrome.tabs.sendMessage(tab.id, { type }).catch(() => {
    // Content script absent — page never finished loading, or the tab predates
    // the last extension reload. A hard reload of the tab fixes it.
    console.warn("[LAMFI] no content script in tab", tab.id);
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "lamfi:state") return;

  chrome.contextMenus.update(MENU_RUN, {
    title: msg.running ? TITLE_RUNNING : TITLE_IDLE,
  });
  chrome.contextMenus.update(MENU_HUD, {
    title: msg.collapsed ? TITLE_SHOW : TITLE_HIDE,
  });

  // Badge is scoped to the reporting tab so two LinkedIn tabs don't fight.
  // It's the only progress signal left when the HUD is hidden.
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  chrome.action.setBadgeText({
    tabId,
    text: msg.running ? String(msg.sent ?? "") : "",
  });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#39ff14" });
});
