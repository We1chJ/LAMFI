/**
 * QuickLinks — global hotkeys that drop a fixed link wherever you're typing.
 *
 * EDIT THESE. The keys must match the command names in manifest.json.
 */
const LINKS = {
  "insert-linkedin": "https://www.linkedin.com/in/erqi-jack-wei/",
  "insert-github": "https://github.com/We1chJ",
};

chrome.commands.onCommand.addListener(async (command) => {
  const url = LINKS[command];
  if (!url) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "quicklink:insert", url });
  } catch {
    // No content script here — chrome:// pages, the Web Store, PDF viewer and
    // other extensions' pages don't allow injection. Nothing we can do.
    console.warn("[QuickLinks] can't inject into this page");
  }
});
