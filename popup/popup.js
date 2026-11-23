const SKIN_SLIDERS = [
  { key: "smooth", label: "磨皮" },
  { key: "skinTexture", label: "质感保留" },
  { key: "whiten", label: "美白" },
  { key: "rosy", label: "红润" },
  { key: "underEye", label: "去黑眼圈" },
  { key: "nasolabial", label: "淡法令纹" },
  { key: "matte", label: "去油光" },
];

const RESHAPE_SLIDERS = [
  { key: "slimFace", label: "瘦脸" },
  { key: "slimCheekbone", label: "窄颧骨" },
  { key: "vChin", label: "下巴长短", bipolar: true },
  { key: "bigEyes", label: "大眼" },
  { key: "eyeTilt", label: "眼尾上扬", bipolar: true },
  { key: "slimNose", label: "瘦鼻" },
  { key: "mouthSize", label: "嘴型大小", bipolar: true },
  { key: "mouthSmile", label: "微笑唇" },
];

const MAKEUP_SLIDERS = [
  { key: "brightEye", label: "亮眼" },
  { key: "contour", label: "立体修容" },
  { key: "lipTint", label: "润唇口红" },
  { key: "whitenTeeth", label: "牙齿美白" },
];

const COLOR_SLIDERS = [
  { key: "sharpen", label: "清晰锐化" },
  { key: "exposure", label: "亮度曝光", bipolar: true },
  { key: "contrast", label: "对比度", bipolar: true },
  { key: "saturation", label: "饱和度", bipolar: true },
  { key: "temperature", label: "色温冷暖", bipolar: true },
  { key: "softGlow", label: "氛围柔光" },
];

const ALL_SLIDERS = [
  ...SKIN_SLIDERS,
  ...RESHAPE_SLIDERS,
  ...MAKEUP_SLIDERS,
  ...COLOR_SLIDERS,
];

const BIPOLAR_KEYS = new Set(ALL_SLIDERS.filter((s) => s.bipolar).map((s) => s.key));

const LIP_SHADE_NAMES = ["裸粉", "蜜桃橘", "玫瑰豆沙", "复古正红"];
const LIP_SHADE_NAME_MAP = {
  裸粉: 0,
  nude: 0,
  pink: 0,
  蜜桃橘: 1,
  蜜桃: 1,
  peach: 1,
  coral: 1,
  玫瑰豆沙: 2,
  豆沙: 2,
  rose: 2,
  复古正红: 3,
  正红: 3,
  red: 3,
};

const DEFAULT_PARAMS = {
  // 美肤 (7)
  smooth: 0.45,
  skinTexture: 0.30,
  whiten: 0.30,
  rosy: 0.15,
  underEye: 0.25,
  nasolabial: 0.20,
  matte: 0.15,
  // 美型 (8)
  slimFace: 0.20,
  slimCheekbone: 0.12,
  vChin: 0.0,
  bigEyes: 0.15,
  eyeTilt: 0.0,
  slimNose: 0.12,
  mouthSize: 0.0,
  mouthSmile: 0.10,
  // 美妆 (5)
  brightEye: 0.20,
  contour: 0.15,
  lipTint: 0.18,
  lipShade: 2,
  whitenTeeth: 0.20,
  // 调色 (6)
  sharpen: 0.25,
  exposure: 0.0,
  contrast: 0.0,
  saturation: 0.0,
  temperature: 0.0,
  softGlow: 0.0,
};

const ZERO_PARAMS = {
  smooth: 0,
  skinTexture: 0,
  whiten: 0,
  rosy: 0,
  underEye: 0,
  nasolabial: 0,
  matte: 0,
  slimFace: 0,
  slimCheekbone: 0,
  vChin: 0,
  bigEyes: 0,
  eyeTilt: 0,
  slimNose: 0,
  mouthSize: 0,
  mouthSmile: 0,
  brightEye: 0,
  contour: 0,
  lipTint: 0,
  lipShade: 2,
  whitenTeeth: 0,
  sharpen: 0,
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  softGlow: 0,
};

const PRESETS = {
  natural: {
    name: "自然清透",
    params: {
      ...ZERO_PARAMS,
      smooth: 0.42,
      skinTexture: 0.35,
      whiten: 0.25,
      rosy: 0.14,
      underEye: 0.25,
      nasolabial: 0.18,
      matte: 0.15,
      slimFace: 0.16,
      slimCheekbone: 0.10,
      bigEyes: 0.12,
      slimNose: 0.08,
      mouthSmile: 0.08,
      brightEye: 0.20,
      contour: 0.12,
      lipTint: 0.14,
      lipShade: 2,
      whitenTeeth: 0.18,
      sharpen: 0.25,
    },
  },
  cool_fair: {
    name: "冷白质感",
    params: {
      ...ZERO_PARAMS,
      smooth: 0.55,
      skinTexture: 0.40,
      whiten: 0.58,
      rosy: 0.08,
      underEye: 0.35,
      nasolabial: 0.28,
      matte: 0.30,
      slimFace: 0.26,
      slimCheekbone: 0.18,
      vChin: 0.12,
      bigEyes: 0.18,
      slimNose: 0.16,
      mouthSmile: 0.08,
      brightEye: 0.32,
      contour: 0.26,
      lipTint: 0.24,
      lipShade: 2,
      whitenTeeth: 0.30,
      sharpen: 0.36,
      exposure: 0.12,
      contrast: 0.10,
      temperature: -0.22,
    },
  },
  soft_glow: {
    name: "日系柔光",
    params: {
      ...ZERO_PARAMS,
      smooth: 0.62,
      skinTexture: 0.22,
      whiten: 0.42,
      rosy: 0.30,
      underEye: 0.38,
      nasolabial: 0.28,
      matte: 0.12,
      slimFace: 0.20,
      slimCheekbone: 0.12,
      bigEyes: 0.22,
      slimNose: 0.10,
      mouthSmile: 0.14,
      brightEye: 0.24,
      contour: 0.10,
      lipTint: 0.28,
      lipShade: 1,
      whitenTeeth: 0.20,
      sharpen: 0.14,
      exposure: 0.10,
      contrast: -0.10,
      saturation: 0.06,
      temperature: 0.16,
      softGlow: 0.42,
    },
  },
  delicate: {
    name: "纯欲微调",
    params: {
      ...ZERO_PARAMS,
      smooth: 0.52,
      skinTexture: 0.28,
      whiten: 0.36,
      rosy: 0.36,
      underEye: 0.36,
      nasolabial: 0.26,
      matte: 0.18,
      slimFace: 0.30,
      slimCheekbone: 0.20,
      vChin: 0.16,
      bigEyes: 0.26,
      eyeTilt: 0.16,
      slimNose: 0.20,
      mouthSize: -0.10,
      mouthSmile: 0.22,
      brightEye: 0.34,
      contour: 0.20,
      lipTint: 0.36,
      lipShade: 0,
      whitenTeeth: 0.28,
      sharpen: 0.28,
      exposure: 0.06,
      softGlow: 0.18,
    },
  },
  glam: {
    name: "网感精修",
    params: {
      ...ZERO_PARAMS,
      smooth: 0.65,
      skinTexture: 0.38,
      whiten: 0.50,
      rosy: 0.22,
      underEye: 0.42,
      nasolabial: 0.38,
      matte: 0.35,
      slimFace: 0.38,
      slimCheekbone: 0.30,
      vChin: 0.24,
      bigEyes: 0.32,
      eyeTilt: 0.20,
      slimNose: 0.28,
      mouthSize: -0.06,
      mouthSmile: 0.20,
      brightEye: 0.40,
      contour: 0.38,
      lipTint: 0.42,
      lipShade: 3,
      whitenTeeth: 0.40,
      sharpen: 0.38,
      exposure: 0.08,
      contrast: 0.12,
      saturation: 0.08,
      temperature: -0.06,
      softGlow: 0.12,
    },
  },
  youthful: {
    name: "减龄打底",
    params: {
      ...ZERO_PARAMS,
      // 美肤：经典磨皮30 + 减龄打底 + 冷调白 + 雪冻浅腮红
      smooth: 0.42,
      skinTexture: 0.32,
      whiten: 0.56,
      rosy: 0.14,
      underEye: 0.34,
      nasolabial: 0.26,
      matte: 0.24,
      // 美型：小脸+20 / 颧骨+8 / 大眼+10眼高+8 / 眼睛倾斜-29 / 瘦鼻+34 / 丰唇+22
      slimFace: 0.28,
      slimCheekbone: 0.10,
      vChin: 0.12,
      bigEyes: 0.20,
      eyeTilt: -0.58,
      slimNose: 0.34,
      mouthSize: 0.22,
      mouthSmile: 0.12,
      // 美妆：眼窝+41 / 修容立体+65 / 豆沙口红+18
      brightEye: 0.42,
      contour: 0.65,
      lipTint: 0.18,
      lipShade: 2,
      whitenTeeth: 0.20,
      // 调色：饱和度-20 / 色温-8 / 清透微提亮
      sharpen: 0.26,
      exposure: 0.12,
      contrast: 0.08,
      saturation: -0.40,
      temperature: -0.16,
      softGlow: 0.14,
    },
  },
  reset: {
    name: "归零",
    params: { ...ZERO_PARAMS },
  },
};

const KEY_ALIASES = {
  // 美肤
  smooth: ["smooth", "磨皮", "肤质"],
  skinTexture: ["skinTexture", "skin_texture", "texture", "质感", "质感保留", "皮肤质感", "毛孔保留"],
  whiten: ["whiten", "whitening", "美白", "提亮", "肤色"],
  rosy: ["rosy", "blush", "红润", "气色", "腮红"],
  underEye: ["underEye", "under_eye", "darkCircle", "去黑眼圈", "黑眼圈", "眼下"],
  nasolabial: ["nasolabial", "smileLine", "法令纹", "淡法令纹", "去法令纹"],
  matte: ["matte", "deShine", "oilControl", "去油光", "哑光", "控油"],
  // 美型
  slimFace: ["slimFace", "slim_face", "瘦脸", "小脸"],
  slimCheekbone: ["slimCheekbone", "slim_cheekbone", "cheekbone", "窄颧骨", "瘦颧骨", "颧骨"],
  vChin: ["vChin", "v_chin", "chin", "下巴", "下巴长短", "v脸", "尖下巴"],
  bigEyes: ["bigEyes", "big_eyes", "enlargeEyes", "大眼", "大眼睛"],
  eyeTilt: ["eyeTilt", "eye_tilt", "眼尾", "眼尾上扬", "眼角"],
  slimNose: ["slimNose", "slim_nose", "瘦鼻", "缩鼻翼"],
  mouthSize: ["mouthSize", "mouth_size", "嘴型", "嘴型大小", "嘴巴大小"],
  mouthSmile: ["mouthSmile", "mouth_smile", "smile", "微笑唇", "微笑", "嘴角上扬"],
  // 美妆
  brightEye: ["brightEye", "bright_eye", "eyeBright", "亮眼", "眼神光"],
  contour: ["contour", "contouring", "修容", "立体修容", "鼻影"],
  lipTint: ["lipTint", "lip_tint", "lipstick", "润唇", "润唇口红", "口红"],
  lipShade: ["lipShade", "lip_shade", "lipColor", "唇色", "唇色风格", "口红色号"],
  whitenTeeth: ["whitenTeeth", "whiten_teeth", "teeth", "美牙", "牙齿美白", "白牙"],
  // 调色
  sharpen: ["sharpen", "clarity", "清晰", "锐化", "清晰锐化", "画质"],
  exposure: ["exposure", "brightness", "亮度", "曝光", "亮度曝光"],
  contrast: ["contrast", "对比度"],
  saturation: ["saturation", "饱和度"],
  temperature: ["temperature", "temp", "色温", "色温冷暖", "冷暖"],
  softGlow: ["softGlow", "soft_glow", "glow", "柔光", "氛围柔光", "梦幻柔光"],
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
  makeupSliders: document.getElementById("makeupSliders"),
  colorSliders: document.getElementById("colorSliders"),
  lipShadeList: document.getElementById("lipShadeList"),
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

function clampParam(key, val, fallback) {
  if (key === "lipShade") {
    if (typeof val === "string") {
      const mapped = LIP_SHADE_NAME_MAP[val.trim().toLowerCase()] ?? LIP_SHADE_NAME_MAP[val.trim()];
      if (mapped !== undefined) return mapped;
    }
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(LIP_SHADE_NAMES.length - 1, Math.round(n)));
  }
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  if (BIPOLAR_KEYS.has(key)) {
    const norm = Math.abs(n) > 1 ? n / 50 : n;
    return Math.max(-1, Math.min(1, norm));
  }
  const norm = n > 1 ? n / 100 : n;
  return Math.max(0, Math.min(1, norm));
}

function toUiValue(key, normVal) {
  if (BIPOLAR_KEYS.has(key)) {
    return Math.round((normVal ?? 0) * 50);
  }
  return Math.round((normVal ?? 0) * 100);
}

function formatSliderText(key, uiVal) {
  if (BIPOLAR_KEYS.has(key) && uiVal > 0) return `+${uiVal}`;
  return String(uiVal);
}

function updateValStyle(valEl, key, uiVal) {
  valEl.textContent = formatSliderText(key, uiVal);
  valEl.classList.toggle("zero", uiVal === 0);
  valEl.classList.toggle("bipolar-neg", BIPOLAR_KEYS.has(key) && uiVal < 0);
}

function normalizeParams(input, base = DEFAULT_PARAMS) {
  const out = { ...base };
  if (!input || typeof input !== "object") return { params: out, matched: 0 };
  const source = input.params && typeof input.params === "object" ? input.params : input;
  let matched = 0;
  for (const [key, aliases] of Object.entries(KEY_ALIASES)) {
    for (const alias of aliases) {
      if (source[alias] !== undefined) {
        out[key] = clampParam(key, source[alias], out[key]);
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
    const isBipolar = !!item.bipolar;
    const row = document.createElement("div");
    row.className = "slider-row";

    const nameEl = document.createElement("span");
    nameEl.className = "slider-name";
    nameEl.textContent = item.label;
    nameEl.title = "双击重置该项为 0";

    const input = document.createElement("input");
    input.type = "range";
    input.dataset.key = item.key;
    input.min = isBipolar ? "-50" : "0";
    input.max = isBipolar ? "50" : "100";
    if (isBipolar) input.classList.add("bipolar");
    input.title = isBipolar ? "双向精调 (-50 ~ +50)，双击归零" : "双击重置为 0";
    const initUi = toUiValue(item.key, currentParams[item.key] ?? 0);
    input.value = String(initUi);

    const valEl = document.createElement("span");
    valEl.className = "slider-val";
    updateValStyle(valEl, item.key, initUi);

    const resetSingle = () => {
      input.value = "0";
      updateValStyle(valEl, item.key, 0);
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
      const uiVal = Number(input.value);
      updateValStyle(valEl, item.key, uiVal);
      currentParams[item.key] = isBipolar ? uiVal / 50 : uiVal / 100;
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
      if (toUiValue(s.key, params[s.key] ?? 0) !== toUiValue(s.key, preset.params[s.key] ?? 0)) {
        same = false;
        break;
      }
    }
    if (same && (params.lipShade ?? 2) !== (preset.params.lipShade ?? 2)) {
      // Only enforce lipShade match when lipTint > 0 or preset is not reset
      if ((params.lipTint ?? 0) > 0 || key !== "reset") {
        same = false;
      }
    }
    if (same) return key;
  }
  return "custom";
}

function syncLipShadeUI(shadeIdx) {
  if (!els.lipShadeList) return;
  const idx = Math.max(0, Math.min(LIP_SHADE_NAMES.length - 1, Math.round(shadeIdx ?? 2)));
  const buttons = els.lipShadeList.querySelectorAll(".swatch");
  for (const btn of buttons) {
    btn.classList.toggle("active", Number(btn.dataset.shade) === idx);
  }
}

function syncSlidersUI(params) {
  for (const s of ALL_SLIDERS) {
    const uiVal = toUiValue(s.key, params[s.key] ?? 0);
    const input = sliderInputs.get(s.key);
    const valEl = sliderValues.get(s.key);
    if (input) input.value = String(uiVal);
    if (valEl) updateValStyle(valEl, s.key, uiVal);
  }
  syncLipShadeUI(params.lipShade ?? 2);
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
  const exported = {};
  for (const s of ALL_SLIDERS) {
    exported[s.key] = toUiValue(s.key, currentParams[s.key] ?? 0);
  }
  exported.lipShade = Math.max(0, Math.min(LIP_SHADE_NAMES.length - 1, Math.round(currentParams.lipShade ?? 2)));
  return {
    schema: "wvb-wink-preset-v2",
    name: PRESETS[activePresetKey]?.name || "自定义方案",
    lipShadeName: LIP_SHADE_NAMES[exported.lipShade],
    params: exported,
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
  els.videoSelect.replaceChildren();
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
    makeup: document.getElementById("pane-makeup"),
    color: document.getElementById("pane-color"),
    io: document.getElementById("pane-io"),
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      for (const t of tabs) t.classList.toggle("active", t === tab);
      for (const [k, pane] of Object.entries(panes)) {
        if (pane) pane.classList.toggle("hidden", k !== target);
      }
    });
  }
}

async function applyImportedJsonText(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    const { params, matched } = normalizeParams(parsed, ZERO_PARAMS);
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
  buildSliders(els.makeupSliders, MAKEUP_SLIDERS);
  buildSliders(els.colorSliders, COLOR_SLIDERS);
  setupTabs();

  const stored = await chrome.storage.local.get({ beautyParams: null, strength: null });
  if (stored.beautyParams && typeof stored.beautyParams === "object") {
    currentParams = normalizeParams(stored.beautyParams, DEFAULT_PARAMS).params;
  } else if (typeof stored.strength === "number") {
    currentParams = {
      ...DEFAULT_PARAMS,
      smooth: clampParam("smooth", stored.strength, DEFAULT_PARAMS.smooth),
      whiten: clampParam("whiten", stored.strength * 0.7, DEFAULT_PARAMS.whiten),
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

els.lipShadeList.addEventListener("click", async (e) => {
  const btn = e.target.closest(".swatch");
  if (!btn) return;
  const idx = clampParam("lipShade", btn.dataset.shade, 2);
  currentParams.lipShade = idx;
  if ((currentParams.lipTint ?? 0) === 0) {
    currentParams.lipTint = 0.25;
  }
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
  a.download = `realtime-beauty-preset-${Date.now()}.json`;
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
