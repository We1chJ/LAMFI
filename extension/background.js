/**
 * L.A.M.F.I. — background service worker.
 *
 * Owns the right-click menu. Context menus can only be created from a
 * background context, not a content script, which is why this file exists.
 *
 * The menu item is a toggle: the content script reports its running state
 * back here, and the label and toolbar badge follow it. With no on-page UI,
 * the badge is the only way to tell whether a run is still going.
 */

const MENU_ID = "lamfi-toggle";
const LINKEDIN = "https://www.linkedin.com/*";

const TITLE_IDLE = "Connect with everyone on this page";
const TITLE_RUNNING = "Stop connecting";

function createMenu() {
  // removeAll first so a reload can't leave a duplicate entry behind.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: TITLE_IDLE,
      contexts: ["page", "selection", "link"],
      documentUrlPatterns: [LINKEDIN],
    });
  });
}

chrome.runtime.onInstalled.addListener(createMenu);
chrome.runtime.onStartup.addListener(createMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "lamfi:toggle" }).catch(() => {
    // Content script not present (page never finished loading, or the tab was
    // opened before the extension was reloaded).
    console.warn("[LAMFI] no content script in tab", tab.id);
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "lamfi:state") return;

  chrome.contextMenus.update(MENU_ID, {
    title: msg.running ? TITLE_RUNNING : TITLE_IDLE,
  });

  // Badge is scoped to the reporting tab so two LinkedIn tabs don't fight.
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  chrome.action.setBadgeText({
    tabId,
    text: msg.running ? String(msg.sent ?? "") : "",
  });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#39ff14" });
});
