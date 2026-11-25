/* Shared by the extension content script and the bundled local player. */
(() => {
  if (window.RBSubtitles) return;

  const runtime = globalThis.chrome?.runtime;
  const storage = globalThis.chrome?.storage;
  const local = runtime?.id === "rb-local-player";
  const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (!local && (!runtime?.id || loopback.has(location.hostname))) return;

  const setting = "rbSubsHosts";
  const profileSetting = "rbSubsProfile";
  const styleSetting = "rbSubsStyle";
  const profiles = new Set(["auto", "cpu", "cpu-fast", "gpu"]);
  const session = crypto.randomUUID?.() || "rb-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const modes = new Set(["off", "zh", "both"]);
  let host = location.hostname.toLowerCase();
  let mode = "off";
  let profile = "auto";
  let activeProfile = null;
  let subStyle = { fontScale: 1, offsetPct: 0 };
  let video = null;
  let mediaEvents = null;
  let timer = 0;
  let task = null;
  let priority = true;
  let generation = 0;
  let requestedAt = null;
  let cues = [];
  let state = "";
  let previouslyRequested = false;
  let pageUrl = location.href;
  let frame = null;
  let primary, secondary, status;
  let nativeTrack = null;
  let nativeCue = null;
  let pipSink = null;
  const listeners = new Set();

  function isPipOpen() {
    return (
      !!(pipSink && typeof pipSink.isOpen === "function" && pipSink.isOpen()) ||
      !!(video && document.pictureInPictureElement === video)
    );
  }

  function isHidden() {
    return document.hidden && !isPipOpen();
  }

  function notify() {
    for (const listener of listeners) listener();
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        runtime.sendMessage(message, (reply) => {
          if (runtime.lastError) resolve(null);
          else resolve(reply);
        });
      } catch (_) { resolve(null); }
    });
  }

  function readSettings() {
    return new Promise((resolve) => {
      try {
        storage.local.get({ [setting]: {}, [profileSetting]: "auto", [styleSetting]: { fontScale: 1, offsetPct: 0 } }, (data) => {
          if (runtime.lastError) resolve({});
          else resolve(data || {});
        });
      } catch (_) { resolve({}); }
    });
  }

  function normalizeStyle(raw) {
    const fs = Number(raw?.fontScale);
    const op = Number(raw?.offsetPct);
    return {
      fontScale: Number.isFinite(fs) ? Math.min(1.6, Math.max(0.7, Math.round(fs * 20) / 20)) : 1,
      offsetPct: Number.isFinite(op) ? Math.min(35, Math.max(0, Math.round(op))) : 0,
    };
  }

  function applyStyle(next) {
    const normalized = normalizeStyle(next);
    if (normalized.fontScale === subStyle.fontScale && normalized.offsetPct === subStyle.offsetPct) return;
    subStyle = normalized;
    render();
    notify();
  }

  function setStyle(partial) {
    applyStyle({ ...subStyle, ...(partial || {}) });
    try {
      storage.local.set({ [styleSetting]: subStyle });
    } catch (_) {}
  }

  function setSettings(next) {
    const savedMode = next?.[host];
    const nextMode = modes.has(savedMode) ? savedMode : "off";
    if (mode === nextMode) return;
    mode = nextMode;
    clearInterval(timer);
    if (mode === "off") {
      deactivate();
      clear();
    } else {
      void tick();
      timer = setInterval(tick, 1000);
    }
    notify();
  }

  async function setMode(next) {
    if (!modes.has(next)) return;
    const all = await readSettings();
    const values = { ...all[setting], [host]: next };
    setSettings(values);
    storage.local.set({ [setting]: values });
  }

  function applyProfile(next) {
    if (!profiles.has(next) || next === profile) return;
    profile = next;
    activeProfile = null;
    generation++;
    priority = true;
    notify();
    void tick();
  }

  function setProfile(next) {
    if (!profiles.has(next)) return;
    applyProfile(next);
    storage.local.set({ [profileSetting]: next });
  }

  async function request(body) {
    if (!local) return send({ type: "rb-subs-focus", payload: body });
    const key = window.__RB_LOCAL_KEY__;
    if (!key) return null;
    try {
      const response = await fetch("/api/subs/" + encodeURIComponent(key) + "/focus", {
        method: "POST", cache: "no-store", keepalive: !body.active, signal: AbortSignal.timeout(4000),
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      return response.ok ? response.json() : { key, state: response.status === 404 ? "uncached" : "offline" };
    } catch (_) {
      return { key, state: "offline" };
    }
  }

  function locationOnTimeline(seconds) {
    const map = local && window.__RB_FULL_TIME_MAP__;
    if (!map?.length) return { time: seconds, until: null, offset: 0 };
    let low = 0;
    let high = map.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (seconds < map[mid].plEnd) high = mid;
      else low = mid + 1;
    }
    const part = map[low];
    const offset = part.fullStart - part.plStart;
    return { time: seconds + offset, until: part.plEnd + offset, offset };
  }

  function deactivate() {
    ++generation;
    priority = true;
    if (previouslyRequested) {
      previouslyRequested = false;
      void request({ session, time: 0, active: false });
    }
  }

  function clear() {
    cues = [];
    state = "";
    requestedAt = null;
    if (frame) frame.hidden = true;
    removeNativeCue();
    if (pipSink && typeof pipSink.isOpen === "function" && pipSink.isOpen()) {
      try {
        pipSink.onRender({ text: "", src: "", hint: "", style: { ...subStyle }, mode, active: false });
      } catch (_) {}
    }
  }

  function removeNativeCue() {
    if (nativeCue && nativeTrack) {
      nativeTrack.removeCue(nativeCue);
      nativeCue = null;
    }
    if (nativeTrack) nativeTrack.mode = "disabled";
  }

  function replaceVideo(next) {
    if (next === video) return;
    mediaEvents?.abort();
    deactivate();
    clear();
    video = next;
    nativeTrack = null;
    if (!video) return;
    mediaEvents = new AbortController();
    const on = (type, listen) => video.addEventListener(type, listen, { signal: mediaEvents.signal });
    const changed = () => {
      ++generation;
      priority = true;
      requestedAt = null;
      render();
      void tick();
    };
    on("seeking", () => {
      ++generation;
      priority = true;
      requestedAt = null;
      render();
    });
    on("seeked", changed);
    on("loadedmetadata", changed);
    on("emptied", () => { deactivate(); clear(); });
    on("play", () => { void tick(); });
    on("timeupdate", render);
    on("enterpictureinpicture", () => { void tick(); render(); });
    on("leavepictureinpicture", () => {
      if (isHidden()) deactivate();
      render();
    });
  }

  async function tick() {
    if (mode === "off" || isHidden() || (local && !window.__RB_SUBS_TIMELINE_READY__)) return;
    if (pageUrl !== location.href) {
      pageUrl = location.href;
      deactivate();
      clear();
    }
    const current = local ? document.getElementById("player") : window.RBPlayerBar?.pickMainVideo(true);
    replaceVideo(current);
    if (!video || video.seeking || video.readyState < 1 || !Number.isFinite(video.currentTime) || task) return;
    const point = locationOnTimeline(video.currentTime);
    const rev = generation;
    const initial = priority || (requestedAt !== null && Math.abs(point.time - requestedAt) > 10);
    priority = false;
    previouslyRequested = true;
    try {
      task = request({ session, time: point.time, until: point.until, seek: initial, active: true, profile });
      const data = await task;
      if (rev !== generation || mode === "off" || isHidden()) return;
      requestedAt = point.time;
      state = data?.state || "offline";
      cues = Array.isArray(data?.cues) ? data.cues : [];
      if (data?.profile && JSON.stringify(data.profile) !== JSON.stringify(activeProfile)) {
        activeProfile = data.profile;
        notify();
      }
      render();
    } finally {
      task = null;
      if (priority && rev !== generation && !isHidden()) void tick();
    }
  }

  function ensureFrame() {
    if (frame) return;
    frame = document.createElement("div");
    frame.style.cssText = "all:initial;display:block;position:fixed;pointer-events:none;z-index:2147483638;";
    frame.hidden = true;
    const shadow = frame.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = [
      ":host([hidden]){display:none!important}",
      ".wrap{text-align:center;color:white;font:600 var(--rb-font,20px)/1.42 system-ui,sans-serif;overflow-wrap:anywhere;text-shadow:0 2px 5px #000}",
      ".line{margin:2px auto;display:table;max-width:90%;padding:.07em .4em;background:#101117d9;border-radius:.25em}",
      ".source{font-size:.77em;font-weight:500}",
      ".state{font-size:.7em;font-weight:500}",
      "[hidden]{display:none!important}",
    ].join("");
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    [secondary, primary, status] = ["source", "", "state"].map((type) => {
      const node = document.createElement("div");
      node.className = "line " + type;
      wrap.append(node);
      return node;
    });
    status.setAttribute("role", "status");
    shadow.append(style, wrap);
  }

  function activeCue(time) {
    let low = 0;
    let high = cues.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cues[mid].t0 <= time) low = mid + 1;
      else high = mid;
    }
    for (let i = low - 1; i >= 0 && cues[i].t0 >= time - 60; i--) {
      if (cues[i].t1 > time) return cues[i];
    }
    return null;
  }

  function showNative(cue, text, offset) {
    if (!cue || !text || !window.VTTCue) {
      removeNativeCue();
      return;
    }
    nativeTrack ||= video.addTextTrack("captions", "本地字幕", "zh");
    if (nativeCue && nativeCue.id === cue.id && nativeCue.text === text) return;
    removeNativeCue();
    const start = Math.max(0, cue.t0 - offset);
    const end = cue.t1 - offset;
    if (end <= start) return;
    nativeCue = new VTTCue(start, end, text.replace(/&/g, "&amp;").replace(/</g, "&lt;"));
    nativeCue.id = cue.id;
    nativeTrack.addCue(nativeCue);
    nativeTrack.mode = "showing";
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
    el.hidden = !text;
  }

  function render() {
    if (!video || mode === "off" || isHidden() || video.seeking) {
      if (frame) frame.hidden = true;
      removeNativeCue();
      if (pipSink && typeof pipSink.isOpen === "function" && pipSink.isOpen()) {
        try {
          pipSink.onRender({ text: "", src: "", hint: "", style: { ...subStyle }, mode, active: false });
        } catch (_) {}
      }
      return;
    }
    const point = locationOnTimeline(video.currentTime);
    const cue = activeCue(point.time);
    const text = cue ? cue.zh || cue.src : "";
    const src = cue?.zh && mode === "both" ? cue.src : "";
    const recent = requestedAt !== null && Math.abs(point.time - requestedAt) < 5;
    let uncachedMsg = "等待本地视频分片";
    if (!local && state === "uncached") {
      const relay = window.__RB_CACHE_RELAY__;
      if (relay && typeof relay.isCacheEnabled === "function" && !relay.isCacheEnabled()) {
        uncachedMsg = "请先开启「本站缓存」以生成字幕";
      } else if (relay && typeof relay.isServerOnline === "function" && !relay.isServerOnline()) {
        uncachedMsg = "正在连接本地缓存服务…";
      } else if (relay && typeof relay.getRewrittenCount === "function" && relay.getRewrittenCount() === 0 && video.currentTime > 3) {
        uncachedMsg = "未捕获到 HLS 分片（可能非 HLS 源或需刷新页面）";
      }
    }
    const messages = { queued: "正在生成字幕", uncached: uncachedMsg, offline: "请启动本地缓存服务", error: "字幕生成遇到问题" };
    const hint = !text && recent && !video.ended ? messages[state] || "" : "";
    const customPip = !!(pipSink && typeof pipSink.isOpen === "function" && pipSink.isOpen());
    if (customPip) {
      try {
        pipSink.onRender({ text, src, hint, style: { ...subStyle }, mode, active: true });
      } catch (_) {}
    }
    const full = document.fullscreenElement || document.webkitFullscreenElement;
    const inNativePip = document.pictureInPictureElement === video;
    if (!customPip && (full === video || video.webkitDisplayingFullscreen || inNativePip)) {
      if (frame) frame.hidden = true;
      showNative(cue, src ? src + "\n" + text : text, point.offset);
      return;
    }
    removeNativeCue();
    if (!text && !hint) {
      if (frame) frame.hidden = true;
      return;
    }
    const rect = video.getBoundingClientRect();
    if (rect.width < 180 || rect.height < 90 || rect.bottom <= 0 || rect.top >= innerHeight) {
      if (frame) frame.hidden = true;
      return;
    }
    ensureFrame();
    const parent = full?.contains(video) ? full : document.body;
    if (frame.parentNode !== parent) parent.append(frame);
    frame.style.left = rect.left + "px";
    frame.style.width = rect.width + "px";
    const trace = local ? document.getElementById("tracebar")?.getBoundingClientRect() : null;
    const controlInset = trace && trace.height ? rect.bottom - trace.top + 8 : 0;
    const extraLift = rect.height * (subStyle.offsetPct / 100);
    const inset = Math.max(24, rect.height * 0.09, controlInset) + extraLift;
    frame.style.bottom = Math.max(0, innerHeight - rect.bottom + inset) + "px";
    const fontPx = Math.round(Math.max(15, Math.min(30, rect.height * 0.047)) * subStyle.fontScale);
    frame.style.setProperty("--rb-font", fontPx + "px");
    setText(primary, text);
    setText(secondary, src);
    setText(status, hint);
    frame.hidden = false;
  }

  window.RBSubtitles = {
    mode: () => mode,
    setMode,
    profile: () => profile,
    activeProfile: () => activeProfile,
    setProfile,
    style: () => ({ ...subStyle }),
    setStyle,
    render,
    setPipSink(sink) {
      pipSink = sink || null;
      if (pipSink && mode !== "off") {
        void tick();
        render();
      } else if (!pipSink && isHidden()) {
        deactivate();
        render();
      } else {
        render();
      }
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  document.addEventListener("fullscreenchange", render);
  document.addEventListener("webkitfullscreenchange", render);
  window.addEventListener("resize", render, { passive: true });
  window.addEventListener("scroll", render, { passive: true, capture: true });
  document.addEventListener("visibilitychange", () => {
    if (isHidden()) { deactivate(); render(); }
    else void tick();
  });
  window.addEventListener("pagehide", deactivate);
  storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[profileSetting]) applyProfile(changes[profileSetting].newValue || "auto");
    if (changes[styleSetting]) applyStyle(changes[styleSetting].newValue);
    if (changes[setting]) setSettings(changes[setting].newValue);
  });
  (async () => {
    if (!local && top !== window) {
      const context = await send({ type: "rb-subs-context" });
      if (context?.host) host = context.host;
    }
    const saved = await readSettings();
    applyStyle(saved[styleSetting]);
    applyProfile(saved[profileSetting]);
    setSettings(saved[setting]);
  })();
})();
