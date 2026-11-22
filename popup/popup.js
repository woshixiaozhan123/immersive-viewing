const SKIN_SLIDERS = [
  { key: "smooth", label: "磨皮" },
  { key: "whiten", label: "美白" },
  { key: "rosy", label: "红润" },
  { key: "sharpen", label: "清晰锐化" },
  { key: "underEye", label: "去黑眼圈" },
  { key: "brightEye", label: "亮眼" },
  { key: "lipTint", label: "润唇" },
];

const RESHAPE_SLIDERS = [
  { key: "slimFace", label: "瘦脸" },
  { key: "bigEyes", label: "大眼" },
  { key: "slimNose", label: "瘦鼻" },
];

const ALL_SLIDERS = [...SKIN_SLIDERS, ...RESHAPE_SLIDERS];

const DEFAULT_PARAMS = {
  smooth: 0.45,
  whiten: 0.30,
  rosy: 0.15,
  sharpen: 0.25,
  underEye: 0.25,
  brightEye: 0.20,
  lipTint: 0.15,
  slimFace: 0.20,
  bigEyes: 0.15,
  slimNose: 0.12,
};

const PRESETS = {
  natural: {
    name: "自然清透",
    params: {
      smooth: 0.40,
      whiten: 0.25,
      rosy: 0.12,
      sharpen: 0.25,
      underEye: 0.25,
      brightEye: 0.20,
      lipTint: 0.12,
      slimFace: 0.15,
      bigEyes: 0.10,
      slimNose: 0.08,
    },
  },
  cool_fair: {
    name: "冷白质感",
    params: {
      smooth: 0.55,
      whiten: 0.60,
      rosy: 0.08,
      sharpen: 0.35,
      underEye: 0.35,
      brightEye: 0.30,
      lipTint: 0.22,
      slimFace: 0.25,
      bigEyes: 0.18,
      slimNose: 0.15,
    },
  },
  soft_glow: {
    name: "日系柔光",
    params: {
      smooth: 0.65,
      whiten: 0.42,
      rosy: 0.30,
      sharpen: 0.15,
      underEye: 0.40,
      brightEye: 0.22,
      lipTint: 0.28,
      slimFace: 0.20,
      bigEyes: 0.22,
      slimNose: 0.10,
    },
  },
  delicate: {
    name: "纯欲微调",
    params: {
      smooth: 0.50,
      whiten: 0.35,
      rosy: 0.35,
      sharpen: 0.30,
      underEye: 0.35,
      brightEye: 0.35,
      lipTint: 0.38,
      slimFace: 0.32,
      bigEyes: 0.28,
      slimNose: 0.22,
    },
  },
  reset: {
    name: "归零",
    params: {
      smooth: 0,
      whiten: 0,
      rosy: 0,
      sharpen: 0,
      underEye: 0,
      brightEye: 0,
      lipTint: 0,
      slimFace: 0,
      bigEyes: 0,
      slimNose: 0,
    },
  },
};

const KEY_ALIASES = {
  smooth: ["smooth", "磨皮", "肤质"],
  whiten: ["whiten", "whitening", "美白", "提亮", "肤色"],
  rosy: ["rosy", "blush", "红润", "气色", "腮红"],
  sharpen: ["sharpen", "clarity", "清晰", "锐化", "清晰锐化", "画质"],
  underEye: ["underEye", "under_eye", "darkCircle", "去黑眼圈", "黑眼圈", "眼下"],
  brightEye: ["brightEye", "bright_eye", "eyeBright", "亮眼", "眼神光"],
  lipTint: ["lipTint", "lip_tint", "lipstick", "润唇", "唇色", "口红"],
  slimFace: ["slimFace", "slim_face", "瘦脸", "小脸", "v脸"],
  bigEyes: ["bigEyes", "big_eyes", "enlargeEyes", "大眼", "大眼睛"],
  slimNose: ["slimNose", "slim_nose", "瘦鼻", "缩鼻翼"],
};

const els = {
  toggleBeauty: document.getElementById("toggleBeauty"),
  videoSelect: document.getElementById("videoSelect"),
  videoMeta: document.getElementById("videoMeta"),
  badgeProtection: document.getElementById("badgeProtection"),
  badgeCapture: document.getElementById("badgeCapture"),
  badgeMode: document.getElementById("badgeMode"),
  presetBar: document.getElementById("presetBar"),
  activePresetLabel: document.getElementById("activePresetLabel"),
  skinSliders: document.getElementById("skinSliders"),
  reshapeSliders: document.getElementById("reshapeSliders"),
  btnCompare: document.getElementById("btnCompare"),
  btnRetry: document.getElementById("btnRetry"),
  btnRescan: document.getElementById("btnRescan"),
  btnSaveCustom: document.getElementById("btnSaveCustom"),
  btnLoadCustom: document.getElementById("btnLoadCustom"),
  btnExportClip: document.getElementById("btnExportClip"),
  btnExportFile: document.getElementById("btnExportFile"),
  inputImportFile: document.getElementById("inputImportFile"),
  presetJsonInput: document.getElementById("presetJsonInput"),
  btnApplyJson: document.getElementById("btnApplyJson"),
  ioStatus: document.getElementById("ioStatus"),
  diagGrid: document.getElementById("diagGrid"),
  btnCopyDiag: document.getElementById("btnCopyDiag"),
  copyHint: document.getElementById("copyHint"),
  errorBanner: document.getElementById("errorBanner"),
};

let currentTabId = null;
let lastState = null;
let pollTimer = null;
let currentParams = { ...DEFAULT_PARAMS };
let activePresetKey = "natural";
let isDraggingSlider = false;
const sliderInputs = new Map();
const sliderValues = new Map();

function clamp01(val, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  const norm = n > 1 ? n / 100 : n;
  return Math.max(0, Math.min(1, norm));
}

function normalizeParams(input, base = DEFAULT_PARAMS) {
  const out = { ...base };
  if (!input || typeof input !== "object") return out;
  const source = input.params && typeof input.params === "object" ? input.params : input;
  let matched = 0;
  for (const [key, aliases] of Object.entries(KEY_ALIASES)) {
    for (const alias of aliases) {
      if (source[alias] !== undefined) {
        out[key] = clamp01(source[alias], out[key]);
        matched++;
        break;
      }
    }
  }
  return { params: out, matched };
}

function buildSliders(container, specs) {
  container.replaceChildren();
  for (const item of specs) {
    const row = document.createElement("div");
    row.className = "slider-row";

    const nameEl = document.createElement("span");
    nameEl.className = "slider-name";
    nameEl.textContent = item.label;
    nameEl.title = "双击重置该项为 0";

    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "100";
    input.title = "双击重置为 0";
    input.value = String(Math.round((currentParams[item.key] ?? 0) * 100));

    const valEl = document.createElement("span");
    valEl.className = "slider-val";
    valEl.textContent = input.value;

    const resetSingle = () => {
      input.value = "0";
      valEl.textContent = "0";
      currentParams[item.key] = 0;
      activePresetKey = detectMatchingPreset(currentParams);
      updatePresetHighlight();
      persistAndPushParams();
    };
    nameEl.addEventListener("dblclick", resetSingle);
    input.addEventListener("dblclick", resetSingle);

    input.addEventListener("pointerdown", () => {
      isDraggingSlider = true;
    });
    input.addEventListener("input", () => {
      const pct = Number(input.value);
      valEl.textContent = String(pct);
      currentParams[item.key] = pct / 100;
      activePresetKey = detectMatchingPreset(currentParams);
      updatePresetHighlight();
      persistAndPushParams();
    });

    sliderInputs.set(item.key, input);
    sliderValues.set(item.key, valEl);

    row.appendChild(nameEl);
    row.appendChild(input);
    row.appendChild(valEl);
    container.appendChild(row);
  }
}

function detectMatchingPreset(params) {
  for (const [key, preset] of Object.entries(PRESETS)) {
    let same = true;
    for (const s of ALL_SLIDERS) {
      if (Math.round((params[s.key] ?? 0) * 100) !== Math.round((preset.params[s.key] ?? 0) * 100)) {
        same = false;
        break;
      }
    }
    if (same) return key;
  }
  return "custom";
}

function syncSlidersUI(params) {
  for (const s of ALL_SLIDERS) {
    const pct = Math.round((params[s.key] ?? 0) * 100);
    const input = sliderInputs.get(s.key);
    const valEl = sliderValues.get(s.key);
    if (input) input.value = String(pct);
    if (valEl) valEl.textContent = String(pct);
  }
  activePresetKey = detectMatchingPreset(params);
  updatePresetHighlight();
}

function updatePresetHighlight() {
  const buttons = els.presetBar.querySelectorAll(".pill");
  for (const btn of buttons) {
    btn.classList.toggle("active", btn.dataset.preset === activePresetKey);
  }
  els.activePresetLabel.textContent =
    activePresetKey !== "custom" && PRESETS[activePresetKey] ? PRESETS[activePresetKey].name : "自定义";
}

function showIoStatus(msg, isError = false) {
  els.ioStatus.textContent = msg;
  els.ioStatus.className = isError ? "hint err" : "hint";
  if (msg) {
    setTimeout(() => {
      if (els.ioStatus.textContent === msg) els.ioStatus.textContent = "";
    }, 2600);
  }
}

function showError(msg) {
  if (!msg) {
    els.errorBanner.classList.add("hidden");
    els.errorBanner.textContent = "";
    return;
  }
  els.errorBanner.textContent = msg;
  els.errorBanner.classList.remove("hidden");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureInjected(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "WVB_PING" });
    if (res && res.ok) return true;
  } catch (_) {
    // Not injected yet
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/engine.js"],
  });
  return true;
}

async function sendToTab(payload) {
  if (!currentTabId) return null;
  try {
    return await chrome.tabs.sendMessage(currentTabId, payload);
  } catch (err) {
    showError("无法与当前页面通信（可能是浏览器内置页面或受限页面）。");
    return null;
  }
}

async function persistAndPushParams() {
  await chrome.storage.local.set({ beautyParams: currentParams, strength: currentParams.smooth });
  const res = await sendToTab({ type: "WVB_SET_PARAMS", params: currentParams });
  if (res && res.state) renderState(res.state);
}

function buildExportObject() {
  const pctParams = {};
  for (const s of ALL_SLIDERS) {
    pctParams[s.key] = Math.round((currentParams[s.key] ?? 0) * 100);
  }
  return {
    schema: "wvb-wink-preset-v1",
    name: PRESETS[activePresetKey]?.name || "自定义方案",
    params: pctParams,
  };
}

function setBadge(el, text, level) {
  el.textContent = text;
  el.className = "badge " + (level || "neutral");
}

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function renderState(state) {
  if (!state) return;
  lastState = state;
  showError(state.lastError || "");

  els.toggleBeauty.checked = !!state.enabled;
  if (!isDraggingSlider && state.params) {
    currentParams = normalizeParams(state.params, DEFAULT_PARAMS).params;
    syncSlidersUI(currentParams);
  }

  // Populate video selector
  const videos = state.videos || [];
  els.videoSelect.innerHTML = "";
  if (videos.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "未检测到可访问的 HTML5 视频";
    els.videoSelect.appendChild(opt);
    els.videoSelect.disabled = true;
    els.videoMeta.textContent =
      state.unsupportedHints && state.unsupportedHints.length
        ? `待适配场景：${state.unsupportedHints.join("、")}`
        : "请先打开包含视频的页面或等待播放器加载。";
  } else {
    els.videoSelect.disabled = false;
    for (const v of videos) {
      const opt = document.createElement("option");
      opt.value = v.id;
      const playTag = v.playbackState || (v.paused ? "暂停" : "播放中");
      const originTag = v.frameOrigin ? ` · ${v.frameOrigin}` : "";
      const lockTag = v.id === state.userLockedId ? " [已锁定]" : "";
      opt.textContent = `${v.label} (${v.videoWidth}×${v.videoHeight}${originTag}) · ${playTag}${lockTag}`;
      if (v.id === state.selectedVideoId) opt.selected = true;
      els.videoSelect.appendChild(opt);
    }
    const sel = videos.find((v) => v.id === state.selectedVideoId) || videos[0];
    const kind = sel.streamKind || "未确认";
    const playState = sel.playbackState || (sel.paused ? "暂停" : "播放中");
    const origin = sel.frameOrigin || "主页面";
    els.videoMeta.textContent =
      `${playState} · ${origin} | ${sel.videoWidth}×${sel.videoHeight} | ` +
      `${formatTime(sel.currentTime)} / ${formatTime(sel.duration)} | ` +
      `${sel.playbackRate}x | ${kind} | 来源：${sel.sourceScheme}`;
  }

  // Badges
  const protMap = {
    none: ["保护：未观察到", "ok"],
    eme_media_keys: ["保护：检测到 EME", "err"],
    eme_encrypted_event: ["保护：收到 encrypted", "err"],
  };
  const [pText, pLvl] = protMap[state.protectionSignal] || ["保护：未观察到", "neutral"];
  setBadge(els.badgeProtection, pText, pLvl);

  const capMap = {
    waiting: ["取帧：等待画面", "warn"],
    ready: ["取帧：可取帧", "ok"],
    cors_restricted: ["取帧：跨域受限", "err"],
    skipped_eme: ["取帧：EME 已跳过", "err"],
    failed_unknown: ["取帧：失败未确认", "err"],
    idle: ["取帧：未启动", "neutral"],
  };
  const [cText, cLvl] = capMap[state.captureStatus] || ["取帧：未知", "neutral"];
  setBadge(els.badgeCapture, cText, cLvl);

  const modeMap = {
    face_mask: ["模式：人脸局部遮罩", "ok"],
    skin_fallback: ["模式：肤色保边回退", "warn"],
    native_fallback: ["模式：原画回退", "warn"],
    off: ["模式：已关闭", "neutral"],
  };
  const [mText, mLvl] = modeMap[state.renderMode] || ["模式：待就绪", "neutral"];
  setBadge(els.badgeMode, mText, mLvl);

  // Diagnostics grid
  const d = state.diagnostics || {};
  const lastCapStr =
    typeof d.lastCapturedMediaTime === "number" && Number.isFinite(d.lastCapturedMediaTime)
      ? `${formatTime(d.lastCapturedMediaTime)} (${d.lastCapturedMediaTime.toFixed(2)}s)`
      : "尚无";
  const rows = [
    ["站点适配器", d.adapterName || "通用 HTML5"],
    ["降级档位", d.degradeTier || "L0"],
    ["渲染帧率", `${d.renderFps ?? 0} fps`],
    ["渲染耗时 (P95)", `${(d.renderP95Ms ?? 0).toFixed(1)} ms`],
    ["检测帧率", `${d.detectFps ?? 0} fps`],
    ["Worker 状态", d.workerStatus || "未启用"],
    ["掉帧增量", `${d.droppedDelta ?? 0}`],
    ["最近取帧时间", lastCapStr],
    ["叠层状态", d.overlayInfo || "未挂载"],
    ["全屏状态", d.fullscreenState || "非全屏"],
  ];
  if (state.unsupportedHints && state.unsupportedHints.length > 0) {
    rows.push(["待适配提示", state.unsupportedHints.join("、")]);
  }
  els.diagGrid.replaceChildren();
  for (const [k, v] of rows) {
    const kEl = document.createElement("span");
    kEl.textContent = k;
    const vEl = document.createElement("span");
    vEl.className = "val";
    vEl.textContent = String(v);
    els.diagGrid.appendChild(kEl);
    els.diagGrid.appendChild(vEl);
  }
}

async function refresh() {
  const res = await sendToTab({ type: "WVB_GET_STATE" });
  if (res && res.state) renderState(res.state);
}

function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panes = {
    skin: document.getElementById("pane-skin"),
    reshape: document.getElementById("pane-reshape"),
    io: document.getElementById("pane-io"),
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      for (const t of tabs) t.classList.toggle("active", t === tab);
      for (const [k, pane] of Object.entries(panes)) {
        pane.classList.toggle("hidden", k !== target);
      }
    });
  }
}

async function applyImportedJsonText(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    const { params, matched } = normalizeParams(parsed, PRESETS.reset.params);
    if (matched === 0) {
      showIoStatus("JSON 中未识别到有效美颜参数字段", true);
      return;
    }
    currentParams = params;
    syncSlidersUI(currentParams);
    await persistAndPushParams();
    showIoStatus(`已导入并应用 ${matched} 项参数`);
  } catch (err) {
    showIoStatus(`JSON 格式错误：${err.message}`, true);
  }
}

async function init() {
  buildSliders(els.skinSliders, SKIN_SLIDERS);
  buildSliders(els.reshapeSliders, RESHAPE_SLIDERS);
  setupTabs();

  const stored = await chrome.storage.local.get({ beautyParams: null, strength: null });
  if (stored.beautyParams && typeof stored.beautyParams === "object") {
    currentParams = normalizeParams(stored.beautyParams, DEFAULT_PARAMS).params;
  } else if (typeof stored.strength === "number") {
    currentParams = {
      ...DEFAULT_PARAMS,
      smooth: clamp01(stored.strength, DEFAULT_PARAMS.smooth),
      whiten: clamp01(stored.strength * 0.7, DEFAULT_PARAMS.whiten),
    };
  }
  syncSlidersUI(currentParams);

  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    showError("未找到活动标签页。");
    return;
  }
  currentTabId = tab.id;

  try {
    await ensureInjected(currentTabId);
    await sendToTab({ type: "WVB_INIT", params: currentParams });
    await refresh();
  } catch (err) {
    showError(`无法注入当前页面：${err.message || err}`);
    return;
  }

  pollTimer = setInterval(refresh, 700);
}

window.addEventListener("pointerup", () => {
  isDraggingSlider = false;
});
window.addEventListener("pointercancel", () => {
  isDraggingSlider = false;
});

els.presetBar.addEventListener("click", async (e) => {
  const btn = e.target.closest(".pill");
  if (!btn) return;
  const key = btn.dataset.preset;
  if (!key || !PRESETS[key]) return;
  currentParams = { ...PRESETS[key].params };
  syncSlidersUI(currentParams);
  await persistAndPushParams();
});

els.btnSaveCustom.addEventListener("click", async () => {
  await chrome.storage.local.set({ savedCustomParams: currentParams });
  showIoStatus("已保存到「我的方案」");
});

els.btnLoadCustom.addEventListener("click", async () => {
  const { savedCustomParams } = await chrome.storage.local.get({ savedCustomParams: null });
  if (!savedCustomParams) {
    showIoStatus("尚未保存「我的方案」", true);
    return;
  }
  currentParams = normalizeParams(savedCustomParams, DEFAULT_PARAMS).params;
  syncSlidersUI(currentParams);
  await persistAndPushParams();
  showIoStatus("已加载「我的方案」");
});

els.btnExportClip.addEventListener("click", async () => {
  const json = JSON.stringify(buildExportObject(), null, 2);
  els.presetJsonInput.value = json;
  try {
    await navigator.clipboard.writeText(json);
    showIoStatus("参数 JSON 已复制到剪贴板");
  } catch (_) {
    showIoStatus("已填入下方文本框，可手动复制");
  }
});

els.btnExportFile.addEventListener("click", () => {
  const json = JSON.stringify(buildExportObject(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `wink-beauty-preset-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showIoStatus("已导出 JSON 文件");
});

els.inputImportFile.addEventListener("change", async () => {
  const f = els.inputImportFile.files && els.inputImportFile.files[0];
  if (!f) return;
  const text = await f.text();
  els.presetJsonInput.value = text;
  await applyImportedJsonText(text);
  els.inputImportFile.value = "";
});

els.btnApplyJson.addEventListener("click", async () => {
  const text = els.presetJsonInput.value.trim();
  if (!text) {
    showIoStatus("请先粘贴参数 JSON", true);
    return;
  }
  await applyImportedJsonText(text);
});

els.toggleBeauty.addEventListener("change", async () => {
  const enabled = els.toggleBeauty.checked;
  const res = await sendToTab({ type: "WVB_SET_ENABLED", enabled });
  if (res && res.state) renderState(res.state);
});

els.videoSelect.addEventListener("change", async () => {
  const id = els.videoSelect.value;
  if (!id) return;
  const res = await sendToTab({ type: "WVB_SELECT_VIDEO", videoId: id });
  if (res && res.state) renderState(res.state);
});

const startCompare = async () => {
  els.btnCompare.classList.add("active");
  await sendToTab({ type: "WVB_SET_COMPARE", compareOriginal: true });
};
const stopCompare = async () => {
  els.btnCompare.classList.remove("active");
  await sendToTab({ type: "WVB_SET_COMPARE", compareOriginal: false });
};
els.btnCompare.addEventListener("pointerdown", startCompare);
window.addEventListener("pointerup", stopCompare);
window.addEventListener("pointercancel", stopCompare);
els.btnCompare.addEventListener("mouseleave", stopCompare);

els.btnRetry.addEventListener("click", async () => {
  const res = await sendToTab({ type: "WVB_RETRY_PROBE" });
  if (res && res.state) renderState(res.state);
});

els.btnRescan.addEventListener("click", async () => {
  const res = await sendToTab({ type: "WVB_RESCAN" });
  if (res && res.state) renderState(res.state);
});

els.btnCopyDiag.addEventListener("click", async () => {
  if (!lastState) return;
  const text = JSON.stringify(lastState, null, 2);
  await navigator.clipboard.writeText(text);
  els.copyHint.textContent = "已复制";
  setTimeout(() => (els.copyHint.textContent = ""), 1500);
});

window.addEventListener("unload", () => {
  if (pollTimer) clearInterval(pollTimer);
});

init();
