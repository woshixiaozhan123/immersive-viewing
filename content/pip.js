/**
 * 沉浸式观影 · 独立置顶美颜小窗 (Picture-in-Picture)
 *
 * 1. 首选 Document Picture-in-Picture API：
 *    不搬动原网页 <video> DOM，在独立置顶小窗内实时镜像 WebGL 美颜画布（或原画 <video>），
 *    渲染中文字幕/双语字幕与悬浮控制条（播放/进度/静音/倍速/一键开关美颜与字幕/回原页）。
 * 2. 自动降级（无 Document PiP，例如纯 HTTP 页）：
 *    离屏 2D 合成画布（美颜画面 + 烧录字幕）-> captureStream() -> 隐藏代理 <video>.requestPictureInPicture()。
 *    若跨域画布受限（SecurityError），再优雅退回原生 video.requestPictureInPicture()（由字幕模块 VTTCue 兜底）。
 */
(() => {
  if (window.RBPip) return;

  const ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    volOn:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12z"/></svg>',
    volOff:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm18.3 3 1.4-1.4-1.4-1.4-1.9 1.9-1.9-1.9-1.4 1.4 1.9 1.9-1.9 1.9 1.4 1.4 1.9-1.9 1.9 1.9 1.4-1.4-1.9-1.9z"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 7v4H5.83l3.58-3.59L8 6l-6 6 6 6 1.41-1.41L5.83 13H21V7z"/></svg>',
  };

  const DOC_PIP_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#07080d;
  font-family:"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;user-select:none}
.rb-pip-stage{position:relative;width:100%;height:100%;background:#07080d;overflow:hidden}
.rb-pip-canvas{display:block;width:100%;height:100%;object-fit:contain;cursor:pointer}
.rb-pip-subs{position:fixed;left:0;right:0;bottom:var(--rb-pip-sub-bottom,24px);padding:0 12px;
  pointer-events:none;z-index:10;transition:bottom .16s ease}
.rb-pip-sub-wrap{text-align:center;color:#fff;font:600 var(--rb-pip-sub-font,17px)/1.4 "Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  overflow-wrap:anywhere;text-shadow:0 2px 5px #000}
.rb-pip-sub-line{margin:2px auto;display:table;max-width:92%;padding:.08em .42em;
  background:rgba(16,17,23,.86);border-radius:.25em}
.rb-pip-sub-src{font-size:.77em;font-weight:500}
.rb-pip-sub-state{font-size:.72em;font-weight:500;color:#cbd5e1}
[hidden]{display:none!important}
.rb-pip-top{position:fixed;top:0;left:0;right:0;z-index:20;display:flex;align-items:center;
  justify-content:space-between;gap:8px;padding:8px 10px 18px;pointer-events:none;
  background:linear-gradient(180deg,rgba(0,0,0,.72),rgba(0,0,0,.22) 64%,transparent);
  opacity:0;transition:opacity .2s}
.rb-pip-stage:not([data-hidden="1"]) .rb-pip-top,
.rb-pip-stage:hover .rb-pip-top{opacity:1}
.rb-pip-pill{pointer-events:none;font-size:11px;line-height:1;color:#cbd5e1;
  background:rgba(15,23,42,.72);border:1px solid rgba(148,163,184,.28);
  padding:5px 8px;border-radius:999px;backdrop-filter:blur(6px)}
.rb-pip-pill[data-on="1"]{color:#fda4af;border-color:rgba(255,77,141,.55);background:rgba(255,77,141,.16)}
.rb-pip-actions{display:flex;align-items:center;gap:6px;pointer-events:auto}
.rb-pip-chip{display:inline-flex;align-items:center;gap:4px;height:25px;padding:0 9px;
  border-radius:999px;border:1px solid rgba(255,255,255,.22);background:rgba(15,23,42,.78);
  color:#e2e8f0;font-size:11px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.rb-pip-chip:hover{background:rgba(30,41,59,.92);border-color:rgba(255,255,255,.4)}
.rb-pip-chip[data-active="1"]{background:rgba(255,77,141,.24);border-color:#ff4d8d;color:#fff}
.rb-pip-chip svg{width:13px;height:13px;fill:currentColor;display:block}
.rb-pip-bar{position:fixed;left:0;right:0;bottom:0;z-index:20;padding:18px 10px 8px;
  pointer-events:none;background:linear-gradient(0deg,rgba(0,0,0,.78),rgba(0,0,0,.26) 64%,transparent);
  opacity:1;transition:opacity .2s}
.rb-pip-stage[data-hidden="1"] .rb-pip-bar{opacity:0}
.rb-pip-inner{display:flex;align-items:center;gap:7px;pointer-events:auto;color:#eceff5;
  font-size:11.5px;font-variant-numeric:tabular-nums}
.rb-pip-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
  border:0;border-radius:7px;background:transparent;cursor:pointer;padding:0;flex:0 0 auto;
  transition:background .15s}
.rb-pip-btn:hover{background:rgba(255,255,255,.16)}
.rb-pip-btn svg{width:18px;height:18px;fill:#fff;display:block}
.rb-pip-time{flex:0 0 auto;min-width:34px;text-align:center;color:#d8deea}
.rb-pip-seek{-webkit-appearance:none;appearance:none;flex:1 1 auto;min-width:0;height:4px;
  border-radius:99px;background:rgba(255,255,255,.28);outline:none;cursor:pointer;margin:0 2px;
  background-image:linear-gradient(#ff4d8d,#ff4d8d);background-repeat:no-repeat;background-size:0% 100%}
.rb-pip-seek::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;border-radius:50%;
  background:#fff;box-shadow:0 0 5px rgba(0,0,0,.55);cursor:pointer}
.rb-pip-rate{flex:0 0 auto;background:rgba(15,23,42,.7);border:1px solid rgba(255,255,255,.26);
  color:#eceff5;border-radius:6px;padding:3px 5px;font-size:11px;cursor:pointer;outline:none}
.rb-pip-rate option{background:#181c26;color:#eceff5}
`;

  const listeners = new Set();
  const state = {
    mode: "off", // "off" | "document" | "composite" | "native"
    video: null,
    pipWindow: null,
    cleanup: null,
  };

  function notify() {
    for (const fn of listeners) {
      try {
        fn(getStatusSnapshot());
      } catch (_) {}
    }
  }

  function getStatusSnapshot() {
    return {
      open: isOpen(),
      mode: state.mode,
      video: state.video,
    };
  }

  function isOpen() {
    if (state.mode === "document") {
      return !!(state.pipWindow && !state.pipWindow.closed);
    }
    if (state.mode === "composite" || state.mode === "native") {
      return !!document.pictureInPictureElement;
    }
    return false;
  }

  function getMode() {
    return isOpen() ? state.mode : "off";
  }

  function isDocumentPipSupported() {
    return !!(
      typeof window.documentPictureInPicture !== "undefined" &&
      typeof window.documentPictureInPicture.requestWindow === "function"
    );
  }

  function isSupported() {
    return isDocumentPipSupported() || !!document.pictureInPictureEnabled;
  }

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

  function resolveVideo(explicitVideo) {
    if (explicitVideo && explicitVideo.tagName === "VIDEO" && explicitVideo.isConnected) {
      return explicitVideo;
    }
    const eng = window.__WVB_ENGINE__;
    if (eng?.video && eng.video.isConnected) return eng.video;
    const barPick = window.RBPlayerBar?.pickMainVideo?.(true);
    if (barPick && barPick.isConnected) return barPick;
    let best = null;
    let bestScore = -1;
    document.querySelectorAll("video").forEach((v) => {
      try {
        const r = v.getBoundingClientRect();
        const area = r.width * r.height;
        const score = (v.paused ? 0 : 1e8) + area + (v.readyState >= 2 ? 5000 : 0);
        if (score > bestScore && (area > 4000 || v.videoWidth > 0)) {
          bestScore = score;
          best = v;
        }
      } catch (_) {}
    });
    return best;
  }

  function calcPipSize(video) {
    const vw = video?.videoWidth || 16;
    const vh = video?.videoHeight || 9;
    const ratio = vw > 0 && vh > 0 ? vw / vh : 16 / 9;
    if (ratio >= 1) {
      const width = 560;
      const height = Math.round(Math.max(240, Math.min(420, width / ratio)));
      return { width, height };
    }
    const height = 560;
    const width = Math.round(Math.max(260, Math.min(420, height * ratio)));
    return { width, height };
  }

  function paintMediaTo2D(ctx, canvas, src, maxLongEdge = 1280) {
    if (!ctx || !canvas || !src) return false;
    const rawW = src.tagName === "VIDEO" ? src.videoWidth : src.width;
    const rawH = src.tagName === "VIDEO" ? src.videoHeight : src.height;
    if (!rawW || !rawH) return false;
    let dw = rawW;
    let dh = rawH;
    if (src.tagName === "VIDEO" && (rawW > maxLongEdge || rawH > maxLongEdge)) {
      const scale = Math.min(maxLongEdge / rawW, maxLongEdge / rawH);
      dw = Math.max(2, Math.round(rawW * scale));
      dh = Math.max(2, Math.round(rawH * scale));
    }
    if (canvas.width !== dw || canvas.height !== dh) {
      canvas.width = dw;
      canvas.height = dh;
    }
    ctx.drawImage(src, 0, 0, dw, dh);
    return true;
  }

  function isEngineBeautyReady(engine, video) {
    return !!(
      engine &&
      engine.enabled &&
      engine.captureStatus === "ready" &&
      !engine.contextLost &&
      engine.video === video &&
      engine.canvas &&
      engine.canvas.width > 0 &&
      engine.canvas.height > 0
    );
  }

  function ensureBeautyEnabledOnVideo(engine, video) {
    if (!engine) return;
    if (engine.video !== video && typeof engine.getVideoId === "function" && typeof engine.selectVideoByUser === "function") {
      try {
        engine.selectVideoByUser(engine.getVideoId(video));
      } catch (_) {}
    }
    engine.setEnabled(!engine.enabled);
  }

  function close() {
    const fn = state.cleanup;
    state.cleanup = null;
    if (typeof fn === "function") {
      try {
        fn();
      } catch (_) {}
    } else if (document.pictureInPictureElement) {
      try {
        void document.exitPictureInPicture();
      } catch (_) {}
    }
    state.mode = "off";
    state.video = null;
    state.pipWindow = null;
    notify();
  }

  // =========================================================================
  // 方案 A（首选）：Document Picture-in-Picture
  // =========================================================================
  function mountDocumentPip(pipWin, video) {
    const pipDoc = pipWin.document;
    pipDoc.title = "沉浸式观影 · 美颜小窗";
    const styleEl = pipDoc.createElement("style");
    styleEl.textContent = DOC_PIP_CSS;
    pipDoc.head.appendChild(styleEl);

    const stage = pipDoc.createElement("div");
    stage.className = "rb-pip-stage";
    stage.setAttribute("data-hidden", "0");
    stage.innerHTML = `
      <canvas class="rb-pip-canvas"></canvas>
      <div class="rb-pip-subs" hidden>
        <div class="rb-pip-sub-wrap">
          <div class="rb-pip-sub-line rb-pip-sub-src" hidden></div>
          <div class="rb-pip-sub-line rb-pip-sub-zh" hidden></div>
          <div class="rb-pip-sub-line rb-pip-sub-state" hidden></div>
        </div>
      </div>
      <div class="rb-pip-top">
        <span class="rb-pip-pill" data-role="beauty-pill">原画</span>
        <div class="rb-pip-actions">
          <button class="rb-pip-chip" data-act="beauty" type="button" title="开关实时美颜 (B)">美颜</button>
          <button class="rb-pip-chip" data-act="sub" type="button" title="切换本地字幕">译:关</button>
          <button class="rb-pip-chip" data-act="back" type="button" title="返回原网页">${ICON.back}<span>回原页</span></button>
        </div>
      </div>
      <div class="rb-pip-bar">
        <div class="rb-pip-inner">
          <button class="rb-pip-btn" data-act="toggle" type="button" title="播放/暂停 (空格)">${ICON.play}</button>
          <span class="rb-pip-time" data-role="cur">0:00</span>
          <input class="rb-pip-seek" type="range" min="0" max="1000" value="0" step="1" aria-label="进度">
          <span class="rb-pip-time" data-role="dur">0:00</span>
          <button class="rb-pip-btn" data-act="mute" type="button" title="静音 (M)">${ICON.volOn}</button>
          <select class="rb-pip-rate" title="播放速度">
            <option value="0.75">0.75x</option>
            <option value="1" selected>1x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
          </select>
        </div>
      </div>
    `;
    pipDoc.body.appendChild(stage);

    const pipCanvas = stage.querySelector(".rb-pip-canvas");
    const pipCtx = pipCanvas.getContext("2d", { alpha: false });
    const subsBox = stage.querySelector(".rb-pip-subs");
    const subSrcEl = stage.querySelector(".rb-pip-sub-src");
    const subZhEl = stage.querySelector(".rb-pip-sub-zh");
    const subStateEl = stage.querySelector(".rb-pip-sub-state");
    const beautyPill = stage.querySelector('[data-role="beauty-pill"]');
    const btnBeauty = stage.querySelector('[data-act="beauty"]');
    const btnSub = stage.querySelector('[data-act="sub"]');
    const btnBack = stage.querySelector('[data-act="back"]');
    const btnToggle = stage.querySelector('[data-act="toggle"]');
    const btnMute = stage.querySelector('[data-act="mute"]');
    const seek = stage.querySelector(".rb-pip-seek");
    const curEl = stage.querySelector('[data-role="cur"]');
    const durEl = stage.querySelector('[data-role="dur"]');
    const rateSel = stage.querySelector(".rb-pip-rate");

    let cleaned = false;
    let hideTimer = null;
    let scrubbing = false;
    let rafHandle = null;
    let lastBeautyPushMs = 0;
    let lastPaintedOnce = false;
    let lastSubPayload = { text: "", src: "", hint: "", style: { fontScale: 1, offsetPct: 0 }, mode: "off", active: false };
    const bound = [];

    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      bound.push([target, type, fn, opts]);
    };

    function syncSubsLayout() {
      const h = pipWin.innerHeight || 300;
      const st = lastSubPayload.style || window.RBSubtitles?.style?.() || { fontScale: 1, offsetPct: 0 };
      const barVisible = stage.getAttribute("data-hidden") !== "1";
      const baseInset = Math.max(16, Math.round(h * 0.07));
      const minClearBar = barVisible ? 46 : 0;
      const extraLift = Math.round(h * ((st.offsetPct || 0) / 100));
      subsBox.style.setProperty("--rb-pip-sub-bottom", `${Math.max(baseInset, minClearBar) + extraLift}px`);
      const fontPx = Math.round(Math.max(13, Math.min(28, h * 0.056)) * (st.fontScale || 1));
      subsBox.style.setProperty("--rb-pip-sub-font", `${fontPx}px`);
    }

    function setSubLine(el, val) {
      if (el.textContent !== val) el.textContent = val;
      el.hidden = !val;
    }

    function renderPipSubs(payload) {
      if (cleaned) return;
      lastSubPayload = payload || lastSubPayload;
      const text = payload?.text || "";
      const src = payload?.src || "";
      const hint = payload?.hint || "";
      if (!payload?.active || (!text && !hint)) {
        subsBox.hidden = true;
        return;
      }
      syncSubsLayout();
      setSubLine(subSrcEl, src);
      setSubLine(subZhEl, text);
      setSubLine(subStateEl, hint);
      subsBox.hidden = false;
    }

    function syncTopControls() {
      const eng = window.__WVB_ENGINE__;
      const beautyOn = !!(eng && eng.enabled);
      const beautyReady = isEngineBeautyReady(eng, video);
      btnBeauty.setAttribute("data-active", beautyOn ? "1" : "0");
      beautyPill.setAttribute("data-on", beautyReady && !eng?.compareOriginal ? "1" : "0");
      if (!beautyOn) beautyPill.textContent = "原画";
      else if (eng?.compareOriginal) beautyPill.textContent = "原画对比";
      else if (beautyReady) beautyPill.textContent = "美颜中";
      else beautyPill.textContent = "美颜准备中";

      const subs = window.RBSubtitles;
      const subMode = subs?.mode?.() || "off";
      const subMap = { off: "译:关", zh: "译:中", both: "译:双" };
      btnSub.textContent = subMap[subMode] || "译:关";
      btnSub.setAttribute("data-active", subMode !== "off" ? "1" : "0");
    }

    function poke() {
      stage.setAttribute("data-hidden", "0");
      syncSubsLayout();
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (video.paused || scrubbing || cleaned) return;
        stage.setAttribute("data-hidden", "1");
        syncSubsLayout();
      }, 2400);
    }

    function syncPlayIcon() {
      btnToggle.innerHTML = video.paused ? ICON.play : ICON.pause;
    }
    function syncMuteIcon() {
      btnMute.innerHTML = video.muted || video.volume === 0 ? ICON.volOff : ICON.volOn;
    }
    function syncRate() {
      const r = String(video.playbackRate || 1);
      if ([...rateSel.options].some((o) => o.value === r)) rateSel.value = r;
    }
    function syncSeek() {
      const d = video.duration;
      if (!scrubbing) {
        if (Number.isFinite(d) && d > 0) {
          const p = (video.currentTime / d) * 1000;
          seek.value = String(Math.round(p));
          seek.style.backgroundSize = `${(p / 10).toFixed(2)}% 100%`;
        }
        curEl.textContent = fmtTime(video.currentTime);
        durEl.textContent = fmtTime(d);
      }
    }

    function paintFromVideoFallback() {
      try {
        if (paintMediaTo2D(pipCtx, pipCanvas, video, 1280)) {
          lastPaintedOnce = true;
        }
      } catch (_) {}
    }

    const fallbackLoop = (now) => {
      if (cleaned || pipWin.closed) return;
      const eng = window.__WVB_ENGINE__;
      const ready = isEngineBeautyReady(eng, video);
      if (!ready) {
        paintFromVideoFallback();
      } else {
        const staleInPlay = !video.paused && !video.ended && now - lastBeautyPushMs > 260;
        if (!lastPaintedOnce || staleInPlay) {
          paintFromVideoFallback();
        }
      }
      rafHandle = pipWin.requestAnimationFrame(fallbackLoop);
    };

    on(pipCanvas, "click", () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
      poke();
    });
    on(btnToggle, "click", () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
      poke();
    });
    on(btnMute, "click", () => {
      video.muted = !video.muted;
      if (!video.muted && video.volume === 0) video.volume = 1;
      syncMuteIcon();
      poke();
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

    on(btnBeauty, "click", () => {
      const eng = window.__WVB_ENGINE__;
      if (eng) ensureBeautyEnabledOnVideo(eng, video);
      syncTopControls();
      poke();
    });
    on(btnSub, "click", () => {
      const subs = window.RBSubtitles;
      if (!subs) return;
      const order = ["off", "zh", "both"];
      const next = order[(order.indexOf(subs.mode()) + 1) % order.length];
      void subs.setMode(next);
      syncTopControls();
      poke();
    });
    on(btnBack, "click", () => {
      try {
        window.focus();
      } catch (_) {}
      close();
    });

    on(stage, "mousemove", poke, { passive: true });
    on(stage, "mouseleave", () => {
      if (!video.paused) {
        stage.setAttribute("data-hidden", "1");
        syncSubsLayout();
      }
    });
    on(pipWin, "resize", syncSubsLayout, { passive: true });
    on(pipWin, "keydown", (e) => {
      if (e.target && /select|input/i.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "k") {
        e.preventDefault();
        video.paused ? video.play().catch(() => {}) : video.pause();
        poke();
      } else if (k === "arrowright") {
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
        poke();
      } else if (k === "arrowleft") {
        video.currentTime = Math.max(0, video.currentTime - 5);
        poke();
      } else if (k === "m") {
        video.muted = !video.muted;
        syncMuteIcon();
        poke();
      } else if (k === "b") {
        const eng = window.__WVB_ENGINE__;
        if (eng) ensureBeautyEnabledOnVideo(eng, video);
        syncTopControls();
        poke();
      }
    });

    on(video, "play", () => {
      syncPlayIcon();
      poke();
    });
    on(video, "pause", () => {
      syncPlayIcon();
      stage.setAttribute("data-hidden", "0");
      syncSubsLayout();
    });
    on(video, "timeupdate", syncSeek);
    on(video, "durationchange", syncSeek);
    on(video, "loadedmetadata", syncSeek);
    on(video, "volumechange", syncMuteIcon);
    on(video, "ratechange", syncRate);
    on(video, "seeked", () => {
      const eng = window.__WVB_ENGINE__;
      if (isEngineBeautyReady(eng, video)) {
        eng.renderSingleFrame(performance.now(), { skipInfer: true, forceUpload: true });
      } else {
        paintFromVideoFallback();
      }
    });
    on(video, "ended", () => {
      syncPlayIcon();
      stage.setAttribute("data-hidden", "0");
      syncSubsLayout();
    });

    const eng = window.__WVB_ENGINE__;
    const unsubEngine = eng?.subscribeChange
      ? eng.subscribeChange(() => {
          syncTopControls();
          if (!isEngineBeautyReady(eng, video)) paintFromVideoFallback();
          else eng.renderSingleFrame(performance.now(), { skipInfer: true, forceUpload: !eng.hasCommittedFrame });
        })
      : () => {};
    const unsubSubs = window.RBSubtitles?.subscribe ? window.RBSubtitles.subscribe(syncTopControls) : () => {};

    if (eng?.setPipSink) {
      eng.setPipSink({
        driverWindow: pipWin,
        onFrame: (glCanvas, targetVideo) => {
          if (cleaned || targetVideo !== video) return;
          try {
            if (paintMediaTo2D(pipCtx, pipCanvas, glCanvas, 1920)) {
              lastBeautyPushMs = performance.now();
              lastPaintedOnce = true;
            }
          } catch (_) {}
        },
      });
    }

    if (window.RBSubtitles?.setPipSink) {
      window.RBSubtitles.setPipSink({
        isOpen: () => !cleaned && state.mode === "document" && !pipWin.closed,
        onRender: renderPipSubs,
      });
    }

    if (!isEngineBeautyReady(eng, video)) {
      paintFromVideoFallback();
    }
    syncPlayIcon();
    syncMuteIcon();
    syncRate();
    syncSeek();
    syncTopControls();
    poke();
    rafHandle = pipWin.requestAnimationFrame(fallbackLoop);

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (hideTimer) clearTimeout(hideTimer);
      if (rafHandle !== null) {
        try {
          pipWin.cancelAnimationFrame(rafHandle);
        } catch (_) {}
      }
      for (const [t, type, fn, opts] of bound) {
        try {
          t.removeEventListener(type, fn, opts);
        } catch (_) {}
      }
      bound.length = 0;
      try {
        unsubEngine();
      } catch (_) {}
      try {
        unsubSubs();
      } catch (_) {}
      try {
        if (window.__WVB_ENGINE__?.setPipSink) window.__WVB_ENGINE__.setPipSink(null);
      } catch (_) {}
      try {
        if (window.RBSubtitles?.setPipSink) window.RBSubtitles.setPipSink(null);
      } catch (_) {}
      try {
        if (!pipWin.closed) pipWin.close();
      } catch (_) {}
      if (state.cleanup === cleanup) {
        state.cleanup = null;
        state.mode = "off";
        state.video = null;
        state.pipWindow = null;
        notify();
      }
    };

    on(pipWin, "pagehide", cleanup);
    on(window, "pagehide", cleanup);
    state.cleanup = cleanup;
  }

  // =========================================================================
  // 方案 B（降级兜底）：离屏 2D 合成画布 + captureStream() / 原生 PiP
  // =========================================================================
  function wrapCanvasText(ctx, text, maxWidth) {
    const lines = [];
    for (const para of String(text || "").split(/\r?\n/)) {
      if (!para) continue;
      let line = "";
      for (const ch of para) {
        const test = line + ch;
        if (line && ctx.measureText(test).width > maxWidth) {
          lines.push(line);
          line = ch;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  function drawBurnedSubtitles(ctx, w, h, payload) {
    if (!payload || !payload.active) return;
    const items = [];
    if (payload.src) items.push({ text: payload.src, scale: 0.77, color: "#f8fafc" });
    if (payload.text) items.push({ text: payload.text, scale: 1.0, color: "#ffffff" });
    else if (payload.hint) items.push({ text: payload.hint, scale: 0.74, color: "#cbd5e1" });
    if (!items.length) return;

    const st = payload.style || { fontScale: 1, offsetPct: 0 };
    const basePx = Math.round(Math.max(16, Math.min(34, h * 0.052)) * (st.fontScale || 1));
    const maxW = w * 0.88;
    const boxes = [];
    for (const item of items) {
      const px = Math.max(12, Math.round(basePx * item.scale));
      ctx.font = `600 ${px}px "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif`;
      const wrapped = wrapCanvasText(ctx, item.text, maxW);
      for (const l of wrapped) boxes.push({ text: l, px, color: item.color });
    }
    if (!boxes.length) return;

    const baseBottom = h - Math.max(18, Math.round(h * 0.06 + h * ((st.offsetPct || 0) / 100)));
    let cursorY = baseBottom;
    for (let i = boxes.length - 1; i >= 0; i -= 1) {
      const b = boxes[i];
      ctx.font = `600 ${b.px}px "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif`;
      const tw = Math.min(maxW, ctx.measureText(b.text).width);
      const padX = Math.round(b.px * 0.42);
      const padY = Math.round(b.px * 0.22);
      const boxH = b.px + padY * 2;
      const boxW = tw + padX * 2;
      const bx = (w - boxW) * 0.5;
      const by = cursorY - boxH;
      ctx.fillStyle = "rgba(16, 17, 23, 0.84)";
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(bx, by, boxW, boxH, Math.round(b.px * 0.24));
      else ctx.rect(bx, by, boxW, boxH);
      ctx.fill();
      ctx.fillStyle = b.color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(b.text, w * 0.5, by + boxH * 0.52);
      cursorY = by - 4;
    }
  }

  async function openCompositeOrNativePip(video) {
    if (!document.pictureInPictureEnabled || typeof video.requestPictureInPicture !== "function") {
      return false;
    }

    const compCanvas = document.createElement("canvas");
    const compCtx = compCanvas.getContext("2d", { alpha: false });
    const proxyVideo = document.createElement("video");
    proxyVideo.muted = true;
    proxyVideo.playsInline = true;
    proxyVideo.style.cssText =
      "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";

    let cleaned = false;
    let timer = null;
    let stream = null;
    let latestBeautyCanvas = null;
    let latestBeautyTs = 0;
    let lastSub = { text: "", src: "", hint: "", style: { fontScale: 1, offsetPct: 0 }, mode: "off", active: false };
    let tainted = false;

    const paintComposite = (preferCanvas) => {
      if (cleaned || tainted) return;
      try {
        const eng = window.__WVB_ENGINE__;
        const ready = isEngineBeautyReady(eng, video);
        const src =
          preferCanvas || (ready && latestBeautyCanvas && performance.now() - latestBeautyTs < 300)
            ? preferCanvas || latestBeautyCanvas
            : video;
        const ok = paintMediaTo2D(compCtx, compCanvas, src, 960);
        if (ok) drawBurnedSubtitles(compCtx, compCanvas.width, compCanvas.height, lastSub);
      } catch (err) {
        const name = err?.name || "";
        if (name === "SecurityError" || /tainted|cross-origin|security/i.test(String(err))) {
          tainted = true;
        }
      }
    };

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (timer) clearInterval(timer);
      try {
        if (window.__WVB_ENGINE__?.setPipSink) window.__WVB_ENGINE__.setPipSink(null);
      } catch (_) {}
      try {
        if (window.RBSubtitles?.setPipSink) window.RBSubtitles.setPipSink(null);
      } catch (_) {}
      if (stream) {
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch (_) {}
      }
      try {
        if (document.pictureInPictureElement === proxyVideo) {
          void document.exitPictureInPicture();
        }
      } catch (_) {}
      try {
        proxyVideo.srcObject = null;
        proxyVideo.remove();
      } catch (_) {}
      if (state.cleanup === cleanup) {
        state.cleanup = null;
        state.mode = "off";
        state.video = null;
        notify();
      }
    };

    try {
      const eng = window.__WVB_ENGINE__;
      if (eng?.setPipSink) {
        eng.setPipSink({
          driverWindow: window,
          onFrame: (glCanvas, targetVideo) => {
            if (cleaned || targetVideo !== video) return;
            latestBeautyCanvas = glCanvas;
            latestBeautyTs = performance.now();
            paintComposite(glCanvas);
          },
        });
      }
      if (window.RBSubtitles?.setPipSink) {
        window.RBSubtitles.setPipSink({
          isOpen: () => !cleaned && state.mode === "composite" && document.pictureInPictureElement === proxyVideo,
          onRender: (p) => {
            lastSub = p || lastSub;
            paintComposite();
          },
        });
      }

      paintComposite(isEngineBeautyReady(eng, video) ? eng.canvas : null);
      if (tainted || compCanvas.width === 0 || typeof compCanvas.captureStream !== "function") {
        throw new Error("composite unavailable");
      }
      stream = compCanvas.captureStream(30);
      proxyVideo.srcObject = stream;
      (document.body || document.documentElement).appendChild(proxyVideo);
      await proxyVideo.play();
      if (tainted) throw new Error("composite tainted");
      await proxyVideo.requestPictureInPicture();

      state.mode = "composite";
      state.video = video;
      state.pipWindow = null;
      state.cleanup = cleanup;
      timer = setInterval(() => {
        if (tainted) {
          cleanup();
          return;
        }
        paintComposite();
      }, 33);

      proxyVideo.addEventListener("play", () => {
        if (video.paused) video.play().catch(() => {});
      });
      proxyVideo.addEventListener("pause", () => {
        if (!video.paused) video.pause();
      });
      proxyVideo.addEventListener("leavepictureinpicture", cleanup, { once: true });
      window.addEventListener("pagehide", cleanup, { once: true });
      window.RBSubtitles?.render?.();
      notify();
      return true;
    } catch (_) {
      cleanup();
      try {
        await video.requestPictureInPicture();
        state.mode = "native";
        state.video = video;
        state.pipWindow = null;
        const onLeave = () => {
          state.mode = "off";
          state.video = null;
          state.cleanup = null;
          notify();
        };
        video.addEventListener("leavepictureinpicture", onLeave, { once: true });
        state.cleanup = () => {
          video.removeEventListener("leavepictureinpicture", onLeave);
          if (document.pictureInPictureElement === video) {
            void document.exitPictureInPicture().catch(() => {});
          }
        };
        notify();
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  // =========================================================================
  // 对外入口（同步触发 requestWindow，绝不先 await 破坏用户手势）
  // =========================================================================
  function open(explicitVideo) {
    const video = resolveVideo(explicitVideo);
    if (!video) return Promise.resolve(false);
    if (isOpen()) {
      if (state.video === video) return Promise.resolve(true);
      close();
    }

    if (isDocumentPipSupported()) {
      const { width, height } = calcPipSize(video);
      let reqPromise;
      try {
        reqPromise = window.documentPictureInPicture.requestWindow({ width, height });
      } catch (err) {
        return openCompositeOrNativePip(video);
      }
      return reqPromise
        .then((pipWin) => {
          if (!pipWin || pipWin.closed) return false;
          state.mode = "document";
          state.video = video;
          state.pipWindow = pipWin;
          mountDocumentPip(pipWin, video);
          notify();
          return true;
        })
        .catch(() => openCompositeOrNativePip(video));
    }

    return openCompositeOrNativePip(video);
  }

  function toggle(explicitVideo) {
    if (isOpen()) {
      close();
      return Promise.resolve(false);
    }
    return open(explicitVideo);
  }

  window.RBPip = {
    open,
    close,
    toggle,
    isOpen,
    getMode,
    isSupported,
    subscribe(fn) {
      if (typeof fn !== "function") return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
})();
