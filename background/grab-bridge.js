/**
 * Realtime Beauty · Cache Bridge (MV3 Service Worker module, spec v4)
 * - Probes http://127.0.0.1:8765/health so content scripts know whether caching is possible
 * - Supplies authoritative top-level `sender.tab.url` -> `pageKey` to all frames (incl. cross-origin iframes)
 * - Relays cache deletion requests (SW has host_permissions, bypassing page CORS / PNA)
 *
 * v3 的整片下载（POST /api/grab、/api/keys 轮询、out.mp4 失效标记）已于 2026-11-24 移除。
 */
const RB_GRAB_LOCAL = "http://127.0.0.1:8765";
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

async function refreshServerState(force = false) {
  const now = Date.now();
  if (!force && now - rbGrabLastSync < 3000) {
    return { serverOnline: rbGrabServerOnline };
  }
  try {
    // /health 就是探针：200 说明服务在跑，缓存能力可用
    const res = await fetch(`${RB_GRAB_LOCAL}/health`, { cache: "no-store" });
    rbGrabServerOnline = res.ok;
  } catch (_) {
    rbGrabServerOnline = false;
  }
  rbGrabLastSync = Date.now();

  try {
    if (chrome.storage && chrome.storage.session) {
      await chrome.storage.session.set({ rbServerOnline: rbGrabServerOnline });
    }
  } catch (_) {}

  return { serverOnline: rbGrabServerOnline };
}

/**
 * 采集 cookie。v4 目前只靠 curl_cffi 的 TLS 指纹 + referer，还没有把 cookie 传给服务端；
 * 这里保留实现，遇到需要登录态的源时在 hls proxy 侧接上即可。
 */
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
    void refreshServerState(true);
  });
}
if (chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    void refreshServerState(true);
  });
}
void refreshServerState(true);
setInterval(() => {
  void refreshServerState(true);
}, 60_000);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  // 1) Frame initialization: return authoritative top-level pageUrl + pageKey + service liveness
  if (msg.type === "rb-grab-init") {
    const topUrl = (sender && sender.tab && sender.tab.url) || (msg.payload && msg.payload.pageUrl) || "";
    const pageKey = computeRbPageKey(topUrl);
    const stale = Date.now() - rbGrabLastSync > 15_000;
    const promise = stale
      ? refreshServerState(true)
      : Promise.resolve({ serverOnline: rbGrabServerOnline });

    promise
      .then(({ serverOnline }) => {
        sendResponse({
          ok: true,
          pageUrl: topUrl,
          pageKey,
          serverOnline,
          isFrame: Boolean(sender && sender.frameId),
        });
      })
      .catch(() => {
        sendResponse({
          ok: false,
          pageUrl: topUrl,
          pageKey,
          serverOnline: false,
        });
      });
    return true;
  }

  // 2) 用户在美颜面板里手动删缓存 -> DELETE /api/library[/{key}]
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
