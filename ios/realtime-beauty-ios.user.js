// ==UserScript==
// @name         实时美颜 · iOS Safari 专业版
// @namespace    https://local.realtime-beauty.ios/
// @version      1.1.0
// @description  iOS Safari (Userscripts / Stay) 实时网页视频美颜：26 项 Wink/剪映专业分项调参、7 档预设（含减龄打底）、JSON 与 Wink 中文配方文本解析、美颜剧场全屏 + 一键 90° 横屏旋转、可选 478 点人脸遮罩。
// @match        http://*/*
// @match        https://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
  if (window.__WVB_IOS_USERSCRIPT__) return;
  window.__WVB_IOS_USERSCRIPT__ = true;
  const IS_TOP_FRAME = window.top === window.self;

  // Early iOS inline-playback hooks: enforce playsinline BEFORE the site calls video.play()
  // so iPhone Safari does not hijack lazily-created <video> into native AVPlayer fullscreen.
  function forceInlineVideo(el) {
    if (!el || el.tagName !== "VIDEO") return;
    try {
      el.playsInline = true;
      if (!el.hasAttribute("playsinline")) el.setAttribute("playsinline", "");
      if (!el.hasAttribute("webkit-playsinline")) el.setAttribute("webkit-playsinline", "");
    } catch (_) {}
  }

  try {
    const origCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function (tagName, options) {
      const el = origCreateElement.call(this, tagName, options);
      if (typeof tagName === "string" && tagName.toLowerCase() === "video") {
        forceInlineVideo(el);
      }
      return el;
    };
  } catch (_) {}

  try {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      forceInlineVideo(this);
      return origPlay.apply(this, args);
    };
  } catch (_) {}

  // Intercept native iOS webkitEnterFullscreen when beauty engine is ready so tapping
  // a site's built-in fullscreen button smoothly enters Beauty Theater Fullscreen instead.
  let nativeFullscreenInterceptor = null;
  try {
    if (typeof HTMLVideoElement !== "undefined" && HTMLVideoElement.prototype.webkitEnterFullscreen) {
      const origWebkitEnterFs = HTMLVideoElement.prototype.webkitEnterFullscreen;
      HTMLVideoElement.prototype.webkitEnterFullscreen = function (...args) {
        if (nativeFullscreenInterceptor && nativeFullscreenInterceptor(this)) {
          return;
        }
        return origWebkitEnterFs.apply(this, args);
      };
    }
  } catch (_) {}

  const STORAGE_KEY_PARAMS = "__wvb_ios_params_v2";
  const STORAGE_KEY_PARAMS_LEGACY = "__wvb_ios_params_v1";
  const STORAGE_KEY_SAVED = "__wvb_ios_saved_v2";
  const STORAGE_KEY_FACE_OPT = "__wvb_ios_face_opt_v1";

  const MP_BUNDLE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs";
  const MP_WASM_DIR = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm";
  const MP_MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

  const IS_IOS_OR_MOBILE =
    /iPad|iPhone|iPod|Android|Mobile/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // ==================== 26-Parameter Wink / CapCut Pro Schema ====================
  const SKIN_SLIDERS = [
    { key: "smooth", label: "磨皮", needsFace: false },
    { key: "skinTexture", label: "质感保留", needsFace: false },
    { key: "whiten", label: "美白", needsFace: false },
    { key: "rosy", label: "红润", needsFace: false },
    { key: "underEye", label: "去黑眼圈", needsFace: true },
    { key: "nasolabial", label: "淡法令纹", needsFace: true },
    { key: "matte", label: "去油光", needsFace: false },
  ];

  const RESHAPE_SLIDERS = [
    { key: "slimFace", label: "瘦脸", needsFace: true },
    { key: "slimCheekbone", label: "窄颧骨", needsFace: true },
    { key: "vChin", label: "下巴长短", bipolar: true, needsFace: true },
    { key: "bigEyes", label: "大眼", needsFace: true },
    { key: "eyeTilt", label: "眼尾上扬", bipolar: true, needsFace: true },
    { key: "slimNose", label: "瘦鼻", needsFace: true },
    { key: "mouthSize", label: "嘴型大小", bipolar: true, needsFace: true },
    { key: "mouthSmile", label: "微笑唇", needsFace: true },
  ];

  const MAKEUP_SLIDERS = [
    { key: "brightEye", label: "亮眼", needsFace: true },
    { key: "contour", label: "立体修容", needsFace: true },
    { key: "lipTint", label: "润唇口红", needsFace: true },
    { key: "whitenTeeth", label: "牙齿美白", needsFace: true },
  ];

  const COLOR_SLIDERS = [
    { key: "sharpen", label: "清晰锐化", needsFace: false },
    { key: "exposure", label: "亮度曝光", bipolar: true, needsFace: false },
    { key: "contrast", label: "对比度", bipolar: true, needsFace: false },
    { key: "saturation", label: "饱和度", bipolar: true, needsFace: false },
    { key: "temperature", label: "色温冷暖", bipolar: true, needsFace: false },
    { key: "softGlow", label: "氛围柔光", needsFace: false },
  ];

  const ALL_SLIDERS = [
    ...SKIN_SLIDERS,
    ...RESHAPE_SLIDERS,
    ...MAKEUP_SLIDERS,
    ...COLOR_SLIDERS,
  ];

  const BIPOLAR_KEYS = new Set(ALL_SLIDERS.filter((s) => s.bipolar).map((s) => s.key));

  // 4 Wink-style lip color shades: 0=裸粉, 1=蜜桃橘, 2=玫瑰豆沙, 3=复古正红
  const LIP_SHADE_RGB = [
    [0.92, 0.56, 0.62],
    [0.95, 0.48, 0.36],
    [0.88, 0.32, 0.42],
    [0.82, 0.16, 0.24],
  ];
  const LIP_SHADE_NAMES = ["裸粉", "蜜桃橘", "玫瑰豆沙", "复古正红"];
  const LIP_SHADE_NAME_MAP = {
    裸粉: 0, nude: 0, pink: 0,
    蜜桃橘: 1, 蜜桃: 1, peach: 1, coral: 1,
    玫瑰豆沙: 2, 豆沙: 2, rose: 2,
    复古正红: 3, 正红: 3, red: 3,
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
    smooth: 0, skinTexture: 0, whiten: 0, rosy: 0, underEye: 0, nasolabial: 0, matte: 0,
    slimFace: 0, slimCheekbone: 0, vChin: 0, bigEyes: 0, eyeTilt: 0, slimNose: 0, mouthSize: 0, mouthSmile: 0,
    brightEye: 0, contour: 0, lipTint: 0, lipShade: 2, whitenTeeth: 0,
    sharpen: 0, exposure: 0, contrast: 0, saturation: 0, temperature: 0, softGlow: 0,
  };

  const PRESETS = {
    natural: {
      name: "自然清透",
      params: {
        ...ZERO_PARAMS,
        smooth: 0.42, skinTexture: 0.35, whiten: 0.25, rosy: 0.14, underEye: 0.25, nasolabial: 0.18, matte: 0.15,
        slimFace: 0.16, slimCheekbone: 0.10, bigEyes: 0.12, slimNose: 0.08, mouthSmile: 0.08,
        brightEye: 0.20, contour: 0.12, lipTint: 0.14, lipShade: 2, whitenTeeth: 0.18,
        sharpen: 0.25,
      },
    },
    cool_fair: {
      name: "冷白质感",
      params: {
        ...ZERO_PARAMS,
        smooth: 0.55, skinTexture: 0.40, whiten: 0.58, rosy: 0.08, underEye: 0.35, nasolabial: 0.28, matte: 0.30,
        slimFace: 0.26, slimCheekbone: 0.18, vChin: 0.12, bigEyes: 0.18, slimNose: 0.16, mouthSmile: 0.08,
        brightEye: 0.32, contour: 0.26, lipTint: 0.24, lipShade: 2, whitenTeeth: 0.30,
        sharpen: 0.36, exposure: 0.12, contrast: 0.10, temperature: -0.22,
      },
    },
    soft_glow: {
      name: "日系柔光",
      params: {
        ...ZERO_PARAMS,
        smooth: 0.62, skinTexture: 0.22, whiten: 0.42, rosy: 0.30, underEye: 0.38, nasolabial: 0.28, matte: 0.12,
        slimFace: 0.20, slimCheekbone: 0.12, bigEyes: 0.22, slimNose: 0.10, mouthSmile: 0.14,
        brightEye: 0.24, contour: 0.10, lipTint: 0.28, lipShade: 1, whitenTeeth: 0.20,
        sharpen: 0.14, exposure: 0.10, contrast: -0.10, saturation: 0.06, temperature: 0.16, softGlow: 0.42,
      },
    },
    delicate: {
      name: "纯欲微调",
      params: {
        ...ZERO_PARAMS,
        smooth: 0.52, skinTexture: 0.28, whiten: 0.36, rosy: 0.36, underEye: 0.36, nasolabial: 0.26, matte: 0.18,
        slimFace: 0.30, slimCheekbone: 0.20, vChin: 0.16, bigEyes: 0.26, eyeTilt: 0.16, slimNose: 0.20, mouthSize: -0.10, mouthSmile: 0.22,
        brightEye: 0.34, contour: 0.20, lipTint: 0.36, lipShade: 0, whitenTeeth: 0.28,
        sharpen: 0.28, exposure: 0.06, softGlow: 0.18,
      },
    },
    glam: {
      name: "网感精修",
      params: {
        ...ZERO_PARAMS,
        smooth: 0.65, skinTexture: 0.38, whiten: 0.50, rosy: 0.22, underEye: 0.42, nasolabial: 0.38, matte: 0.35,
        slimFace: 0.38, slimCheekbone: 0.30, vChin: 0.24, bigEyes: 0.32, eyeTilt: 0.20, slimNose: 0.28, mouthSize: -0.06, mouthSmile: 0.20,
        brightEye: 0.40, contour: 0.38, lipTint: 0.42, lipShade: 3, whitenTeeth: 0.40,
        sharpen: 0.38, exposure: 0.08, contrast: 0.12, saturation: 0.08, temperature: -0.06, softGlow: 0.12,
      },
    },
    youthful: {
      name: "减龄打底",
      params: {
        ...ZERO_PARAMS,
        smooth: 0.42, skinTexture: 0.32, whiten: 0.56, rosy: 0.14, underEye: 0.34, nasolabial: 0.26, matte: 0.24,
        slimFace: 0.28, slimCheekbone: 0.10, vChin: 0.12, bigEyes: 0.20, eyeTilt: -0.58, slimNose: 0.34, mouthSize: 0.22, mouthSmile: 0.12,
        brightEye: 0.42, contour: 0.65, lipTint: 0.18, lipShade: 2, whitenTeeth: 0.20,
        sharpen: 0.26, exposure: 0.12, contrast: 0.08, saturation: -0.40, temperature: -0.16, softGlow: 0.14,
      },
    },
    reset: {
      name: "归零",
      params: { ...ZERO_PARAMS },
    },
  };

  const KEY_ALIASES = {
    smooth: ["smooth", "磨皮", "肤质"],
    skinTexture: ["skinTexture", "skin_texture", "texture", "质感", "质感保留", "皮肤质感", "毛孔保留"],
    whiten: ["whiten", "whitening", "美白", "提亮", "肤色"],
    rosy: ["rosy", "blush", "红润", "气色", "腮红"],
    underEye: ["underEye", "under_eye", "darkCircle", "去黑眼圈", "黑眼圈", "眼下"],
    nasolabial: ["nasolabial", "smileLine", "法令纹", "淡法令纹", "去法令纹"],
    matte: ["matte", "deShine", "oilControl", "去油光", "哑光", "控油"],
    slimFace: ["slimFace", "slim_face", "瘦脸", "小脸"],
    slimCheekbone: ["slimCheekbone", "slim_cheekbone", "cheekbone", "窄颧骨", "瘦颧骨", "颧骨"],
    vChin: ["vChin", "v_chin", "chin", "下巴", "下巴长短", "v脸", "尖下巴"],
    bigEyes: ["bigEyes", "big_eyes", "enlargeEyes", "大眼", "大眼睛"],
    eyeTilt: ["eyeTilt", "eye_tilt", "眼尾", "眼尾上扬", "眼角"],
    slimNose: ["slimNose", "slim_nose", "瘦鼻", "缩鼻翼"],
    mouthSize: ["mouthSize", "mouth_size", "嘴型", "嘴型大小", "嘴巴大小"],
    mouthSmile: ["mouthSmile", "mouth_smile", "smile", "微笑唇", "微笑", "嘴角上扬"],
    brightEye: ["brightEye", "bright_eye", "eyeBright", "亮眼", "眼神光"],
    contour: ["contour", "contouring", "修容", "立体修容", "鼻影"],
    lipTint: ["lipTint", "lip_tint", "lipstick", "润唇", "润唇口红", "口红"],
    lipShade: ["lipShade", "lip_shade", "lipColor", "唇色", "唇色风格", "口红色号"],
    whitenTeeth: ["whitenTeeth", "whiten_teeth", "teeth", "美牙", "牙齿美白", "白牙"],
    sharpen: ["sharpen", "clarity", "清晰", "锐化", "清晰锐化", "画质"],
    exposure: ["exposure", "brightness", "亮度", "曝光", "亮度曝光"],
    contrast: ["contrast", "对比度"],
    saturation: ["saturation", "饱和度"],
    temperature: ["temperature", "temp", "色温", "色温冷暖", "冷暖"],
    softGlow: ["softGlow", "soft_glow", "glow", "柔光", "氛围柔光", "梦幻柔光"],
  };

  const SECTION_HEADERS = [
    { re: /^(?:先大轮廓|大轮廓|身材|美体)\s*[:：]?\s*/, section: "body" },
    { re: /^(?:面部调整|面部|美型|脸部)\s*[:：]?\s*/, section: "face" },
    { re: /^(?:眼睛|眼部)\s*[:：]?\s*/, section: "eye" },
    { re: /^(?:鼻子|鼻部)\s*[:：]?\s*/, section: "nose" },
    { re: /^(?:嘴巴|嘴部|唇部)\s*[:：]?\s*/, section: "mouth" },
    { re: /^(?:眉毛|眉部)\s*[:：]?\s*/, section: "brow" },
    { re: /^(?:处理皮肤|皮肤|美肤|肤质)\s*[:：]?\s*/, section: "skin" },
    { re: /^(?:美妆|妆容)\s*[:：]?\s*/, section: "makeup" },
    { re: /^(?:美发|头发)\s*[:：]?\s*/, section: "hair" },
    { re: /^(?:调色|画质|滤镜)\s*[:：]?\s*/, section: "color" },
  ];

  const UNSUPPORTED_RECIPE_TOKENS = [
    "小头", "天鹅颈", "直角肩", "瘦腰", "瘦腿", "长腿", "增高", "缩肩",
    "染发", "发际线", "高颅顶", "蓬松", "眉毛", "色调", "颗粒", "褪色",
  ];

  const FACE_OVAL_IDX = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
    397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
    172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
  ];
  const FOREHEAD_EXTEND = {
    10: 0.052, 338: 0.048, 109: 0.048, 297: 0.036, 67: 0.036, 332: 0.020, 103: 0.020,
  };
  const LEFT_EYE_IDX = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
  const RIGHT_EYE_IDX = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
  const LEFT_BROW_IDX = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
  const RIGHT_BROW_IDX = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];
  const LIPS_OUTER_IDX = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
  const LIPS_INNER_IDX = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
  const SMALL_FACE_SCAN_ROIS = [
    { x: 0.16, y: 0.04, w: 0.68, h: 0.72 },
    { x: 0.24, y: 0.14, w: 0.52, h: 0.58 },
    { x: 0.00, y: 0.06, w: 0.56, h: 0.70 },
    { x: 0.44, y: 0.06, w: 0.56, h: 0.70 },
  ];

  function safeStorageGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function safeStorageSet(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (_) {}
  }

  function clampParam(key, val, fallback) {
    if (key === "lipShade") {
      if (typeof val === "string") {
        const mapped = LIP_SHADE_NAME_MAP[val.trim().toLowerCase()] ?? LIP_SHADE_NAME_MAP[val.trim()];
        if (mapped !== undefined) return mapped;
      }
      const n = Number(val);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(0, Math.min(LIP_SHADE_RGB.length - 1, Math.round(n)));
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
    return BIPOLAR_KEYS.has(key) ? Math.round((normVal || 0) * 50) : Math.round((normVal || 0) * 100);
  }

  function formatSliderText(key, uiVal) {
    return BIPOLAR_KEYS.has(key) && uiVal > 0 ? `+${uiVal}` : String(uiVal);
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

  function detectLipShadeFromText(text) {
    if (/裸粉|奶茶|nude/i.test(text)) return 0;
    if (/蜜桃|橘|珊瑚|西柚|peach|coral/i.test(text)) return 1;
    if (/豆沙|玫瑰|干枯玫瑰|rose/i.test(text)) return 2;
    if (/正红|复古红|车厘子|酒红|红棕色|red/i.test(text)) return 3;
    return null;
  }

  function parseWinkTextRecipe(rawText) {
    const out = { ...ZERO_PARAMS };
    const matchedKeys = new Set();
    const skipped = [];
    const addSkipped = (label) => {
      const clean = label.replace(/[:：/].*$/, "").trim();
      if (clean && !skipped.includes(clean)) skipped.push(clean);
    };
    const setVal = (key, rawVal, { additive = false, scale = 1 } = {}) => {
      const norm = clampParam(key, rawVal * scale, out[key]);
      if (additive && matchedKeys.has(key)) {
        out[key] = BIPOLAR_KEYS.has(key)
          ? Math.max(-1, Math.min(1, out[key] + norm))
          : Math.max(0, Math.min(1, out[key] + norm));
      } else {
        out[key] = norm;
      }
      matchedKeys.add(key);
    };

    let section = "general";
    let hasCoolWhiteHint = false;
    let hasYouthBaseHint = false;

    const lines = rawText.split(/\r?\n/);
    for (const origLine of lines) {
      let line = origLine.trim();
      if (!line) continue;
      if (/一键美颜|减龄打底/.test(line)) hasYouthBaseHint = true;

      for (const h of SECTION_HEADERS) {
        const m = line.match(h.re);
        if (m) {
          if (m[0].length === line.length || /[:：]/.test(m[0])) {
            section = h.section;
            line = line.slice(m[0].length).trim();
            break;
          }
        }
      }
      if (!line) continue;

      const pairRe = /([\u4e00-\u9fa5A-Za-z_/]+)\s*[:：=]?\s*([+-]?\d+(?:\.\d+)?)/g;
      let match;
      let lineMatchedPair = false;
      while ((match = pairRe.exec(line)) !== null) {
        lineMatchedPair = true;
        const rawLabel = match[1].trim();
        const num = Number(match[2]);
        if (!Number.isFinite(num)) continue;

        const unsupportedHit = UNSUPPORTED_RECIPE_TOKENS.find((t) => rawLabel.includes(t));
        if (unsupportedHit) {
          addSkipped(unsupportedHit);
          continue;
        }

        if (/磨皮|肤质/.test(rawLabel)) {
          section = "skin"; setVal("smooth", Math.abs(num));
        } else if (/质感|毛孔/.test(rawLabel)) {
          section = "skin"; setVal("skinTexture", Math.abs(num));
        } else if (/冷调白|冷白|美白|提亮/.test(rawLabel)) {
          section = "skin"; setVal("whiten", Math.abs(num));
          if (/冷调白|冷白/.test(rawLabel)) hasCoolWhiteHint = true;
        } else if (/腮红|红润|气色/.test(rawLabel)) {
          section = "skin"; setVal("rosy", Math.abs(num));
        } else if (/黑眼圈/.test(rawLabel)) {
          section = "skin"; setVal("underEye", Math.abs(num));
        } else if (/法令纹/.test(rawLabel)) {
          section = "skin"; setVal("nasolabial", Math.abs(num));
        } else if (/去油光|控油|哑光/.test(rawLabel)) {
          section = "skin"; setVal("matte", Math.abs(num));
        } else if (/窄颧骨|瘦颧骨|颧骨/.test(rawLabel)) {
          section = "face"; setVal("slimCheekbone", Math.abs(num));
        } else if (/小脸|瘦脸/.test(rawLabel)) {
          section = "face"; setVal("slimFace", Math.abs(num));
        } else if (/下巴|v脸/i.test(rawLabel)) {
          section = "face"; setVal("vChin", num);
        } else if (/眼睛倾斜|眼倾斜|眼尾上扬|眼尾|眼角倾斜/.test(rawLabel)) {
          section = "eye"; setVal("eyeTilt", num);
        } else if (/大眼|眼睛大小|眼高|眼宽/.test(rawLabel)) {
          section = "eye"; setVal("bigEyes", Math.abs(num), { additive: true });
        } else if (/瘦鼻|缩鼻翼|鼻子大小|鼻翼|鼻头/.test(rawLabel)) {
          section = "nose"; setVal("slimNose", Math.abs(num));
        } else if (/鼻梁|山根/.test(rawLabel)) {
          section = "nose"; setVal("contour", Math.abs(num), { additive: true, scale: 0.7 });
        } else if (/丰唇/.test(rawLabel)) {
          section = "mouth"; setVal("mouthSize", num, { scale: 0.5 });
        } else if (/嘴型|嘴巴大小/.test(rawLabel)) {
          section = "mouth"; setVal("mouthSize", num);
        } else if (/微笑|嘴角/.test(rawLabel)) {
          section = "mouth"; setVal("mouthSmile", Math.abs(num));
        } else if (/眼影|眼窝|亮眼|卧蚕|美瞳|睫毛/.test(rawLabel)) {
          section = "makeup"; setVal("brightEye", Math.abs(num));
        } else if (/修容|鼻影/.test(rawLabel)) {
          section = "makeup"; setVal("contour", Math.abs(num));
        } else if (/口红|润唇|唇釉|唇彩/.test(rawLabel)) {
          section = "makeup"; setVal("lipTint", Math.abs(num));
          const shade = detectLipShadeFromText(rawLabel);
          if (shade !== null) { out.lipShade = shade; matchedKeys.add("lipShade"); }
        } else if (/美牙|牙齿|白牙/.test(rawLabel)) {
          section = "makeup"; setVal("whitenTeeth", Math.abs(num));
        } else if (/清晰|锐化/.test(rawLabel)) {
          section = "color"; setVal("sharpen", Math.abs(num));
        } else if (/曝光|亮度/.test(rawLabel)) {
          section = "color"; setVal("exposure", num);
        } else if (/对比度/.test(rawLabel)) {
          section = "color"; setVal("contrast", num);
        } else if (/饱和度/.test(rawLabel)) {
          section = "color"; setVal("saturation", num);
        } else if (/色温/.test(rawLabel)) {
          section = "color"; setVal("temperature", num);
        } else if (/柔光/.test(rawLabel)) {
          section = "color"; setVal("softGlow", Math.abs(num));
        } else if (section === "body" || section === "hair" || section === "brow") {
          addSkipped(section === "brow" ? `眉毛${rawLabel}` : rawLabel);
        } else if (section === "eye") {
          if (/倾斜/.test(rawLabel)) setVal("eyeTilt", num);
          else if (/大小|高度|眼高/.test(rawLabel)) setVal("bigEyes", Math.abs(num), { additive: true });
          else addSkipped(`眼睛${rawLabel}`);
        } else if (section === "nose") {
          if (/大小|鼻翼|鼻头/.test(rawLabel)) setVal("slimNose", Math.abs(num));
          else if (/鼻梁|山根/.test(rawLabel)) setVal("contour", Math.abs(num), { additive: true, scale: 0.7 });
          else addSkipped(`鼻子${rawLabel}`);
        } else if (section === "mouth") {
          if (/大小|宽度/.test(rawLabel)) setVal("mouthSize", num);
          else if (/微笑/.test(rawLabel)) setVal("mouthSmile", Math.abs(num));
          else addSkipped(`嘴巴${rawLabel}`);
        } else {
          let aliasHit = false;
          for (const [k, aliases] of Object.entries(KEY_ALIASES)) {
            if (aliases.some((a) => a.toLowerCase() === rawLabel.toLowerCase())) {
              setVal(k, num);
              aliasHit = true;
              break;
            }
          }
          if (!aliasHit) addSkipped(rawLabel);
        }
      }

      if (!lineMatchedPair) {
        if (section === "hair" || /染发|美发/.test(line)) {
          addSkipped("染发");
        } else if (/美白|冷调白|冷白/.test(line)) {
          setVal("whiten", /冷调白|冷白/.test(line) ? 52 : 40);
          if (/冷调白|冷白/.test(line)) hasCoolWhiteHint = true;
        } else if (/腮红/.test(line) && !matchedKeys.has("rosy")) {
          setVal("rosy", 16);
        } else if (/美瞳|卧蚕|睫毛/.test(line) && !matchedKeys.has("brightEye")) {
          setVal("brightEye", 28);
        } else if (/口红|润唇|唇釉/.test(line)) {
          const shade = detectLipShadeFromText(line);
          if (shade !== null) { out.lipShade = shade; matchedKeys.add("lipShade"); }
          if (!matchedKeys.has("lipTint")) setVal("lipTint", 20);
        }
      }
    }

    if (hasYouthBaseHint && matchedKeys.size > 0) {
      if (!matchedKeys.has("skinTexture")) out.skinTexture = 0.30;
      if (!matchedKeys.has("underEye")) out.underEye = 0.30;
      if (!matchedKeys.has("nasolabial")) out.nasolabial = 0.24;
      if (!matchedKeys.has("matte")) out.matte = 0.20;
      if (!matchedKeys.has("sharpen")) out.sharpen = 0.25;
    }
    if (hasCoolWhiteHint && !matchedKeys.has("temperature")) {
      out.temperature = -0.14;
      matchedKeys.add("temperature");
    }

    return { params: out, matched: matchedKeys.size, skipped };
  }

  // ==================== Inline MediaPipe 478-Point Worker (Zero-Lag IMAGE + ROI Edition) ====================
  const FACE_WORKER_SOURCE = `
    let landmarker = null;
    let initialized = false;
    let lastDetectTs = 0;
    let lockedBox = null;
    let lostSinceTs = 0;
    const LOCK_GRACE_MS = 140;

    const FAST_SET = new Set([
      33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
      263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466,
      70, 63, 105, 66, 107, 55, 65, 52, 53, 46,
      300, 293, 334, 296, 336, 285, 295, 282, 283, 276,
      61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
      78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191,
    ]);
    const RIGID_ANCHORS = [1, 33, 133, 263, 362, 168, 152, 234, 454];

    class MotionAdaptiveStabilizer {
      constructor() { this.reset(); }
      reset() { this.prevX = null; this.prevY = null; this.prevTs = null; this.velX = null; this.velY = null; }
      process(raw, box, tsMs, mode = "paired") {
        const n = raw.length;
        const out = new Float32Array(n * 4);
        const tsSec = tsMs / 1000;
        if (!this.prevX || this.prevX.length !== n || this.prevTs === null || tsSec - this.prevTs > 0.25) {
          this.prevX = new Float32Array(n); this.prevY = new Float32Array(n);
          this.velX = new Float32Array(n); this.velY = new Float32Array(n);
          this.prevTs = tsSec;
          for (let i = 0; i < n; i++) {
            this.prevX[i] = raw[i].x; this.prevY[i] = raw[i].y;
            out[i * 4] = raw[i].x; out[i * 4 + 1] = raw[i].y;
          }
          return out;
        }
        const dt = Math.max(tsSec - this.prevTs, 1e-3);
        this.prevTs = tsSec;
        const faceScale = Math.max(box.w, box.h, 0.04);
        let sumD = 0, cnt = 0;
        for (let k = 0; k < RIGID_ANCHORS.length; k++) {
          const idx = RIGID_ANCHORS[k];
          if (idx < n) { sumD += Math.hypot(raw[idx].x - this.prevX[idx], raw[idx].y - this.prevY[idx]); cnt++; }
        }
        const gDisp = cnt > 0 ? (sumD / cnt) / faceScale : 0;
        const gBoost = mode === "paired"
          ? Math.max(0, Math.min(1, (gDisp - 0.0045) / 0.0075))
          : Math.max(0, Math.min(1, (gDisp - 0.006) / 0.012));
        const vBlend = gDisp > 0.025 ? 0.85 : 0.55;
        for (let i = 0; i < n; i++) {
          const rx = raw[i].x, ry = raw[i].y;
          const px = this.prevX[i], py = this.prevY[i];
          const dx = rx - px, dy = ry - py;
          const nd = Math.hypot(dx, dy) / faceScale;
          const isFast = FAST_SET.has(i);
          const lo = isFast ? 0.0022 : 0.0032;
          const hi = isFast ? 0.0075 : 0.0110;
          const baseA = isFast ? 0.62 : 0.52;
          const m = Math.max(gBoost, Math.max(0, Math.min(1, (nd - lo) / (hi - lo))));
          const a = m >= 0.99 ? 1.0 : baseA + (1.0 - baseA) * m;
          const fx = a >= 1.0 ? rx : px + dx * a;
          const fy = a >= 1.0 ? ry : py + dy * a;
          const ivx = Math.max(-3, Math.min(3, (fx - px) / dt));
          const ivy = Math.max(-3, Math.min(3, (fy - py) / dt));
          const vx = this.velX[i] * (1 - vBlend) + ivx * vBlend;
          const vy = this.velY[i] * (1 - vBlend) + ivy * vBlend;
          this.prevX[i] = fx; this.prevY[i] = fy; this.velX[i] = vx; this.velY[i] = vy;
          out[i * 4] = fx; out[i * 4 + 1] = fy; out[i * 4 + 2] = vx; out[i * 4 + 3] = vy;
        }
        return out;
      }
    }
    const stab = new MotionAdaptiveStabilizer();
    function resetTracking() { lockedBox = null; lostSinceTs = 0; stab.reset(); }
    function mapRoi(raw, roi) {
      if (!roi || (roi.x === 0 && roi.y === 0 && roi.w === 1 && roi.h === 1)) return raw;
      const out = new Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = { x: roi.x + raw[i].x * roi.w, y: roi.y + raw[i].y * roi.h, z: raw[i].z };
      return out;
    }
    function bbox(lm) {
      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      for (let i = 0; i < lm.length; i++) {
        const p = lm[i];
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
      }
      const w = Math.max(0, maxX - minX), h = Math.max(0, maxY - minY);
      return { minX, minY, maxX, maxY, w, h, cx: (minX + maxX) * 0.5, cy: (minY + maxY) * 0.5, area: w * h };
    }
    function plausible(lm, b) {
      if (!lm || lm.length < 468 || b.w < 0.012 || b.h < 0.015 || b.w > 1.25 || b.h > 1.35) return false;
      const l = lm[33], r = lm[263];
      return !!(l && r && Math.hypot(r.x - l.x, r.y - l.y) >= 0.005);
    }
    function iou(a, b) {
      const inter = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) *
                    Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
      const u = a.area + b.area - inter;
      return u > 0 ? inter / u : 0;
    }
    function pickPrimary(list, roi, nowMs) {
      if (!list || !list.length) {
        if (lockedBox && lostSinceTs === 0) lostSinceTs = nowMs;
        if (lockedBox && nowMs - lostSinceTs > LOCK_GRACE_MS) resetTracking();
        return null;
      }
      const cands = [];
      for (let i = 0; i < list.length; i++) {
        const lm = mapRoi(list[i], roi);
        const box = bbox(lm);
        if (plausible(lm, box)) cands.push({ lm, box });
      }
      if (!cands.length) {
        if (lockedBox && lostSinceTs === 0) lostSinceTs = nowMs;
        if (lockedBox && nowMs - lostSinceTs > LOCK_GRACE_MS) resetTracking();
        return null;
      }
      let chosen = null;
      if (cands.length === 1) {
        chosen = cands[0];
        if (lockedBox) {
          const ov = iou(lockedBox, chosen.box);
          const sc = Math.max(lockedBox.w, lockedBox.h, chosen.box.w, chosen.box.h, 0.05);
          if (ov < 0.04 && Math.hypot(chosen.box.cx - lockedBox.cx, chosen.box.cy - lockedBox.cy) / sc > 1.2) stab.reset();
        }
      } else if (lockedBox) {
        let best = -1;
        const sc = Math.max(lockedBox.w, lockedBox.h, 0.05);
        for (const c of cands) {
          const ov = iou(lockedBox, c.box);
          const prox = Math.max(0, 1 - Math.hypot(c.box.cx - lockedBox.cx, c.box.cy - lockedBox.cy) / (sc * 2.2));
          const sr = Math.min(c.box.area, lockedBox.area) / Math.max(c.box.area, lockedBox.area, 1e-5);
          const score = ov * 0.55 + prox * 0.30 + sr * 0.15;
          if ((ov > 0.04 || prox > 0.35) && score > best) { best = score; chosen = c; }
        }
        if (!chosen) {
          if (lostSinceTs === 0) lostSinceTs = nowMs;
          if (nowMs - lostSinceTs <= LOCK_GRACE_MS) return null;
          resetTracking();
        }
      }
      if (!chosen) { cands.sort((a, b) => b.box.area - a.box.area); chosen = cands[0]; stab.reset(); }
      lockedBox = chosen.box; lostSinceTs = 0;
      return chosen;
    }
    self.onmessage = async (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === "INIT") {
        const pref = msg.delegate || "GPU";
        try {
          if (landmarker && landmarker.close) landmarker.close();
          const mod = await import(msg.bundleUrl);
          const tryOrder = pref === "CPU" ? ["CPU"] : ["GPU", "CPU"];
          for (const del of tryOrder) {
            try {
              const fileset = await mod.FilesetResolver.forVisionTasks(msg.wasmDir, true);
              landmarker = await mod.FaceLandmarker.createFromOptions(fileset, {
                baseOptions: { modelAssetPath: msg.modelUrl, delegate: del },
                runningMode: "IMAGE",
                numFaces: 2,
                minFaceDetectionConfidence: 0.22,
                minFacePresenceConfidence: 0.22,
                minTrackingConfidence: 0.50,
              });
              initialized = true;
              self.postMessage({ type: "READY", delegate: del });
              return;
            } catch (err) {
              if (del === "GPU" && pref !== "CPU") {
                self.postMessage({ type: "FALLBACK_CPU", reason: err && err.message ? err.message : String(err) });
                return;
              }
              throw err;
            }
          }
        } catch (err) {
          initialized = false;
          self.postMessage({ type: "UNAVAILABLE", reason: err && err.message ? err.message : String(err) });
        }
        return;
      }
      if (msg.type === "RESET") { resetTracking(); return; }
      if (msg.type === "CLOSE") {
        try { if (landmarker && landmarker.close) landmarker.close(); } catch (_) {}
        landmarker = null; initialized = false;
        self.postMessage({ type: "CLOSED" });
        return;
      }
      if (msg.type === "FRAME") {
        const bmp = msg.bitmap;
        const roi = msg.roi || { x: 0, y: 0, w: 1, h: 1 };
        try {
          if (!initialized || !landmarker) { self.postMessage({ type: "NO_MODEL", frameId: msg.frameId }); return; }
          if (msg.sceneCut) resetTracking();
          const t0 = performance.now();
          const ts = Math.max(lastDetectTs + 1, Math.floor(msg.timestampMs || performance.now()));
          lastDetectTs = ts;
          const res = landmarker.detect(bmp);
          const inferMs = performance.now() - t0;
          const primary = pickPrimary(res.faceLandmarks, roi, ts);
          if (!primary) {
            self.postMessage({ type: "RESULT", hasFace: false, frameId: msg.frameId, timestampMs: msg.timestampMs, inferMs, roiUsed: roi });
            return;
          }
          const sm = stab.process(primary.lm, primary.box, ts, msg.mode || "paired");
          self.postMessage({
            type: "RESULT", hasFace: true, landmarks: sm, faceBox: primary.box,
            frameId: msg.frameId, timestampMs: msg.timestampMs, inferMs, roiUsed: roi,
          }, [sm.buffer]);
        } catch (err) {
          self.postMessage({ type: "ERROR", frameId: msg.frameId, reason: err && err.message ? err.message : String(err) });
        } finally {
          if (bmp && bmp.close) bmp.close();
        }
      }
    };
  `;

  class MainThreadFaceTracker {
    constructor() {
      this.landmarker = null;
      this.lockedBox = null;
    }
    async init() {
      const mod = await import(MP_BUNDLE_URL);
      const fileset = await mod.FilesetResolver.forVisionTasks(MP_WASM_DIR, true);
      this.landmarker = await mod.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MP_MODEL_URL, delegate: "CPU" },
        runningMode: "IMAGE",
        numFaces: 2,
        minFaceDetectionConfidence: 0.24,
        minFacePresenceConfidence: 0.24,
        minTrackingConfidence: 0.50,
      });
    }
    reset() { this.lockedBox = null; }
    detect(canvas, roi = { x: 0, y: 0, w: 1, h: 1 }) {
      if (!this.landmarker) return null;
      const res = this.landmarker.detect(canvas);
      const list = res.faceLandmarks;
      if (!list || !list.length) return null;
      let best = null;
      let bestBox = null;
      let bestArea = -1;
      for (const raw of list) {
        let minX = 1, minY = 1, maxX = 0, maxY = 0;
        const mapped = new Array(raw.length);
        for (let i = 0; i < raw.length; i++) {
          const x = roi.x + raw[i].x * roi.w;
          const y = roi.y + raw[i].y * roi.h;
          mapped[i] = { x, y };
          if (x < minX) minX = x; if (y < minY) minY = y;
          if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        }
        const w = Math.max(0, maxX - minX), h = Math.max(0, maxY - minY);
        const a = w * h;
        if (w >= 0.012 && h >= 0.015 && a > bestArea) {
          bestArea = a;
          best = mapped;
          bestBox = { minX, minY, maxX, maxY, w, h, cx: (minX + maxX) * 0.5, cy: (minY + maxY) * 0.5, area: a };
        }
      }
      if (!best) return null;
      this.lockedBox = bestBox;
      const out = new Float32Array(best.length * 4);
      for (let i = 0; i < best.length; i++) {
        out[i * 4] = best[i].x;
        out[i * 4 + 1] = best[i].y;
      }
      return { landmarks: out, faceBox: bestBox };
    }
    close() {
      try { if (this.landmarker && this.landmarker.close) this.landmarker.close(); } catch (_) {}
      this.landmarker = null;
      this.lockedBox = null;
    }
  }

  // ==================== 26-Parameter Single-Pass WebGL Shader ====================
  const VERT_SRC = `
    attribute vec2 a_pos;
    uniform vec4 u_uvTransform;
    varying vec2 v_uv;
    void main() {
      vec2 rawUv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
      v_uv = rawUv * u_uvTransform.xy + u_uvTransform.zw;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const FRAG_SRC = `
    precision mediump float;
    uniform sampler2D u_video;
    uniform sampler2D u_mask;
    uniform vec2 u_texel;
    uniform float u_hasFaceMask;
    uniform float u_compareOriginal;

    uniform vec4 u_skinA;     // (smooth, skinTexture, whiten, rosy)
    uniform vec4 u_skinB;     // (underEye, nasolabial, matte, yawFactor)
    uniform vec4 u_reshapeA;  // (slimFace, slimCheekbone, vChin, bigEyes)
    uniform vec4 u_reshapeB;  // (eyeTilt, slimNose, mouthSize, mouthSmile)
    uniform vec4 u_makeupA;   // (brightEye, contour, lipTint, whitenTeeth)
    uniform vec4 u_lipColor;  // (lipR, lipG, lipB, aspect)
    uniform vec4 u_colorA;    // (sharpen, exposure, contrast, saturation)
    uniform vec4 u_colorB;    // (temperature, softGlow, fade, liteMode)
    uniform vec4 u_maskRect;  // (rx, ry, invRw, invRh) tight face-ROI mask UV mapping
    uniform vec4 u_yawVis;    // (leftVis, rightVis, reshapeGate, mouthHalfW)

    uniform vec4 u_eyes;          // (leftEyeX, leftEyeY, rightEyeX, rightEyeY)
    uniform vec4 u_eyeOuter;      // (leftOuterX, leftOuterY, rightOuterX, rightOuterY)
    uniform vec4 u_eyeRadii;      // (leftEyeR, rightEyeR, faceWidth, faceHeight)
    uniform vec4 u_noseBridge;    // (bridgeTopX, bridgeTopY, noseTipX, noseTipY)
    uniform vec4 u_chinMouth;     // (chinX, chinY, mouthCenterX, mouthCenterY)
    uniform vec4 u_mouthCorners;  // (leftCornerX, leftCornerY, rightCornerX, rightCornerY)
    uniform vec4 u_leftContour;   // (leftCheekX, leftCheekY, leftJawX, leftJawY)
    uniform vec4 u_rightContour;  // (rightCheekX, rightCheekY, rightJawX, rightJawY)
    uniform vec4 u_noseWings;     // (leftWingX, leftWingY, rightWingX, rightWingY)

    varying vec2 v_uv;

    vec2 warpEye(vec2 uv, vec2 center, float radius, float amount, float aspect) {
      vec2 d = uv - center;
      d.x *= aspect;
      float dist = length(d);
      if (dist < radius && radius > 0.001) {
        float t = dist / radius;
        float k = 1.0 - t * t;
        k = k * k * amount * 0.42;
        return uv - (uv - center) * k;
      }
      return uv;
    }

    vec2 warpPush(vec2 uv, vec2 fromPt, vec2 toPt, float radius, float strength, float aspect) {
      vec2 d = uv - fromPt;
      d.x *= aspect;
      float dist = length(d);
      if (dist < radius && radius > 0.001) {
        float t = dist / radius;
        float falloff = 1.0 - t * t;
        falloff = falloff * falloff;
        return uv - (toPt - fromPt) * (falloff * strength);
      }
      return uv;
    }

    float segMask(vec2 uv, vec2 a, vec2 b, float width, float aspect) {
      if (width <= 0.0005) return 0.0;
      vec2 pa = uv - a;
      vec2 ba = b - a;
      pa.x *= aspect;
      ba.x *= aspect;
      float denom = max(dot(ba, ba), 1e-5);
      float h = clamp(dot(pa, ba) / denom, 0.0, 1.0);
      float dist = length(pa - ba * h);
      return 1.0 - smoothstep(width * 0.25, width, dist);
    }

    float underEyeMask(vec2 uv, vec2 eyeCenter, float eyeR, float aspect, vec2 rightA, vec2 upA) {
      if (eyeR <= 0.001) return 0.0;
      vec2 cOffsetA = -upA * (eyeR * 0.74);
      vec2 c = eyeCenter + vec2(cOffsetA.x / aspect, cOffsetA.y);
      vec2 dA = vec2((uv.x - c.x) * aspect, uv.y - c.y);
      float lx = dot(dA, rightA) / (eyeR * 1.15);
      float ly = dot(dA, upA) / (eyeR * 0.50);
      float r2 = lx * lx + ly * ly;
      return clamp(1.0 - smoothstep(0.15, 1.0, r2), 0.0, 1.0);
    }

    float skinProbability(vec3 rgb) {
      float cb = -0.168736 * rgb.r - 0.331264 * rgb.g + 0.5 * rgb.b + 0.5;
      float cr =  0.5 * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b + 0.5;
      float wCb = smoothstep(0.28, 0.34, cb) * (1.0 - smoothstep(0.47, 0.52, cb));
      float wCr = smoothstep(0.51, 0.55, cr) * (1.0 - smoothstep(0.68, 0.73, cr));
      float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
      float wLuma = smoothstep(0.08, 0.18, luma) * (1.0 - smoothstep(0.92, 0.99, luma));
      return wCb * wCr * wLuma;
    }

    vec3 edgePreservingSmooth(vec2 uv, vec3 center, float smoothStrength, float textureKeep, float radiusScale, float liteMode) {
      float centerLuma = dot(center, vec3(0.299, 0.587, 0.114));
      float sigmaRange = mix(0.13 + 0.10 * smoothStrength, 0.075 + 0.055 * smoothStrength, textureKeep);
      vec3 acc = center * 0.8;
      float wSum = 0.8;

      vec2 offsets[12];
      offsets[0]  = vec2( 1.0,  0.0);
      offsets[1]  = vec2(-1.0,  0.0);
      offsets[2]  = vec2( 0.5,  0.866);
      offsets[3]  = vec2(-0.5,  0.866);
      offsets[4]  = vec2( 0.5, -0.866);
      offsets[5]  = vec2(-0.5, -0.866);
      offsets[6]  = vec2( 2.4,  0.9);
      offsets[7]  = vec2(-2.4,  0.9);
      offsets[8]  = vec2( 2.4, -0.9);
      offsets[9]  = vec2(-2.4, -0.9);
      offsets[10] = vec2( 0.0,  2.6);
      offsets[11] = vec2( 0.0, -2.6);

      for (int i = 0; i < 12; i++) {
        if (liteMode > 0.5 && i >= 6) break;
        vec2 sampleUv = clamp(uv + offsets[i] * u_texel * radiusScale, vec2(0.0), vec2(1.0));
        vec3 s = texture2D(u_video, sampleUv).rgb;
        float diff = dot(s, vec3(0.299, 0.587, 0.114)) - centerLuma;
        float w = exp(-(diff * diff) / (2.0 * sigmaRange * sigmaRange));
        float spatial = (i < 6) ? 1.0 : 0.72;
        acc += s * (w * spatial);
        wSum += w * spatial;
      }
      return acc / wSum;
    }

    void main() {
      if (u_compareOriginal > 0.5) {
        gl_FragColor = texture2D(u_video, v_uv);
        return;
      }

      float smoothAmt     = u_skinA.x;
      float skinTexAmt    = u_skinA.y;
      float whitenAmt     = u_skinA.z;
      float rosyAmt       = u_skinA.w;

      float underEyeAmt   = u_skinB.x;
      float nasolabialAmt = u_skinB.y;
      float matteAmt      = u_skinB.z;
      float yawFactor     = u_skinB.w;

      float slimFaceAmt   = u_reshapeA.x;
      float slimCheekAmt  = u_reshapeA.y;
      float vChinAmt      = u_reshapeA.z;
      float bigEyesAmt    = u_reshapeA.w;

      float eyeTiltAmt    = u_reshapeB.x;
      float slimNoseAmt   = u_reshapeB.y;
      float mouthSizeAmt  = u_reshapeB.z;
      float mouthSmileAmt = u_reshapeB.w;

      float brightEyeAmt  = u_makeupA.x;
      float contourAmt    = u_makeupA.y;
      float lipTintAmt    = u_makeupA.z;
      float teethAmt      = u_makeupA.w;

      vec3 lipShadeRgb    = u_lipColor.xyz;
      float aspect        = max(u_lipColor.w, 0.1);

      float sharpenAmt    = u_colorA.x;
      float exposureAmt   = u_colorA.y;
      float contrastAmt   = u_colorA.z;
      float satAmt        = u_colorA.w;

      float tempAmt       = u_colorB.x;
      float softGlowAmt   = u_colorB.y;
      float faceFade      = u_colorB.z;
      float liteMode      = u_colorB.w;

      float anyColor =
        sharpenAmt + abs(exposureAmt) + abs(contrastAmt) + abs(satAmt) + abs(tempAmt) + softGlowAmt;
      float anyFace =
        smoothAmt + whitenAmt + rosyAmt + underEyeAmt + nasolabialAmt + matteAmt +
        slimFaceAmt + slimCheekAmt + abs(vChinAmt) + bigEyesAmt + abs(eyeTiltAmt) +
        slimNoseAmt + abs(mouthSizeAmt) + mouthSmileAmt +
        brightEyeAmt + contourAmt + lipTintAmt + teethAmt;

      if (anyColor <= 0.001 && (anyFace <= 0.001 || faceFade <= 0.001)) {
        gl_FragColor = texture2D(u_video, v_uv);
        return;
      }

      vec2 noseTip = u_noseBridge.zw;
      vec2 chinPt  = u_chinMouth.xy;
      vec2 upA     = normalize(vec2((u_noseBridge.x - noseTip.x) * aspect, u_noseBridge.y - noseTip.y) + vec2(0.0, -1e-4));
      vec2 rightA  = vec2(-upA.y, upA.x);
      vec2 upUv    = vec2(upA.x / aspect, upA.y);

      float leftVis     = u_yawVis.x;
      float rightVis    = u_yawVis.y;
      float reshapeGate = u_yawVis.z;
      float mouthHalfW  = u_yawVis.w;
      float maxVis      = max(leftVis, rightVis);

      vec2 wuv = v_uv;
      float anyReshape =
        slimFaceAmt + slimCheekAmt + abs(vChinAmt) + bigEyesAmt +
        abs(eyeTiltAmt) + slimNoseAmt + abs(mouthSizeAmt) + mouthSmileAmt;
      if (u_hasFaceMask > 0.5 && liteMode < 0.5 && faceFade > 0.001 && reshapeGate > 0.01 && maxVis > 0.01 && anyReshape > 0.001) {
        float baseFade = faceFade * reshapeGate;
        float wL = baseFade * leftVis;
        float wR = baseFade * rightVis;
        float wCenter = baseFade * maxVis * (0.45 + 0.55 * yawFactor);
        float fw = max(u_eyeRadii.z, 0.02);
        float fh = max(u_eyeRadii.w, 0.02);

        if (bigEyesAmt > 0.001) {
          wuv = warpEye(wuv, u_eyes.xy, u_eyeRadii.x, bigEyesAmt * wL, aspect);
          wuv = warpEye(wuv, u_eyes.zw, u_eyeRadii.y, bigEyesAmt * wR, aspect);
        }
        if (abs(eyeTiltAmt) > 0.001) {
          vec2 shiftL = upUv * (u_eyeRadii.x * 0.28 * eyeTiltAmt * wL);
          vec2 shiftR = upUv * (u_eyeRadii.y * 0.28 * eyeTiltAmt * wR);
          wuv = warpPush(wuv, u_eyeOuter.xy, u_eyeOuter.xy + shiftL, max(u_eyeRadii.x * 0.85, 0.015), 0.9, aspect);
          wuv = warpPush(wuv, u_eyeOuter.zw, u_eyeOuter.zw + shiftR, max(u_eyeRadii.y * 0.85, 0.015), 0.9, aspect);
        }
        float effCheek = clamp(slimCheekAmt + slimFaceAmt * 0.22, 0.0, 1.0);
        if (effCheek > 0.001) {
          float rCheek = max(fw * 0.44, 0.02);
          wuv = warpPush(wuv, u_leftContour.xy,  noseTip, rCheek, effCheek * wL * 0.24, aspect);
          wuv = warpPush(wuv, u_rightContour.xy, noseTip, rCheek, effCheek * wR * 0.24, aspect);
        }
        if (slimFaceAmt > 0.001) {
          float rJaw = max(fw * 0.48, 0.02);
          vec2 jawTarget = mix(noseTip, chinPt, 0.55);
          wuv = warpPush(wuv, u_leftContour.zw,  jawTarget, rJaw, slimFaceAmt * wL * 0.28, aspect);
          wuv = warpPush(wuv, u_rightContour.zw, jawTarget, rJaw, slimFaceAmt * wR * 0.28, aspect);
        }
        if (abs(vChinAmt) > 0.001) {
          vec2 chinTarget = chinPt - upUv * (fh * 0.075 * vChinAmt * wCenter);
          wuv = warpPush(wuv, chinPt, chinTarget, max(fw * 0.36, 0.02), 0.85, aspect);
        }
        if (slimNoseAmt > 0.001) {
          float rNose = max(fw * 0.19, 0.015);
          wuv = warpPush(wuv, u_noseWings.xy, noseTip, rNose, slimNoseAmt * wL * 0.34, aspect);
          wuv = warpPush(wuv, u_noseWings.zw, noseTip, rNose, slimNoseAmt * wR * 0.34, aspect);
        }
        if (abs(mouthSizeAmt) > 0.001) {
          wuv = warpEye(wuv, u_chinMouth.zw, max(fw * 0.24, 0.02), mouthSizeAmt * 0.65 * wCenter, aspect);
        }
        if (mouthSmileAmt > 0.001) {
          float rMouth = max(fw * 0.14, 0.015);
          vec2 liftL = upUv * (fh * 0.042 * mouthSmileAmt * wL);
          vec2 liftR = upUv * (fh * 0.042 * mouthSmileAmt * wR);
          wuv = warpPush(wuv, u_mouthCorners.xy, u_mouthCorners.xy + liftL, rMouth, 0.9, aspect);
          wuv = warpPush(wuv, u_mouthCorners.zw, u_mouthCorners.zw + liftR, rMouth, 0.9, aspect);
        }
        wuv = clamp(wuv, vec2(0.0), vec2(1.0));
      }

      vec4 orig = texture2D(u_video, wuv);
      vec3 rgb = orig.rgb;

      vec2 maskUv = (wuv - u_maskRect.xy) * u_maskRect.zw;
      float inMask = step(0.0, maskUv.x) * step(maskUv.x, 1.0) * step(0.0, maskUv.y) * step(maskUv.y, 1.0);
      vec4 maskTex = (u_hasFaceMask > 0.5 && inMask > 0.5) ? texture2D(u_mask, maskUv) : vec4(0.0);
      float faceSkinMask = maskTex.r;
      float eyeMask = maskTex.g;
      float lipMask = maskTex.b;

      float origLuma = dot(orig.rgb, vec3(0.299, 0.587, 0.114));
      float skinW = skinProbability(orig.rgb);
      float hairProtect = smoothstep(0.06, 0.22, origLuma);
      float skinGate = mix(0.22 * hairProtect, 1.0, clamp(skinW * 1.15, 0.0, 1.0));
      float skinArea = (u_hasFaceMask > 0.5) ? (faceSkinMask * skinGate) : (skinW * 0.85);

      float ueW = 0.0;
      float nlW = 0.0;
      if (u_hasFaceMask > 0.5 && faceSkinMask > 0.01 && faceFade > 0.001) {
        if (underEyeAmt > 0.001) {
          float ueL = underEyeMask(wuv, u_eyes.xy, u_eyeRadii.x, aspect, rightA, upA);
          float ueR = underEyeMask(wuv, u_eyes.zw, u_eyeRadii.y, aspect, rightA, upA);
          ueW = max(ueL, ueR) * faceSkinMask;
        }
        if (nasolabialAmt > 0.001 && u_eyeRadii.z > 0.01) {
          float nlWidth = max(u_eyeRadii.z * 0.095, 0.01);
          vec2 nlL0 = mix(u_noseWings.xy, u_leftContour.xy, 0.16);
          vec2 nlL1 = mix(u_mouthCorners.xy, u_leftContour.zw, 0.16);
          vec2 nlR0 = mix(u_noseWings.zw, u_rightContour.xy, 0.16);
          vec2 nlR1 = mix(u_mouthCorners.zw, u_rightContour.zw, 0.16);
          nlW = max(segMask(wuv, nlL0, nlL1, nlWidth, aspect), segMask(wuv, nlR0, nlR1, nlWidth, aspect)) * faceSkinMask;
        }
      }

      vec3 smoothed = orig.rgb;
      float effSmooth = clamp(smoothAmt + ueW * underEyeAmt * 0.70 + nlW * nasolabialAmt * 0.65, 0.0, 1.0);
      bool didSmooth = false;
      if (skinArea > 0.01 && (effSmooth > 0.001 || matteAmt > 0.001) && faceFade > 0.001) {
        float radiusScale = 1.6 + max(effSmooth, matteAmt * 0.5) * 3.0;
        smoothed = edgePreservingSmooth(wuv, orig.rgb, max(effSmooth, 0.25), skinTexAmt, radiusScale, liteMode);
        didSmooth = true;
        if (effSmooth > 0.001) {
          float blend = clamp(skinArea * (0.25 + effSmooth * 0.75) * min(effSmooth * 2.2, 1.0) * faceFade, 0.0, 0.94);
          vec3 microTex = (orig.rgb - smoothed) * (skinTexAmt * 0.34);
          rgb = mix(rgb, clamp(smoothed + microTex, 0.0, 1.0), blend);
        }
      }

      if (skinArea > 0.01 && matteAmt > 0.001 && faceFade > 0.001) {
        float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
        float maxC = max(rgb.r, max(rgb.g, rgb.b));
        float minC = min(rgb.r, min(rgb.g, rgb.b));
        float glare = smoothstep(0.66, 0.94, luma) * (1.0 - smoothstep(0.16, 0.44, maxC - minC));
        vec3 baseSkin = didSmooth ? smoothed : rgb;
        vec3 matteTarget = min(rgb, baseSkin * 0.90 + vec3(0.06, 0.04, 0.03));
        rgb = mix(rgb, matteTarget, clamp(glare * matteAmt * 0.65 * skinArea * faceFade, 0.0, 0.75));
      }

      if (ueW > 0.01 && underEyeAmt > 0.001 && faceFade > 0.001) {
        float ueLift = ueW * underEyeAmt * 0.34 * faceFade;
        vec3 ueTarget = rgb + (1.0 - rgb) * vec3(0.96, 0.89, 0.80) * ueLift;
        rgb = mix(rgb, clamp(ueTarget, 0.0, 1.0), clamp(ueW * faceFade, 0.0, 0.90));
      }
      if (nlW > 0.01 && nasolabialAmt > 0.001 && faceFade > 0.001) {
        float nlLift = nlW * nasolabialAmt * 0.24 * faceFade;
        rgb = clamp(rgb + (1.0 - rgb) * (vec3(0.98, 0.94, 0.89) * nlLift), 0.0, 1.0);
      }

      if (skinArea > 0.01 && whitenAmt > 0.001 && faceFade > 0.001) {
        float lift = whitenAmt * 0.36 * skinArea * faceFade;
        rgb = clamp(rgb + (1.0 - rgb) * (vec3(0.97, 0.99, 1.04) * lift), 0.0, 1.0);
      }

      if (skinArea > 0.01 && rosyAmt > 0.001 && faceFade > 0.001) {
        float cheekW = 0.40;
        if (u_hasFaceMask > 0.5 && u_eyeRadii.z > 0.01) {
          vec2 lc = mix(u_leftContour.xy, u_noseBridge.zw, 0.45);
          vec2 rc = mix(u_rightContour.xy, u_noseBridge.zw, 0.45);
          vec2 dl = wuv - lc; dl.x *= aspect;
          vec2 dr = wuv - rc; dr.x *= aspect;
          float cr = u_eyeRadii.z * 0.30;
          float wL = 1.0 - smoothstep(0.0, cr, length(dl));
          float wR = 1.0 - smoothstep(0.0, cr, length(dr));
          cheekW = clamp(0.30 + max(wL, wR) * 0.85, 0.0, 1.0);
        }
        float rAmt = rosyAmt * skinArea * cheekW * 0.35 * faceFade;
        vec3 blush = mix(rgb, rgb * vec3(1.15, 0.92, 0.94) + vec3(0.07, 0.0, 0.02), rAmt);
        rgb = clamp(blush, 0.0, 1.0);
      }

      if (u_hasFaceMask > 0.5 && contourAmt > 0.001 && faceSkinMask > 0.01 && u_eyeRadii.z > 0.01 && faceFade > 0.001) {
        float fw = u_eyeRadii.z;
        float bridgeW = segMask(wuv, u_noseBridge.xy, u_noseBridge.zw, max(fw * 0.07, 0.008), aspect) * faceSkinMask;
        float jawEdgeL = segMask(wuv, u_leftContour.xy, u_leftContour.zw, max(fw * 0.16, 0.015), aspect) * faceSkinMask;
        float jawEdgeR = segMask(wuv, u_rightContour.xy, u_rightContour.zw, max(fw * 0.16, 0.015), aspect) * faceSkinMask;
        float shadeW = max(jawEdgeL, jawEdgeR);
        if (bridgeW > 0.01) rgb = clamp(rgb + (1.0 - rgb) * (bridgeW * contourAmt * 0.18 * faceFade), 0.0, 1.0);
        if (shadeW > 0.01) rgb = clamp(rgb * (1.0 - shadeW * contourAmt * 0.11 * faceFade), 0.0, 1.0);
      }

      if (eyeMask > 0.02 && brightEyeAmt > 0.001 && faceFade > 0.001) {
        float eAmt = eyeMask * brightEyeAmt * faceFade;
        float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
        vec3 contrasted = mix(rgb, clamp((rgb - 0.38) * (1.0 + 0.45 * eAmt) + 0.38, 0.0, 1.0), 0.80);
        vec3 eyeBright = contrasted + (1.0 - contrasted) * (0.22 * eAmt * smoothstep(0.25, 0.72, luma));
        rgb = clamp(eyeBright, 0.0, 1.0);
      }

      if (u_hasFaceMask > 0.5 && teethAmt > 0.001 && faceFade > 0.001 && mouthHalfW > 0.005) {
        vec2 dmA = vec2((wuv.x - u_chinMouth.z) * aspect, wuv.y - u_chinMouth.w);
        float mx = dot(dmA, rightA) / max(mouthHalfW * 0.92, 0.006);
        float my = dot(dmA, upA) / max(mouthHalfW * 0.62, 0.005);
        float mouthEnv = 1.0 - smoothstep(0.60, 1.05, mx * mx + my * my);
        float innerMouth = mouthEnv * clamp(1.0 - faceSkinMask * 1.6, 0.0, 1.0) * clamp(1.0 - lipMask * 1.8, 0.0, 1.0);
        if (innerMouth > 0.05) {
          float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
          float maxC = max(rgb.r, max(rgb.g, rgb.b));
          float minC = min(rgb.r, min(rgb.g, rgb.b));
          float redExcess = rgb.r - rgb.b;
          float isTooth = smoothstep(0.38, 0.62, luma) * (1.0 - smoothstep(0.14, 0.28, redExcess)) * (1.0 - smoothstep(0.18, 0.34, maxC - minC));
          float tAmt = isTooth * innerMouth * teethAmt * 0.70 * faceFade;
          if (tAmt > 0.01) {
            vec3 cleanWhite = mix(rgb, vec3(min(1.0, luma * 1.12 + 0.08)), 0.74);
            rgb = clamp(mix(rgb, cleanWhite, tAmt), 0.0, 1.0);
          }
        }
      }

      if (lipMask > 0.02 && lipTintAmt > 0.001 && faceFade > 0.001) {
        float lAmt = lipMask * lipTintAmt * 0.62 * faceFade;
        float lipLuma = dot(rgb, vec3(0.299, 0.587, 0.114));
        vec3 mulTone = mix(vec3(1.0), lipShadeRgb * 1.25, 0.65);
        vec3 softLip = mix(rgb, rgb * mulTone + lipShadeRgb * (0.28 * (1.0 - lipLuma)), lAmt);
        rgb = clamp(softLip, 0.0, 1.0);
      }

      float effSharp = sharpenAmt * 0.65 + eyeMask * brightEyeAmt * 0.45 * faceFade;
      if (liteMode < 0.5 && effSharp > 0.005) {
        vec3 n1 = texture2D(u_video, clamp(wuv + vec2( u_texel.x, 0.0), vec2(0.0), vec2(1.0))).rgb;
        vec3 n2 = texture2D(u_video, clamp(wuv + vec2(-u_texel.x, 0.0), vec2(0.0), vec2(1.0))).rgb;
        vec3 n3 = texture2D(u_video, clamp(wuv + vec2(0.0,  u_texel.y), vec2(0.0), vec2(1.0))).rgb;
        vec3 n4 = texture2D(u_video, clamp(wuv + vec2(0.0, -u_texel.y), vec2(0.0), vec2(1.0))).rgb;
        vec3 detail = orig.rgb - 0.25 * (n1 + n2 + n3 + n4);
        float sharpGate = mix(1.0, 1.0 - smoothAmt * 0.72 * faceFade, skinArea);
        sharpGate = max(sharpGate, eyeMask);
        rgb = clamp(rgb + detail * (effSharp * sharpGate), 0.0, 1.0);
      }

      if (abs(exposureAmt) > 0.001) rgb = clamp(rgb * pow(2.0, exposureAmt * 0.50), 0.0, 1.0);
      if (abs(contrastAmt) > 0.001) rgb = clamp((rgb - 0.5) * (1.0 + contrastAmt * 0.48) + 0.5, 0.0, 1.0);
      if (abs(satAmt) > 0.001) {
        float lum = dot(rgb, vec3(0.299, 0.587, 0.114));
        rgb = clamp(mix(vec3(lum), rgb, 1.0 + satAmt * 0.55), 0.0, 1.0);
      }
      if (abs(tempAmt) > 0.001) {
        rgb = clamp(rgb * vec3(1.0 + tempAmt * 0.12, 1.0 + tempAmt * 0.02, 1.0 - tempAmt * 0.14), 0.0, 1.0);
      }
      if (softGlowAmt > 0.005 && liteMode < 0.5) {
        vec2 gStep = u_texel * 3.5;
        vec3 g1 = texture2D(u_video, clamp(wuv + vec2( gStep.x,  gStep.y), vec2(0.0), vec2(1.0))).rgb;
        vec3 g2 = texture2D(u_video, clamp(wuv + vec2(-gStep.x,  gStep.y), vec2(0.0), vec2(1.0))).rgb;
        vec3 g3 = texture2D(u_video, clamp(wuv + vec2( gStep.x, -gStep.y), vec2(0.0), vec2(1.0))).rgb;
        vec3 g4 = texture2D(u_video, clamp(wuv + vec2(-gStep.x, -gStep.y), vec2(0.0), vec2(1.0))).rgb;
        vec3 glowAvg = 0.25 * (g1 + g2 + g3 + g4);
        vec3 bloom = max(glowAvg - vec3(0.50), vec3(0.0)) * 1.45;
        rgb = clamp(1.0 - (1.0 - rgb) * (1.0 - bloom * (softGlowAmt * 0.48)), 0.0, 1.0);
      }

      gl_FragColor = vec4(rgb, 1.0);
    }
  `;

  function createShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`Shader compile error: ${info}`);
    }
    return sh;
  }

  function createProgram(gl, vsSrc, fsSrc) {
    const vs = createShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`Program link error: ${info}`);
    }
    return prog;
  }

  // ==================== iOS Beauty Engine with Theater Fullscreen Support ====================
  class IosWebVideoBeautyEngine {
    constructor(onChange) {
      this.onChange = onChange || (() => {});
      this.enabled = false;
      this.faceTrackingEnabled = !!safeStorageGet(STORAGE_KEY_FACE_OPT, false);
      const saved = safeStorageGet(STORAGE_KEY_PARAMS, null) || safeStorageGet(STORAGE_KEY_PARAMS_LEGACY, null);
      this.params = saved ? normalizeParams(saved, DEFAULT_PARAMS).params : { ...DEFAULT_PARAMS };
      this.compareOriginal = false;
      this.faceAnchors = null;
      this.uvTransform = [1, 1, 0, 0];

      // Theater Fullscreen state (iOS web fullscreen + 90-deg landscape rotate)
      this.theaterActive = false;
      this.theaterRotated = false;
      this.theaterFill = false;
      this.theaterSlotEl = null;
      this.theaterBypassBeauty = false;

      this.videosMap = new Map();
      this.videoIds = new WeakMap();
      this.videoOrigins = new WeakMap();
      this.nextVideoId = 1;
      this.selectedVideoId = null;
      this.userLockedId = null;
      this.unsupportedHints = [];

      this.video = null;
      this.adapterName = "通用 HTML5";
      this.protectionSignal = "none";
      this.captureStatus = "idle";
      this.renderMode = "off";
      this.lastError = "";
      this.lastCapturedMediaTime = null;
      this.iosNativeFullscreen = false;

      this.probeCanvas = null;
      this.probeGl = null;
      this.probeTex = null;

      this.canvas = null;
      this.gl = null;
      this.program = null;
      this.videoTex = null;
      this.pendingTex = null;
      this.maskTex = null;
      this.posBuf = null;
      this.uniforms = {};
      this.contextLost = false;
      this.frameSeq = 0;
      this.pendingFrameId = 0;
      this.pendingMediaTime = 0;
      this.hasCommittedFrame = false;
      this.lastInferMs = 0;

      this.maskCanvas = document.createElement("canvas");
      this.maskCanvas.width = 256;
      this.maskCanvas.height = 256;
      this.maskCtx = this.maskCanvas.getContext("2d");
      this.maskRect = [0, 0, 1, 1];

      this.inferCanvas = document.createElement("canvas");
      this.inferCtx = this.inferCanvas.getContext("2d", { willReadFrequently: false });

      this.sceneCanvas = document.createElement("canvas");
      this.sceneCanvas.width = 8;
      this.sceneCanvas.height = 6;
      this.sceneCtx = this.sceneCanvas.getContext("2d", { willReadFrequently: true });
      this.prevSceneLuma = null;

      this.worker = null;
      this.workerBlobUrl = null;
      this.workerDelegatePref = "GPU";
      this.mainTracker = null;
      this.workerStatus = this.faceTrackingEnabled ? "待启动" : "肤色直出模式（未开478点）";
      this.workerReady = false;
      this.workerBusy = false;
      this.workerInitializing = false;
      this.workerUnavailable = false;
      this.lastInferSentMs = 0;
      this.latestLandmarks = null;
      this.latestLandmarkTs = 0;
      this.latestLandmarkRecvTs = 0;
      this.lastFaceBox = null;
      this.validFaceStreak = 0;
      this.missStreak = 0;
      this.scanStep = 0;
      this.pendingSceneCut = false;
      this.pendingRedispatch = false;
      this.hasNewVideoFrame = false;
      this.fadeWeight = 1.0;
      this.reshapeGate = 1.0;
      this.inferMsEma = 14;
      this.adaptiveInferEdge = IS_IOS_OR_MOBILE ? 384 : 512;
      this.lastGeomCheckMs = 0;
      this.lastGeomSig = "";

      this.rvfcHandle = null;
      this.rafHandle = null;
      this.probeTimer = null;
      this.probeAttempts = 0;
      this.resizeObserver = null;
      this.mutationObserver = null;
      this.mutationDebounce = null;
      this.boundVideoHandlers = [];
      this.boundDocCleanup = [];
      this.destroyed = false;

      this.degradeTier = "L0";
      this.renderTimes = [];
      this.renderFrameCount = 0;
      this.detectFrameCount = 0;
      this.lastFpsWindowMs = performance.now();
      this.renderFps = 0;
      this.detectFps = 0;
      this.renderP95Ms = 0;
      this.baseDroppedFrames = 0;
      this.droppedDelta = 0;
      this.overBudgetStreak = 0;
      this.lastMediaTime = -1;

      this.setupGlobalListeners();
      this.scanVideos();
    }

    setupGlobalListeners() {
      this.mutationObserver = new MutationObserver((mutations) => {
        if (this.destroyed) return;
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (!node || node.nodeType !== 1) continue;
            if (node.tagName === "VIDEO") forceInlineVideo(node);
            else if (node.querySelectorAll) {
              const vs = node.querySelectorAll("video");
              for (const v of vs) forceInlineVideo(v);
            }
          }
        }
        if (this.mutationDebounce) clearTimeout(this.mutationDebounce);
        this.mutationDebounce = setTimeout(() => this.scanVideos(), 260);
      });
      this.mutationObserver.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
      });

      document.addEventListener(
        "play",
        (e) => {
          if (this.destroyed) return;
          const t = e.target;
          if (!t || t.tagName !== "VIDEO") return;
          this.enforceInlinePlayback(t);
          if (t !== this.video && !this.theaterActive) {
            if (this.userLockedId && this.video && !this.video.paused) return;
            this.userLockedId = null;
            this.scanVideos();
          }
        },
        true
      );
      document.addEventListener("fullscreenchange", () => this.handleFullscreenChange());
      document.addEventListener("webkitfullscreenchange", () => this.handleFullscreenChange());
      document.addEventListener("visibilitychange", () => {
        if (this.destroyed) return;
        if (document.visibilityState === "hidden") {
          this.stopFrameLoop();
        } else if ((this.enabled || this.theaterActive) && this.captureStatus === "ready" && this.video && !this.video.paused && !this.video.ended) {
          this.renderSingleFrame(performance.now(), { skipInfer: true });
          this.startFrameLoop();
        }
      });
      const onViewportResize = () => this.syncCanvasGeometry();
      window.addEventListener("resize", onViewportResize);
      if (window.visualViewport) window.visualViewport.addEventListener("resize", onViewportResize);
      window.addEventListener("orientationchange", () => setTimeout(() => this.syncCanvasGeometry(), 250));
      window.addEventListener("scroll", () => { if (!this.theaterActive) this.syncCanvasGeometry(); }, { capture: true, passive: true });
      window.addEventListener("pagehide", () => this.teardownAll());
    }

    enforceInlinePlayback(v) {
      if (!v) return;
      try {
        v.playsInline = true;
        if (!v.hasAttribute("playsinline")) v.setAttribute("playsinline", "");
        if (!v.hasAttribute("webkit-playsinline")) v.setAttribute("webkit-playsinline", "");
      } catch (_) {}
    }

    collectVideosRecursive(root, frameOrigin, list, stats) {
      if (!root) return;
      const vids = root.querySelectorAll ? root.querySelectorAll("video") : [];
      for (const v of vids) {
        this.enforceInlinePlayback(v);
        this.videoOrigins.set(v, frameOrigin);
        list.push({ el: v, frameOrigin });
      }
      const canvases = root.querySelectorAll ? root.querySelectorAll("canvas") : [];
      for (const c of canvases) {
        if (c === this.canvas || c === this.probeCanvas || c.classList.contains("wvb-beauty-overlay")) continue;
        const r = c.getBoundingClientRect();
        if (r.width >= 200 && r.height >= 140) stats.largeCanvases++;
      }
      const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const el of all) {
        if (el.id === "wvb-ios-root") continue;
        if (el.shadowRoot) this.collectVideosRecursive(el.shadowRoot, frameOrigin, list, stats);
      }
      const iframes = root.querySelectorAll ? root.querySelectorAll("iframe") : [];
      for (const frame of iframes) {
        try {
          if (frame.contentDocument) {
            this.collectVideosRecursive(frame.contentDocument, "同源 iframe", list, stats);
          } else if (frame.contentWindow) {
            void frame.contentWindow.location.href;
          }
        } catch (_) {
          stats.crossOriginIframes++;
        }
      }
    }

    getVideoId(el) {
      let id = this.videoIds.get(el);
      if (!id) {
        id = `vid_${this.nextVideoId++}`;
        this.videoIds.set(el, id);
      }
      return id;
    }

    scoreVideo(v) {
      const win = (v.ownerDocument && v.ownerDocument.defaultView) || window;
      const rect = v.getBoundingClientRect();
      const style = win.getComputedStyle(v);
      const visible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        parseFloat(style.opacity || "1") > 0 &&
        rect.width > 16 &&
        rect.height > 16;
      if (!visible) return -1;

      const isTinyPreview = rect.width < 220 && v.muted && v.loop;
      const isMainPlayer = !!(v.closest(".plyr__video-wrapper, .plyr, xg-video-container, .xgplayer, .bpx-player-video-wrap, .html5-video-player"));
      const playingBonus = !isTinyPreview && !v.paused && !v.ended ? 1e7 : 0;
      const mainBonus = isMainPlayer ? 2e6 : 0;
      const unmutedBonus = !v.muted ? 1e5 : 0;
      return playingBonus + mainBonus + unmutedBonus + rect.width * rect.height - (isTinyPreview ? 5e6 : 0);
    }

    scanVideos() {
      const found = [];
      const stats = { crossOriginIframes: 0, largeCanvases: 0 };
      this.collectVideosRecursive(document, "主页面", found, stats);

      const hints = [];
      if (stats.crossOriginIframes > 0) hints.push(`跨域 iframe (${stats.crossOriginIframes} 个)`);
      if (stats.largeCanvases > 0) hints.push(`大尺寸 Canvas (${stats.largeCanvases} 个)`);
      this.unsupportedHints = hints;

      this.videosMap.clear();
      const ranked = [];
      for (const item of found) {
        const id = this.getVideoId(item.el);
        this.videosMap.set(id, item.el);
        ranked.push({ id, el: item.el, score: this.scoreVideo(item.el) });
      }
      if (this.userLockedId && !this.videosMap.has(this.userLockedId)) this.userLockedId = null;
      let nextId = this.userLockedId;
      if (!nextId) {
        ranked.sort((a, b) => b.score - a.score);
        nextId = ranked.length ? ranked[0].id : null;
      }
      if (nextId !== this.selectedVideoId && !this.theaterActive) this.bindVideo(nextId);
      this.onChange();
    }

    selectVideoByUser(videoId) {
      if (!this.videosMap.has(videoId)) return;
      this.userLockedId = videoId;
      this.bindVideo(videoId);
      this.onChange();
    }

    bindVideo(videoId) {
      this.unbindCurrentVideo();
      this.selectedVideoId = videoId;
      this.video = videoId ? this.videosMap.get(videoId) || null : null;
      this.protectionSignal = "none";
      this.captureStatus = this.video ? "waiting" : "idle";
      this.lastError = "";
      this.lastCapturedMediaTime = null;
      this.iosNativeFullscreen = false;
      this.probeAttempts = 0;
      this.resetTrackingAndFade();

      if (!this.video) {
        this.renderMode = "off";
        return;
      }

      const v = this.video;
      this.enforceInlinePlayback(v);
      const doc = v.ownerDocument || document;
      const win = doc.defaultView || window;
      this.adapterName = this.detectAdapterName(v);
      this.baseDroppedFrames = this.getDroppedFrames(v);

      const on = (evt, fn) => {
        v.addEventListener(evt, fn);
        this.boundVideoHandlers.push([evt, fn]);
      };

      on("encrypted", () => {
        this.protectionSignal = "eme_encrypted_event";
        this.captureStatus = "skipped_eme";
        this.stopBeautyOverlay("检测到 EME 加密事件，已跳过取帧并保持原画。");
        this.onChange();
      });
      on("webkitbeginfullscreen", () => {
        this.iosNativeFullscreen = true;
        this.hideCanvas();
        this.stopFrameLoop();
        if (this.enabled) this.renderMode = "native_fallback";
        this.onChange();
      });
      on("webkitendfullscreen", () => {
        this.iosNativeFullscreen = false;
        if ((this.enabled || this.theaterActive) && this.captureStatus === "ready") {
          this.showCanvas();
          this.syncCanvasGeometry();
          this.renderSingleFrame(performance.now(), { skipInfer: true });
          if (!v.paused && !v.ended) this.startFrameLoop();
        }
        this.onChange();
      });
      on("emptied", () => this.handleSourceReset());
      on("loadedmetadata", () => this.syncCanvasGeometry());
      on("loadeddata", () => {
        this.probeAttempts = 0;
        this.runProtectionAndProbe();
      });
      on("resize", () => this.syncCanvasGeometry());
      on("seeked", () => {
        this.resetTrackingAndFade();
        if ((this.enabled || this.theaterActive) && this.captureStatus === "ready") {
          this.renderSingleFrame(performance.now(), { skipInfer: true, forceUpload: true });
          if (this.workerReady && !this.maybeDispatchInference(performance.now(), true)) {
            this.pendingRedispatch = true;
          }
        } else if (!this.enabled && this.protectionSignal === "none") {
          this.runProtectionAndProbe();
        }
      });
      on("playing", () => {
        if (this.enabled || this.theaterActive) {
          if (this.captureStatus !== "ready") this.runProtectionAndProbe();
          else this.startFrameLoop();
        } else if (this.captureStatus !== "ready" && this.protectionSignal === "none") {
          this.runProtectionAndProbe();
        }
      });
      on("pause", () => {
        this.stopFrameLoop();
        if ((this.enabled || this.theaterActive) && this.captureStatus === "ready") {
          this.renderSingleFrame(performance.now(), { skipInfer: true, forceUpload: !this.hasCommittedFrame });
          if (this.workerReady && !this.maybeDispatchInference(performance.now(), true)) {
            this.pendingRedispatch = true;
          }
        }
      });
      on("ended", () => this.stopFrameLoop());
      on("error", () => {
        this.stopFrameLoop();
        if (this.enabled) this.stopBeautyOverlay("视频播放出错，已保持原画。");
      });

      if (doc !== document) {
        const onFs = () => this.handleFullscreenChange();
        const onSync = () => this.syncCanvasGeometry();
        doc.addEventListener("fullscreenchange", onFs);
        win.addEventListener("resize", onSync);
        win.addEventListener("scroll", onSync, true);
        this.boundDocCleanup.push(() => {
          doc.removeEventListener("fullscreenchange", onFs);
          win.removeEventListener("resize", onSync);
          win.removeEventListener("scroll", onSync, true);
        });
      }

      if (typeof ResizeObserver === "function") {
        this.resizeObserver = new ResizeObserver(() => this.syncCanvasGeometry());
        this.resizeObserver.observe(v);
      }

      this.runProtectionAndProbe();
    }

    unbindCurrentVideo() {
      this.stopFrameLoop();
      if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null; }
      if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null; }
      for (const c of this.boundDocCleanup) { try { c(); } catch (_) {} }
      this.boundDocCleanup = [];
      if (this.video) {
        for (const [evt, fn] of this.boundVideoHandlers) this.video.removeEventListener(evt, fn);
      }
      this.boundVideoHandlers = [];
      this.destroyWebGLAndCanvas();
      this.video = null;
    }

    handleSourceReset() {
      this.stopFrameLoop();
      this.protectionSignal = "none";
      this.captureStatus = "waiting";
      this.lastCapturedMediaTime = null;
      this.probeAttempts = 0;
      this.resetTrackingAndFade();
      this.runProtectionAndProbe();
    }

    resetTrackingAndFade() {
      this.latestLandmarks = null;
      this.latestLandmarkTs = 0;
      this.latestLandmarkRecvTs = 0;
      this.faceAnchors = null;
      this.lastFaceBox = null;
      this.prevSceneLuma = null;
      this.validFaceStreak = 0;
      this.missStreak = 0;
      this.scanStep = 0;
      this.pendingSceneCut = false;
      this.pendingRedispatch = false;
      this.hasNewVideoFrame = false;
      this.fadeWeight = this.workerReady ? 0.0 : 1.0;
      this.reshapeGate = 1.0;
      this.maskRect = [0, 0, 1, 1];
      this.lastMediaTime = -1;
      this.hasCommittedFrame = false;
      this.pendingFrameId = 0;
      if (this.worker) this.worker.postMessage({ type: "RESET" });
      if (this.mainTracker) this.mainTracker.reset();
    }

    detectAdapterName(video) {
      if (video.closest(".plyr__video-wrapper, .plyr")) return "Plyr 播放器适配";
      if (video.closest("xg-video-container, .xgplayer")) return "XGPlayer 容器适配";
      if (video.closest(".bpx-player-video-wrap")) return "Bilibili 播放器适配";
      if (video.closest(".html5-video-player")) return "YouTube 播放器适配";
      return "通用 HTML5 播放器";
    }

    checkProtectionOnly() {
      if (!this.video) return false;
      if (this.video.mediaKeys) {
        this.protectionSignal = "eme_media_keys";
        this.captureStatus = "skipped_eme";
        return true;
      }
      return false;
    }

    probeFrameCaptureOnly() {
      if (!this.probeGl) {
        const c = document.createElement("canvas");
        c.width = 2; c.height = 2;
        const gl = c.getContext("webgl2") || c.getContext("webgl");
        if (!gl) throw new Error("WebGL unavailable");
        this.probeCanvas = c;
        this.probeGl = gl;
        this.probeTex = this.createLinearTexture(gl);
      }
      const gl = this.probeGl;
      gl.bindTexture(gl.TEXTURE_2D, this.probeTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
      const err = gl.getError();
      if (err !== gl.NO_ERROR) throw new Error(`WebGL error code: ${err}`);
    }

    runProtectionAndProbe() {
      if (!this.video) return;
      if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null; }
      if (this.checkProtectionOnly()) {
        this.stopBeautyOverlay("检测到 EME mediaKeys，已跳过取帧。");
        return;
      }
      if (this.video.readyState < 2 || this.video.videoWidth === 0 || this.video.videoHeight === 0) {
        this.captureStatus = "waiting";
        return;
      }
      const activeRender = this.enabled || this.theaterActive;
      if (activeRender && !this.ensureWebGL()) {
        this.captureStatus = "failed_unknown";
        this.stopBeautyOverlay("WebGL 上下文初始化失败，已保持原画。");
        return;
      }
      try {
        if (activeRender) {
          const gl = this.gl;
          gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
          const err = gl.getError();
          if (err !== gl.NO_ERROR) throw new Error(`WebGL error code: ${err}`);
          this.captureStatus = "ready";
          this.lastCapturedMediaTime = this.video.currentTime;
          this.lastError = "";
          this.probeAttempts = 0;
          if (this.enabled && this.faceTrackingEnabled) this.ensureFaceTracking();
          this.showCanvas();
          this.syncCanvasGeometry();
          this.renderSingleFrame(performance.now(), { skipInfer: false });
          if (!this.video.paused && !this.video.ended) this.startFrameLoop();
        } else {
          this.probeFrameCaptureOnly();
          this.captureStatus = "ready";
          this.lastCapturedMediaTime = this.video.currentTime;
          this.lastError = "";
          this.probeAttempts = 0;
          this.renderMode = "off";
        }
      } catch (err) {
        const name = err && err.name ? err.name : "";
        const msg = err && err.message ? err.message : String(err);
        if (name === "SecurityError" || /tainted|cross-origin|security/i.test(msg)) {
          this.captureStatus = "cors_restricted";
          this.stopBeautyOverlay("跨域取帧受限（SecurityError），已恢复原画。");
          return;
        }
        if (this.probeAttempts < 3) {
          const delay = 300 * Math.pow(2, this.probeAttempts++);
          this.captureStatus = "waiting";
          this.probeTimer = setTimeout(() => this.runProtectionAndProbe(), delay);
        } else {
          this.captureStatus = "failed_unknown";
          this.stopBeautyOverlay("取帧失败，原因未确认，已恢复原画。");
        }
      }
    }

    getMountContainer(video) {
      return (
        video.closest(".plyr__video-wrapper") ||
        video.closest("xg-video-container") ||
        video.closest(".bpx-player-video-wrap") ||
        video.closest(".html5-video-player") ||
        video.parentElement ||
        (video.ownerDocument && video.ownerDocument.body) ||
        document.body
      );
    }

    findPositionedAncestor(el, win) {
      let cur = el;
      while (cur && cur !== cur.ownerDocument.body && cur !== cur.ownerDocument.documentElement) {
        const cs = win.getComputedStyle(cur);
        if (cs.position !== "static" || cs.transform !== "none" || cs.filter !== "none") return cur;
        cur = cur.parentElement;
      }
      return (el && el.ownerDocument && el.ownerDocument.body) || document.body;
    }

    mountCanvasBackToVideo() {
      if (!this.canvas || !this.video) return;
      const doc = this.video.ownerDocument || document;
      const win = doc.defaultView || window;
      const container = this.getMountContainer(this.video);
      if (win.getComputedStyle(container).position === "static") container.style.position = "relative";
      this.canvas.style.setProperty("position", "absolute", "important");
      this.canvas.style.setProperty("pointer-events", "none", "important");
      this.canvas.style.setProperty("transform", "translateZ(0)", "important");
      if (this.video.parentElement === container && this.video.nextSibling) {
        container.insertBefore(this.canvas, this.video.nextSibling);
      } else {
        container.appendChild(this.canvas);
      }
    }

    enterTheaterMode(slotEl) {
      if (!this.video) return { ok: false, reason: "未检测到视频" };
      if (this.captureStatus === "cors_restricted" || this.captureStatus === "skipped_eme") {
        return { ok: false, reason: "当前视频受跨域/DRM 限制，无法启用美颜全屏" };
      }
      if (!this.enabled) {
        this.enabled = true;
      }
      this.theaterActive = true;
      this.theaterSlotEl = slotEl;
      if (!this.ensureWebGL()) {
        this.theaterActive = false;
        this.theaterSlotEl = null;
        return { ok: false, reason: "WebGL 初始化失败" };
      }
      if (this.captureStatus !== "ready") {
        this.runProtectionAndProbe();
      }
      if (this.captureStatus !== "ready") {
        this.theaterActive = false;
        this.theaterSlotEl = null;
        return { ok: false, reason: this.lastError || "视频尚未就绪，请先点播放" };
      }

      // Move ONLY our own WebGL overlay canvas into the fullscreen theater stage
      // (never reparent the site's <video>, keeping HLS/MSE/audio 100% intact).
      this.canvas.style.setProperty("position", "relative", "important");
      this.canvas.style.setProperty("left", "0", "important");
      this.canvas.style.setProperty("top", "0", "important");
      this.canvas.style.setProperty("z-index", "1", "important");
      this.canvas.style.setProperty("display", "block", "important");
      slotEl.replaceChildren(this.canvas);

      this.syncCanvasGeometry();
      this.renderSingleFrame(performance.now(), { skipInfer: true });
      if (!this.video.paused && !this.video.ended) this.startFrameLoop();
      this.onChange();
      return { ok: true };
    }

    exitTheaterMode() {
      if (!this.theaterActive) return;
      this.theaterActive = false;
      this.theaterRotated = false;
      this.theaterFill = false;
      this.theaterSlotEl = null;
      if (this.canvas && this.video) {
        this.mountCanvasBackToVideo();
        if (this.enabled && this.captureStatus === "ready") {
          this.showCanvas();
          this.syncCanvasGeometry();
          this.renderSingleFrame(performance.now(), { skipInfer: true });
          if (!this.video.paused && !this.video.ended) this.startFrameLoop();
        } else {
          this.hideCanvas();
          this.stopFrameLoop();
        }
      }
      this.onChange();
    }

    setTheaterRotated(flag) {
      this.theaterRotated = !!flag;
      this.syncCanvasGeometry();
      if ((this.enabled || this.theaterActive) && this.captureStatus === "ready") {
        this.renderSingleFrame(performance.now(), { skipInfer: true });
      }
    }

    setTheaterFill(flag) {
      this.theaterFill = !!flag;
      this.syncCanvasGeometry();
      if ((this.enabled || this.theaterActive) && this.captureStatus === "ready") {
        this.renderSingleFrame(performance.now(), { skipInfer: true });
      }
    }

    ensureWebGL() {
      if (this.canvas && this.gl && !this.contextLost) return true;
      if (!this.video) return false;
      this.destroyProbeWebGL();

      const doc = this.video.ownerDocument || document;
      if (!this.canvas) {
        const canvas = doc.createElement("canvas");
        canvas.className = "wvb-beauty-overlay";
        const props = [
          ["position", "absolute"],
          ["pointer-events", "none"],
          ["z-index", "2"],
          ["display", "none"],
          ["visibility", "visible"],
          ["opacity", "1"],
          ["max-width", "none"],
          ["max-height", "none"],
          ["min-width", "0"],
          ["min-height", "0"],
          ["margin", "0"],
          ["padding", "0"],
          ["border", "0"],
          ["transform", "translateZ(0)"],
        ];
        for (const [k, v] of props) canvas.style.setProperty(k, v, "important");
        canvas.addEventListener("webglcontextlost", (e) => {
          if (this.canvas !== canvas) return;
          e.preventDefault();
          this.contextLost = true;
          this.stopBeautyOverlay("WebGL 上下文丢失，已自动回退原画。");
        });
        canvas.addEventListener("webglcontextrestored", () => {
          if (this.canvas !== canvas) return;
          this.contextLost = false;
          this.initWebGLResources();
          if (this.enabled || this.theaterActive) this.runProtectionAndProbe();
        });
        this.canvas = canvas;
        if (!this.theaterActive) {
          this.mountCanvasBackToVideo();
        }
      }
      return this.initWebGLResources();
    }

    initWebGLResources() {
      const gl =
        this.canvas.getContext("webgl2", { alpha: false, antialias: false, powerPreference: "high-performance" }) ||
        this.canvas.getContext("webgl", { alpha: false, antialias: false });
      if (!gl) return false;
      this.gl = gl;
      this.program = createProgram(gl, VERT_SRC, FRAG_SRC);
      gl.useProgram(this.program);

      this.posBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(this.program, "a_pos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      this.videoTex = this.createLinearTexture(gl);
      this.pendingTex = this.createLinearTexture(gl);
      this.maskTex = this.createLinearTexture(gl);
      this.hasCommittedFrame = false;
      this.pendingFrameId = 0;

      const u = (n) => gl.getUniformLocation(this.program, n);
      this.uniforms = {
        u_uvTransform: u("u_uvTransform"),
        u_video: u("u_video"),
        u_mask: u("u_mask"),
        u_texel: u("u_texel"),
        u_hasFaceMask: u("u_hasFaceMask"),
        u_compareOriginal: u("u_compareOriginal"),
        u_skinA: u("u_skinA"),
        u_skinB: u("u_skinB"),
        u_reshapeA: u("u_reshapeA"),
        u_reshapeB: u("u_reshapeB"),
        u_makeupA: u("u_makeupA"),
        u_lipColor: u("u_lipColor"),
        u_colorA: u("u_colorA"),
        u_colorB: u("u_colorB"),
        u_maskRect: u("u_maskRect"),
        u_yawVis: u("u_yawVis"),
        u_eyes: u("u_eyes"),
        u_eyeOuter: u("u_eyeOuter"),
        u_eyeRadii: u("u_eyeRadii"),
        u_noseBridge: u("u_noseBridge"),
        u_chinMouth: u("u_chinMouth"),
        u_mouthCorners: u("u_mouthCorners"),
        u_leftContour: u("u_leftContour"),
        u_rightContour: u("u_rightContour"),
        u_noseWings: u("u_noseWings"),
      };
      gl.uniform1i(this.uniforms.u_video, 0);
      gl.uniform1i(this.uniforms.u_mask, 1);
      gl.uniform4f(this.uniforms.u_uvTransform, 1, 1, 0, 0);
      gl.uniform4f(this.uniforms.u_maskRect, 0, 0, 1, 1);
      gl.uniform4f(this.uniforms.u_yawVis, 1, 1, 1, 0.05);
      return true;
    }

    createLinearTexture(gl) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return tex;
    }

    destroyProbeWebGL() {
      if (this.probeGl) {
        if (this.probeTex) this.probeGl.deleteTexture(this.probeTex);
        const ext = this.probeGl.getExtension("WEBGL_lose_context");
        if (ext) ext.loseContext();
      }
      this.probeGl = null; this.probeTex = null; this.probeCanvas = null;
    }

    destroyWebGLAndCanvas() {
      const oldCanvas = this.canvas;
      const oldGl = this.gl;
      this.canvas = null; this.gl = null;
      if (oldGl) {
        if (this.videoTex) oldGl.deleteTexture(this.videoTex);
        if (this.pendingTex) oldGl.deleteTexture(this.pendingTex);
        if (this.maskTex) oldGl.deleteTexture(this.maskTex);
        if (this.posBuf) oldGl.deleteBuffer(this.posBuf);
        if (this.program) oldGl.deleteProgram(this.program);
        const ext = oldGl.getExtension("WEBGL_lose_context");
        if (ext) ext.loseContext();
      }
      this.program = null; this.videoTex = null; this.pendingTex = null; this.maskTex = null; this.posBuf = null;
      this.hasCommittedFrame = false; this.pendingFrameId = 0;
      if (oldCanvas && oldCanvas.parentElement) oldCanvas.parentElement.removeChild(oldCanvas);
    }

    parseCssTransform2D(str) {
      if (!str || str === "none") return null;
      const m2 = str.match(/^matrix\(([^)]+)\)$/);
      if (m2) {
        const p = m2[1].split(",").map((s) => parseFloat(s.trim()));
        if (p.length === 6 && p.every(Number.isFinite)) return { a: p[0], b: p[1], c: p[2], d: p[3], tx: p[4], ty: p[5] };
      }
      const m3 = str.match(/^matrix3d\(([^)]+)\)$/);
      if (m3) {
        const p = m3[1].split(",").map((s) => parseFloat(s.trim()));
        if (p.length === 16 && p.every(Number.isFinite)) return { a: p[0], b: p[1], c: p[4], d: p[5], tx: p[12], ty: p[13] };
      }
      return null;
    }

    evalObjectPosAxis(token, freeSpace) {
      if (!token) return freeSpace * 0.5;
      const t = token.trim().toLowerCase();
      if (t === "left" || t === "top") return 0;
      if (t === "center") return freeSpace * 0.5;
      if (t === "right" || t === "bottom") return freeSpace;
      if (t.endsWith("%")) {
        const pct = parseFloat(t);
        return Number.isFinite(pct) ? (pct / 100) * freeSpace : freeSpace * 0.5;
      }
      const px = parseFloat(t);
      return Number.isFinite(px) ? px : freeSpace * 0.5;
    }

    computeContentRect(video, boxWOverride, boxHOverride) {
      const win = (video.ownerDocument && video.ownerDocument.defaultView) || window;
      const vStyle = win.getComputedStyle(video);
      const vRect = video.getBoundingClientRect();
      const insetX = (parseFloat(vStyle.borderLeftWidth) || 0) + (parseFloat(vStyle.paddingLeft) || 0);
      const insetY = (parseFloat(vStyle.borderTopWidth) || 0) + (parseFloat(vStyle.paddingTop) || 0);
      const rawW = boxWOverride > 0 ? boxWOverride : vRect.width;
      const rawH = boxHOverride > 0 ? boxHOverride : vRect.height;
      const cw = Math.max(1, rawW - insetX - (parseFloat(vStyle.borderRightWidth) || 0) - (parseFloat(vStyle.paddingRight) || 0));
      const ch = Math.max(1, rawH - insetY - (parseFloat(vStyle.borderBottomWidth) || 0) - (parseFloat(vStyle.paddingBottom) || 0));
      const vw = video.videoWidth || cw;
      const vh = video.videoHeight || ch;
      if (!vw || !vh || !cw || !ch) return { x: insetX, y: insetY, width: cw, height: ch, uvTransform: [1, 1, 0, 0] };

      const fit = vStyle.objectFit || "contain";
      const posTokens = (vStyle.objectPosition || "50% 50%").trim().split(/\s+/);
      const posXTok = posTokens[0] || "50%";
      const posYTok = posTokens[1] || posXTok;
      const vr = vw / vh;
      const br = cw / ch;

      if (fit === "fill") return { x: insetX, y: insetY, width: cw, height: ch, uvTransform: [1, 1, 0, 0] };
      if (fit === "cover") {
        const renderW = vr > br ? ch * vr : cw;
        const renderH = vr > br ? ch : cw / vr;
        const offX = this.evalObjectPosAxis(posXTok, cw - renderW);
        const offY = this.evalObjectPosAxis(posYTok, ch - renderH);
        const sx = Math.min(1, cw / Math.max(renderW, 1e-4));
        const sy = Math.min(1, ch / Math.max(renderH, 1e-4));
        const ox = Math.max(0, Math.min(1 - sx, -offX / Math.max(renderW, 1e-4)));
        const oy = Math.max(0, Math.min(1 - sy, -offY / Math.max(renderH, 1e-4)));
        return { x: insetX, y: insetY, width: cw, height: ch, uvTransform: [sx, sy, ox, oy] };
      }
      if (fit === "none" || (fit === "scale-down" && vw <= cw && vh <= ch)) {
        const offX = this.evalObjectPosAxis(posXTok, cw - vw);
        const offY = this.evalObjectPosAxis(posYTok, ch - vh);
        const visL = Math.max(0, offX), visT = Math.max(0, offY);
        const visW = Math.max(1, Math.min(cw, offX + vw) - visL);
        const visH = Math.max(1, Math.min(ch, offY + vh) - visT);
        return { x: insetX + visL, y: insetY + visT, width: visW, height: visH, uvTransform: [visW / vw, visH / vh, Math.max(0, (visL - offX) / vw), Math.max(0, (visT - offY) / vh)] };
      }
      const renderW = vr > br ? cw : ch * vr;
      const renderH = vr > br ? cw / vr : ch;
      return {
        x: insetX + this.evalObjectPosAxis(posXTok, cw - renderW),
        y: insetY + this.evalObjectPosAxis(posYTok, ch - renderH),
        width: renderW,
        height: renderH,
        uvTransform: [1, 1, 0, 0],
      };
    }

    syncCanvasGeometry() {
      if (!this.canvas || !this.video) return;
      const doc = this.video.ownerDocument || document;
      const win = doc.defaultView || window;

      if (this.theaterActive && this.theaterSlotEl) {
        const vpW = (window.visualViewport && window.visualViewport.width) || window.innerWidth;
        const vpH = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
        const stageW = this.theaterRotated ? vpH : vpW;
        const stageH = this.theaterRotated ? vpW : vpH;
        const vw = this.video.videoWidth || stageW;
        const vh = this.video.videoHeight || stageH;
        const vr = vw / Math.max(vh, 1);
        const sr = stageW / Math.max(stageH, 1);

        let dispW = stageW;
        let dispH = stageH;
        let uvTransform = [1, 1, 0, 0];

        if (this.theaterFill) {
          let sx = 1, sy = 1;
          if (vr > sr) sx = sr / vr;
          else sy = vr / sr;
          uvTransform = [sx, sy, (1 - sx) * 0.5, (1 - sy) * 0.5];
        } else {
          if (vr > sr) dispH = stageW / vr;
          else dispW = stageH * vr;
        }

        this.uvTransform = uvTransform;
        this.canvas.style.setProperty("position", "relative", "important");
        this.canvas.style.setProperty("left", "0", "important");
        this.canvas.style.setProperty("top", "0", "important");
        this.canvas.style.setProperty("width", `${dispW}px`, "important");
        this.canvas.style.setProperty("height", `${dispH}px`, "important");

        const dpr = Math.min(window.devicePixelRatio || 1, IS_IOS_OR_MOBILE ? 1.5 : 1.75);
        const isPortrait = dispH > dispW;
        const longMax = this.degradeTier === "L2" ? 1280 : IS_IOS_OR_MOBILE ? 1440 : 1920;
        const shortMax = this.degradeTier === "L2" ? 720 : IS_IOS_OR_MOBILE ? 810 : 1080;
        const maxW = isPortrait ? shortMax : longMax;
        const maxH = isPortrait ? longMax : shortMax;
        const targetW = Math.max(2, Math.min(Math.round(dispW * dpr), this.video.videoWidth || maxW, maxW));
        const targetH = Math.max(2, Math.min(Math.round(dispH * dpr), this.video.videoHeight || maxH, maxH));
        if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
          this.canvas.width = targetW;
          this.canvas.height = targetH;
          if (this.captureStatus === "ready" && this.video.paused) {
            this.renderSingleFrame(performance.now(), { skipInfer: true });
          }
        }
        return;
      }

      const fsEl = doc.fullscreenElement || doc.webkitFullscreenElement || document.fullscreenElement;
      if (fsEl === this.video || this.iosNativeFullscreen) {
        this.hideCanvas();
        if (this.enabled) this.renderMode = "native_fallback";
        return;
      }

      const parent = this.canvas.parentElement;
      if (!parent) return;
      const vStyle = win.getComputedStyle(this.video);
      const vZ = parseInt(vStyle.zIndex, 10);
      this.canvas.style.setProperty("z-index", String(Number.isFinite(vZ) ? Math.max(2, vZ + 1) : 2), "important");
      if (win.getComputedStyle(parent).position === "static") parent.style.position = "relative";

      const offsetParent = this.canvas.offsetParent || this.findPositionedAncestor(parent, win);
      const opRect = offsetParent.getBoundingClientRect();
      const opStyle = win.getComputedStyle(offsetParent);
      const borderL = parseFloat(opStyle.borderLeftWidth) || 0;
      const borderT = parseFloat(opStyle.borderTopWidth) || 0;
      const opScaleX = offsetParent.offsetWidth > 0 ? opRect.width / offsetParent.offsetWidth : 1;
      const opScaleY = offsetParent.offsetHeight > 0 ? opRect.height / offsetParent.offsetHeight : 1;
      const safeScaleX = opScaleX > 0.05 ? opScaleX : 1;
      const safeScaleY = opScaleY > 0.05 ? opScaleY : 1;

      const vRect = this.video.getBoundingClientRect();
      const mat = this.parseCssTransform2D(vStyle.transform);
      const hasRotation = !!(mat && (Math.abs(mat.b) > 1e-3 || Math.abs(mat.c) > 1e-3));
      const flipX = mat && !hasRotation && mat.a < 0 ? -1 : 1;
      const flipY = mat && !hasRotation && mat.d < 0 ? -1 : 1;

      let left, top, cssW, cssH;
      let canvasTransform = "translateZ(0)";
      if (hasRotation && this.video.offsetWidth > 0 && this.video.offsetHeight > 0) {
        const content = this.computeContentRect(this.video, this.video.offsetWidth, this.video.offsetHeight);
        this.uvTransform = content.uvTransform;
        const centerX = (vRect.left + vRect.width * 0.5 - opRect.left) / safeScaleX - borderL;
        const centerY = (vRect.top + vRect.height * 0.5 - opRect.top) / safeScaleY - borderT;
        cssW = content.width; cssH = content.height;
        left = centerX - cssW * 0.5; top = centerY - cssH * 0.5;
        canvasTransform = `matrix(${mat.a}, ${mat.b}, ${mat.c}, ${mat.d}, 0, 0) translateZ(0)`;
      } else {
        const localW = vRect.width / safeScaleX;
        const localH = vRect.height / safeScaleY;
        const content = this.computeContentRect(this.video, localW, localH);
        this.uvTransform = content.uvTransform;
        const cx = flipX < 0 ? localW - content.x - content.width : content.x;
        const cy = flipY < 0 ? localH - content.y - content.height : content.y;
        left = (vRect.left - opRect.left) / safeScaleX - borderL + cx;
        top = (vRect.top - opRect.top) / safeScaleY - borderT + cy;
        cssW = content.width; cssH = content.height;
        if (flipX < 0 || flipY < 0) canvasTransform = `scale(${flipX}, ${flipY}) translateZ(0)`;
      }

      this.canvas.style.setProperty("left", `${left}px`, "important");
      this.canvas.style.setProperty("top", `${top}px`, "important");
      this.canvas.style.setProperty("width", `${cssW}px`, "important");
      this.canvas.style.setProperty("height", `${cssH}px`, "important");
      this.canvas.style.setProperty("transform", canvasTransform, "important");
      this.lastGeomSig = `${Math.round(vRect.left * 2)},${Math.round(vRect.top * 2)},${Math.round(vRect.width * 2)},${Math.round(vRect.height * 2)},${Math.round(opRect.left * 2)},${Math.round(opRect.top * 2)},${this.video.videoWidth}x${this.video.videoHeight},${vStyle.objectFit},${vStyle.objectPosition},${vStyle.transform}`;

      const dprCap = IS_IOS_OR_MOBILE ? 1.25 : 1.5;
      const dpr = Math.min(win.devicePixelRatio || 1, dprCap);
      const isPortrait = cssH > cssW;
      const longMax = this.degradeTier === "L2" || IS_IOS_OR_MOBILE ? 1280 : 1920;
      const shortMax = this.degradeTier === "L2" || IS_IOS_OR_MOBILE ? 720 : 1080;
      const maxW = isPortrait ? shortMax : longMax;
      const maxH = isPortrait ? longMax : shortMax;

      const targetW = Math.max(2, Math.min(Math.round(cssW * safeScaleX * dpr), this.video.videoWidth || maxW, maxW));
      const targetH = Math.max(2, Math.min(Math.round(cssH * safeScaleY * dpr), this.video.videoHeight || maxH, maxH));

      if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
        this.canvas.width = targetW;
        this.canvas.height = targetH;
        if (this.enabled && this.captureStatus === "ready" && this.video.paused) {
          this.renderSingleFrame(performance.now(), { skipInfer: true });
        }
      }
    }

    maybeSyncGeometryThrottled(nowMs) {
      if (this.theaterActive || !this.canvas || !this.video || nowMs - this.lastGeomCheckMs < 200) return;
      this.lastGeomCheckMs = nowMs;
      const doc = this.video.ownerDocument || document;
      const win = doc.defaultView || window;
      const parent = this.canvas.parentElement;
      if (!parent) return;
      const offsetParent = this.canvas.offsetParent || this.findPositionedAncestor(parent, win);
      const opRect = offsetParent.getBoundingClientRect();
      const vRect = this.video.getBoundingClientRect();
      const vStyle = win.getComputedStyle(this.video);
      const sig = `${Math.round(vRect.left * 2)},${Math.round(vRect.top * 2)},${Math.round(vRect.width * 2)},${Math.round(vRect.height * 2)},${Math.round(opRect.left * 2)},${Math.round(opRect.top * 2)},${this.video.videoWidth}x${this.video.videoHeight},${vStyle.objectFit},${vStyle.objectPosition},${vStyle.transform}`;
      if (sig !== this.lastGeomSig) this.syncCanvasGeometry();
    }

    handleFullscreenChange() {
      if (!this.video || this.theaterActive) return;
      const doc = this.video.ownerDocument || document;
      const fsEl = doc.fullscreenElement || doc.webkitFullscreenElement || document.fullscreenElement;
      if (fsEl === this.video || this.iosNativeFullscreen) {
        this.hideCanvas();
        this.stopFrameLoop();
        if (this.enabled) this.renderMode = "native_fallback";
      } else if (this.enabled && this.captureStatus === "ready") {
        this.showCanvas();
        this.syncCanvasGeometry();
        this.renderSingleFrame(performance.now(), { skipInfer: true });
        if (!this.video.paused && !this.video.ended) this.startFrameLoop();
      } else {
        this.syncCanvasGeometry();
      }
    }

    async ensureFaceTracking(preferredDelegate = this.workerDelegatePref || "GPU") {
      if (!this.faceTrackingEnabled) {
        this.workerStatus = "肤色直出模式（未开478点）";
        return;
      }
      if (this.worker || this.mainTracker || this.workerInitializing || this.workerUnavailable) return;
      this.workerInitializing = true;
      this.workerDelegatePref = preferredDelegate;
      this.workerStatus = preferredDelegate === "CPU" ? "正在加载 478 点模型 (CPU)…" : "正在加载 478 点模型…";

      const fallbackToMainThread = async (workerReason) => {
        if (!this.enabled || !this.faceTrackingEnabled || this.destroyed) {
          this.workerInitializing = false;
          return;
        }
        try {
          this.workerStatus = "Worker 受限，尝试主线程加载…";
          const tracker = new MainThreadFaceTracker();
          await tracker.init();
          if (!this.enabled || !this.faceTrackingEnabled || this.destroyed) {
            tracker.close();
            this.workerInitializing = false;
            return;
          }
          this.mainTracker = tracker;
          this.workerReady = true;
          this.workerInitializing = false;
          this.workerStatus = "就绪 (主线程省电模式)";
          if (this.captureStatus === "ready" && this.video && this.video.paused) {
            this.maybeDispatchInference(performance.now(), true);
          }
          this.onChange();
        } catch (err) {
          this.workerInitializing = false;
          this.workerReady = false;
          this.workerUnavailable = true;
          const r = (err && err.message) || workerReason || "CSP/网络拦截";
          this.workerStatus = `478 点不可用（已回退肤色模式）: ${String(r).slice(0, 48)}`;
          this.onChange();
        }
      };

      try {
        const blob = new Blob([FACE_WORKER_SOURCE], { type: "application/javascript" });
        this.workerBlobUrl = URL.createObjectURL(blob);
        const w = new Worker(this.workerBlobUrl, { type: "module" });
        this.worker = w;

        w.onmessage = (e) => {
          const msg = e.data;
          if (!msg || this.worker !== w) return;
          if (msg.type === "READY") {
            this.workerReady = true;
            this.workerInitializing = false;
            this.workerStatus = `就绪 (${msg.delegate} · 零滞后帧同步)`;
            if (this.enabled && this.captureStatus === "ready" && this.video) {
              this.maybeDispatchInference(performance.now(), true);
            }
            this.onChange();
          } else if (msg.type === "FALLBACK_CPU") {
            this.terminateFaceTracking(true, true);
            if (this.enabled && this.faceTrackingEnabled && !this.destroyed) {
              this.ensureFaceTracking("CPU");
            }
          } else if (msg.type === "UNAVAILABLE") {
            this.terminateFaceTracking(true);
            fallbackToMainThread(msg.reason);
          } else if (msg.type === "RESULT") {
            this.workerBusy = false;
            this.detectFrameCount++;
            if (typeof msg.inferMs === "number" && Number.isFinite(msg.inferMs)) {
              this.lastInferMs = msg.inferMs;
              this.inferMsEma = this.inferMsEma * 0.8 + msg.inferMs * 0.2;
              if (this.degradeTier === "L0") {
                const maxCap = IS_IOS_OR_MOBILE ? 416 : 576;
                const minCap = IS_IOS_OR_MOBILE ? 288 : 352;
                if (this.inferMsEma > 28 && this.adaptiveInferEdge > minCap) {
                  this.adaptiveInferEdge = Math.max(minCap, this.adaptiveInferEdge - 32);
                } else if (this.inferMsEma < 14 && this.adaptiveInferEdge < maxCap) {
                  this.adaptiveInferEdge = Math.min(maxCap, this.adaptiveInferEdge + 16);
                }
              }
            }
            const recvNow = performance.now();

            if (!msg.frameId || msg.frameId !== this.pendingFrameId) {
              if (this.enabled && this.captureStatus === "ready" && (this.pendingRedispatch || (this.hasNewVideoFrame && this.video && !this.video.paused))) {
                const force = this.pendingRedispatch;
                this.pendingRedispatch = false;
                this.hasNewVideoFrame = false;
                this.maybeDispatchInference(recvNow, force);
              }
              return;
            }

            if (this.pendingTex && this.videoTex) {
              const tmp = this.videoTex;
              this.videoTex = this.pendingTex;
              this.pendingTex = tmp;
              this.hasCommittedFrame = true;
              this.lastCapturedMediaTime = this.pendingMediaTime;
            }

            if (msg.hasFace && msg.landmarks) {
              this.latestLandmarks = msg.landmarks;
              this.latestLandmarkTs = Number.isFinite(msg.timestampMs) ? msg.timestampMs : recvNow;
              this.latestLandmarkRecvTs = recvNow;
              this.lastFaceBox = msg.faceBox || null;
              this.validFaceStreak = Math.min(this.validFaceStreak + 1, 10);
              this.missStreak = 0;
              this.scanStep = 0;
              this.fadeWeight = 1.0;
              this.reshapeGate = 1.0;
            } else {
              const wasCropped = !!(msg.roiUsed && (msg.roiUsed.w < 0.99 || msg.roiUsed.h < 0.99));
              if (wasCropped) this.lastFaceBox = null;
              if (this.pendingSceneCut || !this.latestLandmarks || this.missStreak >= 3) {
                this.latestLandmarks = null;
                this.lastFaceBox = null;
                this.validFaceStreak = 0;
                this.missStreak = 0;
                this.fadeWeight = 0.0;
                this.reshapeGate = 0.0;
              } else {
                this.missStreak++;
                this.fadeWeight = Math.max(0.18, 1.0 - this.missStreak * 0.27);
                this.reshapeGate = Math.max(0.0, 1.0 - this.missStreak * 0.5);
              }
            }
            this.pendingSceneCut = false;

            if ((this.enabled || this.theaterActive) && this.captureStatus === "ready" && this.gl && !this.contextLost && this.hasCommittedFrame) {
              this.maybeSyncGeometryThrottled(recvNow);
              const hasFaceMask = this.enabled ? this.updateFaceMaskTexture(recvNow) : false;
              this.drawCommittedVideoTex(hasFaceMask, recvNow);
            }

            if (this.enabled && this.captureStatus === "ready" && this.video) {
              if (this.pendingRedispatch) {
                this.pendingRedispatch = false;
                this.hasNewVideoFrame = false;
                this.maybeDispatchInference(performance.now(), true);
              } else if (this.hasNewVideoFrame && !this.video.paused && !this.video.ended) {
                this.hasNewVideoFrame = false;
                this.maybeDispatchInference(performance.now(), false);
              }
            }
          } else if (msg.type === "ERROR" || msg.type === "NO_MODEL") {
            this.workerBusy = false;
            if (this.pendingRedispatch) {
              this.pendingRedispatch = false;
              this.maybeDispatchInference(performance.now(), true);
            }
          }
        };
        w.onerror = () => {
          if (this.worker !== w) return;
          this.terminateFaceTracking(true);
          fallbackToMainThread("Worker 受 CSP/Safari 限制");
        };
        w.postMessage({ type: "INIT", bundleUrl: MP_BUNDLE_URL, wasmDir: MP_WASM_DIR, modelUrl: MP_MODEL_URL, delegate: preferredDelegate });
      } catch (err) {
        this.terminateFaceTracking(true);
        fallbackToMainThread(err && err.message);
      }
    }

    terminateFaceTracking(preserveStatus = false, immediate = false) {
      this.workerInitializing = false;
      this.workerReady = false;
      this.workerBusy = false;
      if (this.mainTracker) {
        this.mainTracker.close();
        this.mainTracker = null;
      }
      const oldW = this.worker;
      const oldUrl = this.workerBlobUrl;
      this.worker = null;
      this.workerBlobUrl = null;
      if (!preserveStatus) {
        this.workerStatus = this.faceTrackingEnabled ? "未启用" : "肤色直出模式（未开478点）";
      }
      if (!oldW) {
        if (oldUrl) URL.revokeObjectURL(oldUrl);
        return;
      }
      const fin = () => {
        try { oldW.terminate(); } catch (_) {}
        if (oldUrl) try { URL.revokeObjectURL(oldUrl); } catch (_) {}
      };
      if (immediate) { fin(); return; }
      let done = false;
      const clean = () => { if (done) return; done = true; clearTimeout(t); fin(); };
      const t = setTimeout(clean, 500);
      oldW.onmessage = (e) => { if (e.data && e.data.type === "CLOSED") clean(); };
      oldW.onerror = clean;
      try { oldW.postMessage({ type: "CLOSE" }); } catch (_) { clean(); }
    }

    detectSceneCut(frameSource) {
      try {
        this.sceneCtx.drawImage(frameSource, 0, 0, 8, 6);
        const data = this.sceneCtx.getImageData(0, 0, 8, 6).data;
        const curr = new Uint8Array(48);
        for (let i = 0; i < 48; i++) {
          const o = i * 4;
          curr[i] = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8;
        }
        let isCut = false;
        if (this.prevSceneLuma) {
          let sad = 0;
          for (let i = 0; i < 48; i++) sad += Math.abs(curr[i] - this.prevSceneLuma[i]);
          if (sad / 48 > 30) isCut = true;
        }
        this.prevSceneLuma = curr;
        return isCut;
      } catch (_) {
        return false;
      }
    }

    computeInferRoi(vw, vh, isSceneCut) {
      if (isSceneCut) {
        this.lastFaceBox = null;
        this.scanStep = 0;
        return { x: 0, y: 0, w: 1, h: 1, isSmallCrop: false };
      }
      const aspect = vw / Math.max(1, vh);
      const box = this.lastFaceBox;
      if (box && (box.w < 0.26 || box.h < 0.36)) {
        const faceSizeA = Math.max(box.w * aspect, box.h, 0.08);
        const cropA = Math.max(0.32, Math.min(0.95, faceSizeA * 3.1));
        const rw = Math.min(1.0, cropA / aspect);
        const rh = Math.min(1.0, cropA);
        if (rw < 0.88 || rh < 0.88) {
          const rx = Math.max(0, Math.min(1 - rw, box.cx - rw * 0.5));
          const ry = Math.max(0, Math.min(1 - rh, box.cy - rh * 0.5));
          return { x: rx, y: ry, w: rw, h: rh, isSmallCrop: true };
        }
      }
      if (!box) {
        const step = this.scanStep++;
        if (step % 2 === 1) {
          const win = SMALL_FACE_SCAN_ROIS[Math.floor(step / 2) % SMALL_FACE_SCAN_ROIS.length];
          return { x: win.x, y: win.y, w: win.w, h: win.h, isSmallCrop: true };
        }
      }
      return { x: 0, y: 0, w: 1, h: 1, isSmallCrop: false };
    }

    maybeDispatchInference(nowMs, force = false) {
      if (!this.enabled || !this.workerReady || (!this.worker && !this.mainTracker) || this.workerBusy || !this.video || !this.gl || this.contextLost) return false;
      const captureTs = performance.now();
      const minIntervalMs = this.mainTracker ? 75 : IS_IOS_OR_MOBILE ? 24 : this.degradeTier === "L0" ? 8 : 26;
      if (!force && captureTs - this.lastInferSentMs < minIntervalMs) return false;

      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      if (!vw || !vh) return false;

      let vf = null;
      if (typeof VideoFrame === "function") {
        try { vf = new VideoFrame(this.video); } catch (_) { vf = null; }
      }
      const frameSrc = vf || this.video;

      let isSceneCut = false;
      let roi = { x: 0, y: 0, w: 1, h: 1, isSmallCrop: false };
      let frameId = 0;

      try {
        isSceneCut = this.detectSceneCut(frameSrc);
        roi = this.computeInferRoi(vw, vh, isSceneCut);

        const sx = Math.floor(roi.x * vw);
        const sy = Math.floor(roi.y * vh);
        const sw = Math.max(16, Math.min(vw - sx, Math.round(roi.w * vw)));
        const sh = Math.max(16, Math.min(vh - sy, Math.round(roi.h * vh)));
        const exactRoi = { x: sx / vw, y: sy / vh, w: sw / vw, h: sh / vh };

        const baseEdge = this.degradeTier === "L0" ? this.adaptiveInferEdge : IS_IOS_OR_MOBILE ? 320 : 416;
        const targetEdge = roi.isSmallCrop ? Math.min(384, baseEdge) : baseEdge;
        const scale = Math.min(1, targetEdge / Math.max(sw, sh));
        const tw = Math.max(32, Math.round(sw * scale));
        const th = Math.max(32, Math.round(sh * scale));

        if (this.inferCanvas.width !== tw || this.inferCanvas.height !== th) {
          this.inferCanvas.width = tw;
          this.inferCanvas.height = th;
        }
        this.inferCtx.drawImage(frameSrc, sx, sy, sw, sh, 0, 0, tw, th);
        this.lastInferSentMs = captureTs;

        if (this.mainTracker) {
          const res = this.mainTracker.detect(this.inferCanvas, exactRoi);
          this.detectFrameCount++;
          if (res && res.landmarks) {
            this.latestLandmarks = res.landmarks;
            this.latestLandmarkTs = captureTs;
            this.latestLandmarkRecvTs = performance.now();
            this.lastFaceBox = res.faceBox || null;
            this.validFaceStreak = Math.min(this.validFaceStreak + 1, 10);
            this.missStreak = 0;
            this.scanStep = 0;
            this.fadeWeight = 1.0;
            this.reshapeGate = 1.0;
          } else {
            if (exactRoi.w < 0.99 || exactRoi.h < 0.99) this.lastFaceBox = null;
            if (isSceneCut || !this.latestLandmarks || this.missStreak >= 3) {
              this.latestLandmarks = null;
              this.lastFaceBox = null;
              this.validFaceStreak = 0;
              this.missStreak = 0;
              this.fadeWeight = 0.0;
              this.reshapeGate = 0.0;
            } else {
              this.missStreak++;
              this.fadeWeight = Math.max(0.18, 1.0 - this.missStreak * 0.27);
              this.reshapeGate = Math.max(0.0, 1.0 - this.missStreak * 0.5);
            }
          }
          return true;
        }

        // Worker Frame-Paired path: upload atomic frame into pendingTex
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.pendingTex);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frameSrc);
        } catch (_) {
          this.captureStatus = "cors_restricted";
          this.stopBeautyOverlay("运行时取帧受限，已恢复原画。");
          return false;
        }

        frameId = ++this.frameSeq;
        this.pendingFrameId = frameId;
        this.pendingMediaTime = this.video.currentTime;
        this.pendingSceneCut = isSceneCut;
        this.workerBusy = true;
        roi = exactRoi;
      } finally {
        if (vf) { try { vf.close(); } catch (_) {} }
      }

      createImageBitmap(this.inferCanvas)
        .then((bitmap) => {
          if (!this.worker || frameId !== this.pendingFrameId) {
            bitmap.close();
            if (frameId === this.pendingFrameId) this.workerBusy = false;
            return;
          }
          this.worker.postMessage(
            { type: "FRAME", bitmap, frameId, timestampMs: captureTs, roi, sceneCut: isSceneCut, mode: "paired" },
            [bitmap]
          );
        })
        .catch(() => { this.workerBusy = false; });
      return true;
    }

    updateFaceMaskTexture(nowMs) {
      if (!this.workerReady || !this.latestLandmarks) return false;
      const isPaused = !!(this.video && this.video.paused);
      if (this.mainTracker) {
        const recvAgeMs = Math.max(0, performance.now() - (this.latestLandmarkRecvTs || this.latestLandmarkTs));
        if (!isPaused && recvAgeMs > 280) {
          this.fadeWeight = Math.max(0, this.fadeWeight - 0.25);
          return this.fadeWeight > 0.01;
        }
      }

      const ctx = this.maskCtx;
      const w = this.maskCanvas.width;
      const h = this.maskCanvas.height;
      ctx.clearRect(0, 0, w, h);

      const lm = this.latestLandmarks;
      const ptUv = (idx) => {
        const b = idx * 4;
        if (b + 1 >= lm.length) return [0.5, 0.5];
        return [Math.min(1, Math.max(0, lm[b])), Math.min(1, Math.max(0, lm[b + 1]))];
      };
      const avgUv = (idxs) => {
        let sx = 0, sy = 0;
        for (const i of idxs) { const [x, y] = ptUv(i); sx += x; sy += y; }
        return [sx / idxs.length, sy / idxs.length];
      };
      const aspect =
        this.video && this.video.videoHeight > 0
          ? this.video.videoWidth / this.video.videoHeight
          : this.canvas && this.canvas.height > 0
            ? this.canvas.width / this.canvas.height
            : 16 / 9;
      const distAspect = (a, b) => Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1]);

      const lEye = avgUv([33, 133, 159, 145]);
      const rEye = avgUv([263, 362, 386, 374]);
      const lEyeOuter = ptUv(33);
      const rEyeOuter = ptUv(263);
      const lEyeR = Math.max(0.012, distAspect(lEyeOuter, ptUv(133)) * 1.15);
      const rEyeR = Math.max(0.012, distAspect(rEyeOuter, ptUv(362)) * 1.15);
      const leftEar = ptUv(234), rightEar = ptUv(454), forehead = ptUv(10), chin = ptUv(152);
      const noseBridgeTop = ptUv(168), noseTip = ptUv(1);
      const leftMouth = ptUv(61), rightMouth = ptUv(291);
      const mouthCenter = avgUv([13, 14, 61, 291]);
      const faceWidth = Math.max(0.03, distAspect(leftEar, rightEar));
      const faceHeight = Math.max(0.04, distAspect(forehead, chin));
      const mouthHalfW = Math.max(0.008, distAspect(leftMouth, rightMouth) * 0.55);
      const leftCheek = ptUv(132), leftJaw = ptUv(172), rightCheek = ptUv(361), rightJaw = ptUv(397);
      const leftWing = ptUv(129), rightWing = ptUv(358);

      const upRawAx = (noseBridgeTop[0] - noseTip[0]) * aspect;
      const upRawAy = noseBridgeTop[1] - noseTip[1] - 1e-4;
      const upLen = Math.hypot(upRawAx, upRawAy) || 1;
      const upUvX = (upRawAx / upLen) / aspect;
      const upUvY = upRawAy / upLen;

      const dL = distAspect(noseTip, leftEar), dR = distAspect(noseTip, rightEar);
      const denomLR = Math.max(dL + dR, 1e-4);
      const leftVis = Math.max(0, Math.min(1, (dL / denomLR - 0.16) / 0.22));
      const rightVis = Math.max(0, Math.min(1, (dR / denomLR - 0.16) / 0.22));
      const sym = Math.min(dL, dR) / Math.max(dL, dR, 1e-4);
      const yawFactor = Math.max(0, Math.min(1, (sym - 0.18) / 0.34));

      this.faceAnchors = {
        eyes: [lEye[0], lEye[1], rEye[0], rEye[1]],
        eyeOuter: [lEyeOuter[0], lEyeOuter[1], rEyeOuter[0], rEyeOuter[1]],
        eyeRadii: [lEyeR, rEyeR, faceWidth, faceHeight],
        noseBridge: [noseBridgeTop[0], noseBridgeTop[1], noseTip[0], noseTip[1]],
        chinMouth: [chin[0], chin[1], mouthCenter[0], mouthCenter[1]],
        mouthCorners: [leftMouth[0], leftMouth[1], rightMouth[0], rightMouth[1]],
        leftContour: [leftCheek[0], leftCheek[1], leftJaw[0], leftJaw[1]],
        rightContour: [rightCheek[0], rightCheek[1], rightJaw[0], rightJaw[1]],
        noseWings: [leftWing[0], leftWing[1], rightWing[0], rightWing[1]],
        yawFactor,
        leftVis,
        rightVis,
        mouthHalfW,
      };

      const ovalUv = new Array(FACE_OVAL_IDX.length);
      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      for (let i = 0; i < FACE_OVAL_IDX.length; i++) {
        const idx = FACE_OVAL_IDX[i];
        let [x, y] = ptUv(idx);
        const ext = FOREHEAD_EXTEND[idx];
        if (ext) { x += upUvX * (faceHeight * ext); y += upUvY * (faceHeight * ext); }
        ovalUv[i] = [x, y];
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }

      const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5;
      const halfA = Math.max((maxX - minX) * aspect, maxY - minY, 0.04) * 0.5 * 1.32;
      const rw = Math.max(0.04, (halfA * 2) / aspect);
      const rh = Math.max(0.04, halfA * 2);
      const rx = cx - rw * 0.5, ry = cy - rh * 0.5;
      const invRw = 1.0 / rw, invRh = 1.0 / rh;
      this.maskRect = [rx, ry, invRw, invRh];

      const uvToMask = (x, y) => [(x - rx) * invRw * w, (y - ry) * invRh * h];
      const traceUvPts = (pts) => {
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const [mx, my] = uvToMask(pts[i][0], pts[i][1]);
          if (i === 0) ctx.moveTo(mx, my); else ctx.lineTo(mx, my);
        }
        ctx.closePath();
      };
      const addSubpathIdx = (indices) => {
        for (let i = 0; i < indices.length; i++) {
          const [x, y] = ptUv(indices[i]);
          const [mx, my] = uvToMask(x, y);
          if (i === 0) ctx.moveTo(mx, my); else ctx.lineTo(mx, my);
        }
        ctx.closePath();
      };
      const traceIdx = (indices) => { ctx.beginPath(); addSubpathIdx(indices); };

      ctx.save();
      ctx.filter = "blur(4.2px)";
      ctx.fillStyle = "#ff0000";
      traceUvPts(ovalUv);
      ctx.fill();

      ctx.globalCompositeOperation = "destination-out";
      ctx.filter = "blur(1.5px)";
      ctx.fillStyle = "#000000";
      [LEFT_EYE_IDX, RIGHT_EYE_IDX, LEFT_BROW_IDX, RIGHT_BROW_IDX, LIPS_OUTER_IDX].forEach((p) => { traceIdx(p); ctx.fill(); });

      ctx.globalCompositeOperation = "destination-over";
      ctx.filter = "none";
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = "lighter";
      ctx.filter = "blur(0.9px)";
      ctx.fillStyle = "#00ff00";
      [LEFT_EYE_IDX, RIGHT_EYE_IDX].forEach((p) => { traceIdx(p); ctx.fill(); });
      ctx.fillStyle = "#0000ff";
      ctx.beginPath();
      addSubpathIdx(LIPS_OUTER_IDX);
      addSubpathIdx(LIPS_INNER_IDX);
      ctx.fill("evenodd");
      ctx.restore();

      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.maskCanvas);
      return true;
    }

    drawCommittedVideoTex(hasFaceMask, nowMs = performance.now()) {
      if ((!this.enabled && !this.theaterActive) || !this.video || !this.gl || this.contextLost || !this.videoTex) return;
      if (!this.theaterActive) {
        const doc = this.video.ownerDocument || document;
        const fsEl = doc.fullscreenElement || doc.webkitFullscreenElement || document.fullscreenElement;
        if (fsEl === this.video || this.iosNativeFullscreen) return;
      }

      const t0 = performance.now();
      const gl = this.gl;
      if (!this.workerReady) { this.fadeWeight = 1.0; this.reshapeGate = 1.0; }

      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);

      const p = this.params;
      const aspect =
        this.video.videoHeight > 0
          ? this.video.videoWidth / this.video.videoHeight
          : this.canvas.height > 0
            ? this.canvas.width / this.canvas.height
            : 16 / 9;
      const a = this.faceAnchors;
      const shadeIdx = Math.max(0, Math.min(LIP_SHADE_RGB.length - 1, Math.round(p.lipShade ?? 2)));
      const lipRgb = LIP_SHADE_RGB[shadeIdx];
      const uvt = this.uvTransform || [1, 1, 0, 0];
      const mr = this.maskRect || [0, 0, 1, 1];
      const showRaw = this.compareOriginal || !this.enabled;

      gl.uniform4f(this.uniforms.u_uvTransform, uvt[0], uvt[1], uvt[2], uvt[3]);
      gl.uniform2f(this.uniforms.u_texel, uvt[0] / Math.max(this.canvas.width, 1), uvt[1] / Math.max(this.canvas.height, 1));
      gl.uniform1f(this.uniforms.u_hasFaceMask, hasFaceMask ? 1 : 0);
      gl.uniform1f(this.uniforms.u_compareOriginal, showRaw ? 1 : 0);

      gl.uniform4f(this.uniforms.u_skinA, p.smooth, p.skinTexture, p.whiten, p.rosy);
      gl.uniform4f(this.uniforms.u_skinB, p.underEye, p.nasolabial, p.matte, hasFaceMask && a ? a.yawFactor : 0);
      gl.uniform4f(this.uniforms.u_reshapeA, p.slimFace, p.slimCheekbone, p.vChin, p.bigEyes);
      gl.uniform4f(this.uniforms.u_reshapeB, p.eyeTilt, p.slimNose, p.mouthSize, p.mouthSmile);
      gl.uniform4f(this.uniforms.u_makeupA, p.brightEye, p.contour, p.lipTint, p.whitenTeeth);
      gl.uniform4f(this.uniforms.u_lipColor, lipRgb[0], lipRgb[1], lipRgb[2], aspect);
      gl.uniform4f(this.uniforms.u_colorA, p.sharpen, p.exposure, p.contrast, p.saturation);
      gl.uniform4f(this.uniforms.u_colorB, p.temperature, p.softGlow, this.fadeWeight, this.degradeTier === "L2" ? 1 : 0);
      gl.uniform4f(this.uniforms.u_maskRect, mr[0], mr[1], mr[2], mr[3]);
      gl.uniform4f(
        this.uniforms.u_yawVis,
        hasFaceMask && a ? a.leftVis : 1.0,
        hasFaceMask && a ? a.rightVis : 1.0,
        this.reshapeGate,
        hasFaceMask && a ? a.mouthHalfW : 0.05
      );

      if (hasFaceMask && a) {
        gl.uniform4f(this.uniforms.u_eyes, a.eyes[0], a.eyes[1], a.eyes[2], a.eyes[3]);
        gl.uniform4f(this.uniforms.u_eyeOuter, a.eyeOuter[0], a.eyeOuter[1], a.eyeOuter[2], a.eyeOuter[3]);
        gl.uniform4f(this.uniforms.u_eyeRadii, a.eyeRadii[0], a.eyeRadii[1], a.eyeRadii[2], a.eyeRadii[3]);
        gl.uniform4f(this.uniforms.u_noseBridge, a.noseBridge[0], a.noseBridge[1], a.noseBridge[2], a.noseBridge[3]);
        gl.uniform4f(this.uniforms.u_chinMouth, a.chinMouth[0], a.chinMouth[1], a.chinMouth[2], a.chinMouth[3]);
        gl.uniform4f(this.uniforms.u_mouthCorners, a.mouthCorners[0], a.mouthCorners[1], a.mouthCorners[2], a.mouthCorners[3]);
        gl.uniform4f(this.uniforms.u_leftContour, a.leftContour[0], a.leftContour[1], a.leftContour[2], a.leftContour[3]);
        gl.uniform4f(this.uniforms.u_rightContour, a.rightContour[0], a.rightContour[1], a.rightContour[2], a.rightContour[3]);
        gl.uniform4f(this.uniforms.u_noseWings, a.noseWings[0], a.noseWings[1], a.noseWings[2], a.noseWings[3]);
      }

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.renderMode = !this.enabled ? "off" : hasFaceMask ? "face_mask" : "skin_fallback";
      this.recordPerformance(performance.now() - t0, nowMs);
    }

    renderSingleFrame(nowMs = performance.now(), opts = {}) {
      if ((!this.enabled && !this.theaterActive) || !this.video || !this.gl || this.contextLost || this.captureStatus !== "ready") return;
      if (!this.theaterActive) {
        const doc = this.video.ownerDocument || document;
        const fsEl = doc.fullscreenElement || doc.webkitFullscreenElement || document.fullscreenElement;
        if (fsEl === this.video || this.iosNativeFullscreen) return;
      }

      this.maybeSyncGeometryThrottled(nowMs);

      const mt = this.video.currentTime;
      if (this.lastMediaTime >= 0 && Math.abs(mt - this.lastMediaTime) > 0.6) this.resetTrackingAndFade();
      this.lastMediaTime = mt;

      // Exact Frame-Paired Live Mode when Worker is active
      if (this.enabled && this.workerReady && this.worker && !this.mainTracker && !this.video.paused && !opts.skipInfer) {
        const dispatched = this.maybeDispatchInference(nowMs, false);
        if (!dispatched && this.workerBusy) this.hasNewVideoFrame = true;
        const workerStalled = this.workerBusy && performance.now() - this.lastInferSentMs > 240;
        if (this.hasCommittedFrame && !workerStalled) return;
      }

      const gl = this.gl;
      const stallBypass = this.enabled && this.workerReady && this.worker && !this.mainTracker && this.workerBusy && performance.now() - this.lastInferSentMs > 240;
      if (!this.hasCommittedFrame || !this.workerReady || this.mainTracker || !this.enabled || opts.forceUpload || stallBypass) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
          this.hasCommittedFrame = true;
          this.lastCapturedMediaTime = mt;
        } catch (_) {
          this.captureStatus = "cors_restricted";
          this.stopBeautyOverlay("运行时取帧受限，已恢复原画。");
          return;
        }
      }

      if (!opts.skipInfer && this.enabled && this.workerReady) {
        this.maybeDispatchInference(nowMs, false);
      }
      const hasFaceMask = !this.enabled || stallBypass ? false : this.updateFaceMaskTexture(nowMs);
      this.drawCommittedVideoTex(hasFaceMask, nowMs);
    }

    getDroppedFrames(v) {
      if (v && typeof v.getVideoPlaybackQuality === "function") return v.getVideoPlaybackQuality().droppedVideoFrames || 0;
      return 0;
    }

    recordPerformance(renderMs, nowMs) {
      this.renderFrameCount++;
      this.renderTimes.push(renderMs);
      if (this.renderTimes.length > 60) this.renderTimes.shift();
      if (nowMs - this.lastFpsWindowMs >= 1000) {
        const sec = (nowMs - this.lastFpsWindowMs) / 1000;
        this.renderFps = Math.round(this.renderFrameCount / sec);
        this.detectFps = Math.round(this.detectFrameCount / sec);
        this.renderFrameCount = 0;
        this.detectFrameCount = 0;
        this.lastFpsWindowMs = nowMs;
        const sorted = [...this.renderTimes].sort((a, b) => a - b);
        this.renderP95Ms = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
        this.droppedDelta = Math.max(0, this.getDroppedFrames(this.video) - this.baseDroppedFrames);
        if (this.renderP95Ms > 20) {
          if (++this.overBudgetStreak >= 3) {
            if (this.degradeTier === "L0") this.degradeTier = "L1";
            else if (this.degradeTier === "L1") { this.degradeTier = "L2"; this.syncCanvasGeometry(); }
            else if (this.degradeTier === "L2" && !this.theaterActive) { this.degradeTier = "L3"; this.stopBeautyOverlay("设备性能吃紧，已自动切回原画。"); }
            this.overBudgetStreak = 0;
          }
        } else {
          this.overBudgetStreak = 0;
        }
      }
    }

    startFrameLoop() {
      this.stopFrameLoop();
      if (!this.video || (!this.enabled && !this.theaterActive) || this.captureStatus !== "ready") return;
      if (typeof this.video.requestVideoFrameCallback === "function") {
        const onFrame = (now) => {
          this.rvfcHandle = null;
          if ((!this.enabled && !this.theaterActive) || !this.video || this.video.paused || this.video.ended) return;
          this.renderSingleFrame(now);
          this.rvfcHandle = this.video.requestVideoFrameCallback(onFrame);
        };
        this.rvfcHandle = this.video.requestVideoFrameCallback(onFrame);
      } else {
        const tick = (now) => {
          this.rafHandle = null;
          if ((!this.enabled && !this.theaterActive) || !this.video || this.video.paused || this.video.ended) return;
          this.renderSingleFrame(now);
          this.rafHandle = requestAnimationFrame(tick);
        };
        this.rafHandle = requestAnimationFrame(tick);
      }
    }

    stopFrameLoop() {
      if (this.rvfcHandle !== null && this.video && typeof this.video.cancelVideoFrameCallback === "function") {
        this.video.cancelVideoFrameCallback(this.rvfcHandle);
      }
      this.rvfcHandle = null;
      if (this.rafHandle !== null) { cancelAnimationFrame(this.rafHandle); this.rafHandle = null; }
    }

    showCanvas() { if (this.canvas) this.canvas.style.setProperty("display", "block", "important"); }
    hideCanvas() { if (this.canvas && !this.theaterActive) this.canvas.style.setProperty("display", "none", "important"); }

    stopBeautyOverlay(errorMessage) {
      if (!this.theaterActive) {
        this.stopFrameLoop();
        this.hideCanvas();
      }
      this.renderMode = this.enabled && errorMessage ? "native_fallback" : "off";
      if (errorMessage) this.lastError = errorMessage;
    }

    setEnabled(enabled) {
      this.enabled = !!enabled;
      this.degradeTier = "L0";
      this.overBudgetStreak = 0;
      if (!this.enabled) {
        if (this.theaterActive) {
          // Keep theater canvas rendering raw pass-through video so screen never turns black
          this.terminateFaceTracking(false);
          this.renderSingleFrame(performance.now(), { skipInfer: true });
        } else {
          this.stopBeautyOverlay("");
          this.terminateFaceTracking(false);
        }
        this.onChange();
        return;
      }
      this.workerUnavailable = false;
      if (!this.video) this.scanVideos();
      if (this.video) {
        this.probeAttempts = 0;
        this.runProtectionAndProbe();
      }
      this.onChange();
    }

    setFaceTrackingEnabled(flag) {
      this.faceTrackingEnabled = !!flag;
      safeStorageSet(STORAGE_KEY_FACE_OPT, this.faceTrackingEnabled);
      this.workerUnavailable = false;
      if (!this.faceTrackingEnabled) {
        this.terminateFaceTracking(false);
        this.latestLandmarks = null;
        this.faceAnchors = null;
        this.fadeWeight = 1.0;
        if (this.enabled && this.captureStatus === "ready") {
          this.renderSingleFrame(performance.now(), { skipInfer: true });
        }
      } else if (this.enabled && this.captureStatus === "ready") {
        this.ensureFaceTracking();
      } else {
        this.workerStatus = "待开启美颜后启动";
      }
      this.onChange();
    }

    setBeautyParams(partial) {
      this.params = normalizeParams(partial, this.params).params;
      safeStorageSet(STORAGE_KEY_PARAMS, this.params);
      if (this.enabled && this.captureStatus === "ready") {
        this.renderSingleFrame(performance.now(), { skipInfer: true });
      }
    }

    setCompareOriginal(flag) {
      this.compareOriginal = !!flag;
      if ((this.enabled || this.theaterActive) && this.captureStatus === "ready") {
        this.renderSingleFrame(performance.now(), { skipInfer: true });
      }
    }

    teardownAll() {
      this.destroyed = true;
      this.exitTheaterMode();
      this.setEnabled(false);
      this.unbindCurrentVideo();
      this.terminateFaceTracking(false, true);
      this.destroyProbeWebGL();
      if (this.mutationObserver) this.mutationObserver.disconnect();
    }

    getStateSnapshot() {
      const videos = [];
      for (const [id, v] of this.videosMap.entries()) {
        const src = v.currentSrc || v.src || "";
        let scheme = "未知";
        if (src.startsWith("blob:")) scheme = "blob:";
        else if (src.startsWith("https:")) scheme = "https:";
        else if (src.startsWith("http:")) scheme = "http:";
        else if (!src && v.srcObject) scheme = "媒体流";
        let streamKind = "未确认";
        if (v.duration === Infinity) streamKind = "直播";
        else if (Number.isFinite(v.duration) && v.duration > 0) streamKind = "点播";
        let playbackState = "播放中";
        if (v.error) playbackState = "播放错误";
        else if (v.ended) playbackState = "已结束";
        else if (v.readyState === 0) playbackState = "加载中";
        else if (v.readyState < 3 && !v.paused) playbackState = "缓冲中";
        else if (v.paused) playbackState = "暂停";

        videos.push({
          id,
          label: v.closest(".plyr, .xgplayer, .bpx-player-video-wrap, .html5-video-player") ? "主播放器" : "HTML5 视频",
          frameOrigin: this.videoOrigins.get(v) || "主页面",
          playbackState,
          videoWidth: v.videoWidth || 0,
          videoHeight: v.videoHeight || 0,
          paused: v.paused,
          currentTime: v.currentTime || 0,
          duration: v.duration,
          playbackRate: v.playbackRate || 1,
          sourceScheme: scheme,
          streamKind,
        });
      }

      let fullscreenState = "非全屏";
      const doc = (this.video && this.video.ownerDocument) || document;
      const fsEl = doc.fullscreenElement || doc.webkitFullscreenElement || document.fullscreenElement;
      if (this.theaterActive) fullscreenState = this.theaterRotated ? "美颜剧场全屏（横屏 90°）" : "美颜剧场全屏";
      else if (this.iosNativeFullscreen || fsEl === this.video) fullscreenState = "原生 <video> 全屏（已回退）";
      else if (fsEl) fullscreenState = "容器全屏（支持叠层）";

      let overlayInfo = "未挂载";
      if (this.canvas && this.video) {
        const win = (this.video.ownerDocument && this.video.ownerDocument.defaultView) || window;
        const cRect = this.canvas.getBoundingClientRect();
        const cStyle = win.getComputedStyle(this.canvas);
        const vStyle = win.getComputedStyle(this.video);
        const tag = (this.canvas.parentElement && this.canvas.parentElement.tagName.toLowerCase()) || "?";
        const vis = cStyle.display !== "none" && cRect.width > 1 && cRect.height > 1 ? "可见" : "隐藏";
        overlayInfo = `${vis} ${Math.round(cRect.width)}×${Math.round(cRect.height)} z=${cStyle.zIndex}/v=${vStyle.zIndex} (${tag})`;
      }

      return {
        enabled: this.enabled,
        theaterActive: this.theaterActive,
        theaterRotated: this.theaterRotated,
        theaterFill: this.theaterFill,
        faceTrackingEnabled: this.faceTrackingEnabled,
        params: { ...this.params },
        selectedVideoId: this.selectedVideoId,
        userLockedId: this.userLockedId,
        videos,
        unsupportedHints: this.unsupportedHints,
        protectionSignal: this.protectionSignal,
        captureStatus: this.captureStatus,
        renderMode: this.renderMode,
        lastError: this.lastError,
        diagnostics: {
          adapterName: this.adapterName,
          degradeTier: this.degradeTier,
          renderFps: this.renderFps,
          detectFps: this.detectFps,
          renderP95Ms: this.renderP95Ms,
          workerStatus: this.workerStatus,
          droppedDelta: this.droppedDelta,
          lastCapturedMediaTime: this.lastCapturedMediaTime,
          overlayInfo,
          fullscreenState,
        },
      };
    }
  }

  // ==================== Shadow DOM Floating UI + iOS Theater Fullscreen ====================
  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif; }
    .hidden { display: none !important; }

    /* Floating pill FAB */
    .fab-group {
      position: fixed;
      right: 12px;
      bottom: 84px;
      z-index: 2147483645;
      display: flex;
      align-items: center;
      gap: 6px;
      touch-action: none;
    }
    .fab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 13px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.22);
      background: rgba(15, 23, 42, 0.88);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      color: #f8fafc;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 6px 20px rgba(0,0,0,0.35);
      cursor: pointer;
      user-select: none;
      touch-action: none;
    }
    .fab .dot { width: 8px; height: 8px; border-radius: 50%; background: #64748b; }
    .fab.on .dot { background: #ec4899; box-shadow: 0 0 8px #ec4899; }
    .fab-fs {
      padding: 8px 11px;
      font-size: 12px;
      font-weight: 600;
      background: linear-gradient(135deg, rgba(236,72,153,0.9), rgba(139,92,246,0.9));
      border-color: rgba(255,255,255,0.28);
    }

    /* Theater Fullscreen Stage (iOS web fullscreen + 90-deg landscape rotate) */
    .theater-stage {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      background: #000;
      overflow: hidden;
      touch-action: manipulation;
      user-select: none;
    }
    .theater-viewport {
      position: fixed;
      top: 50%;
      left: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #000;
      overflow: hidden;
      transform-origin: center center;
    }
    .theater-media-slot {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #000;
    }
    .theater-hud {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      pointer-events: none;
      transition: opacity 0.22s ease;
      z-index: 5;
    }
    .theater-hud.faded { opacity: 0; }
    .theater-top {
      pointer-events: auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 12px 14px 20px;
      background: linear-gradient(180deg, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0) 100%);
    }
    .theater-bottom {
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 20px 14px 14px;
      background: linear-gradient(0deg, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0) 100%);
    }
    .t-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .t-group { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; }
    .t-btn {
      border: 1px solid rgba(255,255,255,0.22);
      background: rgba(15, 23, 42, 0.72);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: #f8fafc;
      border-radius: 999px;
      padding: 6px 11px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      touch-action: manipulation;
    }
    .t-btn.active {
      background: linear-gradient(135deg, #ec4899, #8b5cf6);
      border-color: transparent;
    }
    .t-play {
      width: 34px; height: 34px; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 14px; flex: 0 0 auto;
    }
    .t-time {
      font-size: 11px; color: #e2e8f0;
      font-family: ui-monospace, monospace; white-space: nowrap;
    }
    .t-seek {
      flex: 1;
      height: 5px;
      accent-color: #ec4899;
      margin: 0;
      cursor: pointer;
      touch-action: none;
    }
    .theater-toast {
      position: absolute;
      top: 56px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 8;
      background: rgba(15, 23, 42, 0.88);
      border: 1px solid rgba(255,255,255,0.18);
      color: #f8fafc;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 12px;
      pointer-events: none;
      white-space: nowrap;
    }

    /* Main Panel (works both normally and docked inside Theater Viewport including 90-deg landscape!) */
    .panel {
      position: fixed;
      right: 10px;
      bottom: 14px;
      z-index: 2147483647;
      width: min(382px, calc(100vw - 20px));
      max-height: 78vh;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      background: rgba(15, 23, 42, 0.96);
      border: 1px solid #334155;
      border-radius: 14px;
      padding: 11px 12px;
      color: #e2e8f0;
      font-size: 13px;
      box-shadow: 0 12px 36px rgba(0,0,0,0.58);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .panel.in-theater {
      position: absolute;
      right: 10px;
      bottom: 10px;
      top: auto;
      width: min(368px, calc(100% - 20px));
      max-height: calc(100% - 20px);
      z-index: 20;
      background: rgba(15, 23, 42, 0.92);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }

    .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .header h1 { margin: 0; font-size: 15px; color: #f8fafc; }
    .sub { margin: 2px 0 0; font-size: 11px; color: #94a3b8; }
    .hdr-right { display: flex; align-items: center; gap: 8px; }
    .close-btn {
      background: #334155; color: #e2e8f0; border: none; border-radius: 999px;
      width: 26px; height: 26px; font-size: 15px; line-height: 26px; text-align: center; cursor: pointer;
    }
    .card {
      background: #1e293b; border: 1px solid #334155; border-radius: 10px;
      padding: 9px 10px; display: flex; flex-direction: column; gap: 7px;
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .label { font-size: 12px; color: #cbd5e1; font-weight: 500; }
    .muted { font-size: 11px; color: #94a3b8; }
    .select {
      width: 100%; background: #0f172a; color: #f1f5f9; border: 1px solid #475569;
      border-radius: 6px; padding: 6px 8px; font-size: 12px;
    }
    .badges { display: flex; flex-wrap: wrap; gap: 5px; }
    .badge { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: #334155; color: #e2e8f0; }
    .badge.ok { background: #064e3b; color: #6ee7b7; }
    .badge.warn { background: #78350f; color: #fcd34d; }
    .badge.err { background: #7f1d1d; color: #fca5a5; }
    .presets { display: flex; flex-wrap: wrap; gap: 5px; }
    .pill {
      border: 1px solid #475569; background: #0f172a; color: #cbd5e1;
      border-radius: 999px; padding: 4px 9px; font-size: 11px; cursor: pointer;
    }
    .pill.active { background: linear-gradient(135deg, #ec4899, #8b5cf6); border-color: transparent; color: #fff; font-weight: 500; }
    .tabs { display: grid; grid-template-columns: repeat(5, 1fr); background: #0f172a; border-radius: 8px; padding: 3px; gap: 3px; }
    .tab { border: none; background: transparent; color: #94a3b8; border-radius: 6px; padding: 6px 2px; font-size: 11px; cursor: pointer; white-space: nowrap; }
    .tab.active { background: #334155; color: #f8fafc; font-weight: 500; }
    .tip { margin: 0; padding: 5px 8px; background: #0f172a; border-left: 2px solid #ec4899; border-radius: 4px; font-size: 11px; color: #94a3b8; line-height: 1.35; }
    .sliders { display: flex; flex-direction: column; gap: 7px; max-height: 220px; overflow-y: auto; padding-right: 2px; }
    .s-row { display: grid; grid-template-columns: 78px 1fr 34px; align-items: center; gap: 7px; }
    .s-name { font-size: 12px; color: #cbd5e1; white-space: nowrap; user-select: none; }
    .s-name .tag { font-size: 9px; color: #f59e0b; margin-left: 2px; }
    .s-val { font-size: 11px; font-weight: 600; color: #f472b6; text-align: right; font-family: ui-monospace, monospace; }
    .s-val.neg { color: #38bdf8; }
    .s-val.zero { color: #64748b; font-weight: 500; }
    input[type="range"] { width: 100%; margin: 0; accent-color: #ec4899; touch-action: none; }
    input[type="range"].bipolar { accent-color: #a855f7; }

    .swatch-row { display: grid; grid-template-columns: 78px 1fr; align-items: center; gap: 7px; padding-top: 5px; border-top: 1px dashed #334155; }
    .swatch-list { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
    .swatch {
      display: inline-flex; align-items: center; justify-content: center; gap: 3px;
      padding: 5px 3px; background: #0f172a; border: 1px solid #475569; border-radius: 6px;
      color: #cbd5e1; font-size: 11px; cursor: pointer; white-space: nowrap;
    }
    .swatch.active { border-color: #ec4899; background: rgba(236,72,153,0.18); color: #fff; font-weight: 500; }
    .swatch-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 0 1px rgba(255,255,255,0.25); }

    .actions { display: flex; gap: 6px; }
    .btn {
      flex: 1; border: none; border-radius: 8px; padding: 8px 8px; font-size: 12px; font-weight: 500;
      cursor: pointer; user-select: none; touch-action: manipulation; text-align: center;
    }
    .btn.primary { background: #0284c7; color: #fff; }
    .btn.primary.active { background: #0369a1; }
    .btn.accent { background: linear-gradient(135deg, #ec4899, #8b5cf6); color: #fff; }
    .btn.ghost { background: #334155; color: #e2e8f0; }
    .btn.sm { padding: 6px 6px; font-size: 11px; }
    .file-lbl { display: inline-flex; align-items: center; justify-content: center; }
    .link { background: none; border: none; color: #38bdf8; font-size: 11px; cursor: pointer; padding: 0; }
    .switch { position: relative; display: inline-block; width: 42px; height: 24px; flex: 0 0 auto; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .sw-track { position: absolute; inset: 0; background: #475569; border-radius: 999px; transition: 0.2s; cursor: pointer; }
    .sw-track:before { content: ""; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: 0.2s; }
    .switch input:checked + .sw-track { background: linear-gradient(135deg, #ec4899, #8b5cf6); }
    .switch input:checked + .sw-track:before { transform: translateX(18px); }
    .json-box {
      width: 100%; background: #0f172a; color: #e2e8f0; border: 1px solid #475569;
      border-radius: 6px; padding: 6px 8px; font-size: 11px; font-family: ui-monospace, monospace; line-height: 1.35;
    }
    .diag summary { cursor: pointer; font-size: 12px; color: #cbd5e1; }
    .diag-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; font-size: 11px; color: #94a3b8; margin-top: 6px; }
    .diag-grid .val { color: #f1f5f9; text-align: right; font-family: ui-monospace, monospace; }
    .hint { font-size: 11px; color: #6ee7b7; line-height: 1.35; }
    .hint.err { color: #fca5a5; }
    .err-banner { background: #7f1d1d; color: #fecaca; border: 1px solid #b91c1c; border-radius: 8px; padding: 7px 9px; font-size: 11px; }
  `;

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "--:--";
    return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  }

  function mountUI() {
    const host = document.createElement("div");
    host.id = "wvb-ios-root";
    const shadow = host.attachShadow({ mode: "open" });

    const styleEl = document.createElement("style");
    styleEl.textContent = UI_CSS;
    shadow.appendChild(styleEl);

    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="fab-group" id="fabGroup">
        <div class="fab fab-fs hidden" id="fabFs" role="button" aria-label="美颜全屏">⛶ 全屏</div>
        <div class="fab" id="fab" role="button" aria-label="打开实时美颜">
          <span class="dot"></span><span id="fabText">美颜</span>
        </div>
      </div>

      <div class="theater-stage hidden" id="theaterStage">
        <div class="theater-viewport" id="theaterViewport">
          <div class="theater-media-slot" id="theaterMediaSlot"></div>
          <div class="theater-toast hidden" id="theaterToast"></div>
          <div class="theater-hud" id="theaterHud">
            <div class="theater-top">
              <div class="t-group">
                <button class="t-btn" id="btnExitTheater" type="button">← 退出</button>
                <button class="t-btn active" id="btnTheaterBeauty" type="button">美颜开</button>
              </div>
              <div class="t-group">
                <button class="t-btn" id="btnTheaterFill" type="button">适应</button>
                <button class="t-btn" id="btnTheaterRotate" type="button">↻ 横屏90°</button>
                <button class="t-btn" id="btnTheaterPanel" type="button">🎛 调参</button>
              </div>
            </div>
            <div class="theater-bottom">
              <div class="t-row">
                <button class="t-btn t-play" id="btnTheaterPlay" type="button">❚❚</button>
                <span class="t-time" id="theaterTimeCur">00:00</span>
                <input class="t-seek" id="theaterSeek" type="range" min="0" max="1000" value="0" />
                <span class="t-time" id="theaterTimeDur">00:00</span>
              </div>
              <div class="t-row">
                <div class="t-group">
                  <button class="t-btn" id="btnTheaterSpeed" type="button">1.0x</button>
                  <button class="t-btn" id="btnTheaterCompare" type="button">按住看原画</button>
                </div>
                <span class="t-time" id="theaterPresetTag">自然清透</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel hidden" id="panel">
        <div class="header">
          <div>
            <h1>实时美颜</h1>
            <p class="sub">iOS Safari · 26 项专业调参 + 剧场横屏</p>
          </div>
          <div class="hdr-right">
            <label class="switch" title="开启或关闭美颜"><input type="checkbox" id="toggleBeauty" /><span class="sw-track"></span></label>
            <button class="close-btn" id="btnClose" type="button">×</button>
          </div>
        </div>

        <div class="card">
          <div class="row">
            <span class="label">当前视频</span>
            <button class="link" id="btnRescan" type="button">重新扫描</button>
          </div>
          <select class="select" id="videoSelect"></select>
          <div class="muted" id="videoMeta">检测中…</div>
          <div class="badges">
            <span class="badge" id="bProt">保护：检测中</span>
            <span class="badge" id="bCap">取帧：等待中</span>
            <span class="badge" id="bMode">模式：已关闭</span>
          </div>
          <div class="row" style="margin-top:2px;">
            <span class="muted">478 点人脸遮罩（在线加载，解锁美型/美妆）</span>
            <label class="switch"><input type="checkbox" id="toggleFace" /><span class="sw-track"></span></label>
          </div>
        </div>

        <div class="card">
          <div class="row">
            <span class="label">风格预设</span>
            <span class="muted" id="presetLabel">自定义</span>
          </div>
          <div class="presets" id="presetBar">
            <button class="pill" data-preset="natural" type="button">自然清透</button>
            <button class="pill" data-preset="cool_fair" type="button">冷白质感</button>
            <button class="pill" data-preset="soft_glow" type="button">日系柔光</button>
            <button class="pill" data-preset="delicate" type="button">纯欲微调</button>
            <button class="pill" data-preset="glam" type="button">网感精修</button>
            <button class="pill" data-preset="youthful" type="button">减龄打底</button>
            <button class="pill" data-preset="reset" type="button">归零</button>
          </div>

          <div class="tabs">
            <button class="tab active" data-tab="skin" type="button">美肤</button>
            <button class="tab" data-tab="reshape" type="button">美型</button>
            <button class="tab" data-tab="makeup" type="button">美妆</button>
            <button class="tab" data-tab="color" type="button">调色</button>
            <button class="tab" data-tab="io" type="button">方案</button>
          </div>

          <div id="pane-skin"><div class="sliders" id="skinSliders"></div></div>

          <div id="pane-reshape" class="hidden">
            <p class="tip">美型需开启上方「478 点人脸遮罩」；双击项名可单项归零。</p>
            <div class="sliders" id="reshapeSliders" style="margin-top:6px;"></div>
          </div>

          <div id="pane-makeup" class="hidden">
            <div class="sliders" id="makeupSliders"></div>
            <div class="swatch-row">
              <span class="s-name">唇色风格</span>
              <div class="swatch-list" id="lipShadeList">
                <button class="swatch" data-shade="0" type="button"><span class="swatch-dot" style="background:#eb8f9e"></span>裸粉</button>
                <button class="swatch" data-shade="1" type="button"><span class="swatch-dot" style="background:#f27a5c"></span>蜜桃</button>
                <button class="swatch" data-shade="2" type="button"><span class="swatch-dot" style="background:#e0526b"></span>豆沙</button>
                <button class="swatch" data-shade="3" type="button"><span class="swatch-dot" style="background:#d1293d"></span>正红</button>
              </div>
            </div>
          </div>

          <div id="pane-color" class="hidden">
            <p class="tip">画面调色作用于整帧（无需 478 点，双向滑块支持 -50 ~ +50）。</p>
            <div class="sliders" id="colorSliders" style="margin-top:6px;"></div>
          </div>

          <div id="pane-io" class="hidden" style="display:flex;flex-direction:column;gap:6px;">
            <div class="actions">
              <button class="btn ghost sm" id="btnSave" type="button">存为我的方案</button>
              <button class="btn ghost sm" id="btnLoad" type="button">加载我的方案</button>
            </div>
            <div class="actions">
              <button class="btn ghost sm" id="btnExport" type="button">复制 JSON</button>
              <button class="btn ghost sm" id="btnExportFile" type="button">下载 .json</button>
              <label class="btn ghost sm file-lbl">选择 .json<input id="inputImportFile" type="file" accept=".json,application/json" hidden /></label>
            </div>
            <textarea class="json-box" id="jsonBox" rows="3" placeholder='粘贴参数 JSON 或 Wink/小红书中文配方，如：&#10;小脸+20 颧骨+8 眼睛倾斜-29 鼻子大小+34 口红/豆沙+18 饱和度-20 色温-8'></textarea>
            <button class="btn primary sm" id="btnImport" type="button">识别并应用 JSON / 配方文本</button>
            <span class="hint" id="ioHint"></span>
          </div>

          <div class="actions">
            <button class="btn accent" id="btnEnterTheater" type="button">⛶ 美颜全屏</button>
            <button class="btn primary" id="btnCompare" type="button">按住看原画</button>
            <button class="btn ghost" id="btnRetry" type="button">重检</button>
          </div>
        </div>

        <details class="card diag">
          <summary>诊断信息与性能监控</summary>
          <div class="diag-grid" id="diagGrid"></div>
          <div class="row" style="margin-top:6px;">
            <button class="btn ghost sm" id="btnCopyDiag" type="button" style="flex:0 0 auto;">复制诊断 JSON</button>
            <span class="hint" id="copyHint"></span>
          </div>
        </details>

        <div class="err-banner hidden" id="errBanner"></div>
      </div>
    `;
    shadow.appendChild(wrap);
    (document.body || document.documentElement).appendChild(host);

    const $ = (id) => shadow.getElementById(id);
    const ui = {
      fabGroup: $("fabGroup"),
      fab: $("fab"),
      fabFs: $("fabFs"),
      fabText: $("fabText"),
      theaterStage: $("theaterStage"),
      theaterViewport: $("theaterViewport"),
      theaterMediaSlot: $("theaterMediaSlot"),
      theaterHud: $("theaterHud"),
      theaterToast: $("theaterToast"),
      btnExitTheater: $("btnExitTheater"),
      btnTheaterBeauty: $("btnTheaterBeauty"),
      btnTheaterFill: $("btnTheaterFill"),
      btnTheaterRotate: $("btnTheaterRotate"),
      btnTheaterPanel: $("btnTheaterPanel"),
      btnTheaterPlay: $("btnTheaterPlay"),
      theaterSeek: $("theaterSeek"),
      theaterTimeCur: $("theaterTimeCur"),
      theaterTimeDur: $("theaterTimeDur"),
      btnTheaterSpeed: $("btnTheaterSpeed"),
      btnTheaterCompare: $("btnTheaterCompare"),
      theaterPresetTag: $("theaterPresetTag"),
      panel: $("panel"),
      toggleBeauty: $("toggleBeauty"),
      toggleFace: $("toggleFace"),
      btnClose: $("btnClose"),
      btnRescan: $("btnRescan"),
      videoSelect: $("videoSelect"),
      videoMeta: $("videoMeta"),
      bProt: $("bProt"),
      bCap: $("bCap"),
      bMode: $("bMode"),
      presetBar: $("presetBar"),
      presetLabel: $("presetLabel"),
      skinSliders: $("skinSliders"),
      reshapeSliders: $("reshapeSliders"),
      makeupSliders: $("makeupSliders"),
      colorSliders: $("colorSliders"),
      lipShadeList: $("lipShadeList"),
      btnSave: $("btnSave"),
      btnLoad: $("btnLoad"),
      btnExport: $("btnExport"),
      btnExportFile: $("btnExportFile"),
      inputImportFile: $("inputImportFile"),
      btnImport: $("btnImport"),
      jsonBox: $("jsonBox"),
      ioHint: $("ioHint"),
      btnEnterTheater: $("btnEnterTheater"),
      btnCompare: $("btnCompare"),
      btnRetry: $("btnRetry"),
      diagGrid: $("diagGrid"),
      btnCopyDiag: $("btnCopyDiag"),
      copyHint: $("copyHint"),
      errBanner: $("errBanner"),
    };

    const sliderInputs = new Map();
    const sliderVals = new Map();
    let panelOpen = false;
    let isDragging = false;
    let isSeeking = false;
    let engine = null;
    let hudVisible = true;
    let hudAutoHideTimer = null;
    let toastTimer = null;
    let savedDocOverflow = "";
    const SPEED_STEPS = [1.0, 1.25, 1.5, 2.0, 0.75];

    function showToast(msg) {
      ui.theaterToast.textContent = msg;
      ui.theaterToast.classList.remove("hidden");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => ui.theaterToast.classList.add("hidden"), 2000);
    }

    function layoutTheaterViewport() {
      if (!engine || !engine.theaterActive) return;
      const vpW = (window.visualViewport && window.visualViewport.width) || window.innerWidth;
      const vpH = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
      if (engine.theaterRotated) {
        ui.theaterViewport.style.width = `${vpH}px`;
        ui.theaterViewport.style.height = `${vpW}px`;
        ui.theaterViewport.style.transform = "translate(-50%, -50%) rotate(90deg)";
      } else {
        ui.theaterViewport.style.width = `${vpW}px`;
        ui.theaterViewport.style.height = `${vpH}px`;
        ui.theaterViewport.style.transform = "translate(-50%, -50%)";
      }
      engine.syncCanvasGeometry();
    }

    function setHudVisible(vis, scheduleAutoHide = true) {
      hudVisible = !!vis;
      ui.theaterHud.classList.toggle("faded", !hudVisible);
      ui.theaterHud.style.pointerEvents = hudVisible ? "none" : "none";
      ui.theaterHud.querySelectorAll(".theater-top, .theater-bottom").forEach((el) => {
        el.style.pointerEvents = hudVisible ? "auto" : "none";
      });
      if (hudAutoHideTimer) { clearTimeout(hudAutoHideTimer); hudAutoHideTimer = null; }
      if (hudVisible && scheduleAutoHide && !panelOpen && engine && engine.video && !engine.video.paused) {
        hudAutoHideTimer = setTimeout(() => {
          if (engine && engine.theaterActive && !panelOpen && !isSeeking && engine.video && !engine.video.paused) {
            setHudVisible(false, false);
          }
        }, 3600);
      }
    }

    function openTheater(autoRotate = false) {
      if (!engine) return false;
      if (!engine.video) engine.scanVideos();
      const res = engine.enterTheaterMode(ui.theaterMediaSlot);
      if (!res.ok) {
        ui.errBanner.textContent = res.reason;
        ui.errBanner.classList.remove("hidden");
        return false;
      }
      savedDocOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
      panelOpen = false;
      ui.panel.classList.add("hidden");
      ui.panel.classList.add("in-theater");
      ui.theaterViewport.appendChild(ui.panel);
      ui.fabGroup.classList.add("hidden");
      ui.theaterStage.classList.remove("hidden");
      if (autoRotate) engine.setTheaterRotated(true);
      layoutTheaterViewport();
      setHudVisible(true, true);
      updateTheaterHud();
      renderUI();
      showToast(engine.theaterRotated ? "已进入横屏美颜全屏" : "已进入美颜全屏 · 点右上角可一键横屏");
      return true;
    }

    function closeTheater() {
      if (!engine || !engine.theaterActive) return;
      engine.exitTheaterMode();
      document.documentElement.style.overflow = savedDocOverflow;
      panelOpen = false;
      ui.panel.classList.add("hidden");
      ui.panel.classList.remove("in-theater");
      wrap.appendChild(ui.panel);
      ui.theaterStage.classList.add("hidden");
      if (hudAutoHideTimer) { clearTimeout(hudAutoHideTimer); hudAutoHideTimer = null; }
      renderUI();
    }

    function updateTheaterHud() {
      if (!engine || !engine.theaterActive || !engine.video) return;
      const v = engine.video;
      ui.btnTheaterPlay.textContent = v.paused ? "▶" : "❚❚";
      ui.btnTheaterBeauty.textContent = engine.enabled ? "美颜开" : "原画";
      ui.btnTheaterBeauty.classList.toggle("active", engine.enabled);
      ui.btnTheaterRotate.textContent = engine.theaterRotated ? "↺ 竖屏" : "↻ 横屏90°";
      ui.btnTheaterRotate.classList.toggle("active", engine.theaterRotated);
      ui.btnTheaterFill.textContent = engine.theaterFill ? "铺满" : "适应";
      ui.btnTheaterFill.classList.toggle("active", engine.theaterFill);
      ui.btnTheaterSpeed.textContent = `${Number(v.playbackRate || 1).toFixed(v.playbackRate % 1 === 0 ? 1 : 2)}x`;
      const pk = detectPreset(engine.params);
      ui.theaterPresetTag.textContent = pk !== "custom" && PRESETS[pk] ? PRESETS[pk].name : "自定义";

      const cur = v.currentTime || 0;
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      ui.theaterTimeCur.textContent = formatTime(cur);
      ui.theaterTimeDur.textContent = dur > 0 ? formatTime(dur) : "直播";
      ui.theaterSeek.disabled = dur <= 0;
      if (!isSeeking && dur > 0) {
        ui.theaterSeek.value = String(Math.round((cur / dur) * 1000));
      }
    }

    // Intercept native webkitEnterFullscreen when beauty is active & frame capture is ready
    nativeFullscreenInterceptor = (targetVideo) => {
      if (!engine || !engine.enabled || engine.captureStatus !== "ready") return false;
      if (targetVideo && engine.video !== targetVideo) {
        const vidId = engine.getVideoId(targetVideo);
        if (engine.videosMap.has(vidId)) engine.selectVideoByUser(vidId);
      }
      return openTheater(false);
    };

    function detectPreset(p) {
      for (const [k, pr] of Object.entries(PRESETS)) {
        let same = true;
        for (const s of ALL_SLIDERS) {
          if (toUiValue(s.key, p[s.key] || 0) !== toUiValue(s.key, pr.params[s.key] || 0)) {
            same = false; break;
          }
        }
        if (same && (p.lipShade ?? 2) !== (pr.params.lipShade ?? 2)) {
          if ((p.lipTint || 0) > 0 || k !== "reset") same = false;
        }
        if (same) return k;
      }
      return "custom";
    }

    function updateValStyle(valEl, key, uiVal) {
      valEl.textContent = formatSliderText(key, uiVal);
      valEl.classList.toggle("zero", uiVal === 0);
      valEl.classList.toggle("neg", BIPOLAR_KEYS.has(key) && uiVal < 0);
    }

    function syncLipShade(shadeIdx) {
      const idx = Math.max(0, Math.min(LIP_SHADE_NAMES.length - 1, Math.round(shadeIdx ?? 2)));
      ui.lipShadeList.querySelectorAll(".swatch").forEach((b) => b.classList.toggle("active", Number(b.dataset.shade) === idx));
    }

    function syncSliders(p) {
      for (const s of ALL_SLIDERS) {
        const uiVal = toUiValue(s.key, p[s.key] || 0);
        const inp = sliderInputs.get(s.key);
        const val = sliderVals.get(s.key);
        if (inp) inp.value = String(uiVal);
        if (val) updateValStyle(val, s.key, uiVal);
      }
      syncLipShade(p.lipShade ?? 2);
      const pk = detectPreset(p);
      ui.presetBar.querySelectorAll(".pill").forEach((b) => b.classList.toggle("active", b.dataset.preset === pk));
      ui.presetLabel.textContent = pk !== "custom" && PRESETS[pk] ? PRESETS[pk].name : "自定义";
    }

    function buildSliders(container, specs) {
      container.replaceChildren();
      for (const s of specs) {
        const isBi = !!s.bipolar;
        const row = document.createElement("div");
        row.className = "s-row";
        const name = document.createElement("span");
        name.className = "s-name";
        name.textContent = s.label;
        name.title = "双击重置为 0";
        if (s.needsFace) {
          const tag = document.createElement("span");
          tag.className = "tag";
          tag.textContent = "478";
          name.appendChild(tag);
        }
        const inp = document.createElement("input");
        inp.type = "range";
        inp.dataset.key = s.key;
        inp.min = isBi ? "-50" : "0";
        inp.max = isBi ? "50" : "100";
        if (isBi) inp.classList.add("bipolar");
        const val = document.createElement("span");
        val.className = "s-val";

        const resetSingle = () => {
          inp.value = "0";
          updateValStyle(val, s.key, 0);
          engine.setBeautyParams({ [s.key]: 0 });
          syncSliders(engine.params);
        };
        // Double-tap / double-click on label resets single slider to 0
        let lastTap = 0;
        name.addEventListener("dblclick", resetSingle);
        name.addEventListener("touchend", () => {
          const now = Date.now();
          if (now - lastTap < 320) resetSingle();
          lastTap = now;
        }, { passive: true });

        inp.addEventListener("pointerdown", () => { isDragging = true; });
        inp.addEventListener("touchstart", () => { isDragging = true; }, { passive: true });
        inp.addEventListener("input", () => {
          const uiVal = Number(inp.value);
          updateValStyle(val, s.key, uiVal);
          engine.setBeautyParams({ [s.key]: isBi ? uiVal / 50 : uiVal / 100 });
          const pk = detectPreset(engine.params);
          ui.presetBar.querySelectorAll(".pill").forEach((b) => b.classList.toggle("active", b.dataset.preset === pk));
          ui.presetLabel.textContent = pk !== "custom" && PRESETS[pk] ? PRESETS[pk].name : "自定义";
        });
        sliderInputs.set(s.key, inp);
        sliderVals.set(s.key, val);
        row.appendChild(name);
        row.appendChild(inp);
        row.appendChild(val);
        container.appendChild(row);
      }
    }

    function renderUI() {
      if (!engine) return;
      const st = engine.getStateSnapshot();
      const hasAnyVideo = st.videos.length > 0;
      const canTheater = hasAnyVideo && st.captureStatus !== "cors_restricted" && st.captureStatus !== "skipped_eme";

      if (st.theaterActive) {
        ui.fabGroup.classList.add("hidden");
        updateTheaterHud();
      } else {
        const shouldShowFab = !panelOpen && (IS_TOP_FRAME || hasAnyVideo);
        ui.fabGroup.classList.toggle("hidden", !shouldShowFab);
        ui.fabFs.classList.toggle("hidden", !canTheater);
        ui.fab.classList.toggle("on", !!st.enabled);
        ui.fab.style.opacity = hasAnyVideo || st.enabled ? "1" : "0.65";
        ui.fabText.textContent = hasAnyVideo ? "美颜" : "美颜(0)";
      }

      if (!panelOpen) return;

      ui.toggleBeauty.checked = !!st.enabled;
      ui.toggleFace.checked = !!st.faceTrackingEnabled;
      ui.btnEnterTheater.textContent = st.theaterActive ? "退出全屏" : "⛶ 美颜全屏";
      if (!isDragging) syncSliders(st.params);

      if (st.lastError) {
        ui.errBanner.textContent = st.lastError;
        ui.errBanner.classList.remove("hidden");
      } else {
        ui.errBanner.classList.add("hidden");
      }

      ui.videoSelect.replaceChildren();
      if (!st.videos.length) {
        const opt = document.createElement("option");
        opt.textContent = "未检测到可访问的 HTML5 视频";
        ui.videoSelect.appendChild(opt);
        ui.videoSelect.disabled = true;
        ui.videoMeta.textContent = st.unsupportedHints.length
          ? `待适配场景：${st.unsupportedHints.join("、")}`
          : "请等待视频播放器加载。";
      } else {
        ui.videoSelect.disabled = false;
        for (const v of st.videos) {
          const opt = document.createElement("option");
          opt.value = v.id;
          const lock = v.id === st.userLockedId ? " [锁定]" : "";
          opt.textContent = `${v.label} (${v.videoWidth}×${v.videoHeight}·${v.frameOrigin}) ${v.playbackState}${lock}`;
          if (v.id === st.selectedVideoId) opt.selected = true;
          ui.videoSelect.appendChild(opt);
        }
        const sel = st.videos.find((v) => v.id === st.selectedVideoId) || st.videos[0];
        ui.videoMeta.textContent =
          `${sel.playbackState} · ${sel.frameOrigin} | ${sel.videoWidth}×${sel.videoHeight} | ` +
          `${formatTime(sel.currentTime)}/${formatTime(sel.duration)} | ${sel.sourceScheme}`;
      }

      const setB = (el, txt, lvl) => { el.textContent = txt; el.className = "badge " + lvl; };
      const pMap = { none: ["保护：未观察到", "ok"], eme_media_keys: ["保护：检测到 EME", "err"], eme_encrypted_event: ["保护：收到 encrypted", "err"] };
      setB(ui.bProt, ...(pMap[st.protectionSignal] || ["保护：未观察到", ""]));
      const cMap = { waiting: ["取帧：等待画面", "warn"], ready: ["取帧：可取帧", "ok"], cors_restricted: ["取帧：跨域受限", "err"], skipped_eme: ["取帧：EME 已跳过", "err"], failed_unknown: ["取帧：失败未确认", "err"], idle: ["取帧：未启动", ""] };
      setB(ui.bCap, ...(cMap[st.captureStatus] || ["取帧：未知", ""]));
      const mMap = { face_mask: ["模式：478点遮罩", "ok"], skin_fallback: ["模式：肤色保边", "warn"], native_fallback: ["模式：原画回退", "warn"], off: ["模式：已关闭", ""] };
      setB(ui.bMode, ...(mMap[st.renderMode] || ["模式：待就绪", ""]));

      const d = st.diagnostics;
      const rows = [
        ["站点适配器", d.adapterName],
        ["降级档位", d.degradeTier],
        ["渲染 / 检测", `${d.renderFps} / ${d.detectFps} fps`],
        ["渲染耗时 (P95)", `${d.renderP95Ms.toFixed(1)} ms`],
        ["人脸追踪", d.workerStatus],
        ["叠层状态", d.overlayInfo],
        ["全屏状态", d.fullscreenState],
      ];
      if (st.unsupportedHints.length) rows.push(["待适配提示", st.unsupportedHints.join("、")]);
      ui.diagGrid.replaceChildren();
      for (const [k, v] of rows) {
        const ke = document.createElement("span"); ke.textContent = k;
        const ve = document.createElement("span"); ve.className = "val"; ve.textContent = String(v);
        ui.diagGrid.appendChild(ke); ui.diagGrid.appendChild(ve);
      }
    }

    // Draggable FAB group
    let fabDrag = null;
    ui.fab.addEventListener("pointerdown", (e) => {
      const r = ui.fabGroup.getBoundingClientRect();
      fabDrag = { sx: e.clientX, sy: e.clientY, rx: window.innerWidth - r.right, by: window.innerHeight - r.bottom, moved: false };
      try { ui.fab.setPointerCapture(e.pointerId); } catch (_) {}
    });
    ui.fab.addEventListener("pointermove", (e) => {
      if (!fabDrag) return;
      const dx = e.clientX - fabDrag.sx;
      const dy = e.clientY - fabDrag.sy;
      if (Math.hypot(dx, dy) > 6) fabDrag.moved = true;
      if (fabDrag.moved) {
        ui.fabGroup.style.right = `${Math.max(8, Math.min(window.innerWidth - 96, fabDrag.rx - dx))}px`;
        ui.fabGroup.style.bottom = `${Math.max(8, Math.min(window.innerHeight - 48, fabDrag.by - dy))}px`;
      }
    });
    ui.fab.addEventListener("pointerup", () => {
      const wasDrag = fabDrag && fabDrag.moved;
      fabDrag = null;
      if (!wasDrag) {
        panelOpen = true;
        ui.panel.classList.remove("hidden");
        ui.fabGroup.classList.add("hidden");
        engine.scanVideos();
        renderUI();
      }
    });

    ui.fabFs.addEventListener("click", () => openTheater(false));

    ui.btnClose.addEventListener("click", () => {
      panelOpen = false;
      ui.panel.classList.add("hidden");
      if (engine && engine.theaterActive) setHudVisible(true, true);
      renderUI();
    });

    // Theater Stage touch interactions (tap toggles HUD, double-tap toggles play/pause)
    let lastStageTap = 0;
    let singleTapTimer = null;
    ui.theaterMediaSlot.addEventListener("click", () => {
      if (panelOpen) {
        panelOpen = false;
        ui.panel.classList.add("hidden");
        setHudVisible(true, true);
        return;
      }
      const now = Date.now();
      if (now - lastStageTap < 280) {
        if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null; }
        lastStageTap = 0;
        if (engine && engine.video) {
          if (engine.video.paused) { engine.video.play().catch(() => {}); showToast("▶ 继续播放"); }
          else { engine.video.pause(); showToast("❚❚ 已暂停"); }
          updateTheaterHud();
        }
      } else {
        lastStageTap = now;
        singleTapTimer = setTimeout(() => {
          singleTapTimer = null;
          setHudVisible(!hudVisible, true);
        }, 280);
      }
    });

    ui.btnExitTheater.addEventListener("click", closeTheater);
    ui.btnTheaterBeauty.addEventListener("click", () => {
      engine.setEnabled(!engine.enabled);
      showToast(engine.enabled ? "已开启美颜" : "已切换原画");
      updateTheaterHud();
    });
    ui.btnTheaterRotate.addEventListener("click", () => {
      engine.setTheaterRotated(!engine.theaterRotated);
      layoutTheaterViewport();
      updateTheaterHud();
      showToast(engine.theaterRotated ? "已横屏旋转 90°" : "已恢复竖屏");
    });
    ui.btnTheaterFill.addEventListener("click", () => {
      engine.setTheaterFill(!engine.theaterFill);
      updateTheaterHud();
      showToast(engine.theaterFill ? "已切换铺满裁剪" : "已切换完整适应");
    });
    ui.btnTheaterPanel.addEventListener("click", () => {
      panelOpen = !panelOpen;
      ui.panel.classList.toggle("hidden", !panelOpen);
      if (panelOpen) {
        if (hudAutoHideTimer) clearTimeout(hudAutoHideTimer);
        renderUI();
      } else {
        setHudVisible(true, true);
      }
    });
    ui.btnTheaterPlay.addEventListener("click", () => {
      if (!engine || !engine.video) return;
      if (engine.video.paused) engine.video.play().catch(() => {});
      else engine.video.pause();
      updateTheaterHud();
      setHudVisible(true, true);
    });
    ui.btnTheaterSpeed.addEventListener("click", () => {
      if (!engine || !engine.video) return;
      const cur = engine.video.playbackRate || 1.0;
      const idx = SPEED_STEPS.findIndex((s) => Math.abs(s - cur) < 0.05);
      const next = SPEED_STEPS[(idx + 1) % SPEED_STEPS.length];
      engine.video.playbackRate = next;
      updateTheaterHud();
      showToast(`倍速 ${next}x`);
    });
    ui.theaterSeek.addEventListener("pointerdown", () => { isSeeking = true; });
    ui.theaterSeek.addEventListener("touchstart", () => { isSeeking = true; }, { passive: true });
    ui.theaterSeek.addEventListener("input", () => {
      if (!engine || !engine.video || !Number.isFinite(engine.video.duration) || engine.video.duration <= 0) return;
      const target = (Number(ui.theaterSeek.value) / 1000) * engine.video.duration;
      ui.theaterTimeCur.textContent = formatTime(target);
      engine.video.currentTime = target;
    });
    const endSeek = () => {
      if (!isSeeking) return;
      isSeeking = false;
      setHudVisible(true, true);
    };
    ui.theaterSeek.addEventListener("change", endSeek);

    const onCompareStart = (e) => {
      e.preventDefault();
      ui.btnCompare.classList.add("active");
      ui.btnTheaterCompare.classList.add("active");
      engine.setCompareOriginal(true);
    };
    const onCompareEnd = () => {
      ui.btnCompare.classList.remove("active");
      ui.btnTheaterCompare.classList.remove("active");
      if (engine) engine.setCompareOriginal(false);
    };
    for (const btn of [ui.btnCompare, ui.btnTheaterCompare]) {
      btn.addEventListener("pointerdown", onCompareStart);
      btn.addEventListener("touchstart", onCompareStart, { passive: false });
    }
    window.addEventListener("pointerup", () => { isDragging = false; endSeek(); onCompareEnd(); });
    window.addEventListener("pointercancel", () => { isDragging = false; endSeek(); onCompareEnd(); });
    window.addEventListener("touchend", () => { isDragging = false; endSeek(); onCompareEnd(); }, { passive: true });
    window.addEventListener("resize", layoutTheaterViewport);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", layoutTheaterViewport);
    window.addEventListener("orientationchange", () => setTimeout(layoutTheaterViewport, 250));

    // Tabs (5 columns)
    const tabs = shadow.querySelectorAll(".tab");
    const panes = {
      skin: $("pane-skin"),
      reshape: $("pane-reshape"),
      makeup: $("pane-makeup"),
      color: $("pane-color"),
      io: $("pane-io"),
    };
    tabs.forEach((t) => {
      t.addEventListener("click", () => {
        const k = t.dataset.tab;
        tabs.forEach((x) => x.classList.toggle("active", x === t));
        for (const [pk, el] of Object.entries(panes)) el.classList.toggle("hidden", pk !== k);
      });
    });

    ui.toggleBeauty.addEventListener("change", () => engine.setEnabled(ui.toggleBeauty.checked));
    ui.toggleFace.addEventListener("change", () => engine.setFaceTrackingEnabled(ui.toggleFace.checked));
    ui.btnRescan.addEventListener("click", () => { engine.scanVideos(); renderUI(); });
    ui.btnRetry.addEventListener("click", () => { engine.probeAttempts = 0; engine.workerUnavailable = false; engine.runProtectionAndProbe(); renderUI(); });
    ui.btnEnterTheater.addEventListener("click", () => {
      if (engine.theaterActive) closeTheater();
      else openTheater(false);
    });
    ui.videoSelect.addEventListener("change", () => { if (ui.videoSelect.value) engine.selectVideoByUser(ui.videoSelect.value); });

    ui.presetBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".pill");
      if (!btn || !PRESETS[btn.dataset.preset]) return;
      engine.setBeautyParams(PRESETS[btn.dataset.preset].params);
      syncSliders(engine.params);
      updateTheaterHud();
    });

    ui.lipShadeList.addEventListener("click", (e) => {
      const btn = e.target.closest(".swatch");
      if (!btn) return;
      const idx = clampParam("lipShade", btn.dataset.shade, 2);
      const patch = { lipShade: idx };
      if ((engine.params.lipTint || 0) === 0) patch.lipTint = 0.25;
      engine.setBeautyParams(patch);
      syncSliders(engine.params);
    });

    const showHint = (el, msg, isErr = false) => {
      el.textContent = msg;
      el.className = isErr ? "hint err" : "hint";
      setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 4500);
    };

    function buildExportObject() {
      const exported = {};
      for (const s of ALL_SLIDERS) exported[s.key] = toUiValue(s.key, engine.params[s.key] || 0);
      exported.lipShade = Math.max(0, Math.min(LIP_SHADE_NAMES.length - 1, Math.round(engine.params.lipShade ?? 2)));
      const pk = detectPreset(engine.params);
      return {
        schema: "wvb-wink-preset-v2",
        name: pk !== "custom" && PRESETS[pk] ? PRESETS[pk].name : "自定义方案",
        lipShadeName: LIP_SHADE_NAMES[exported.lipShade],
        params: exported,
      };
    }

    function applyImportedText(rawText) {
      const trimmed = rawText.trim();
      if (!trimmed) {
        showHint(ui.ioHint, "请先粘贴 JSON 或 Wink 配方文本", true);
        return;
      }
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed);
          const { params, matched } = normalizeParams(parsed, ZERO_PARAMS);
          if (!matched) { showHint(ui.ioHint, "JSON 中未识别到有效参数字段", true); return; }
          engine.setBeautyParams(params);
          syncSliders(engine.params);
          showHint(ui.ioHint, `已导入并应用 ${matched} 项 JSON 参数`);
        } catch (err) {
          showHint(ui.ioHint, `JSON 格式错误: ${err.message}`, true);
        }
        return;
      }
      const { params, matched, skipped } = parseWinkTextRecipe(trimmed);
      if (!matched) {
        showHint(ui.ioHint, "未识别到有效 JSON 或 Wink 配方参数", true);
        return;
      }
      engine.setBeautyParams(params);
      syncSliders(engine.params);
      const skipNote = skipped.length
        ? `（忽略：${skipped.slice(0, 3).join("、")}${skipped.length > 3 ? ` 等${skipped.length}项` : ""}）`
        : "";
      showHint(ui.ioHint, `已解析并应用 ${matched} 项配方${skipNote}`);
    }

    ui.btnSave.addEventListener("click", () => { safeStorageSet(STORAGE_KEY_SAVED, engine.params); showHint(ui.ioHint, "已存为「我的方案」"); });
    ui.btnLoad.addEventListener("click", () => {
      const sv = safeStorageGet(STORAGE_KEY_SAVED, null);
      if (!sv) { showHint(ui.ioHint, "尚未保存方案", true); return; }
      engine.setBeautyParams(sv);
      syncSliders(engine.params);
      showHint(ui.ioHint, "已加载「我的方案」");
    });
    ui.btnExport.addEventListener("click", async () => {
      const txt = JSON.stringify(buildExportObject(), null, 2);
      ui.jsonBox.value = txt;
      try { await navigator.clipboard.writeText(txt); showHint(ui.ioHint, "参数 JSON 已复制"); }
      catch (_) { showHint(ui.ioHint, "已填入文本框，请手动复制"); }
    });
    ui.btnExportFile.addEventListener("click", () => {
      const txt = JSON.stringify(buildExportObject(), null, 2);
      const blob = new Blob([txt], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `realtime-beauty-preset-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showHint(ui.ioHint, "已导出 JSON 文件");
    });
    ui.inputImportFile.addEventListener("change", async () => {
      const f = ui.inputImportFile.files && ui.inputImportFile.files[0];
      if (!f) return;
      const text = await f.text();
      ui.jsonBox.value = text;
      applyImportedText(text);
      ui.inputImportFile.value = "";
    });
    ui.btnImport.addEventListener("click", () => applyImportedText(ui.jsonBox.value));

    ui.btnCopyDiag.addEventListener("click", async () => {
      const txt = JSON.stringify(engine.getStateSnapshot(), null, 2);
      try { await navigator.clipboard.writeText(txt); showHint(ui.copyHint, "已复制"); }
      catch (_) { ui.jsonBox.value = txt; showHint(ui.copyHint, "剪贴板受限，已填入导入框"); }
    });

    buildSliders(ui.skinSliders, SKIN_SLIDERS);
    buildSliders(ui.reshapeSliders, RESHAPE_SLIDERS);
    buildSliders(ui.makeupSliders, MAKEUP_SLIDERS);
    buildSliders(ui.colorSliders, COLOR_SLIDERS);

    engine = new IosWebVideoBeautyEngine(renderUI);
    window.__WVB_IOS_ENGINE__ = engine;
    syncSliders(engine.params);
    renderUI();
    setInterval(() => {
      if (panelOpen) renderUI();
      if (engine && engine.theaterActive) updateTheaterHud();
    }, 500);
  }

  function safeBoot() {
    try {
      if (!IS_TOP_FRAME) {
        const tryMountIframe = () => {
          if (document.querySelector("video")) { mountUI(); return true; }
          return false;
        };
        if (tryMountIframe()) return;
        const mo = new MutationObserver(() => {
          if (tryMountIframe()) mo.disconnect();
        });
        mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
        return;
      }
      mountUI();
    } catch (err) {
      const badge = document.createElement("div");
      badge.textContent = "实时美颜启动异常: " + (err && err.message ? err.message : String(err));
      badge.style.cssText =
        "position:fixed;right:10px;bottom:80px;z-index:2147483647;background:#7f1d1d;color:#fff;padding:8px 10px;border-radius:8px;font-size:12px;max-width:85vw;";
      (document.body || document.documentElement).appendChild(badge);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", safeBoot, { once: true });
  } else {
    safeBoot();
  }
})();
