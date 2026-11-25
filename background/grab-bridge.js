/**
 * Realtime Beauty · Cache Bridge (MV3 Service Worker module, spec v4)
 * - Probes http://127.0.0.1:8765/health so content scripts know whether caching is possible
 * - Supplies authoritative top-level `sender.tab.url` -> `pageKey` to all frames (incl. cross-origin iframes)
 * - Relays cache deletion requests (SW has host_permissions, bypassing page CORS / PNA)
 *
 * v3 的整片下载（POST /api/grab、/api/keys 轮询、out.mp4 失效标记）已于 2026-11-24 移除。
 */
const RB_GRAB_LOCAL = "http://127.0.0.1:8765";
const RB_NATIVE_HOST = "com.realtime_beauty.cache_host";
let rbGrabServerOnline = false;
let rbGrabLastSync = 0;
let rbStartPromise = null;
let rbNativeBackoffUntil = 0;

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

async function ensureServerRunning(reason = "demand") {
  const probe = await refreshServerState(!rbGrabServerOnline);
  if (probe.serverOnline) {
    return { ok: true, serverOnline: true, alreadyRunning: true, started: false };
  }
  if (Date.now() < rbNativeBackoffUntil) {
    return { ok: false, serverOnline: false, reason: "native_backoff" };
  }
  if (rbStartPromise) {
    return rbStartPromise;
  }
  if (!chrome.runtime || typeof chrome.runtime.sendNativeMessage !== "function") {
    rbNativeBackoffUntil = Date.now() + 30_000;
    return { ok: false, serverOnline: false, reason: "native_unsupported" };
  }

  rbStartPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      rbStartPromise = null;
      resolve(res);
    };
    const timer = setTimeout(() => {
      rbNativeBackoffUntil = Date.now() + 15_000;
      finish({ ok: false, serverOnline: false, reason: "native_timeout" });
    }, 30_000);

    try {
      chrome.runtime.sendNativeMessage(
        RB_NATIVE_HOST,
        { action: "ensure_running", reason },
        async (res) => {
          clearTimeout(timer);
          const err = chrome.runtime.lastError;
          if (err || !res || !res.ok) {
            rbNativeBackoffUntil = Date.now() + 15_000;
            finish({
              ok: false,
              serverOnline: false,
              reason: (err && err.message) || (res && res.error) || "native_failed",
            });
            return;
          }
          rbNativeBackoffUntil = 0;
          const refreshed = await refreshServerState(true);
          finish({
            ok: refreshed.serverOnline,
            serverOnline: refreshed.serverOnline,
            alreadyRunning: Boolean(res.alreadyRunning),
            started: Boolean(res.started),
          });
        }
      );
    } catch (err) {
      clearTimeout(timer);
      rbNativeBackoffUntil = Date.now() + 15_000;
      finish({
        ok: false,
        serverOnline: false,
        reason: err && err.message ? err.message : "native_exception",
      });
    }
  });

  return rbStartPromise;
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

  if (msg.type === "rb-ensure-server") {
    const reason = (msg.payload && msg.payload.reason) || "panel";
    ensureServerRunning(reason)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, serverOnline: false }));
    return true;
  }

  if (msg.type === "rb-subs-context" || msg.type === "rb-subs-focus") {
    const topUrl = sender?.tab?.url || "";
    const pageKey = computeRbPageKey(topUrl);
    if (!pageKey) {
      sendResponse({ state: "uncached" });
      return;
    }
    if (msg.type === "rb-subs-context") {
      sendResponse({ host: new URL(topUrl).hostname.toLowerCase() });
      return;
    }
    const key = pageKey.replace(/[^\w.\-]/g, "_").replace(/^[._]+|[._]+$/g, "");
    const payload = msg.payload || {};
    const clientSession = String(payload.session || "");
    if (!/^[\w-]{1,60}$/.test(clientSession)) {
      sendResponse({ key, state: "error" });
      return;
    }
    const body = { ...payload, session: sender.tab.id + "-" + sender.frameId + "-" + clientSession };
    const focusUrl = RB_GRAB_LOCAL + "/api/subs/" + encodeURIComponent(key) + "/focus";
    const postFocus = () =>
      fetch(focusUrl, {
        method: "POST", cache: "no-store", signal: AbortSignal.timeout(4000),
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }).then(async (response) => {
        rbGrabServerOnline = true;
        return response.ok ? response.json()
          : { key, state: response.status === 404 ? "uncached" : "offline" };
      });

    postFocus()
      .catch(async () => {
        if (payload.active === false) {
          return { key, state: "offline" };
        }
        const ensured = await ensureServerRunning("subtitles");
        if (!ensured.serverOnline) {
          return { key, state: "offline" };
        }
        return postFocus().catch(() => ({ key, state: "offline" }));
      })
      .then(sendResponse, () => sendResponse({ key, state: "offline" }));
    return true;
  }

  // 1) Frame initialization: return authoritative top-level pageUrl + pageKey + service liveness
  if (msg.type === "rb-grab-init") {
    const topUrl = (sender && sender.tab && sender.tab.url) || (msg.payload && msg.payload.pageUrl) || "";
    const pageKey = computeRbPageKey(topUrl);
    const wantCache = Boolean(msg.payload && msg.payload.cacheEnabled === true);
    const stale = Date.now() - rbGrabLastSync > 15_000;
    const promise = stale
      ? refreshServerState(true)
      : Promise.resolve({ serverOnline: rbGrabServerOnline });

    promise
      .then(async ({ serverOnline }) => {
        let online = serverOnline;
        if (!online && wantCache) {
          const ensured = await ensureServerRunning("cache-init");
          online = Boolean(ensured && ensured.serverOnline);
        }
        sendResponse({
          ok: true,
          pageUrl: topUrl,
          pageKey,
          serverOnline: online,
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

    const runDelete = () =>
      fetch(url, { method: "DELETE", cache: "no-store" }).then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          return { ok: false, status: r.status, ...data };
        }
        rbGrabServerOnline = true;
        return { ok: true, scope, ...data };
      });

    runDelete()
      .catch(async (err) => {
        const ensured = await ensureServerRunning("cache-delete");
        if (ensured && ensured.serverOnline) {
          return runDelete();
        }
        throw err;
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
