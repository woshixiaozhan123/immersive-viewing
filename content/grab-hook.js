/**
 * Realtime Beauty · Transparent HLS Cache Hook (MAIN world, document_start, all_frames) — spec v4
 *
 * 核心：把播放器指向本地 m3u8 代理，之后每一片都先问本地服务。
 *   - hook `Hls.prototype.loadSource`（hls.js / flowplayer / 自研播放器都走这里）
 *   - 原生 `<video src="*.m3u8">` 也改写（Safari 类）
 *   - 本地服务不可用时**不改写**，播放器行为与未装扩展完全一致
 *
 * 只管分片级透明缓存。v3 的整片下载（out.mp4）已于 2026-11-24 移除。
 */
(() => {
  if (window.__RB_GRAB_HOOK__) return;
  window.__RB_GRAB_HOOK__ = true;

  // ---------------------------------------------------------------------
  // 全站可用，但**默认不缓存**：是否接管由用户的「本站缓存」开关决定
  // （rbCacheHosts，按域名记忆，见 grab-relay.js）。
  // 唯一硬排除：走 v2 MSE 方案的 B站 / YouTube，它们由 cache-hook.js 负责。
  // ---------------------------------------------------------------------
  try {
    const h = (window.location.hostname || "").toLowerCase();
    if (h.endsWith("bilibili.com") || h.endsWith("youtube.com")) return;
  } catch (_) {}

  const LOCAL_ORIGIN = "http://127.0.0.1:8765";
  const SESSION_KEY = "rb_cache_state";
  const M3U8_RE = /\.m3u8(\?|#|$)/i;

  let pageKey = null;
  let pageUrl = window.location.href;
  let serverOnline = false;
  // 缓存开关（按域名，用户自己开）。false 时完全不改写 m3u8 = 不落盘。
  let cacheEnabled = false;
  // 已经 patch 过的 hls.js 实例，用于「中途开关」时热切换
  const LIVE_PLAYERS = [];

  const STATS = { rewritten: 0, skippedOffline: 0, skippedNoCache: 0 };

  // =========================================================================
  // 状态同步（来自 ISOLATED world 的 grab-relay.js）
  // =========================================================================
  function applySyncState(state) {
    if (!state || typeof state !== "object") return;
    const wasReady = serverOnline && cacheEnabled;
    if (typeof state.pageKey === "string" && state.pageKey) pageKey = state.pageKey;
    if (typeof state.pageUrl === "string" && state.pageUrl) pageUrl = state.pageUrl;
    if (typeof state.serverOnline === "boolean") serverOnline = state.serverOnline;
    if (typeof state.cacheEnabled === "boolean") cacheEnabled = state.cacheEnabled;
    const isReady = serverOnline && cacheEnabled;
    // 用户中途打开开关或本地服务刚唤醒：把正在播的 hls.js 实例热切到本地代理，不用刷新页面
    if (!wasReady && isReady) reapplyLivePlayers();
  }

  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) applySyncState(JSON.parse(raw));
  } catch (_) {}

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data && typeof data === "object" && data.__rbGrabSync === true) applySyncState(data);
  });

  // =========================================================================
  // Key 计算 —— 必须与 cache-server/hls_proxy.py 的 safe_key_of 逐字符一致
  // =========================================================================
  function safeKeyOf(urlStr) {
    try {
      const u = new URL(urlStr);
      let path = u.pathname || "/";
      if (path !== "/" && path.endsWith("/")) path = path.slice(0, -1);
      const raw = (u.hostname.toLowerCase() + path).replace(/[^\w.\-/]/g, "_");
      return raw.replace(/[^\w.\-]/g, "_").replace(/^[._]+/, "").replace(/[._]+$/, "");
    } catch (_) {
      return "";
    }
  }

  function b64e(str) {
    try {
      const bytes = new TextEncoder().encode(String(str));
      let bin = "";
      for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } catch (_) {
      return "";
    }
  }

  function currentSafeKey() {
    return safeKeyOf(pageUrl || window.location.href);
  }

  // =========================================================================
  // 改写：媒体 URL -> 本地 m3u8 代理
  // =========================================================================
  function shouldInterceptM3u8Url(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return "";
    if (isLocal(rawUrl) || !M3U8_RE.test(rawUrl)) return "";
    try {
      const u = new URL(rawUrl, window.location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      const lower = (u.pathname || "").toLowerCase();
      if (/(?:subtitle|caption|webvtt|vtt|thumb|sprite)/.test(lower)) return "";
      return u.href;
    } catch (_) {
      return "";
    }
  }

  function toLocalPlaylist(mediaUrl) {
    if (!serverOnline) {
      STATS.skippedOffline += 1;
      return mediaUrl;
    }
    // 用户没为这个站点开启缓存 —— 原样返回，不产生任何落盘
    if (!cacheEnabled) {
      STATS.skippedNoCache += 1;
      return mediaUrl;
    }
    const sk = currentSafeKey();
    if (!sk) return mediaUrl;
    const src = b64e(mediaUrl);
    if (!src) return mediaUrl;
    const ref = b64e(window.location.href);
    STATS.rewritten += 1;
    try {
      window.postMessage({ __rbGrabStats: true, rewritten: STATS.rewritten }, "*");
    } catch (_) {}
    const local = `${LOCAL_ORIGIN}/hls/${encodeURIComponent(sk)}/master.m3u8?src=${src}&ref=${ref}`;
    try {
      console.log("[rb-hls][rewrite]", mediaUrl, "->", local);
    } catch (_) {}
    return local;
  }

  /** 开关从关到开时，把正在播的实例热切到本地代理（不刷新页面、不丢进度） */
  function reapplyLivePlayers() {
    for (const hls of LIVE_PLAYERS.slice()) {
      try {
        const orig = hls.__rbOrigSrc;
        if (!orig) continue;
        if (isLocal(String(hls.url || ""))) continue;
        const local = toLocalPlaylist(orig);
        if (!local || local === orig) continue;
        const media = hls.media || null;
        const pos = media ? media.currentTime : 0;
        const wasPlaying = media ? !media.paused : false;
        hls.loadSource(local);
        if (media) {
          if (pos > 0) {
            try {
              media.currentTime = pos;
            } catch (_) {}
          }
          if (wasPlaying) {
            try {
              media.play().catch(() => {});
            } catch (_) {}
          }
        }
        console.log("[rb-hls][hot-enable] ->", local);
      } catch (err) {
        console.warn("[rb-hls][hot-enable] failed", err);
      }
    }
  }

  function isLocal(u) {
    return typeof u === "string" && u.startsWith(LOCAL_ORIGIN);
  }

  // =========================================================================
  // Hook 1: hls.js（主入口）
  // =========================================================================
  function patchHlsProto(proto) {
    if (!proto || typeof proto.loadSource !== "function" || proto.__rbPatched) return;
    proto.__rbPatched = true;
    const origLoad = proto.loadSource;
    proto.loadSource = function (url) {
      const s = String(url || "");
      let next = url;
      try {
        if (s && M3U8_RE.test(s) && !isLocal(s)) {
          // 记住原始地址：即使此刻缓存是关的，用户中途打开也能热切过去
          this.__rbOrigSrc = s;
          next = toLocalPlaylist(s);
        }
      } catch (_) {}
      try {
        if (LIVE_PLAYERS.indexOf(this) < 0) LIVE_PLAYERS.push(this);
      } catch (_) {}
      return origLoad.call(this, next);
    };
  }

  let _HlsRef = null;
  try {
    Object.defineProperty(window, "Hls", {
      configurable: true,
      enumerable: true,
      get() {
        return _HlsRef;
      },
      set(v) {
        _HlsRef = v;
        try {
          patchHlsProto(v && v.prototype);
        } catch (_) {}
      },
    });
  } catch (_) {}

  // hls.js 若在本脚本之前已加载，补一次 patch
  if (window.Hls) {
    try {
      patchHlsProto(window.Hls.prototype);
    } catch (_) {}
  }

  // =========================================================================
  // Hook 2: 原生 <video src="*.m3u8">（兜底）
  // =========================================================================
  const videoSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
  if (videoSrcDesc && typeof videoSrcDesc.set === "function") {
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      configurable: true,
      enumerable: videoSrcDesc.enumerable,
      get: videoSrcDesc.get,
      set: function (val) {
        let next = val;
        try {
          const s = val === null || val === undefined ? "" : String(val);
          if (s && !isLocal(s) && M3U8_RE.test(s)) {
            next = toLocalPlaylist(s);
          }
        } catch (_) {}

        return videoSrcDesc.set.call(this, next);
      },
    });
  }

  // =========================================================================
  // Hook 3: XMLHttpRequest.open（拦截打包进闭包的 hls.js / 自研播放器）
  // =========================================================================
  const origXhrOpen = XMLHttpRequest.prototype.open;
  if (typeof origXhrOpen === "function") {
    XMLHttpRequest.prototype.open = function (method, url) {
      const args = Array.prototype.slice.call(arguments);
      try {
        if (
          cacheEnabled &&
          serverOnline &&
          String(method || "GET").toUpperCase() === "GET" &&
          typeof url === "string"
        ) {
          const abs = shouldInterceptM3u8Url(url);
          if (abs) {
            args[1] = toLocalPlaylist(abs);
          }
        }
      } catch (_) {}
      return origXhrOpen.apply(this, args);
    };
  }

  // =========================================================================
  // Hook 4: window.fetch（拦截基于 fetch 的现代 HLS 播放器）
  // =========================================================================
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      let nextInput = input;
      try {
        if (cacheEnabled && serverOnline) {
          const reqMethod = String(
            (init && init.method) || (input && typeof input === "object" && input.method) || "GET"
          ).toUpperCase();
          if (reqMethod === "GET") {
            if (typeof input === "string" || input instanceof URL) {
              const abs = shouldInterceptM3u8Url(String(input));
              if (abs) nextInput = toLocalPlaylist(abs);
            } else if (typeof Request !== "undefined" && input instanceof Request) {
              const abs = shouldInterceptM3u8Url(input.url);
              if (abs) {
                const rewritten = toLocalPlaylist(abs);
                if (rewritten && rewritten !== abs) {
                  nextInput = new Request(rewritten, input);
                }
              }
            }
          }
        }
      } catch (_) {
        nextInput = input;
      }
      return origFetch.call(this, nextInput, init);
    };
  }

  // =========================================================================
  // 本地播放失败兜底：退回原始地址
  // =========================================================================
  document.addEventListener(
    "error",
    (e) => {
      const t = e && e.target;
      if (!t || t.tagName !== "VIDEO") return;
      const cur = t.currentSrc || t.src || "";
      if (!isLocal(cur)) return;
      console.warn("[rb-hls][fallback] local playback failed, reverting:", cur);
      const orig = t.dataset && t.dataset.rbOrig;
      delete t.dataset.rbLocal;
      if (orig && videoSrcDesc && videoSrcDesc.set) {
        videoSrcDesc.set.call(t, orig);
        try {
          t.load();
          t.play().catch(() => {});
        } catch (_) {}
      }
    },
    true
  );

  // =========================================================================
  // 启动：向 relay 请求权威 pageKey / keys / serverOnline
  // =========================================================================
  try {
    window.postMessage({ __rbGrab: "request-sync" }, "*");
  } catch (_) {}

  window.__RB_HLS_DEBUG__ = {
    getPageKey: () => pageKey,
    getSafeKey: () => currentSafeKey(),
    isServerOnline: () => serverOnline,
    isCacheEnabled: () => cacheEnabled,
    getStats: () => ({ ...STATS }),
    toLocalPlaylist,
    setSyncState: applySyncState,
  };
})();
