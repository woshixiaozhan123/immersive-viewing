/**
 * Realtime Beauty · Video Cache Bridge (MV3 Service Worker module, spec v2 · P2)
 * Stateless forwarder from content/cache-relay.js -> local cache-server (127.0.0.1:8765).
 * Handles:
 *  - "cache-miss"       -> POST /api/enqueue
 *  - "cache-cdn-log"    -> POST /api/debug/cdn-log
 *  - "cache-get-ranges" -> GET  /api/ranges
 */
const RB_CACHE_SERVER_BASE = "http://127.0.0.1:8765";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") {
    return;
  }

  if (msg.type === "cache-get-ranges") {
    fetch(`${RB_CACHE_SERVER_BASE}/api/ranges`, {
      method: "GET",
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) {
          sendResponse({ ok: false, status: res.status, ranges: {} });
          return;
        }
        const data = await res.json().catch(() => ({ ranges: {} }));
        sendResponse({ ok: true, offline: false, ranges: data.ranges || {}, ts: data.ts || null });
      })
      .catch((err) => {
        sendResponse({
          ok: false,
          offline: true,
          ranges: {},
          reason: err && err.message ? err.message : "offline",
        });
      });
    return true;
  }

  if (msg.type !== "cache-miss" && msg.type !== "cache-cdn-log") {
    return;
  }

  const endpoint =
    msg.type === "cache-miss"
      ? `${RB_CACHE_SERVER_BASE}/api/enqueue`
      : `${RB_CACHE_SERVER_BASE}/api/debug/cdn-log`;

  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg.payload || {}),
  })
    .then(async (res) => {
      if (!res.ok) {
        sendResponse({ accepted: false, status: res.status });
        return;
      }
      const data = await res.json().catch(() => ({ accepted: true }));
      sendResponse(data);
    })
    .catch((err) => {
      sendResponse({ accepted: false, offline: true, reason: err && err.message ? err.message : "offline" });
    });

  return true;
});
