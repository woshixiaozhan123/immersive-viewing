/**
 * chrome.* 垫片 —— 让扩展版的 engine.js / overlay-ui.js 在普通网页里原样跑。
 *
 * 播放器页的加载顺序必须是：
 *   shim.js  ->  engine.js  ->  overlay-ui.js
 *
 * 只有三处扩展 API 被用到（已核对源码）：
 *   engine.js:1627   chrome.runtime.getURL("worker/face-worker.js")
 *   engine.js:1628   chrome.runtime.getURL("vendor/mediapipe/")
 *   engine.js:2592   chrome.runtime.onMessage.addListener(...)
 *   overlay-ui.js    chrome.storage.local.get / set
 * 所以这里只实现 getURL / onMessage(空) / storage.local(localStorage 落地)。
 */
(() => {
  if (window.__RB_CHROME_SHIM__) return;
  window.__RB_CHROME_SHIM__ = true;

  const NS = "rbp:"; // localStorage 前缀，避免和其它页面数据打架

  function readOne(key, fallback) {
    let raw = null;
    try {
      raw = localStorage.getItem(NS + key);
    } catch (_) {
      return fallback;
    }
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function lsGet(defaults) {
    const src = defaults && typeof defaults === "object" ? defaults : {};
    const out = {};
    for (const k of Object.keys(src)) out[k] = readOne(k, src[k]);
    return out;
  }

  function lsSet(obj) {
    if (!obj || typeof obj !== "object") return;
    for (const k of Object.keys(obj)) {
      try {
        localStorage.setItem(NS + k, JSON.stringify(obj[k]));
      } catch (_) {}
    }
  }

  function lsRemove(keys) {
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : [];
    for (const k of list) {
      try {
        localStorage.removeItem(NS + k);
      } catch (_) {}
    }
  }

  const noop = () => {};
  const noopEvent = { addListener: noop, removeListener: noop, hasListener: () => false };

  const runtime = {
    id: "rb-local-player",
    // 必须返回「带 origin 的完整 URL」：engine.js 会把 face-worker.js 的源码包成 Blob
    // 再 new Worker(blobUrl, {type:"module"})，而 blob: 的 base 里没有 host，
    // 以 "/" 开头的相对路径在 worker 内 import() 会直接报 Failed to resolve module specifier。
    getURL: (p) => `${location.origin}/static/${String(p || "").replace(/^\/+/, "")}`,
    getManifest: () => ({ version: "local-player" }),
    onMessage: noopEvent,
    onConnect: noopEvent,
    onMessageExternal: noopEvent,
    sendMessage: (_msg, cb) => {
      if (typeof cb === "function") setTimeout(() => cb(undefined), 0);
    },
    connect: () => ({
      postMessage: noop,
      disconnect: noop,
      onMessage: noopEvent,
      onDisconnect: noopEvent,
    }),
    lastError: undefined,
  };

  const area = {
    get(keys, cb) {
      let defaults;
      if (typeof keys === "string") defaults = { [keys]: null };
      else if (Array.isArray(keys)) {
        defaults = {};
        for (const k of keys) defaults[k] = null;
      } else defaults = keys || {};
      const res = lsGet(defaults);
      if (typeof cb === "function") {
        setTimeout(() => cb(res), 0);
        return undefined;
      }
      return Promise.resolve(res);
    },
    set(obj, cb) {
      lsSet(obj);
      if (typeof cb === "function") setTimeout(cb, 0);
      return Promise.resolve();
    },
    remove(keys, cb) {
      lsRemove(keys);
      if (typeof cb === "function") setTimeout(cb, 0);
      return Promise.resolve();
    },
    clear(cb) {
      try {
        const drop = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (k && k.startsWith(NS)) drop.push(k);
        }
        drop.forEach((k) => localStorage.removeItem(k));
      } catch (_) {}
      if (typeof cb === "function") setTimeout(cb, 0);
      return Promise.resolve();
    },
  };

  const shim = { runtime, storage: { local: area, sync: area, session: area } };

  try {
    window.chrome = window.chrome || {};
  } catch (_) {
    /* window.chrome 理论上可写；真不可写时下面整体替换会失败，安静降级 */
  }

  try {
    window.chrome.runtime = runtime;
    window.chrome.storage = shim.storage;
  } catch (_) {
    try {
      window.chrome = Object.assign({}, window.chrome, shim);
    } catch (__) {}
  }

  // 兜底：若上面因属性只读没写进去，用 defineProperty 强写一次
  if (!window.chrome || !window.chrome.runtime || typeof window.chrome.runtime.getURL !== "function") {
    try {
      Object.defineProperty(window, "chrome", {
        value: Object.assign({}, window.chrome, shim),
        configurable: true,
        writable: true,
      });
    } catch (_) {}
  }
})();
