/**
 * Realtime Beauty · Universal Video Grab Bridge (MV3 Service Worker module, spec v3)
 * - Periodically syncs complete cached pageKeys from GET http://127.0.0.1:8765/api/keys
 * - Supplies authoritative top-level `sender.tab.url` -> `pageKey` to all frames (including cross-origin iframes)
 * - Harvests media/page cookies via chrome.cookies.getAll() and forwards POST /api/grab to local cache-server
 * - Handles corrupted local playback unmarking via POST /api/video/{key}/unmark
 */
const RB_GRAB_LOCAL = "http://127.0.0.1:8765";
let rbGrabKeys = [];
let rbGrabServerOnline = false;
let rbGrabLastSync = 0;

function computeRbPageKey(pageUrl) {
  if (!pageUrl || typeof pageUrl !== "string") return null;
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    let path = u.pathname || "/";
    if (path !== "/" && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    return (u.hostname.toLowerCase() + path).replace(/[^\w.\-/]/g, "_");
  } catch (_) {
    return null;
  }
}

async function refreshRbGrabKeys(force = false) {
  const now = Date.now();
  if (!force && now - rbGrabLastSync < 3000) {
    return { keys: rbGrabKeys, serverOnline: rbGrabServerOnline };
  }
  try {
    const res = await fetch(`${RB_GRAB_LOCAL}/api/keys`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    rbGrabKeys = Array.isArray(data.keys) ? data.keys : [];
    rbGrabServerOnline = true;
    rbGrabLastSync = Date.now();
  } catch (_) {
    rbGrabKeys = [];
    rbGrabServerOnline = false;
    rbGrabLastSync = Date.now();
  }

  try {
    if (chrome.storage && chrome.storage.session) {
      await chrome.storage.session.set({
        rbKeys: rbGrabKeys,
        rbServerOnline: rbGrabServerOnline,
      });
    }
  } catch (_) {}

  return { keys: rbGrabKeys, serverOnline: rbGrabServerOnline };
}

async function collectCookieHeader(mediaUrl, pageUrl, frameUrl) {
  if (!chrome.cookies || typeof chrome.cookies.getAll !== "function") {
    return "";
  }
  const cookieMap = new Map();
  const urls = [mediaUrl, frameUrl, pageUrl].filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));
  for (const u of urls) {
    try {
      const list = await chrome.cookies.getAll({ url: u });
      for (const c of list || []) {
        if (c && c.name && !cookieMap.has(c.name)) {
          cookieMap.set(c.name, c.value || "");
        }
      }
    } catch (_) {}
  }
  if (cookieMap.size === 0) return "";
  return Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

if (chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    void refreshRbGrabKeys(true);
  });
}
if (chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    void refreshRbGrabKeys(true);
  });
}
void refreshRbGrabKeys(true);
setInterval(() => {
  void refreshRbGrabKeys(true);
}, 60_000);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  // 1) Frame initialization: return authoritative top-level pageUrl, pageKey, and current complete keys
  if (msg.type === "rb-grab-init") {
    const topUrl = (sender && sender.tab && sender.tab.url) || (msg.payload && msg.payload.pageUrl) || "";
    const pageKey = computeRbPageKey(topUrl);
    const stale = Date.now() - rbGrabLastSync > 15_000;
    const promise = stale
      ? refreshRbGrabKeys(true)
      : Promise.resolve({ keys: rbGrabKeys, serverOnline: rbGrabServerOnline });

    promise
      .then(({ keys, serverOnline }) => {
        sendResponse({
          ok: true,
          pageUrl: topUrl,
          pageKey,
          keys,
          serverOnline,
          isFrame: Boolean(sender && sender.frameId),
        });
      })
      .catch(() => {
        sendResponse({
          ok: false,
          pageUrl: topUrl,
          pageKey,
          keys: [],
          serverOnline: false,
        });
      });
    return true;
  }

  // 2) Media source found in top page or nested cross-origin iframe -> forward POST /api/grab
  if (msg.type === "rb-grab") {
    const p = msg.payload || {};
    const topUrl = (sender && sender.tab && sender.tab.url) || p.pageUrl || "";
    const isIframe = Boolean(sender && sender.frameId);
    const frameUrl = isIframe ? (sender.url || p.frameUrl || null) : null;
    const title = (sender && sender.tab && sender.tab.title) || p.title || "";

    (async () => {
      const cookie = await collectCookieHeader(p.url, topUrl, frameUrl);
      const body = {
        url: p.url,
        kind: p.kind || "auto",
        contentType: p.contentType || null,
        contentLength: Number.isFinite(p.contentLength) && p.contentLength > 0 ? p.contentLength : null,
        pageUrl: topUrl,
        frameUrl,
        referer: frameUrl || topUrl || p.referer || "",
        cookie: cookie || null,
        userAgent: p.userAgent || navigator.userAgent || "",
        title,
      };
      const res = await fetch(`${RB_GRAB_LOCAL}/api/grab`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        return { accepted: false, status: res.status };
      }
      const data = await res.json().catch(() => ({ accepted: true }));
      rbGrabServerOnline = true;
      // Schedule a key sync shortly after a grab completes or starts
      setTimeout(() => void refreshRbGrabKeys(true), 5000);
      return data;
    })()
      .then(sendResponse)
      .catch((err) => {
        rbGrabServerOnline = false;
        sendResponse({
          accepted: false,
          offline: true,
          reason: err && err.message ? err.message : "offline",
        });
      });
    return true;
  }

  // 3) Local file playback error fallback -> unmark on server & remove from session keys (spec 6.3)
  if (msg.type === "rb-local-broken") {
    const p = msg.payload || {};
    const topUrl = (sender && sender.tab && sender.tab.url) || p.pageUrl || "";
    const pageKey = p.pageKey || computeRbPageKey(topUrl);

    if (pageKey) {
      rbGrabKeys = rbGrabKeys.filter((k) => k !== pageKey);
      if (chrome.storage && chrome.storage.session) {
        chrome.storage.session.set({ rbKeys: rbGrabKeys }).catch(() => {});
      }
      fetch(`${RB_GRAB_LOCAL}/api/video/${encodeURIComponent(pageKey)}/unmark`, {
        method: "POST",
      })
        .then((r) => r.json().catch(() => ({ unmarked: true })))
        .then(sendResponse)
        .catch(() => sendResponse({ unmarked: false, offline: true }));
      return true;
    }
    sendResponse({ unmarked: false, reason: "missing_key" });
    return false;
  }

  // 4) 用户在美颜面板里手动删缓存 -> DELETE /api/library[/{key}]
  //    走后台是因为 SW 有 host_permissions，不受页面 CORS / PNA 限制。
  if (msg.type === "rb-cache-delete") {
    const p = msg.payload || {};
    const scope = p.scope === "site" ? "site" : "video";
    const url =
      scope === "site"
        ? `${RB_GRAB_LOCAL}/api/library?host=${encodeURIComponent(p.host || "")}`
        : `${RB_GRAB_LOCAL}/api/library/${encodeURIComponent(p.key || "")}`;

    fetch(url, { method: "DELETE", cache: "no-store" })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          return { ok: false, status: r.status, ...data };
        }
        rbGrabServerOnline = true;
        // 缓存条目变了，尽快刷新 pageKey 列表，避免继续命中已删条目
        setTimeout(() => void refreshRbGrabKeys(true), 300);
        return { ok: true, scope, ...data };
      })
      .then(sendResponse)
      .catch((err) => {
        rbGrabServerOnline = false;
        sendResponse({
          ok: false,
          offline: true,
          reason: err && err.message ? err.message : "offline",
        });
      });
    return true;
  }
});
