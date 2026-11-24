/**
 * MV3 Event-Driven Service Worker (zero idle overhead)
 * Clicking the toolbar icon toggles the in-page Shadow DOM floating ball & beauty panel.
 */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  const tabId = tab.id;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "WVB_TOGGLE_PANEL" });
    if (res && res.ok) return;
  } catch (_) {
    // Content scripts not injected on this tab yet (e.g. tab opened prior to install/reload)
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/engine.js", "content/overlay-ui.js"],
    });
    await chrome.tabs.sendMessage(tabId, { type: "WVB_OPEN_PANEL" });
  } catch (_) {
    // Restricted browser internal pages (chrome://, edge://, ego://, Chrome Web Store, etc.)
  }
});
