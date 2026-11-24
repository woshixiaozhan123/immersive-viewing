/**
 * Realtime Beauty · Transparent HLS Cache Hook (MAIN world, document_start, all_frames) — spec v4
 *
 * 核心：把播放器指向本地 m3u8 代理，之后每一片都先问本地服务。
 *   - hook `Hls.prototype.loadSource`（hls.js / flowplayer / 自研播放器都走这里）
 *   - 原生 `<video src="*.m3u8">` 也改写（Safari 类）
 *   - 本地服务不可用时**不改写**，播放器行为与未装扩展完全一致
 *
 * 保留 v3 能力：若该 pageKey 已有整片 out.mp4（v3 下载完成），直接把 <video> 指向本地 mp4。
 */
(() => {
  if (window.__RB_GRAB_HOOK__) return;
  window.__RB_GRAB_HOOK__ = true;

  // ---------------------------------------------------------------------
  // 域名白名单 —— 只接管目标站的 m3u8，绝不碰正规站
  // 注意：javrate 的播放器在 iframe 里（www.javrate.com），主站在 javrate.com，
  //       CDN 在 avking.xyz / surrit.com / 52cute.com，都要覆盖。
  // ---------------------------------------------------------------------
  const ALLOW_HOST = /(^|\.)(missav\.[a-z]+|javrate\.[a-z]+|avbebe\.[a-z]+|52cute\.com|avking\.xyz|surrit\.com)$/i;
  try {
    const h = (window.location.hostname || "").toLowerCase();
    if (!ALLOW_HOST.test(h)) return;
  } catch (_) {
    return;
  }

  const LOCAL_ORIGIN = "http://127.0.0.1:8765";
  const SESSION_KEY = "rb_v3_state";
  const M3U8_RE = /\.m3u8(\?|#|$)/i;

  let pageKey = null;
  let pageUrl = window.location.href;
  let LOCAL_KEYS = new Set();
  let serverOnline = false;

  const STATS = { rewritten: 0, v3Hit: 0, skippedOffline: 0 };

  // =========================================================================
  // 状态同步（来自 ISOLATED world 的 grab-relay.js）
  // =========================================================================
  function applySyncState(state) {
    if (!state || typeof state !== "object") return;
    if (typeof state.pageKey === "string" && state.pageKey) pageKey = state.pageKey;
    if (typeof state.pageUrl === "string" && state.pageUrl) pageUrl = state.pageUrl;
    if (Array.isArray(state.keys)) LOCAL_KEYS = new Set(state.keys);
    if (typeof state.serverOnline === "boolean") serverOnline = state.serverOnline;
    // 状态同步后如果已有主播放器，尝试升级到 v3 整片
    if (queryV3Local()) upgradeExistingMainVideo();
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
  function toLocalPlaylist(mediaUrl) {
    if (!serverOnline) {
      STATS.skippedOffline += 1;
      return mediaUrl;
    }
    const sk = currentSafeKey();
    if (!sk) return mediaUrl;
    const src = b64e(mediaUrl);
    if (!src) return mediaUrl;
    const ref = b64e(window.location.href);
    STATS.rewritten += 1;
    const local = `${LOCAL_ORIGIN}/hls/${encodeURIComponent(sk)}/master.m3u8?src=${src}&ref=${ref}`;
    try {
      console.log("[rb-hls][rewrite]", mediaUrl, "->", local);
    } catch (_) {}
    return local;
  }

  function isLocal(u) {
    return typeof u === "string" && u.startsWith(LOCAL_ORIGIN);
  }

  // =========================================================================
  // Hook 1: hls.js（主入口）
  // =========================================================================
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
          const proto = v && v.prototype;
          if (!proto || typeof proto.loadSource !== "function" || proto.__rbPatched) return;
          proto.__rbPatched = true;
          const origLoad = proto.loadSource;
          proto.loadSource = function (url) {
            let next = url;
            try {
              const s = String(url || "");
              if (s && !isLocal(s) && M3U8_RE.test(s)) next = toLocalPlaylist(s);
            } catch (_) {}
            return origLoad.call(this, next);
          };
        } catch (_) {}
      },
    });
  } catch (_) {}

  // hls.js 若在本脚本之前已加载，补一次 patch
  if (window.Hls) {
    try {
      const proto = window.Hls.prototype;
      if (proto && typeof proto.loadSource === "function" && !proto.__rbPatched) {
        proto.__rbPatched = true;
        const origLoad = proto.loadSource;
        proto.loadSource = function (url) {
          let next = url;
          try {
            const s = String(url || "");
            if (s && !isLocal(s) && M3U8_RE.test(s)) next = toLocalPlaylist(s);
          } catch (_) {}
          return origLoad.call(this, next);
        };
      }
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
          } else if (s && !isLocal(s) && /\.mp4(\?|#|$)/i.test(s) && serverOnline) {
            // 直接 mp4 直链暂不接管（v3 全量下载路径负责），保持原样
          }
        } catch (_) {}

        // v3 整片已完成时，直接把 src 顶到 out.mp4
        try {
          const localMp4 = queryV3Local();
          if (localMp4 && this.tagName === "VIDEO" && isMainPlayer(this)) {
            const s = String(next || "");
            if (s && !isLocal(s)) {
              this.dataset.rbOrig = s;
              STATS.v3Hit += 1;
              return videoSrcDesc.set.call(this, localMp4);
            }
          }
        } catch (_) {}

        return videoSrcDesc.set.call(this, next);
      },
    });
  }

  const origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (attrName, attrVal) {
    if (this.tagName === "VIDEO" && String(attrName || "").toLowerCase() === "src") {
      try {
        const localMp4 = queryV3Local();
        if (localMp4 && isMainPlayer(this)) {
          const s = attrVal === null || attrVal === undefined ? "" : String(attrVal);
          if (s && !isLocal(s)) {
            if (!this.dataset.rbOrig) this.dataset.rbOrig = s;
            STATS.v3Hit += 1;
            return origSetAttr.call(this, attrName, localMp4);
          }
        }
      } catch (_) {}
    }
    return origSetAttr.apply(this, arguments);
  };

  // =========================================================================
  // v3 整片命中
  // =========================================================================
  function queryV3Local() {
    if (!serverOnline || !pageKey) return null;
    if (!LOCAL_KEYS.has(pageKey)) return null;
    return `${LOCAL_ORIGIN}/local/${encodeURIComponent(pageKey)}/out.mp4`;
  }

  function isMainPlayer(el) {
    if (!el || el.tagName !== "VIDEO") return false;
    try {
      if (window !== window.top && (window.innerWidth <= 320 || window.innerHeight <= 180)) {
        return false;
      }
      const r = el.getBoundingClientRect();
      if (r.width > 320 && r.height > 180) return true;
      if (r.width > 0 || r.height > 0) {
        return Boolean(el.controls && r.width > 240 && r.height > 140);
      }
      if (el.controls) return true;
      const parent = el.parentElement;
      if (parent) {
        const pr = parent.getBoundingClientRect();
        if (pr.width > 320 && pr.height > 180) return true;
        if (pr.width > 0 || pr.height > 0) return false;
      }
      return !el.isConnected && window.innerWidth > 320 && window.innerHeight > 180;
    } catch (_) {
      return false;
    }
  }

  function upgradeExistingMainVideo() {
    const localMp4 = queryV3Local();
    if (!localMp4) return;
    try {
      document.querySelectorAll("video").forEach((v) => {
        if (!isMainPlayer(v)) return;
        const cur = v.currentSrc || v.src || "";
        if (cur.startsWith(LOCAL_ORIGIN)) return;
        if (!cur) return;
        const pos = v.currentTime || 0;
        const wasPlaying = !v.paused;
        if (!v.dataset.rbOrig) v.dataset.rbOrig = cur;
        STATS.v3Hit += 1;
        videoSrcDesc && videoSrcDesc.set && videoSrcDesc.set.call(v, localMp4);
        if (pos > 0) {
          try {
            v.currentTime = pos;
          } catch (_) {}
        }
        if (wasPlaying) {
          try {
            v.play().catch(() => {});
          } catch (_) {}
        }
      });
    } catch (_) {}
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
    getKeys: () => Array.from(LOCAL_KEYS),
    isServerOnline: () => serverOnline,
    getStats: () => ({ ...STATS }),
    toLocalPlaylist,
    setSyncState: applySyncState,
  };
})();
