/**
 * Realtime Beauty · Universal Video Grab Relay (ISOLATED world, document_start, all_frames, spec v3)
 * Bridges MAIN-world content/grab-hook.js <-> background/grab-bridge.js across top page & nested iframes:
 *  - Fetches authoritative top-level pageKey & completed LOCAL_KEYS from SW on startup
 *  - Syncs updates to sessionStorage("rb_v3_state") and posts them into MAIN world
 *  - Relays detected media sources ("found") and playback fallback errors ("local-broken") to SW
 */
(() => {
  if (window.__RB_GRAB_RELAY__) return;
  window.__RB_GRAB_RELAY__ = true;

  // Skip v2 MSE sites (Bilibili / YouTube) on top frame
  try {
    const host = (window.location.hostname || "").toLowerCase();
    if (host.endsWith("bilibili.com") || host.endsWith("youtube.com")) return;
  } catch (_) {}

  const SESSION_KEY = "rb_v3_state";
  // 缓存开关：按域名记忆，{ "missav.ws": true, ... }。没有条目 = 不缓存。
  const CACHE_HOSTS_KEY = "rbCacheHosts";

  let lastPageKey = null;
  let lastPageUrl = null;
  let lastKeys = [];
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

  function pushStateToMain(pageKey, pageUrl, keys, serverOnline) {
    lastPageKey = pageKey || lastPageKey;
    lastPageUrl = pageUrl || lastPageUrl;
    if (Array.isArray(keys)) lastKeys = keys;
    if (typeof serverOnline === "boolean") lastOnline = serverOnline;

    const state = {
      pageKey: lastPageKey,
      pageUrl: lastPageUrl,
      keys: lastKeys,
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
            pushStateToMain(null, null, [], false);
            return;
          }
          pushStateToMain(res.pageKey || null, res.pageUrl || null, res.keys || [], Boolean(res.serverOnline));
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
          pushStateToMain(null, null, null, null);
          return;
        }
        if (area !== "session") return;
        const nextKeys = changes.rbKeys ? changes.rbKeys.newValue : lastKeys;
        const nextOnline = changes.rbServerOnline ? changes.rbServerOnline.newValue : lastOnline;
        if (changes.rbKeys || changes.rbServerOnline) {
          pushStateToMain(lastPageKey, lastPageUrl, nextKeys, nextOnline);
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

    if (data.__rbGrab === "found") {
      if (!canUseRuntime()) return;
      try {
        chrome.runtime.sendMessage(
          {
            type: "rb-grab",
            payload: {
              url: data.url,
              kind: data.kind || "auto",
              contentType: data.contentType || null,
              contentLength: data.contentLength || 0,
              pageUrl: lastPageUrl || data.pageUrl || window.location.href,
              frameUrl: data.frameUrl || window.location.href,
              referer: window.location.href,
              title: document.title || "",
              userAgent: navigator.userAgent || "",
            },
          },
          () => {
            void chrome.runtime.lastError;
          }
        );
      } catch (_) {}
      return;
    }

    if (data.__rbGrab === "local-broken") {
      if (!canUseRuntime()) return;
      try {
        chrome.runtime.sendMessage(
          {
            type: "rb-local-broken",
            payload: {
              pageKey: data.pageKey || lastPageKey,
              pageUrl: lastPageUrl || window.location.href,
              url: data.url || "",
            },
          },
          () => {
            void chrome.runtime.lastError;
          }
        );
      } catch (_) {}
    }
  });

  // 先读缓存开关，再拉 SW 状态：保证第一次同步就带正确的 cacheEnabled
  readCachePref(() => requestInitFromSw());
})();
