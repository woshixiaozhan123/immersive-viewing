/**
 * Realtime Beauty · In-page Player Bar (原站页面内的增强播放器控制条)
 *
 * 目标：**不新开网页**，直接在目标站点自己的页面上，把原视频包一层我们自己的控制条。
 * 原站的播放/暂停/seek 逻辑不动（操作的还是同一个 <video>），只把简陋的控制条换成我们的。
 *
 * 作用域：missav / javrate / avbebe（与 grab-hook 白名单一致）。
 * 抖音 / B站 / YouTube 不接管 —— 它们自带播放器已经很完整，只保留美颜层。
 *
 * 同一份代码也供本地媒体库播放器页复用：window.RBPlayerBar.attach(video)。
 */
(() => {
  if (window.RBPlayerBar) return;

  const ALLOW_HOST = /(^|\.)(missav\.[a-z]+|javrate\.[a-z]+|avbebe\.[a-z]+|127\.0\.0\.1|localhost)$/i;

  const ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    pause:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    volOn:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12z"/></svg>',
    volOff:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm18.3 3 1.4-1.4-1.4-1.4-1.9 1.9-1.9-1.9-1.4 1.4 1.9 1.9-1.9 1.9 1.4 1.4 1.9-1.9 1.9 1.9 1.4-1.4-1.9-1.9z"/></svg>',
    full:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
    exitFull:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>',
  };

  const CSS = `
.rbp-root{position:absolute;left:0;right:0;bottom:0;z-index:2147483000;
  padding:16px 12px 7px;pointer-events:none;
  background:linear-gradient(0deg,rgba(0,0,0,.66),rgba(0,0,0,.22) 62%,transparent);
  opacity:1;transition:opacity .22s;font-family:"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.rbp-root[data-hidden="1"]{opacity:0}
.rbp-inner{display:flex;align-items:center;gap:10px;pointer-events:auto;
  color:#eceff5;font-size:12.5px;font-variant-numeric:tabular-nums;user-select:none}
.rbp-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;
  border:0;border-radius:8px;background:transparent;cursor:pointer;padding:0;flex:0 0 auto;
  transition:background .15s}
.rbp-btn:hover{background:rgba(255,255,255,.16)}
.rbp-btn svg{width:20px;height:20px;fill:#fff;display:block}
.rbp-time{flex:0 0 auto;min-width:44px;text-align:center;color:#d8deea;letter-spacing:.2px}
.rbp-seek{-webkit-appearance:none;appearance:none;flex:1 1 auto;height:4px;border-radius:99px;
  background:rgba(255,255,255,.26);outline:none;cursor:pointer;margin:0 2px;
  background-image:linear-gradient(#ff4d8d,#ff4d8d);background-repeat:no-repeat;
  background-size:0% 100%}
.rbp-seek::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;
  background:#fff;box-shadow:0 0 6px rgba(0,0,0,.5);cursor:pointer;
  transition:transform .12s}
.rbp-seek:hover::-webkit-slider-thumb{transform:scale(1.18)}
.rbp-seek::-moz-range-thumb{width:12px;height:12px;border:0;border-radius:50%;background:#fff}
.rbp-rate{flex:0 0 auto;background:transparent;border:1px solid rgba(255,255,255,.28);
  color:#eceff5;border-radius:7px;padding:4px 6px;font-size:12px;cursor:pointer;outline:none}
.rbp-rate:hover{background:rgba(255,255,255,.14)}
.rbp-rate option{background:#181c26;color:#eceff5}
.rbp-close{opacity:.62}
.rbp-close:hover{opacity:1}
@media (max-width:520px){
  .rbp-inner{gap:7px;font-size:11.5px}
  .rbp-btn{width:28px;height:28px}
  .rbp-btn svg{width:18px;height:18px}
  .rbp-time{min-width:38px}
}
`;

  function injectStyle() {
    if (document.getElementById("rbp-style")) return;
    const s = document.createElement("style");
    s.id = "rbp-style";
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  const mounted = new WeakMap();

  function fmtTime(sec) {
    const s = Number(sec);
    if (!Number.isFinite(s) || s < 0) return "0:00";
    const t = Math.floor(s);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const ss = t % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
      : `${m}:${String(ss).padStart(2, "0")}`;
  }

  /** 把原站自己的控制条藏起来，避免两层叠在一起。
   *  只动「明确是控制条」的元素，播放器外壳与点击层保留，免得破坏原站交互。 */
  const NATIVE_BARS = [
    ".plyr__controls",
    ".fp-controls",
    ".fp-timeline",
    ".flowplayer .fp-controls",
    ".xgplayer-controls",
    ".vjs-control-bar",
    ".dplayer-controller",
    ".jw-controls",
    ".art-controls",
    ".prism-controlbar",
    ".bpx-player-control-bottom",
    ".video-controls",
    "#player .control-bar",
  ];

  function hideNativeControls(scope) {
    const root = scope || document;
    for (const sel of NATIVE_BARS) {
      let nodes;
      try {
        nodes = root.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      nodes.forEach((n) => {
        if (!n || n.dataset.rbpHidden) return;
        n.dataset.rbpHidden = "1";
        n.style.setProperty("display", "none", "important");
      });
    }
  }

  function attach(video, opts) {
    if (!video || video.tagName !== "VIDEO") return null;
    if (mounted.has(video)) return mounted.get(video);
    injectStyle();

    const options = opts || {};
    const hideNative = options.hideNative !== false;

    // 需要一个定位容器：优先用「紧邻 video 的父元素」
    let container = video.parentElement;
    if (!container) return null;
    const cs = getComputedStyle(container);
    if (cs.position === "static") container.style.position = "relative";

    if (hideNative) hideNativeControls(container);

    const root = document.createElement("div");
    root.className = "rbp-root";
    root.setAttribute("data-hidden", "0");
    root.innerHTML = `
      <div class="rbp-inner">
        <button class="rbp-btn" data-act="toggle" title="播放/暂停 (空格)">${ICON.play}</button>
        <span class="rbp-time" data-role="cur">0:00</span>
        <input class="rbp-seek" type="range" min="0" max="1000" value="0" step="1" aria-label="进度">
        <span class="rbp-time" data-role="dur">0:00</span>
        <button class="rbp-btn" data-act="mute" title="静音 (M)">${ICON.volOn}</button>
        <select class="rbp-rate" title="播放速度">
          <option value="0.5">0.5x</option>
          <option value="0.75">0.75x</option>
          <option value="1" selected>1x</option>
          <option value="1.25">1.25x</option>
          <option value="1.5">1.5x</option>
          <option value="2">2x</option>
        </select>
        <button class="rbp-btn" data-act="full" title="全屏 (F)">${ICON.full}</button>
        ${
          options.closable
            ? '<button class="rbp-btn rbp-close" data-act="close" title="收起控制条">✕</button>'
            : ""
        }
      </div>`;
    container.appendChild(root);

    const btnToggle = root.querySelector('[data-act="toggle"]');
    const btnMute = root.querySelector('[data-act="mute"]');
    const btnFull = root.querySelector('[data-act="full"]');
    const seek = root.querySelector(".rbp-seek");
    const curEl = root.querySelector('[data-role="cur"]');
    const durEl = root.querySelector('[data-role="dur"]');
    const rateSel = root.querySelector(".rbp-rate");

    let hideTimer = null;
    let scrubbing = false;

    function poke() {
      root.setAttribute("data-hidden", "0");
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (video.paused) return;
        if (scrubbing) return;
        root.setAttribute("data-hidden", "1");
      }, 2600);
    }

    function syncPlayIcon() {
      btnToggle.innerHTML = video.paused ? ICON.play : ICON.pause;
    }
    function syncMuteIcon() {
      btnMute.innerHTML = video.muted || video.volume === 0 ? ICON.volOff : ICON.volOn;
    }
    function syncFullIcon() {
      btnFull.innerHTML = document.fullscreenElement ? ICON.exitFull : ICON.full;
    }
    function syncSeek() {
      const d = video.duration;
      if (scrubbing) return;
      if (Number.isFinite(d) && d > 0) {
        const p = (video.currentTime / d) * 1000;
        seek.value = String(Math.round(p));
        seek.style.backgroundSize = `${(p / 10).toFixed(2)}% 100%`;
      }
      curEl.textContent = fmtTime(video.currentTime);
      durEl.textContent = fmtTime(d);
    }

    // -- 事件 ---------------------------------------------------------------
    const bound = [];
    const on = (target, type, fn, o) => {
      target.addEventListener(type, fn, o);
      bound.push([target, type, fn, o]);
    };

    on(btnToggle, "click", () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
      poke();
    });

    on(btnMute, "click", () => {
      video.muted = !video.muted;
      if (!video.muted && video.volume === 0) video.volume = 1;
      syncMuteIcon();
    });

    on(btnFull, "click", () => {
      const stage = container;
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (stage.requestFullscreen) {
        // 注意：不能对 <video> 全屏，否则美颜 canvas 会被浏览器踢出（engine 会回退原生）
        stage.requestFullscreen().catch(() => {
          video.requestFullscreen && video.requestFullscreen().catch(() => {});
        });
      }
    });

    on(seek, "input", () => {
      scrubbing = true;
      const d = video.duration;
      if (Number.isFinite(d) && d > 0) {
        const p = Number(seek.value) / 1000;
        video.currentTime = p * d;
        seek.style.backgroundSize = `${(p * 100).toFixed(2)}% 100%`;
        curEl.textContent = fmtTime(video.currentTime);
      }
      poke();
    });
    on(seek, "change", () => {
      scrubbing = false;
    });

    on(rateSel, "change", () => {
      const r = Number(rateSel.value) || 1;
      video.playbackRate = r;
      if (typeof video.defaultPlaybackRate !== "undefined") video.defaultPlaybackRate = r;
    });

    on(video, "play", () => {
      syncPlayIcon();
      poke();
    });
    on(video, "pause", () => {
      syncPlayIcon();
      root.setAttribute("data-hidden", "0");
    });
    on(video, "timeupdate", syncSeek);
    on(video, "durationchange", syncSeek);
    on(video, "loadedmetadata", syncSeek);
    on(video, "volumechange", syncMuteIcon);
    on(video, "ended", () => {
      syncPlayIcon();
      root.setAttribute("data-hidden", "0");
    });

    on(document, "fullscreenchange", syncFullIcon);
    on(container, "mousemove", poke, { passive: true });
    on(container, "mouseleave", () => {
      if (!video.paused) root.setAttribute("data-hidden", "1");
    });

    if (options.closable) {
      on(root.querySelector('[data-act="close"]'), "click", () => detach(video));
    }

    syncPlayIcon();
    syncMuteIcon();
    syncSeek();
    poke();

    const api = {
      root,
      detach: () => detach(video),
      poke,
      unbind: () => {
        for (const [target, type, fn, o] of bound) {
          try {
            target.removeEventListener(type, fn, o);
          } catch (_) {}
        }
        bound.length = 0;
      },
    };
    mounted.set(video, api);
    return api;
  }

  function detach(video) {
    const api = mounted.get(video);
    if (!api) return;
    try {
      api.unbind();
    } catch (_) {}
    try {
      api.root.remove();
    } catch (_) {}
    mounted.delete(video);
  }

  // -- 自动挂载：找「面积最大的那个 video」当主播放器 --------------------
  function pickMainVideo() {
    let best = null;
    let bestArea = 0;
    document.querySelectorAll("video").forEach((v) => {
      let area = 0;
      try {
        const r = v.getBoundingClientRect();
        area = r.width * r.height;
      } catch (_) {}
      // 已经挂过的不重复处理
      if (mounted.has(v)) return;
      if (area > bestArea && area > 40000) {
        bestArea = area;
        best = v;
      }
    });
    return best;
  }

  function autoMount() {
    const v = pickMainVideo();
    if (v) attach(v, { hideNative: true });
  }

  window.RBPlayerBar = { attach, detach, autoMount, pickMainVideo };

  // 只在目标站点自动挂载（本地页由页面自己调 attach）
  try {
    if (!ALLOW_HOST.test(location.hostname)) return;
  } catch (_) {
    return;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoMount, { once: true });
  } else {
    autoMount();
  }

  // 换集 / 换视频 / 懒渲染播放器：持续观察
  let debounce = null;
  const mo = new MutationObserver(() => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(autoMount, 350);
  });
  try {
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
  } catch (_) {}

  // 原站播放器可能在我们挂载之后才重新渲染控制条，定期再压一次
  setInterval(() => {
    const v = pickMainVideo();
    if (v) attach(v, { hideNative: true });
    else if (document.querySelector("video")) hideNativeControls();
  }, 2500);
})();
