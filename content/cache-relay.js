/**
 * Realtime Beauty · Video Cache Relay (ISOLATED world, document_start, spec v2 · P2)
 * Bridges MAIN-world window.postMessage events from content/cache-hook.js
 * to background/cache-bridge.js via chrome.runtime.sendMessage, and keeps
 * sessionStorage("rb_ranges") + MAIN-world RANGE_SNAP synchronized with 127.0.0.1:8765.
 */
(() => {
  if (window.__RB_CACHE_RELAY__) return;
  window.__RB_CACHE_RELAY__ = true;

  const SESSION_KEY = "rb_ranges";
  const SYNC_INTERVAL_MS = 3000;
  let redirectEnabled = true;
  let syncInFlight = false;
  let postMissTimer = null;

  function canUseRuntime() {
    return typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function";
  }

  function pushRangesToMain(ranges, offline) {
    if (!offline && ranges && typeof ranges === "object") {
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(ranges));
      } catch (_) {}
    }
    try {
      window.postMessage(
        {
          __rbCache: "ranges-sync",
          ranges: !offline && ranges ? ranges : null,
          offline: Boolean(offline),
          redirectEnabled,
        },
        "*"
      );
    } catch (_) {}
  }

  function syncRanges() {
    if (syncInFlight || !canUseRuntime()) return;
    syncInFlight = true;
    try {
      chrome.runtime.sendMessage({ type: "cache-get-ranges" }, (res) => {
        syncInFlight = false;
        if (chrome.runtime.lastError || !res) {
          pushRangesToMain(null, true);
          return;
        }
        if (res.ok && !res.offline) {
          pushRangesToMain(res.ranges || {}, false);
        } else {
          pushRangesToMain(null, Boolean(res.offline));
        }
      });
    } catch (_) {
      syncInFlight = false;
    }
  }

  function schedulePostMissSync() {
    if (postMissTimer) return;
    postMissTimer = window.setTimeout(() => {
      postMissTimer = null;
      syncRanges();
    }, 800);
  }

  // Optional user toggle stored in chrome.storage.local (default enabled)
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["rbCacheRedirectEnabled"], (items) => {
        void chrome.runtime.lastError;
        if (items && typeof items.rbCacheRedirectEnabled === "boolean") {
          redirectEnabled = items.rbCacheRedirectEnabled;
        }
        syncRanges();
      });
      if (chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === "local" && changes.rbCacheRedirectEnabled) {
            redirectEnabled = changes.rbCacheRedirectEnabled.newValue !== false;
            syncRanges();
          }
        });
      }
    } else {
      syncRanges();
    }
  } catch (_) {
    syncRanges();
  }

  // Periodic background range-table refresh while tab is visible
  window.setInterval(() => {
    if (document.visibilityState === "hidden") return;
    syncRanges();
  }, SYNC_INTERVAL_MS);

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.__rbCache === "request-ranges") {
      syncRanges();
      return;
    }

    if (data.__rbCache !== "miss" && data.__rbCache !== "cdn-log") return;

    const msgType = data.__rbCache === "miss" ? "cache-miss" : "cache-cdn-log";
    const payload =
      msgType === "cache-miss"
        ? {
            url: data.url,
            videoKey: data.videoKey,
            kind: data.kind || "video",
            rangeStart: Number.isFinite(data.rangeStart) ? data.rangeStart : 0,
            rangeEnd: Number.isFinite(data.rangeEnd) ? data.rangeEnd : null,
            contentType: data.contentType || null,
            bandwidth: data.bandwidth ?? null,
            codecid: data.codecid ?? null,
            duration: data.duration ?? null,
            transport: data.transport || "unknown",
            matchedRule: data.matchedRule || null,
            referer: window.location.href,
            pageUrl: window.location.href,
            title: document.title || "",
            userAgent: navigator.userAgent || "",
          }
        : {
            url: data.url,
            range: data.range || null,
            transport: data.transport || "unknown",
            reason: data.reason || "cdn_observed",
            referer: window.location.href,
          };

    try {
      if (canUseRuntime()) {
        chrome.runtime.sendMessage({ type: msgType, payload }, (resp) => {
          void chrome.runtime.lastError;
          if (msgType === "cache-miss" && resp && resp.accepted && !resp.skipped) {
            schedulePostMissSync();
          }
        });
      }
    } catch (_) {}
  });
})();
