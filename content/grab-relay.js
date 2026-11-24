/**
 * Realtime Beauty · Cache Relay (ISOLATED world, document_start, all_frames, spec v4)
 * Bridges MAIN-world content/grab-hook.js <-> background/grab-bridge.js across top page & nested iframes:
 *  - Fetches authoritative top-level pageKey + service liveness from SW on startup
 *  - Reads the per-domain 本站缓存 preference (chrome.storage.local is not reachable from MAIN world)
 *  - Syncs everything to sessionStorage and posts it into MAIN world
 *
 * v3 的 media-source 上报（"found"）与损坏回退（"local-broken"）已于 2026-11-24 移除。
 */
(() => {
  if (window.__RB_GRAB_RELAY__) return;
  window.__RB_GRAB_RELAY__ = true;

  // Skip v2 MSE sites (Bilibili / YouTube) on top frame
  try {
    const host = (window.location.hostname || "").toLowerCase();
    if (host.endsWith("bilibili.com") || host.endsWith("youtube.com")) return;
  } catch (_) {}

  const SESSION_KEY = "rb_cache_state";
  // 缓存开关：按域名记忆，{ "missav.ws": true, ... }。没有条目 = 不缓存。
  const CACHE_HOSTS_KEY = "rbCacheHosts";

  let lastPageKey = null;
  let lastPageUrl = null;
  let lastOnline = false;
  let lastCacheEnabled = false;

  function canUseRuntime() {
    return typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function";
  }

  function resolveCacheEnabled(hosts) {
    const map = hosts && typeof hosts === "object" ? hosts : {};
    const h = (window.location.hostname || "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(map, h)) return !!map[h];
    return false; // 默认不缓存，由用户自己开
  }

  function readCachePref(cb) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get({ [CACHE_HOSTS_KEY]: {} }, (res) => {
          if (chrome.runtime.lastError) {
            if (cb) cb();
            return;
          }
          const map = (res && res[CACHE_HOSTS_KEY]) || {};
          lastCacheEnabled = resolveCacheEnabled(map);
          if (cb) cb();
        });
        return;
      }
    } catch (_) {}
    if (cb) cb();
  }

  function pushStateToMain(pageKey, pageUrl, serverOnline) {
    lastPageKey = pageKey || lastPageKey;
    lastPageUrl = pageUrl || lastPageUrl;
    if (typeof serverOnline === "boolean") lastOnline = serverOnline;

    const state = {
      pageKey: lastPageKey,
      pageUrl: lastPageUrl,
      serverOnline: lastOnline,
      cacheEnabled: lastCacheEnabled,
    };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
    } catch (_) {}
    try {
      window.postMessage({ __rbGrabSync: true, ...state }, "*");
    } catch (_) {}
  }

  function requestInitFromSw() {
    if (!canUseRuntime()) return;
    try {
      chrome.runtime.sendMessage(
        {
          type: "rb-grab-init",
          payload: { pageUrl: window.location.href },
        },
        (res) => {
          if (chrome.runtime.lastError || !res) {
            pushStateToMain(null, null, false);
            return;
          }
          pushStateToMain(res.pageKey || null, res.pageUrl || null, Boolean(res.serverOnline));
        }
      );
    } catch (_) {}
  }

  // Subscribe to session storage key updates pushed by SW refreshRbGrabKeys()
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        // 面板里切换「本站缓存」后立刻同步给 MAIN，不用刷新页面
        if (area === "local" && changes[CACHE_HOSTS_KEY]) {
          lastCacheEnabled = resolveCacheEnabled(changes[CACHE_HOSTS_KEY].newValue);
          pushStateToMain(null, null, null);
          return;
        }
        if (area !== "session") return;
        if (changes.rbServerOnline) {
          pushStateToMain(lastPageKey, lastPageUrl, changes.rbServerOnline.newValue);
        }
      });
    }
  } catch (_) {}

  // Relay messages from MAIN world grab-hook.js
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.__rbGrab === "request-sync") {
      readCachePref(() => requestInitFromSw());
      return;
    }
  });

  // 先读缓存开关，再拉 SW 状态：保证第一次同步就带正确的 cacheEnabled
  readCachePref(() => requestInitFromSw());
})();
