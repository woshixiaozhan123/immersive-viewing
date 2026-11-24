/**
 * MV3 Event-Driven Service Worker (zero idle overhead)
 * - Loads cache-bridge.js (v2 preserved) and grab-bridge.js (v3 universal video grabber)
 * - Clicking the toolbar icon toggles the in-page Shadow DOM floating ball & beauty panel.
 */
importScripts("cache-bridge.js", "grab-bridge.js");

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
      // player-bar 必须排在最前：overlay 面板要读 window.RBPlayerBar 才能显示控制条开关
      files: ["content/player-bar.js", "content/engine.js", "content/overlay-ui.js"],
    });
    await chrome.tabs.sendMessage(tabId, { type: "WVB_OPEN_PANEL" });
  } catch (_) {
    // Restricted browser internal pages (chrome://, edge://, Chrome Web Store, etc.)
  }
});
