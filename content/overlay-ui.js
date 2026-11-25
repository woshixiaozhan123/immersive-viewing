(() => {
  if (window.__WVB_DESKTOP_UI__) return;
  window.__WVB_DESKTOP_UI__ = true;

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
    裸粉: 0, nude: 0, pink: 0,
    蜜桃橘: 1, 蜜桃: 1, peach: 1, coral: 1,
    玫瑰豆沙: 2, 豆沙: 2, rose: 2,
    复古正红: 3, 正红: 3, red: 3,
  };

  const DEFAULT_PARAMS = {
    smooth: 0.45, skinTexture: 0.30, whiten: 0.30, rosy: 0.15, underEye: 0.25, nasolabial: 0.20, matte: 0.15,
    slimFace: 0.20, slimCheekbone: 0.12, vChin: 0.0, bigEyes: 0.15, eyeTilt: 0.0, slimNose: 0.12, mouthSize: 0.0, mouthSmile: 0.10,
    brightEye: 0.20, contour: 0.15, lipTint: 0.18, lipShade: 2, whitenTeeth: 0.20,
    sharpen: 0.25, exposure: 0.0, contrast: 0.0, saturation: 0.0, temperature: 0.0, softGlow: 0.0,
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
        brightEye: 0.20, contour: 0.12, lipTint: 0.14, lipShade: 2, whitenTeeth: 0.18, sharpen: 0.25,
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

  function storageGet(defaults) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(defaults, (res) => resolve(res || defaults));
          return;
        }
      } catch (_) {}
      resolve(defaults);
    });
  }

  function storageSet(obj) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(obj);
      }
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
    return BIPOLAR_KEYS.has(key) ? Math.round((normVal ?? 0) * 50) : Math.round((normVal ?? 0) * 100);
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
        if (m && (m[0].length === line.length || /[:：]/.test(m[0]))) {
          section = h.section;
          line = line.slice(m[0].length).trim();
          break;
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

        if (/磨皮|肤质/.test(rawLabel)) { section = "skin"; setVal("smooth", Math.abs(num)); }
        else if (/质感|毛孔/.test(rawLabel)) { section = "skin"; setVal("skinTexture", Math.abs(num)); }
        else if (/冷调白|冷白|美白|提亮/.test(rawLabel)) {
          section = "skin"; setVal("whiten", Math.abs(num));
          if (/冷调白|冷白/.test(rawLabel)) hasCoolWhiteHint = true;
        }
        else if (/腮红|红润|气色/.test(rawLabel)) { section = "skin"; setVal("rosy", Math.abs(num)); }
        else if (/黑眼圈/.test(rawLabel)) { section = "skin"; setVal("underEye", Math.abs(num)); }
        else if (/法令纹/.test(rawLabel)) { section = "skin"; setVal("nasolabial", Math.abs(num)); }
        else if (/去油光|控油|哑光/.test(rawLabel)) { section = "skin"; setVal("matte", Math.abs(num)); }
        else if (/窄颧骨|瘦颧骨|颧骨/.test(rawLabel)) { section = "face"; setVal("slimCheekbone", Math.abs(num)); }
        else if (/小脸|瘦脸/.test(rawLabel)) { section = "face"; setVal("slimFace", Math.abs(num)); }
        else if (/下巴|v脸/i.test(rawLabel)) { section = "face"; setVal("vChin", num); }
        else if (/眼睛倾斜|眼倾斜|眼尾上扬|眼尾|眼角倾斜/.test(rawLabel)) { section = "eye"; setVal("eyeTilt", num); }
        else if (/大眼|眼睛大小|眼高|眼宽/.test(rawLabel)) { section = "eye"; setVal("bigEyes", Math.abs(num), { additive: true }); }
        else if (/瘦鼻|缩鼻翼|鼻子大小|鼻翼|鼻头/.test(rawLabel)) { section = "nose"; setVal("slimNose", Math.abs(num)); }
        else if (/鼻梁|山根/.test(rawLabel)) { section = "nose"; setVal("contour", Math.abs(num), { additive: true, scale: 0.7 }); }
        else if (/丰唇/.test(rawLabel)) { section = "mouth"; setVal("mouthSize", num, { scale: 0.5 }); }
        else if (/嘴型|嘴巴大小/.test(rawLabel)) { section = "mouth"; setVal("mouthSize", num); }
        else if (/微笑|嘴角/.test(rawLabel)) { section = "mouth"; setVal("mouthSmile", Math.abs(num)); }
        else if (/眼影|眼窝|亮眼|卧蚕|美瞳|睫毛/.test(rawLabel)) { section = "makeup"; setVal("brightEye", Math.abs(num)); }
        else if (/修容|鼻影/.test(rawLabel)) { section = "makeup"; setVal("contour", Math.abs(num)); }
        else if (/口红|润唇|唇釉|唇彩/.test(rawLabel)) {
          section = "makeup"; setVal("lipTint", Math.abs(num));
          const shade = detectLipShadeFromText(rawLabel);
          if (shade !== null) { out.lipShade = shade; matchedKeys.add("lipShade"); }
        }
        else if (/美牙|牙齿|白牙/.test(rawLabel)) { section = "makeup"; setVal("whitenTeeth", Math.abs(num)); }
        else if (/清晰|锐化/.test(rawLabel)) { section = "color"; setVal("sharpen", Math.abs(num)); }
        else if (/曝光|亮度/.test(rawLabel)) { section = "color"; setVal("exposure", num); }
        else if (/对比度/.test(rawLabel)) { section = "color"; setVal("contrast", num); }
        else if (/饱和度/.test(rawLabel)) { section = "color"; setVal("saturation", num); }
        else if (/色温/.test(rawLabel)) { section = "color"; setVal("temperature", num); }
        else if (/柔光/.test(rawLabel)) { section = "color"; setVal("softGlow", Math.abs(num)); }
        else if (section === "body" || section === "hair" || section === "brow") {
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
              setVal(k, num); aliasHit = true; break;
            }
          }
          if (!aliasHit) addSkipped(rawLabel);
        }
      }

      if (!lineMatchedPair) {
        if (section === "hair" || /染发|美发/.test(line)) addSkipped("染发");
        else if (/美白|冷调白|冷白/.test(line)) {
          setVal("whiten", /冷调白|冷白/.test(line) ? 52 : 40);
          if (/冷调白|冷白/.test(line)) hasCoolWhiteHint = true;
        } else if (/腮红/.test(line) && !matchedKeys.has("rosy")) setVal("rosy", 16);
        else if (/美瞳|卧蚕|睫毛/.test(line) && !matchedKeys.has("brightEye")) setVal("brightEye", 28);
        else if (/口红|润唇|唇釉/.test(line)) {
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

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "--:--";
    return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  }

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
    .hidden { display: none !important; }

    /* Draggable Floating Ball */
    .fab {
      position: fixed;
      right: 22px;
      bottom: 86px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 8px 14px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.22);
      background: rgba(15, 23, 42, 0.88);
      backdrop-filter: blur(12px);
      color: #f8fafc;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.42);
      cursor: grab;
      user-select: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .fab:hover {
      border-color: rgba(236, 72, 153, 0.65);
      box-shadow: 0 8px 28px rgba(236, 72, 153, 0.28);
    }
    .fab:active { cursor: grabbing; }
    .fab .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #64748b;
      flex-shrink: 0;
    }
    .fab.on .dot {
      background: #ec4899;
      box-shadow: 0 0 10px #ec4899;
    }

    /* Draggable Floating Panel */
    .panel {
      position: fixed;
      right: 20px;
      bottom: 24px;
      z-index: 2147483647;
      width: 386px;
      max-height: min(86vh, 720px);
      overflow-y: auto;
      background: rgba(15, 23, 42, 0.95);
      backdrop-filter: blur(14px);
      border: 1px solid #334155;
      border-radius: 14px;
      padding: 11px 12px;
      color: #e2e8f0;
      font-size: 13px;
      box-shadow: 0 16px 44px rgba(0, 0, 0, 0.6);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .panel::-webkit-scrollbar { width: 5px; }
    .panel::-webkit-scrollbar-thumb { background: #475569; border-radius: 999px; }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: move;
      user-select: none;
      padding-bottom: 2px;
    }
    .header h1 { margin: 0; font-size: 15px; font-weight: 600; color: #f8fafc; }
    .subtitle { margin: 2px 0 0; font-size: 11px; color: #94a3b8; }
    .hdr-right { display: flex; align-items: center; gap: 6px; }
    .icon-btn {
      border: 1px solid #334155;
      background: #1e293b;
      color: #cbd5e1;
      border-radius: 7px;
      height: 24px;
      padding: 0 7px;
      font-size: 11px;
      cursor: pointer;
    }
    .icon-btn:hover { background: #334155; color: #fff; }
    .close-btn {
      width: 24px;
      padding: 0;
      font-size: 15px;
      line-height: 22px;
      text-align: center;
    }

    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 9px 11px;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .row-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .label { font-size: 12px; color: #cbd5e1; font-weight: 500; }
    .hint-muted { font-size: 11px; color: #94a3b8; }
    .select {
      width: 100%;
      background: #0f172a;
      color: #f1f5f9;
      border: 1px solid #475569;
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 12px;
    }
    .meta { font-size: 11px; color: #94a3b8; line-height: 1.4; }
    .badges { display: flex; flex-wrap: wrap; gap: 5px; }
    .badge {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 999px;
      background: #334155;
      color: #e2e8f0;
    }
    .badge.ok { background: #064e3b; color: #6ee7b7; }
    .badge.warn { background: #78350f; color: #fcd34d; }
    .badge.err { background: #7f1d1d; color: #fca5a5; }

    .preset-bar { display: flex; flex-wrap: wrap; gap: 5px; }
    .pill {
      border: 1px solid #475569;
      background: #0f172a;
      color: #cbd5e1;
      border-radius: 999px;
      padding: 3px 9px;
      font-size: 11px;
      cursor: pointer;
      transition: 0.15s;
    }
    .pill:hover { border-color: #38bdf8; color: #f8fafc; }
    .pill.active {
      background: linear-gradient(135deg, #ec4899, #8b5cf6);
      border-color: transparent;
      color: #fff;
      font-weight: 500;
    }
    .pill.ghost-pill { color: #94a3b8; }

    .tabs {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      background: #0f172a;
      border-radius: 8px;
      padding: 3px;
      gap: 3px;
    }
    .tab {
      border: none;
      background: transparent;
      color: #94a3b8;
      border-radius: 6px;
      padding: 5px 4px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
    }
    .tab:hover { color: #e2e8f0; }
    .tab.active { background: #334155; color: #f8fafc; }
    .tab-pane { display: flex; flex-direction: column; gap: 6px; }
    .tip-box {
      margin: 0;
      padding: 5px 8px;
      background: #0f172a;
      border-left: 2px solid #ec4899;
      border-radius: 4px;
      font-size: 11px;
      color: #94a3b8;
      line-height: 1.35;
    }

    .slider-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 236px;
      overflow-y: auto;
      padding-right: 2px;
    }
    .slider-list::-webkit-scrollbar { width: 4px; }
    .slider-list::-webkit-scrollbar-thumb { background: #475569; border-radius: 999px; }
    .slider-row {
      display: grid;
      grid-template-columns: 68px 1fr 34px;
      align-items: center;
      gap: 8px;
    }
    .slider-name {
      font-size: 12px;
      color: #cbd5e1;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
    }
    .slider-name:hover { color: #f8fafc; }
    .slider-val {
      font-size: 11px;
      font-weight: 600;
      color: #f472b6;
      text-align: right;
      font-family: ui-monospace, monospace;
    }
    .slider-val.bipolar-neg { color: #38bdf8; }
    .slider-val.zero { color: #64748b; font-weight: 500; }
    input[type="range"] {
      width: 100%;
      margin: 0;
      accent-color: #ec4899;
      cursor: pointer;
      height: 4px;
    }
    input[type="range"].bipolar { accent-color: #a855f7; }

    .swatch-row {
      display: grid;
      grid-template-columns: 68px 1fr;
      align-items: center;
      gap: 8px;
      padding-top: 4px;
      border-top: 1px dashed #334155;
    }
    .swatch-list { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
    .swatch {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 4px 4px;
      background: #0f172a;
      border: 1px solid #475569;
      border-radius: 6px;
      color: #cbd5e1;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
    }
    .swatch:hover { border-color: #94a3b8; color: #f8fafc; }
    .swatch.active { border-color: #ec4899; background: rgba(236, 72, 153, 0.16); color: #fff; font-weight: 500; }
    .swatch-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 0 1px rgba(255,255,255,0.25); }

    .io-row { display: flex; gap: 6px; flex-wrap: wrap; }
    .file-label { display: inline-flex; align-items: center; justify-content: center; }
    .json-box {
      width: 100%;
      resize: vertical;
      background: #0f172a;
      color: #e2e8f0;
      border: 1px solid #475569;
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 11px;
      font-family: ui-monospace, Consolas, monospace;
      line-height: 1.35;
    }
    .json-box:focus { outline: none; border-color: #ec4899; }

    .actions { display: flex; gap: 8px; margin-top: 2px; }
    .btn {
      flex: 1;
      border: none;
      border-radius: 7px;
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      user-select: none;
      text-align: center;
    }
    .btn.secondary { background: #0284c7; color: #fff; }
    .btn.secondary:active, .btn.secondary.active { background: #0369a1; transform: scale(0.98); }
    .btn.ghost { background: #334155; color: #e2e8f0; }
    .btn.ghost:hover { background: #475569; }
    .btn.small { flex: 1 1 auto; padding: 5px 8px; font-size: 11px; }
    .link-btn { background: none; border: none; color: #38bdf8; font-size: 11px; cursor: pointer; padding: 0; }
    .link-btn.danger { color: #f87171; }
    .link-btn.danger:hover { color: #fca5a5; text-decoration: underline; }
    .link-btn:disabled { color: #64748b; cursor: default; text-decoration: none; }

    .switch { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute; inset: 0;
      background: #475569;
      border-radius: 999px;
      transition: 0.2s;
      cursor: pointer;
    }
    .slider:before {
      content: "";
      position: absolute;
      width: 16px; height: 16px;
      left: 3px; top: 3px;
      background: #fff;
      border-radius: 50%;
      transition: 0.2s;
    }
    .switch input:checked + .slider { background: linear-gradient(135deg, #ec4899, #8b5cf6); }
    .switch input:checked + .slider:before { transform: translateX(18px); }

    .diag summary { cursor: pointer; font-size: 12px; color: #cbd5e1; font-weight: 500; }
    .diag-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px 8px;
      font-size: 11px;
      color: #94a3b8;
      margin-top: 6px;
    }
    .diag-grid span.val { color: #f1f5f9; text-align: right; font-family: ui-monospace, monospace; }
    .diag-actions { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
    .hint { font-size: 11px; color: #6ee7b7; line-height: 1.35; }
    .hint.err { color: #fca5a5; }
    .error-banner {
      background: #7f1d1d;
      color: #fecaca;
      border: 1px solid #b91c1c;
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 11px;
      line-height: 1.4;
    }
  `;

  function mountDesktopFloatingUI() {
    if (document.getElementById("wvb-desktop-root")) return;
    const engine = window.__WVB_ENGINE__;
    if (!engine) return;

    const host = document.createElement("div");
    host.id = "wvb-desktop-root";
    const shadow = host.attachShadow({ mode: "open" });

    const styleEl = document.createElement("style");
    styleEl.textContent = UI_CSS;
    shadow.appendChild(styleEl);

    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="fab hidden" id="fab" role="button" title="点击打开实时美颜面板，按住可拖拽">
        <span class="dot"></span>
        <span id="fabText">美颜</span>
      </div>

      <div class="panel hidden" id="panel">
        <header class="header" id="panelHeader" title="按住标题栏可拖动面板位置">
          <div>
            <h1>实时美颜</h1>
            <p class="subtitle">26 项专业调参 · 悬浮球模式 · 478 点追踪</p>
          </div>
          <div class="hdr-right">
            <label class="switch" title="开启或关闭美颜">
              <input type="checkbox" id="toggleBeauty" />
              <span class="slider"></span>
            </label>
            <button id="btnHideFab" class="icon-btn" type="button" title="隐藏本页悬浮球（点击浏览器扩展图标可随时呼出）">隐藏</button>
            <button id="btnClosePanel" class="icon-btn close-btn" type="button" title="收起为悬浮球">×</button>
          </div>
        </header>

        <section class="card">
          <div class="row-between">
            <span class="label">当前视频</span>
            <button id="btnRescan" class="link-btn" type="button">重新扫描</button>
          </div>
          <select id="videoSelect" class="select"></select>
          <div id="videoMeta" class="meta">正在检测当前页面视频…</div>
          <div class="badges">
            <span id="badgeProtection" class="badge neutral">保护：检测中</span>
            <span id="badgeCapture" class="badge neutral">取帧：等待中</span>
            <span id="badgeMode" class="badge neutral">模式：待就绪</span>
          </div>
          <div class="row-between" id="barToggleRow" style="margin-top:11px">
            <span class="label">播放器控制条 <span id="barHostHint" class="hint-muted"></span></span>
            <label class="switch" title="在当前站点启用自制播放器控制条（按域名记忆，随时可关）">
              <input type="checkbox" id="togglePlayerBar" />
              <span class="slider"></span>
            </label>
          </div>
          <div class="row-between" style="margin-top:9px">
            <label class="label" for="subtitleMode">本地字幕</label>
            <select id="subtitleMode" class="select" style="width:auto;margin:0" disabled>
              <option value="off">关闭</option>
              <option value="zh">中文字幕</option>
              <option value="both">双语字幕</option>
            </select>
          </div>
          <div class="row-between" style="margin-top:9px">
            <label class="label" for="subtitleProfile">字幕性能 <span id="subtitleProfileHint" class="hint-muted"></span></label>
            <select id="subtitleProfile" class="select" style="width:auto;margin:0" disabled>
              <option value="auto">自动</option>
              <option value="cpu">CPU 兼容</option>
              <option value="cpu-fast">CPU 多核</option>
              <option value="gpu">GPU 翻译</option>
            </select>
          </div>
          <div class="row-between" id="cacheToggleRow" style="margin-top:9px">
            <span class="label">本站缓存 <span id="cacheHostHint" class="hint-muted"></span></span>
            <label class="switch" title="把本站视频分片缓存到本地磁盘（按域名记忆）。关闭=完全不接管">
              <input type="checkbox" id="toggleSiteCache" />
              <span class="slider"></span>
            </label>
          </div>
          <div id="cacheInfo" class="meta" style="margin-top:6px;display:none"></div>
          <div id="cacheActions" style="margin-top:7px;display:none;justify-content:space-between;align-items:center;gap:8px">
            <button id="btnDeleteVideoCache" class="link-btn danger" type="button">删除本视频</button>
            <button id="btnDeleteSiteCache" class="link-btn danger" type="button">清空本站</button>
          </div>
        </section>

        <section class="card">
          <div class="row-between">
            <span class="label">风格预设</span>
            <span id="activePresetLabel" class="hint-muted">自定义</span>
          </div>
          <div class="preset-bar" id="presetBar">
            <button class="pill" data-preset="natural" type="button">自然清透</button>
            <button class="pill" data-preset="cool_fair" type="button">冷白质感</button>
            <button class="pill" data-preset="soft_glow" type="button">日系柔光</button>
            <button class="pill" data-preset="delicate" type="button">纯欲微调</button>
            <button class="pill" data-preset="glam" type="button">网感精修</button>
            <button class="pill" data-preset="youthful" type="button">减龄打底</button>
            <button class="pill ghost-pill" data-preset="reset" type="button">归零</button>
          </div>

          <div class="tabs" role="tablist">
            <button class="tab active" data-tab="skin" type="button" role="tab">美肤</button>
            <button class="tab" data-tab="reshape" type="button" role="tab">美型</button>
            <button class="tab" data-tab="makeup" type="button" role="tab">美妆</button>
            <button class="tab" data-tab="color" type="button" role="tab">调色</button>
            <button class="tab" data-tab="io" type="button" role="tab">方案</button>
          </div>

          <div class="tab-pane" id="pane-skin">
            <div class="slider-list" id="skinSliders"></div>
          </div>

          <div class="tab-pane hidden" id="pane-reshape">
            <p class="tip-box">美型依赖 478 点人脸锚点；侧脸角度过大或 L2 降级时自动平滑减弱，双击单项可归零。</p>
            <div class="slider-list" id="reshapeSliders"></div>
          </div>

          <div class="tab-pane hidden" id="pane-makeup">
            <div class="slider-list" id="makeupSliders"></div>
            <div class="swatch-row">
              <span class="slider-name" title="选择口红唇色风格">唇色风格</span>
              <div class="swatch-list" id="lipShadeList">
                <button class="swatch" data-shade="0" type="button"><span class="swatch-dot" style="background:#eb8f9e"></span><span>裸粉</span></button>
                <button class="swatch" data-shade="1" type="button"><span class="swatch-dot" style="background:#f27a5c"></span><span>蜜桃橘</span></button>
                <button class="swatch" data-shade="2" type="button"><span class="swatch-dot" style="background:#e0526b"></span><span>豆沙</span></button>
                <button class="swatch" data-shade="3" type="button"><span class="swatch-dot" style="background:#d1293d"></span><span>正红</span></button>
              </div>
            </div>
          </div>

          <div class="tab-pane hidden" id="pane-color">
            <p class="tip-box">画面调色直接作用于整帧视频（含无脸或降级回退场景），双向滑块支持 -50 到 +50 精调。</p>
            <div class="slider-list" id="colorSliders"></div>
          </div>

          <div class="tab-pane hidden" id="pane-io">
            <div class="io-row">
              <button id="btnSaveCustom" class="btn ghost small" type="button">存为「我的方案」</button>
              <button id="btnLoadCustom" class="btn ghost small" type="button">加载「我的方案」</button>
            </div>
            <div class="io-row">
              <button id="btnExportClip" class="btn ghost small" type="button">复制参数 JSON</button>
              <button id="btnExportFile" class="btn ghost small" type="button">下载 .json</button>
              <label class="btn ghost small file-label">
                选择 .json
                <input id="inputImportFile" type="file" accept=".json,application/json" hidden />
              </label>
            </div>
            <textarea
              id="presetJsonInput"
              class="json-box"
              rows="4"
              placeholder='支持粘贴参数 JSON 或直接粘贴 Wink/小红书文字配方，例如：&#10;小脸+20 颧骨+8 眼睛倾斜-29 鼻子大小+34 磨皮+30 口红/豆沙+18 修容+65 饱和度-20 色温-8'
            ></textarea>
            <div class="row-between">
              <button id="btnApplyJson" class="btn secondary small" type="button">识别并应用 JSON / 配方文本</button>
              <span id="ioStatus" class="hint"></span>
            </div>
          </div>

          <div class="actions">
            <button id="btnCompare" class="btn secondary" type="button">按住看原画</button>
            <button id="btnRetry" class="btn ghost" type="button">重新检测</button>
          </div>
        </section>

        <details class="card diag">
          <summary>诊断信息与性能监控</summary>
          <div class="row-between" style="margin-top:6px;">
            <span class="hint-muted">显示 478 点识别遮罩（绿=肤 / 青=眼 / 粉=唇）</span>
            <label class="switch" title="开启后在画面上高亮显示实时识别到的人脸遮罩区域">
              <input type="checkbox" id="toggleDebugMask" />
              <span class="slider"></span>
            </label>
          </div>
          <div class="diag-grid" id="diagGrid"></div>
          <div class="diag-actions">
            <button id="btnCopyDiag" class="btn ghost small" type="button">复制诊断 JSON</button>
            <span id="copyHint" class="hint"></span>
          </div>
        </details>

        <div id="errorBanner" class="error-banner hidden"></div>
      </div>
    `;
    shadow.appendChild(wrap);
    (document.documentElement || document.body).appendChild(host);

    const $ = (id) => shadow.getElementById(id);
    const els = {
      fab: $("fab"),
      fabText: $("fabText"),
      panel: $("panel"),
      panelHeader: $("panelHeader"),
      toggleBeauty: $("toggleBeauty"),
      btnHideFab: $("btnHideFab"),
      btnClosePanel: $("btnClosePanel"),
      videoSelect: $("videoSelect"),
      videoMeta: $("videoMeta"),
      badgeProtection: $("badgeProtection"),
      badgeCapture: $("badgeCapture"),
      badgeMode: $("badgeMode"),
      barToggleRow: $("barToggleRow"),
      togglePlayerBar: $("togglePlayerBar"),
      barHostHint: $("barHostHint"),
      cacheToggleRow: $("cacheToggleRow"),
      toggleSiteCache: $("toggleSiteCache"),
      cacheHostHint: $("cacheHostHint"),
      cacheInfo: $("cacheInfo"),
      cacheActions: $("cacheActions"),
      btnDeleteVideoCache: $("btnDeleteVideoCache"),
      btnDeleteSiteCache: $("btnDeleteSiteCache"),
      presetBar: $("presetBar"),
      activePresetLabel: $("activePresetLabel"),
      skinSliders: $("skinSliders"),
      reshapeSliders: $("reshapeSliders"),
      makeupSliders: $("makeupSliders"),
      colorSliders: $("colorSliders"),
      lipShadeList: $("lipShadeList"),
      btnCompare: $("btnCompare"),
      btnRetry: $("btnRetry"),
      btnRescan: $("btnRescan"),
      btnSaveCustom: $("btnSaveCustom"),
      btnLoadCustom: $("btnLoadCustom"),
      btnExportClip: $("btnExportClip"),
      btnExportFile: $("btnExportFile"),
      inputImportFile: $("inputImportFile"),
      presetJsonInput: $("presetJsonInput"),
      btnApplyJson: $("btnApplyJson"),
      ioStatus: $("ioStatus"),
      diagGrid: $("diagGrid"),
      toggleDebugMask: $("toggleDebugMask"),
      btnCopyDiag: $("btnCopyDiag"),
      copyHint: $("copyHint"),
      errorBanner: $("errorBanner"),
    };

    let panelOpen = false;
    let fabHiddenByUser = false;
    let isDraggingSlider = false;
    let currentParams = { ...DEFAULT_PARAMS };
    let activePresetKey = "natural";
    let lastState = null;
    const sliderInputs = new Map();
    const sliderValues = new Map();

    // Keep floating ball & panel visible inside container fullscreen (Bilibili/YouTube/Douyin/Plyr)
    function syncHostMountForFullscreen() {
      const fsEl = document.fullscreenElement;
      const targetParent =
        fsEl && fsEl.tagName !== "VIDEO" ? fsEl : document.documentElement || document.body;
      if (targetParent && host.parentElement !== targetParent) {
        try {
          targetParent.appendChild(host);
        } catch (_) {}
      }
    }
    document.addEventListener("fullscreenchange", syncHostMountForFullscreen);

    function updateValStyle(valEl, key, uiVal) {
      valEl.textContent = formatSliderText(key, uiVal);
      valEl.classList.toggle("zero", uiVal === 0);
      valEl.classList.toggle("bipolar-neg", BIPOLAR_KEYS.has(key) && uiVal < 0);
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
          if ((params.lipTint ?? 0) > 0 || key !== "reset") same = false;
        }
        if (same) return key;
      }
      return "custom";
    }

    function syncLipShadeUI(shadeIdx) {
      const idx = Math.max(0, Math.min(LIP_SHADE_NAMES.length - 1, Math.round(shadeIdx ?? 2)));
      els.lipShadeList.querySelectorAll(".swatch").forEach((btn) => {
        btn.classList.toggle("active", Number(btn.dataset.shade) === idx);
      });
    }

    function updatePresetHighlight() {
      els.presetBar.querySelectorAll(".pill").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.preset === activePresetKey);
      });
      els.activePresetLabel.textContent =
        activePresetKey !== "custom" && PRESETS[activePresetKey] ? PRESETS[activePresetKey].name : "自定义";
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

    function pushParams() {
      storageSet({ beautyParams: currentParams, strength: currentParams.smooth });
      engine.setBeautyParams(currentParams);
    }

    function buildSliders(container, specs) {
      container.replaceChildren();
      for (const item of specs) {
        const isBi = !!item.bipolar;
        const row = document.createElement("div");
        row.className = "slider-row";

        const nameEl = document.createElement("span");
        nameEl.className = "slider-name";
        nameEl.textContent = item.label;
        nameEl.title = "双击重置该项为 0";

        const input = document.createElement("input");
        input.type = "range";
        input.dataset.key = item.key;
        input.min = isBi ? "-50" : "0";
        input.max = isBi ? "50" : "100";
        if (isBi) input.classList.add("bipolar");
        input.title = isBi ? "双向精调 (-50 ~ +50)，双击归零" : "双击重置为 0";
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
          pushParams();
        };
        nameEl.addEventListener("dblclick", resetSingle);
        input.addEventListener("dblclick", resetSingle);

        input.addEventListener("pointerdown", () => { isDraggingSlider = true; });
        input.addEventListener("input", () => {
          const uiVal = Number(input.value);
          updateValStyle(valEl, item.key, uiVal);
          currentParams[item.key] = isBi ? uiVal / 50 : uiVal / 100;
          activePresetKey = detectMatchingPreset(currentParams);
          updatePresetHighlight();
          pushParams();
        });

        sliderInputs.set(item.key, input);
        sliderValues.set(item.key, valEl);
        row.appendChild(nameEl);
        row.appendChild(input);
        row.appendChild(valEl);
        container.appendChild(row);
      }
    }

    function showIoStatus(msg, isError = false) {
      els.ioStatus.textContent = msg;
      els.ioStatus.className = isError ? "hint err" : "hint";
      if (msg) {
        setTimeout(() => { if (els.ioStatus.textContent === msg) els.ioStatus.textContent = ""; }, 5000);
      }
    }

    function setBadge(el, text, level) {
      el.textContent = text;
      el.className = "badge " + (level || "neutral");
    }

    function renderUI() {
      const state = engine.getStateSnapshot();
      lastState = state;
      const hasVideos = (state.videos && state.videos.length > 0) || state.enabled;

      // Auto-show floating ball on pages with videos (unless hidden by user or panel is open)
      const showFab = !panelOpen && !fabHiddenByUser && hasVideos;
      els.fab.classList.toggle("hidden", !showFab);
      els.fab.classList.toggle("on", !!state.enabled);
      els.fabText.textContent = state.enabled ? "美颜开" : "美颜";

      if (!panelOpen) return;

      if (state.lastError) {
        els.errorBanner.textContent = state.lastError;
        els.errorBanner.classList.remove("hidden");
      } else {
        els.errorBanner.classList.add("hidden");
      }

      els.toggleBeauty.checked = !!state.enabled;
      if (els.toggleDebugMask) els.toggleDebugMask.checked = !!state.debugMask;
      if (!isDraggingSlider && state.params) {
        currentParams = normalizeParams(state.params, DEFAULT_PARAMS).params;
        syncSlidersUI(currentParams);
      }

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
        els.videoMeta.textContent =
          `${sel.playbackState || (sel.paused ? "暂停" : "播放中")} · ${sel.frameOrigin || "主页面"} | ` +
          `${sel.videoWidth}×${sel.videoHeight} | ${formatTime(sel.currentTime)} / ${formatTime(sel.duration)} | ` +
          `${sel.playbackRate}x | ${sel.streamKind || "未确认"} | 来源：${sel.sourceScheme}`;
      }

      const protMap = {
        none: ["保护：未观察到", "ok"],
        eme_media_keys: ["保护：检测到 EME", "err"],
        eme_encrypted_event: ["保护：收到 encrypted", "err"],
      };
      setBadge(els.badgeProtection, ...(protMap[state.protectionSignal] || ["保护：未观察到", "neutral"]));

      const capMap = {
        waiting: ["取帧：等待画面", "warn"],
        ready: ["取帧：可取帧", "ok"],
        cors_restricted: ["取帧：跨域受限", "err"],
        skipped_eme: ["取帧：EME 已跳过", "err"],
        failed_unknown: ["取帧：失败未确认", "err"],
        idle: ["取帧：未启动", "neutral"],
      };
      setBadge(els.badgeCapture, ...(capMap[state.captureStatus] || ["取帧：未知", "neutral"]));

      const modeMap = {
        face_mask: ["模式：人脸局部遮罩", "ok"],
        skin_fallback: ["模式：肤色保边回退", "warn"],
        native_fallback: ["模式：原画回退", "warn"],
        off: ["模式：已关闭", "neutral"],
      };
      setBadge(els.badgeMode, ...(modeMap[state.renderMode] || ["模式：待就绪", "neutral"]));

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
        ["检测帧率 / 耗时", `${d.detectFps ?? 0} fps / ${(d.inferMs ?? 0).toFixed(1)} ms`],
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
        const kEl = document.createElement("span"); kEl.textContent = k;
        const vEl = document.createElement("span"); vEl.className = "val"; vEl.textContent = String(v);
        els.diagGrid.appendChild(kEl);
        els.diagGrid.appendChild(vEl);
      }
    }

    function openPanel() {
      fabHiddenByUser = false;
      panelOpen = true;
      els.panel.classList.remove("hidden");
      els.fab.classList.add("hidden");
      // 面板一打开就对齐一次缓存状态。必须放在 engine 相关调用之前：
      // 某些页面上 scanVideos()/renderUI() 可能抛错，否则这里的刷新会被跳过。
      try {
        if (window.__WVB_CACHE_SYNC__) window.__WVB_CACHE_SYNC__();
      } catch (_) {}
      engine.scanVideos();
      if (engine.video && engine.captureStatus === "waiting") engine.runProtectionAndProbe();
      renderUI();
    }

    function closePanel() {
      panelOpen = false;
      els.panel.classList.add("hidden");
      renderUI();
    }

    // Draggable FAB (click opens panel, drag repositions & persists)
    let fabDrag = null;
    els.fab.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const r = els.fab.getBoundingClientRect();
      fabDrag = {
        sx: e.clientX, sy: e.clientY,
        rx: window.innerWidth - r.right,
        by: window.innerHeight - r.bottom,
        moved: false,
      };
      try { els.fab.setPointerCapture(e.pointerId); } catch (_) {}
    });
    els.fab.addEventListener("pointermove", (e) => {
      if (!fabDrag) return;
      const dx = e.clientX - fabDrag.sx;
      const dy = e.clientY - fabDrag.sy;
      if (Math.hypot(dx, dy) > 5) fabDrag.moved = true;
      if (fabDrag.moved) {
        const right = Math.max(8, Math.min(window.innerWidth - 90, fabDrag.rx - dx));
        const bottom = Math.max(8, Math.min(window.innerHeight - 44, fabDrag.by - dy));
        els.fab.style.right = `${right}px`;
        els.fab.style.bottom = `${bottom}px`;
      }
    });
    els.fab.addEventListener("pointerup", () => {
      if (!fabDrag) return;
      const wasDrag = fabDrag.moved;
      fabDrag = null;
      if (wasDrag) {
        storageSet({ fabPos: { right: els.fab.style.right, bottom: els.fab.style.bottom } });
      } else {
        openPanel();
      }
    });

    // Draggable Panel by Header
    let panelDrag = null;
    els.panelHeader.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button, label, input")) return;
      const r = els.panel.getBoundingClientRect();
      panelDrag = { sx: e.clientX, sy: e.clientY, left: r.left, top: r.top };
      els.panel.style.right = "auto";
      els.panel.style.bottom = "auto";
      els.panel.style.left = `${r.left}px`;
      els.panel.style.top = `${r.top}px`;
      try { els.panelHeader.setPointerCapture(e.pointerId); } catch (_) {}
    });
    els.panelHeader.addEventListener("pointermove", (e) => {
      if (!panelDrag) return;
      const r = els.panel.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - r.width - 8, panelDrag.left + (e.clientX - panelDrag.sx)));
      const top = Math.max(8, Math.min(window.innerHeight - Math.min(r.height, 120) - 8, panelDrag.top + (e.clientY - panelDrag.sy)));
      els.panel.style.left = `${left}px`;
      els.panel.style.top = `${top}px`;
    });
    els.panelHeader.addEventListener("pointerup", () => { panelDrag = null; });

    // Prevent webpage hotkeys (e.g. YouTube/Douyin space/arrows) from firing while typing in JSON textarea
    els.presetJsonInput.addEventListener("keydown", (e) => e.stopPropagation());
    els.presetJsonInput.addEventListener("keyup", (e) => e.stopPropagation());

    els.btnClosePanel.addEventListener("click", closePanel);
    els.btnHideFab.addEventListener("click", () => {
      fabHiddenByUser = true;
      closePanel();
    });

    // 播放器控制条开关 —— 按域名记忆，用户自己决定哪些站点套我们的条
    (function setupPlayerBarToggle() {
      if (!els.togglePlayerBar || !els.barToggleRow) return;
      const hostNow = (function () {
        try {
          return (location.hostname || "").toLowerCase();
        } catch (_) {
          return "";
        }
      })();
      els.barHostHint.textContent = hostNow;

      const mount = (bar) => {
        els.togglePlayerBar.disabled = false;
        try {
          els.barHostHint.textContent = bar.getHost ? bar.getHost() : hostNow;
        } catch (_) {}
        const sync = () => {
          try {
            els.togglePlayerBar.checked = !!bar.isEnabled();
            els.barToggleRow.title = bar.isDefaultOn && bar.isDefaultOn()
              ? "该站点默认开启，可随时关闭"
              : "该站点默认关闭，打开后仅对当前域名生效";
          } catch (_) {}
        };
        try {
          if (bar.ready && typeof bar.ready.then === "function") {
            bar.ready.then(sync).catch(sync);
          } else {
            sync();
          }
        } catch (_) {
          sync();
        }
        els.togglePlayerBar.addEventListener("change", async () => {
          const want = els.togglePlayerBar.checked;
          try {
            await bar.setEnabled(want);
          } catch (_) {}
          sync();
        });
        // 面板每次打开时对齐一次（可能被别的标签页改过）
        window.__WVB_BAR_SYNC__ = sync;
      };

      if (window.RBPlayerBar) {
        mount(window.RBPlayerBar);
        return;
      }

      // 拿不到 RBPlayerBar：多半是本标签页在扩展安装/重载之前就打开了，
      // 面板只是点图标时临时注入的，没带上 player-bar.js。
      // 不要静默隐藏整行 —— 用户会以为功能没了。这里明说原因，并轮询等它出现。
      els.togglePlayerBar.disabled = true;
      els.togglePlayerBar.checked = false;
      els.barHostHint.textContent = `${hostNow} · 需刷新页面`;
      els.barToggleRow.title =
        "控制条脚本还没注入到本页（标签页在扩展重载前打开）。刷新页面后即可用。";

      let tries = 0;
      const timer = setInterval(() => {
        if (window.RBPlayerBar) {
          clearInterval(timer);
          els.barToggleRow.title = "";
          mount(window.RBPlayerBar);
        } else if ((tries += 1) >= 10) {
          clearInterval(timer);
        }
      }, 500);
    })();

    const subtitleMode = $("subtitleMode");
    if (window.RBSubtitles && subtitleMode) {
      const subtitles = window.RBSubtitles;
      const profileControl = $("subtitleProfile");
      const profileHint = $("subtitleProfileHint");
      const names = { cpu: "CPU 兼容", "cpu-fast": "CPU 多核", gpu: "GPU 翻译" };
      const syncSubtitles = () => {
        subtitleMode.value = subtitles.mode();
        profileControl.value = subtitles.profile();
        const active = subtitles.activeProfile();
        for (const option of profileControl.options) {
          if (!active || option.value === "auto" || option.value === "cpu") option.disabled = false;
          else option.disabled = !active.available.includes(option.value);
        }
        profileHint.textContent = active ? names[active.effective] || "" : "";
      };
      subtitleMode.disabled = false;
      profileControl.disabled = false;
      profileControl.addEventListener("change", () => subtitles.setProfile(profileControl.value));
      syncSubtitles();
      subtitles.subscribe(syncSubtitles);
      subtitleMode.addEventListener("change", () => {
        void subtitles.setMode(subtitleMode.value);
      });
    }

    // 本站缓存开关 —— 按域名记忆，默认关；开了才会把分片落到磁盘
    (function setupCacheToggle() {
      const cb = els.toggleSiteCache;
      if (!cb || !els.cacheToggleRow) return;
      const KEY = "rbCacheHosts";
      const host = (function () {
        try {
          return (location.hostname || "").toLowerCase();
        } catch (_) {
          return "";
        }
      })();
      if (els.cacheHostHint) els.cacheHostHint.textContent = host;

      const canStore =
        typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

      const readMap = () =>
        new Promise((resolve) => {
          if (!canStore) {
            resolve({});
            return;
          }
          try {
            chrome.storage.local.get({ [KEY]: {} }, (res) => {
              const v = res && res[KEY];
              resolve(v && typeof v === "object" ? v : {});
            });
          } catch (_) {
            resolve({});
          }
        });

      const writeMap = (map) =>
        new Promise((resolve) => {
          if (!canStore) {
            resolve();
            return;
          }
          try {
            chrome.storage.local.set({ [KEY]: map }, () => {
              void chrome.runtime.lastError;
              resolve();
            });
          } catch (_) {
            resolve();
          }
        });

      const sync = () =>
        readMap().then((map) => {
          cb.checked = Object.prototype.hasOwnProperty.call(map, host)
            ? !!map[host]
            : false;
        });

      sync();

      cb.addEventListener("change", async () => {
        const map = await readMap();
        map[host] = !!cb.checked;
        await writeMap(map);
      });

      // 缓存状态 + 手动删除（能拿到本地服务才有意义）
      if (els.cacheInfo) {
        const API = "http://127.0.0.1:8765";
        let siteStat = { site: "", count: 0, bytes: 0, at: 0 };
        let busy = false;
        let flashTimer = 0;
        let lastInfo = null;

        // 网页里靠 grab-hook 暴露的 safeKey；本地播放器页靠 player.html 暴露的 key
        const curKey = () => {
          const dbg = window.__RB_HLS_DEBUG__;
          if (dbg && typeof dbg.getSafeKey === "function") {
            try {
              const k = dbg.getSafeKey();
              if (k) return k;
            } catch (_) {}
          }
          return window.__RB_LOCAL_KEY__ || "";
        };

        // safeKey 形如 `avbebe.com_archives_357404`，前半段才是视频真正所属站点。
        // 本地播放器页的 host 是 127.0.0.1，不能拿它当「本站」，否则会删错目标。
        const siteOf = (sk) => {
          const i = sk ? sk.indexOf("_") : -1;
          return i > 0 ? sk.slice(0, i).toLowerCase() : host;
        };

        const reqJSON = async (url, init) => {
          const r = await fetch(url, Object.assign({ cache: "no-store" }, init || {}));
          const d = await r.json().catch(() => ({}));
          if (!r.ok) {
            throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, data: d });
          }
          return d;
        };

        const fmtMB = (bytes) => {
          const mb = (Number(bytes) || 0) / 1048576;
          return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
        };

        // 直连优先（本地页同源；网页靠服务端的 CORS + PNA 头）；
        // 被浏览器拦下时转后台 service worker（它有 host_permissions，不受 CORS 约束）
        const callDelete = async (scope, sk, site) => {
          const target = site || host;
          const url =
            scope === "site"
              ? `${API}/api/library?host=${encodeURIComponent(target)}`
              : `${API}/api/library/${encodeURIComponent(sk)}`;
          try {
            return await reqJSON(url, { method: "DELETE" });
          } catch (err) {
            const viaBg = await new Promise((resolve) => {
              let settled = false;
              const done = (v) => {
                if (!settled) {
                  settled = true;
                  resolve(v);
                }
              };
              try {
                if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
                  done(null);
                  return;
                }
                chrome.runtime.sendMessage(
                  { type: "rb-cache-delete", payload: { scope, key: sk, host: target } },
                  (res) => {
                    void chrome.runtime.lastError;
                    done(res || null);
                  }
                );
                setTimeout(() => done(null), 1800);
              } catch (_) {
                done(null);
              }
            });
            if (viaBg && viaBg.ok) return viaBg;
            throw err;
          }
        };

        const refreshSiteStat = async (site, force) => {
          const target = (site || host).toLowerCase();
          if (!force && siteStat.site === target && Date.now() - siteStat.at < 20000) {
            return siteStat;
          }
          try {
            const d = await reqJSON(`${API}/api/library`);
            const items = (d.items || []).filter(
              (x) => String(x.site || "").toLowerCase() === target
            );
            siteStat = {
              site: target,
              count: items.length,
              bytes: items.reduce((s, x) => s + (Number(x.cachedBytes) || 0), 0),
              at: Date.now(),
            };
          } catch (_) {
            siteStat = { site: target, count: 0, bytes: 0, at: Date.now() };
          }
          return siteStat;
        };

        const hideActions = () => {
          if (els.cacheActions) els.cacheActions.style.display = "none";
        };
        const hideAll = () => {
          els.cacheInfo.style.display = "none";
          hideActions();
        };
        const showText = (t) => {
          els.cacheInfo.style.display = "";
          els.cacheInfo.textContent = t;
        };

        const renderActions = async (d, sk) => {
          if (!els.cacheActions) return;
          const site = siteOf(sk);
          const st = await refreshSiteStat(site);
          const hasEntry = !!(d && d.exists);
          const n = hasEntry ? Number(d.cachedSegments) || 0 : 0;
          if (els.btnDeleteVideoCache) {
            els.btnDeleteVideoCache.style.display = hasEntry && n > 0 ? "" : "none";
            els.btnDeleteVideoCache.textContent = `删除本视频 · ${n} 片`;
            els.btnDeleteVideoCache.disabled = busy;
          }
          if (els.btnDeleteSiteCache) {
            const sameSite = site === host;
            els.btnDeleteSiteCache.style.display = st.count > 0 ? "" : "none";
            els.btnDeleteSiteCache.textContent =
              `${sameSite ? "清空本站" : "清空该站"} · ${st.count} 条 · ${fmtMB(st.bytes)}`;
            els.btnDeleteSiteCache.disabled = busy;
          }
          els.cacheActions.style.display =
            (hasEntry && n > 0) || st.count > 0 ? "flex" : "none";
        };

        const flash = (msg, ms) => {
          showText(msg);
          hideActions();
          if (flashTimer) clearTimeout(flashTimer);
          flashTimer = setTimeout(() => {
            flashTimer = 0;
            void tick();
          }, ms || 3800);
        };

        const tick = async () => {
          // 面板没开就别轮询，省得每个标签页每秒都在打本地服务
          if (!panelOpen || busy) return;
          const sk = curKey();
          if (!sk) {
            if (!cb.checked) {
              hideAll();
              return;
            }
            // 开关开着却没有 key：要么 hook 没注入（旧标签页），要么这站不是 HLS。
            // 两种都明说，别让面板看起来"什么都没有"。
            showText(
              window.__RB_HLS_DEBUG__
                ? "未识别到可缓存的视频源（本站可能不是 HLS 播放）"
                : "缓存脚本未注入本页，刷新页面后生效"
            );
            hideActions();
            return;
          }
          let d = null;
          try {
            d = await reqJSON(`${API}/api/video/${encodeURIComponent(sk)}`);
          } catch (_) {
            lastInfo = null;
            showText("本地服务未启动，缓存不可用");
            hideActions();
            return;
          }
          if (!d || !d.exists) {
            lastInfo = null;
            if (!cb.checked) {
              hideAll();
              return;
            }
            showText("本地还没有这条视频的分片");
            await renderActions(null, sk);
            return;
          }
          lastInfo = d;
          const total = Number(d.totalSegments) || 0;
          const cached = Number(d.cachedSegments) || 0;
          const pct = total ? Math.round((cached / total) * 100) : 0;
          showText(
            `已缓存 ${cached}/${total} 片 · ${pct}% · ${fmtMB(d.cachedBytes)}`
          );
          await renderActions(d, sk);
        };

        // -- 删除本视频 ------------------------------------------------------
        if (els.btnDeleteVideoCache) {
          els.btnDeleteVideoCache.addEventListener("click", async () => {
            if (busy) return;
            const sk = curKey();
            if (!sk) return;
            const site = siteOf(sk);
            const d = lastInfo || {};
            const n = Number(d.cachedSegments) || 0;
            const size = fmtMB(d.cachedBytes);
            let msg = `删除这条视频在本地磁盘的缓存？\n\n${n} 个分片 · ${size}`;
            if (window.__RB_LOCAL_KEY__ && sk === window.__RB_LOCAL_KEY__) {
              msg += "\n\n注意：这个页面正在播放它，删除后需要刷新页面才能重新加载。";
            }
            if (cb.checked) {
              msg +=
                "\n\n注意：本站缓存开关还开着，播放中的视频会从当前位置重新开始缓存。想彻底清掉，请先关掉上面的开关。";
            }
            if (!window.confirm(msg)) return;
            busy = true;
            try {
              await callDelete("video", sk, site);
              await refreshSiteStat(site, true);
              lastInfo = null;
              flash(`已删除本视频缓存 · ${n} 片 · ${size}`, 4200);
            } catch (_) {
              flash("删除失败：本地服务不可用", 4200);
            } finally {
              busy = false;
            }
          });
        }

        // -- 清空本站 --------------------------------------------------------
        if (els.btnDeleteSiteCache) {
          els.btnDeleteSiteCache.addEventListener("click", async () => {
            if (busy) return;
            const site = siteOf(curKey());
            const st = await refreshSiteStat(site);
            if (!st.count) return;
            const msg =
              `清空 ${site} 在本地的全部缓存？\n\n` +
              `共 ${st.count} 条 · ${fmtMB(st.bytes)}\n\n此操作不可撤销。`;
            if (!window.confirm(msg)) return;
            busy = true;
            try {
              const res = await callDelete("site", "", site);
              const n = (res && Array.isArray(res.deleted) && res.deleted.length) || 0;
              const fail = (res && Array.isArray(res.failed) && res.failed.length) || 0;
              lastInfo = null;
              await refreshSiteStat(site, true);
              flash(
                `已清空本站 ${n} 条 · ${fmtMB(res && res.freedBytes)}` +
                  (fail ? ` · ${fail} 条失败` : ""),
                5000
              );
            } catch (_) {
              flash("删除失败：本地服务不可用", 4200);
            } finally {
              busy = false;
            }
          });
        }

        window.__WVB_CACHE_SYNC__ = tick;
        tick();
        setInterval(tick, 4000);
      }
    })();

    // Tabs
    const tabs = shadow.querySelectorAll(".tab");
    const panes = {
      skin: $("pane-skin"),
      reshape: $("pane-reshape"),
      makeup: $("pane-makeup"),
      color: $("pane-color"),
      io: $("pane-io"),
    };
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = tab.dataset.tab;
        tabs.forEach((t) => t.classList.toggle("active", t === tab));
        for (const [k, pane] of Object.entries(panes)) {
          if (pane) pane.classList.toggle("hidden", k !== target);
        }
      });
    });

    els.presetBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".pill");
      if (!btn || !PRESETS[btn.dataset.preset]) return;
      currentParams = { ...PRESETS[btn.dataset.preset].params };
      syncSlidersUI(currentParams);
      pushParams();
    });

    els.lipShadeList.addEventListener("click", (e) => {
      const btn = e.target.closest(".swatch");
      if (!btn) return;
      currentParams.lipShade = clampParam("lipShade", btn.dataset.shade, 2);
      if ((currentParams.lipTint ?? 0) === 0) currentParams.lipTint = 0.25;
      syncSlidersUI(currentParams);
      pushParams();
    });

    function buildExportObject() {
      const exported = {};
      for (const s of ALL_SLIDERS) exported[s.key] = toUiValue(s.key, currentParams[s.key] ?? 0);
      exported.lipShade = Math.max(0, Math.min(LIP_SHADE_NAMES.length - 1, Math.round(currentParams.lipShade ?? 2)));
      return {
        schema: "wvb-wink-preset-v2",
        name: PRESETS[activePresetKey]?.name || "自定义方案",
        lipShadeName: LIP_SHADE_NAMES[exported.lipShade],
        params: exported,
      };
    }

    function applyImportedText(rawText) {
      const trimmed = rawText.trim();
      if (!trimmed) {
        showIoStatus("请先粘贴参数 JSON 或 Wink 配方", true);
        return;
      }
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed);
          const { params, matched } = normalizeParams(parsed, ZERO_PARAMS);
          if (matched === 0) { showIoStatus("JSON 中未识别到有效美颜参数字段", true); return; }
          currentParams = params;
          syncSlidersUI(currentParams);
          pushParams();
          showIoStatus(`已导入并应用 ${matched} 项 JSON 参数`);
        } catch (err) {
          showIoStatus(`JSON 格式错误：${err.message}`, true);
        }
        return;
      }
      const { params, matched, skipped } = parseWinkTextRecipe(trimmed);
      if (matched === 0) {
        showIoStatus("未识别到有效 JSON 或 Wink 配方参数", true);
        return;
      }
      currentParams = params;
      syncSlidersUI(currentParams);
      pushParams();
      const skipNote = skipped.length
        ? `（忽略：${skipped.slice(0, 3).join("、")}${skipped.length > 3 ? ` 等${skipped.length}项` : ""}）`
        : "";
      showIoStatus(`已解析并应用 ${matched} 项配方${skipNote}`);
    }

    els.btnSaveCustom.addEventListener("click", () => {
      storageSet({ savedCustomParams: currentParams });
      showIoStatus("已保存到「我的方案」");
    });
    els.btnLoadCustom.addEventListener("click", async () => {
      const { savedCustomParams } = await storageGet({ savedCustomParams: null });
      if (!savedCustomParams) { showIoStatus("尚未保存「我的方案」", true); return; }
      currentParams = normalizeParams(savedCustomParams, DEFAULT_PARAMS).params;
      syncSlidersUI(currentParams);
      pushParams();
      showIoStatus("已加载「我的方案」");
    });
    els.btnExportClip.addEventListener("click", async () => {
      const json = JSON.stringify(buildExportObject(), null, 2);
      els.presetJsonInput.value = json;
      try { await navigator.clipboard.writeText(json); showIoStatus("参数 JSON 已复制到剪贴板"); }
      catch (_) { showIoStatus("已填入下方文本框，可手动复制"); }
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
      applyImportedText(text);
      els.inputImportFile.value = "";
    });
    els.btnApplyJson.addEventListener("click", () => applyImportedText(els.presetJsonInput.value));

    els.toggleBeauty.addEventListener("change", () => {
      engine.setEnabled(els.toggleBeauty.checked);
      renderUI();
    });
    if (els.toggleDebugMask) {
      els.toggleDebugMask.addEventListener("change", () => {
        if (typeof engine.setDebugMask === "function") {
          engine.setDebugMask(els.toggleDebugMask.checked);
        }
        renderUI();
      });
    }
    els.videoSelect.addEventListener("change", () => {
      if (els.videoSelect.value) { engine.selectVideoByUser(els.videoSelect.value); renderUI(); }
    });

    const startCompare = () => { els.btnCompare.classList.add("active"); engine.setCompareOriginal(true); };
    const stopCompare = () => { els.btnCompare.classList.remove("active"); engine.setCompareOriginal(false); };
    els.btnCompare.addEventListener("pointerdown", startCompare);
    els.btnCompare.addEventListener("mouseleave", stopCompare);
    window.addEventListener("pointerup", () => { isDraggingSlider = false; stopCompare(); });
    window.addEventListener("pointercancel", () => { isDraggingSlider = false; stopCompare(); });

    els.btnRetry.addEventListener("click", () => {
      engine.probeAttempts = 0;
      engine.workerUnavailable = false;
      engine.runProtectionAndProbe();
      renderUI();
    });
    els.btnRescan.addEventListener("click", () => {
      engine.scanVideos();
      renderUI();
    });
    els.btnCopyDiag.addEventListener("click", async () => {
      if (!lastState) return;
      const text = JSON.stringify(lastState, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        els.copyHint.textContent = "已复制";
        setTimeout(() => (els.copyHint.textContent = ""), 1500);
      } catch (_) {
        els.presetJsonInput.value = text;
        els.copyHint.textContent = "已填入下方输入框";
      }
    });

    // Listen for toolbar icon click messages from service worker
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || !msg.type) return;
        if (msg.type === "WVB_TOGGLE_PANEL") {
          if (panelOpen) closePanel();
          else openPanel();
          sendResponse({ ok: true, panelOpen });
          return true;
        }
        if (msg.type === "WVB_OPEN_PANEL") {
          openPanel();
          sendResponse({ ok: true, panelOpen: true });
          return true;
        }
      });
    }

    buildSliders(els.skinSliders, SKIN_SLIDERS);
    buildSliders(els.reshapeSliders, RESHAPE_SLIDERS);
    buildSliders(els.makeupSliders, MAKEUP_SLIDERS);
    buildSliders(els.colorSliders, COLOR_SLIDERS);

    // Load saved params & FAB position from chrome.storage.local
    storageGet({ beautyParams: null, fabPos: null }).then((stored) => {
      if (stored.beautyParams && typeof stored.beautyParams === "object") {
        currentParams = normalizeParams(stored.beautyParams, DEFAULT_PARAMS).params;
        engine.setBeautyParams(currentParams);
      }
      if (stored.fabPos && stored.fabPos.right && stored.fabPos.bottom) {
        els.fab.style.right = stored.fabPos.right;
        els.fab.style.bottom = stored.fabPos.bottom;
      }
      syncSlidersUI(currentParams);
      renderUI();
    });

    window.__WVB_DESKTOP_UI_CTRL__ = { openPanel, closePanel, renderUI };
    renderUI();
    setInterval(renderUI, 700);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountDesktopFloatingUI, { once: true });
  } else {
    mountDesktopFloatingUI();
  }
})();
