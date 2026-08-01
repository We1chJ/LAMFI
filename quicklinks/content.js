/**
 * QuickLinks — inserts the link at the cursor, or copies it if nothing is
 * focused.
 */

/** Fall back to a hidden textarea + execCommand: a hotkey isn't a user
 *  gesture in the page, so navigator.clipboard is often rejected here. */
function copyToClipboard(text) {
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  scratch.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.append(scratch);
  scratch.select();
  const ok = document.execCommand("copy");
  scratch.remove();
  return ok;
}

function insert(text) {
  const el = document.activeElement;

  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.setRangeText(text, start, end, "end");
    // React and friends track state off events, not the DOM value — without
    // this the framework overwrites what we just typed.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return "inserted";
  }

  if (el?.isContentEditable) {
    document.execCommand("insertText", false, text);
    return "inserted";
  }

  return copyToClipboard(text) ? "copied" : "failed";
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "quicklink:insert") return;
  const result = insert(msg.url);
  console.log(`[QuickLinks] ${result}: ${msg.url}`);
  sendResponse({ result });
  return true;
});
