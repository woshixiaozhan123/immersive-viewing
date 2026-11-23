(() => {
  if (window.__WVB_ENGINE__) return;

  const BIPOLAR_KEYS = new Set([
    "vChin",
    "eyeTilt",
    "mouthSize",
    "exposure",
    "contrast",
    "saturation",
    "temperature",
  ]);

  // 4 Wink-style lip color shades: 0=裸粉, 1=蜜桃橘, 2=玫瑰豆沙, 3=复古正红
  const LIP_SHADE_RGB = [
    [0.92, 0.56, 0.62],
    [0.95, 0.48, 0.36],
    [0.88, 0.32, 0.42],
    [0.82, 0.16, 0.24],
  ];

  const DEFAULT_BEAUTY_PARAMS = {
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

  function clampParam(key, val, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    if (key === "lipShade") {
      return Math.max(0, Math.min(LIP_SHADE_RGB.length - 1, Math.round(n)));
    }
    if (BIPOLAR_KEYS.has(key)) {
      const norm = Math.abs(n) > 1 ? n / 50 : n;
      return Math.max(-1, Math.min(1, norm));
    }
    const norm = n > 1 ? n / 100 : n;
    return Math.max(0, Math.min(1, norm));
  }

  function normalizeBeautyParams(input, base = DEFAULT_BEAUTY_PARAMS) {
    const out = { ...base };
    if (!input || typeof input !== "object") return out;
    for (const key of Object.keys(DEFAULT_BEAUTY_PARAMS)) {
      if (input[key] !== undefined) {
        out[key] = clampParam(key, input[key], out[key]);
      }
    }
    return out;
  }

  // MediaPipe 478-landmark contour indices for multi-channel local face mask
  const FACE_OVAL_IDX = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
    397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
    172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
  ];
  const LEFT_EYE_IDX = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
  const RIGHT_EYE_IDX = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
  const LEFT_BROW_IDX = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
  const RIGHT_BROW_IDX = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];
  const LIPS_IDX = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];

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

  // Wink / CapCut Pro single-pass WebGL pipeline (26 parameters):
  // 1) UV micro-reshape (slimFace, slimCheekbone, vChin, bigEyes, eyeTilt, slimNose, mouthSize, mouthSmile)
  // 2) Skin (smooth, skinTexture, whiten, rosy, underEye, nasolabial, matte)
  // 3) Makeup (brightEye, contour, lipTint + lipShade, whitenTeeth)
  // 4) Color grading (sharpen, exposure, contrast, saturation, temperature, softGlow)
  const FRAG_SRC = `
    precision mediump float;
    uniform sampler2D u_video;
    uniform sampler2D u_mask;
    uniform vec2 u_texel;
    uniform float u_hasFaceMask;
    uniform float u_compareOriginal;

    // Parameter vectors
    uniform vec4 u_skinA;     // (smooth, skinTexture, whiten, rosy)
    uniform vec4 u_skinB;     // (underEye, nasolabial, matte, yawFactor)
    uniform vec4 u_reshapeA;  // (slimFace, slimCheekbone, vChin, bigEyes)
    uniform vec4 u_reshapeB;  // (eyeTilt, slimNose, mouthSize, mouthSmile)
    uniform vec4 u_makeupA;   // (brightEye, contour, lipTint, whitenTeeth)
    uniform vec4 u_lipColor;  // (lipR, lipG, lipB, aspect)
    uniform vec4 u_colorA;    // (sharpen, exposure, contrast, saturation)
    uniform vec4 u_colorB;    // (temperature, softGlow, fade, liteMode)

    // Face landmark anchor vectors (normalized UV space)
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

    float underEyeMask(vec2 uv, vec2 eyeCenter, float eyeR, float aspect) {
      if (eyeR <= 0.001) return 0.0;
      vec2 c = eyeCenter + vec2(0.0, eyeR * 0.78);
      vec2 d = uv - c;
      d.x *= aspect;
      vec2 nd = vec2(d.x / (eyeR * 1.15), d.y / (eyeR * 0.52));
      float r2 = dot(nd, nd);
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

      // 1) Aspect-corrected micro-reshape UV warp (gated by face mask, yaw symmetry, fade & L2)
      vec2 wuv = v_uv;
      float anyReshape =
        slimFaceAmt + slimCheekAmt + abs(vChinAmt) + bigEyesAmt +
        abs(eyeTiltAmt) + slimNoseAmt + abs(mouthSizeAmt) + mouthSmileAmt;
      if (u_hasFaceMask > 0.5 && liteMode < 0.5 && faceFade > 0.001 && yawFactor > 0.01 && anyReshape > 0.001) {
        float wFade = faceFade * yawFactor;
        float fw = max(u_eyeRadii.z, 0.02);
        float fh = max(u_eyeRadii.w, 0.02);
        vec2 noseTip = u_noseBridge.zw;
        vec2 chinPt  = u_chinMouth.xy;
        vec2 faceUp  = normalize((u_noseBridge.xy - noseTip) + vec2(0.0, -1e-4));

        if (bigEyesAmt > 0.001) {
          float be = bigEyesAmt * wFade;
          wuv = warpEye(wuv, u_eyes.xy, u_eyeRadii.x, be, aspect);
          wuv = warpEye(wuv, u_eyes.zw, u_eyeRadii.y, be, aspect);
        }
        if (abs(eyeTiltAmt) > 0.001) {
          float et = eyeTiltAmt * wFade;
          vec2 shiftL = faceUp * (u_eyeRadii.x * 0.28 * et);
          vec2 shiftR = faceUp * (u_eyeRadii.y * 0.28 * et);
          wuv = warpPush(wuv, u_eyeOuter.xy, u_eyeOuter.xy + shiftL, max(u_eyeRadii.x * 0.85, 0.015), 0.9, aspect);
          wuv = warpPush(wuv, u_eyeOuter.zw, u_eyeOuter.zw + shiftR, max(u_eyeRadii.y * 0.85, 0.015), 0.9, aspect);
        }
        // Independent cheekbone & lower jaw slimming (with smooth continuity)
        float effCheek = clamp(slimCheekAmt + slimFaceAmt * 0.22, 0.0, 1.0);
        if (effCheek > 0.001) {
          float sc = effCheek * wFade;
          float rCheek = max(fw * 0.44, 0.02);
          wuv = warpPush(wuv, u_leftContour.xy,  noseTip, rCheek, sc * 0.24, aspect);
          wuv = warpPush(wuv, u_rightContour.xy, noseTip, rCheek, sc * 0.24, aspect);
        }
        if (slimFaceAmt > 0.001) {
          float sf = slimFaceAmt * wFade;
          float rJaw = max(fw * 0.48, 0.02);
          vec2 jawTarget = mix(noseTip, chinPt, 0.55);
          wuv = warpPush(wuv, u_leftContour.zw,  jawTarget, rJaw, sf * 0.28, aspect);
          wuv = warpPush(wuv, u_rightContour.zw, jawTarget, rJaw, sf * 0.28, aspect);
        }
        if (abs(vChinAmt) > 0.001) {
          float vc = vChinAmt * wFade;
          vec2 downDir = -faceUp;
          vec2 chinTarget = chinPt + downDir * (fh * 0.075 * vc);
          wuv = warpPush(wuv, chinPt, chinTarget, max(fw * 0.36, 0.02), 0.85, aspect);
        }
        if (slimNoseAmt > 0.001) {
          float sn = slimNoseAmt * wFade;
          float rNose = max(fw * 0.19, 0.015);
          wuv = warpPush(wuv, u_noseWings.xy, noseTip, rNose, sn * 0.34, aspect);
          wuv = warpPush(wuv, u_noseWings.zw, noseTip, rNose, sn * 0.34, aspect);
        }
        if (abs(mouthSizeAmt) > 0.001) {
          wuv = warpEye(wuv, u_chinMouth.zw, max(fw * 0.24, 0.02), mouthSizeAmt * 0.65 * wFade, aspect);
        }
        if (mouthSmileAmt > 0.001) {
          float ms = mouthSmileAmt * wFade;
          vec2 lift = faceUp * (fh * 0.042 * ms);
          float rMouth = max(fw * 0.14, 0.015);
          wuv = warpPush(wuv, u_mouthCorners.xy, u_mouthCorners.xy + lift, rMouth, 0.9, aspect);
          wuv = warpPush(wuv, u_mouthCorners.zw, u_mouthCorners.zw + lift, rMouth, 0.9, aspect);
        }
        wuv = clamp(wuv, vec2(0.0), vec2(1.0));
      }

      vec4 orig = texture2D(u_video, wuv);
      vec3 rgb = orig.rgb;

      // Multi-channel face mask: R=skin oval (cutouts punched), G=eyes, B=lips
      vec4 maskTex = (u_hasFaceMask > 0.5) ? texture2D(u_mask, wuv) : vec4(0.0);
      float faceSkinMask = maskTex.r;
      float eyeMask = maskTex.g;
      float lipMask = maskTex.b;

      float skinW = skinProbability(orig.rgb);
      float skinArea = (u_hasFaceMask > 0.5) ? (faceSkinMask * mix(0.45, 1.0, skinW)) : (skinW * 0.85);

      // Localized under-eye & nasolabial masks (gated by faceSkinMask so eyes/lips stay crisp)
      float ueW = 0.0;
      float nlW = 0.0;
      if (u_hasFaceMask > 0.5 && faceSkinMask > 0.01 && faceFade > 0.001) {
        if (underEyeAmt > 0.001) {
          float ueL = underEyeMask(wuv, u_eyes.xy, u_eyeRadii.x, aspect);
          float ueR = underEyeMask(wuv, u_eyes.zw, u_eyeRadii.y, aspect);
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

      // 2) Edge-preserving skin smoothing + texture retention + matte de-shine
      vec3 smoothed = orig.rgb;
      float effSmooth = clamp(smoothAmt + ueW * underEyeAmt * 0.70 + nlW * nasolabialAmt * 0.65, 0.0, 1.0);
      bool didSmooth = false;
      if (skinArea > 0.01 && (effSmooth > 0.001 || matteAmt > 0.001) && faceFade > 0.001) {
        float radiusScale = 1.6 + max(effSmooth, matteAmt * 0.5) * 3.0;
        smoothed = edgePreservingSmooth(wuv, orig.rgb, max(effSmooth, 0.25), skinTexAmt, radiusScale, liteMode);
        didSmooth = true;
        if (effSmooth > 0.001) {
          float blend = clamp(skinArea * (0.25 + effSmooth * 0.75) * min(effSmooth * 2.2, 1.0) * faceFade, 0.0, 0.94);
          // Optional fine skin texture preservation (prevents plastic look)
          vec3 microTex = (orig.rgb - smoothed) * (skinTexAmt * 0.34);
          rgb = mix(rgb, clamp(smoothed + microTex, 0.0, 1.0), blend);
        }
      }

      // 2b) Matte / de-shine oil highlight suppression on skin
      if (skinArea > 0.01 && matteAmt > 0.001 && faceFade > 0.001) {
        float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
        float maxC = max(rgb.r, max(rgb.g, rgb.b));
        float minC = min(rgb.r, min(rgb.g, rgb.b));
        float chroma = maxC - minC;
        float glare = smoothstep(0.66, 0.94, luma) * (1.0 - smoothstep(0.16, 0.44, chroma));
        vec3 baseSkin = didSmooth ? smoothed : rgb;
        vec3 matteTarget = min(rgb, baseSkin * 0.90 + vec3(0.06, 0.04, 0.03));
        rgb = mix(rgb, matteTarget, clamp(glare * matteAmt * 0.65 * skinArea * faceFade, 0.0, 0.75));
      }

      // 3) Under-eye & nasolabial shadow lift
      if (ueW > 0.01 && underEyeAmt > 0.001 && faceFade > 0.001) {
        float ueLift = ueW * underEyeAmt * 0.34 * faceFade;
        vec3 ueTarget = rgb + (1.0 - rgb) * vec3(0.96, 0.89, 0.80) * ueLift;
        rgb = mix(rgb, clamp(ueTarget, 0.0, 1.0), clamp(ueW * faceFade, 0.0, 0.90));
      }
      if (nlW > 0.01 && nasolabialAmt > 0.001 && faceFade > 0.001) {
        float nlLift = nlW * nasolabialAmt * 0.24 * faceFade;
        rgb = clamp(rgb + (1.0 - rgb) * (vec3(0.98, 0.94, 0.89) * nlLift), 0.0, 1.0);
      }

      // 4) Highlight-safe whitening / clear fair skin tone
      if (skinArea > 0.01 && whitenAmt > 0.001 && faceFade > 0.001) {
        float lift = whitenAmt * 0.36 * skinArea * faceFade;
        rgb = clamp(rgb + (1.0 - rgb) * (vec3(0.97, 0.99, 1.04) * lift), 0.0, 1.0);
      }

      // 5) Rosy cheeks & healthy skin warmth
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

      // 6) 3D Contour (nose bridge highlight + subtle jawline outer shading)
      if (u_hasFaceMask > 0.5 && contourAmt > 0.001 && faceSkinMask > 0.01 && u_eyeRadii.z > 0.01 && faceFade > 0.001) {
        float fw = u_eyeRadii.z;
        float bridgeW = segMask(wuv, u_noseBridge.xy, u_noseBridge.zw, max(fw * 0.07, 0.008), aspect) * faceSkinMask;
        float jawEdgeL = segMask(wuv, u_leftContour.xy, u_leftContour.zw, max(fw * 0.16, 0.015), aspect) * faceSkinMask;
        float jawEdgeR = segMask(wuv, u_rightContour.xy, u_rightContour.zw, max(fw * 0.16, 0.015), aspect) * faceSkinMask;
        float shadeW = max(jawEdgeL, jawEdgeR);
        if (bridgeW > 0.01) {
          rgb = clamp(rgb + (1.0 - rgb) * (bridgeW * contourAmt * 0.18 * faceFade), 0.0, 1.0);
        }
        if (shadeW > 0.01) {
          rgb = clamp(rgb * (1.0 - shadeW * contourAmt * 0.11 * faceFade), 0.0, 1.0);
        }
      }

      // 7) Bright eyes (sclera lift + micro contrast)
      if (eyeMask > 0.02 && brightEyeAmt > 0.001 && faceFade > 0.001) {
        float eAmt = eyeMask * brightEyeAmt * faceFade;
        float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
        vec3 contrasted = mix(rgb, clamp((rgb - 0.38) * (1.0 + 0.45 * eAmt) + 0.38, 0.0, 1.0), 0.80);
        vec3 eyeBright = contrasted + (1.0 - contrasted) * (0.22 * eAmt * smoothstep(0.25, 0.72, luma));
        rgb = clamp(eyeBright, 0.0, 1.0);
      }

      // 8) Teeth whitening (neutralizes yellow teeth inside mouth without bleaching pink/red lips)
      if (u_hasFaceMask > 0.5 && teethAmt > 0.001 && faceFade > 0.001 && u_eyeRadii.z > 0.01) {
        vec2 dm = wuv - u_chinMouth.zw;
        dm.x *= aspect;
        float mouthZone = (1.0 - smoothstep(u_eyeRadii.z * 0.06, u_eyeRadii.z * 0.18, length(dm))) * (1.0 - faceSkinMask * 0.8);
        if (mouthZone > 0.05) {
          float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
          float maxC = max(rgb.r, max(rgb.g, rgb.b));
          float minC = min(rgb.r, min(rgb.g, rgb.b));
          float redExcess = rgb.r - rgb.b;
          float isTooth = smoothstep(0.42, 0.65, luma) * (1.0 - smoothstep(0.14, 0.28, redExcess)) * (1.0 - smoothstep(0.18, 0.34, maxC - minC));
          float tAmt = isTooth * mouthZone * teethAmt * 0.65 * faceFade;
          if (tAmt > 0.01) {
            vec3 cleanWhite = mix(rgb, vec3(min(1.0, luma * 1.12 + 0.08)), 0.72);
            rgb = clamp(mix(rgb, cleanWhite, tAmt), 0.0, 1.0);
          }
        }
      }

      // 9) Natural lip tint using selected lipShade RGB
      if (lipMask > 0.02 && lipTintAmt > 0.001 && faceFade > 0.001) {
        float lAmt = lipMask * lipTintAmt * 0.62 * faceFade;
        float lipLuma = dot(rgb, vec3(0.299, 0.587, 0.114));
        vec3 mulTone = mix(vec3(1.0), lipShadeRgb * 1.25, 0.65);
        vec3 softLip = mix(rgb, rgb * mulTone + lipShadeRgb * (0.28 * (1.0 - lipLuma)), lAmt);
        rgb = clamp(softLip, 0.0, 1.0);
      }

      // 10) Clarity / detail sharpen (global + eye boost, gentle on smoothed skin)
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

      // 11) Full-frame color grading (exposure, contrast, saturation, temperature, soft glow)
      if (abs(exposureAmt) > 0.001) {
        rgb = clamp(rgb * pow(2.0, exposureAmt * 0.50), 0.0, 1.0);
      }
      if (abs(contrastAmt) > 0.001) {
        rgb = clamp((rgb - 0.5) * (1.0 + contrastAmt * 0.48) + 0.5, 0.0, 1.0);
      }
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

  class WebVideoBeautyEngine {
    constructor() {
      this.enabled = false;
      this.params = { ...DEFAULT_BEAUTY_PARAMS };
      this.strength = this.params.smooth;
      this.compareOriginal = false;
      this.faceAnchors = null;
      this.uvTransform = [1, 1, 0, 0];

      this.videosMap = new Map(); // id -> HTMLVideoElement
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

      // Detached probe canvas for read-only Stage-1 frame verification when beauty is OFF
      this.probeCanvas = null;
      this.probeGl = null;
      this.probeTex = null;

      // Canvas & WebGL resources
      this.canvas = null;
      this.gl = null;
      this.program = null;
      this.videoTex = null;
      this.maskTex = null;
      this.posBuf = null;
      this.uniforms = {};
      this.contextLost = false;

      // Mask 2D offscreen canvas (384x384 for crisp eye/lip cutouts)
      this.maskCanvas = document.createElement("canvas");
      this.maskCanvas.width = 384;
      this.maskCanvas.height = 384;
      this.maskCtx = this.maskCanvas.getContext("2d");

      // Downscale canvas for Worker inference
      this.inferCanvas = document.createElement("canvas");
      this.inferCtx = this.inferCanvas.getContext("2d", { willReadFrequently: false });

      // Worker & tracking state
      this.worker = null;
      this.workerBlobUrl = null;
      this.workerStatus = "未启用";
      this.workerReady = false;
      this.workerBusy = false;
      this.workerInitializing = false;
      this.workerUnavailable = false;
      this.lastInferSentMs = 0;
      this.latestLandmarks = null; // Float32Array (x, y, vx, vy)
      this.latestLandmarkTs = 0;
      this.validFaceStreak = 0;
      this.fadeWeight = 1.0;

      // Scheduling & observers
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

      // Performance & degradation
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
      this.mutationObserver = new MutationObserver(() => {
        if (this.destroyed) return;
        if (this.mutationDebounce) clearTimeout(this.mutationDebounce);
        this.mutationDebounce = setTimeout(() => this.scanVideos(), 280);
      });
      this.mutationObserver.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
      });

      document.addEventListener(
        "play",
        (e) => {
          if (this.destroyed) return;
          const target = e.target;
          if (!target || target.tagName !== "VIDEO") return;
          // Auto-follow feed swipes (e.g. Douyin/TikTok) when a new main video starts playing
          if (target !== this.video) {
            if (this.userLockedId && this.video && !this.video.paused) return;
            this.userLockedId = null;
            this.scanVideos();
          }
        },
        true
      );
      document.addEventListener("fullscreenchange", () => this.handleFullscreenChange());
      document.addEventListener("visibilitychange", () => {
        if (this.destroyed) return;
        if (document.visibilityState === "hidden") {
          this.stopFrameLoop();
        } else if (
          this.enabled &&
          this.captureStatus === "ready" &&
          this.video &&
          !this.video.paused &&
          !this.video.ended
        ) {
          this.renderSingleFrame(performance.now(), { skipInfer: true });
          this.startFrameLoop();
        }
      });
      window.addEventListener("resize", () => this.syncCanvasGeometry());
      window.addEventListener("scroll", () => this.syncCanvasGeometry(), true);
      window.addEventListener("pagehide", () => this.teardownAll());
    }

    collectVideosRecursive(root, frameOrigin, list, stats) {
      if (!root) return;
      const vids = root.querySelectorAll ? root.querySelectorAll("video") : [];
      for (const v of vids) {
        this.videoOrigins.set(v, frameOrigin);
        list.push({ el: v, frameOrigin });
      }
      // Large non-overlay canvases (diagnostic hint for custom canvas players)
      const canvases = root.querySelectorAll ? root.querySelectorAll("canvas") : [];
      for (const c of canvases) {
        if (c === this.canvas || c === this.probeCanvas || c.classList.contains("wvb-beauty-overlay")) {
          continue;
        }
        const rect = c.getBoundingClientRect();
        if (rect.width >= 240 && rect.height >= 160) {
          stats.largeCanvases++;
        }
      }
      // Open shadow roots
      const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const el of all) {
        if (el.shadowRoot) {
          this.collectVideosRecursive(el.shadowRoot, frameOrigin, list, stats);
        }
      }
      // Same-origin iframes (and cross-origin detection)
      const iframes = root.querySelectorAll ? root.querySelectorAll("iframe") : [];
      for (const frame of iframes) {
        try {
          if (frame.contentDocument) {
            this.collectVideosRecursive(frame.contentDocument, "同源 iframe", list, stats);
          } else if (frame.contentWindow) {
            // Accessing cross-origin location throws SecurityError even when contentDocument is null
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

      // Strongly penalize hover preview thumbnails (e.g. recommendation card previews)
      // so a looping muted thumbnail never steals focus from a paused main player.
      const isTinyPreview = rect.width < 320 && v.muted && v.loop;
      const isMainPlayer = !!v.closest(
        ".plyr__video-wrapper, .plyr, xg-video-container, .xgplayer, .bpx-player-video-wrap, .bilibili-player-video, .html5-video-player"
      );
      const playingBonus = !isTinyPreview && !v.paused && !v.ended ? 1e7 : 0;
      const mainPlayerBonus = isMainPlayer ? 2e6 : 0;
      const unmutedBonus = !v.muted ? 1e5 : 0;
      const area = rect.width * rect.height;
      return playingBonus + mainPlayerBonus + unmutedBonus + area - (isTinyPreview ? 5e6 : 0);
    }

    scanVideos() {
      const found = [];
      const stats = { crossOriginIframes: 0, largeCanvases: 0 };
      this.collectVideosRecursive(document, "主页面", found, stats);

      const hints = [];
      if (stats.crossOriginIframes > 0) {
        hints.push(`跨域 iframe (${stats.crossOriginIframes} 个)`);
      }
      if (stats.largeCanvases > 0) {
        hints.push(`大尺寸 Canvas (${stats.largeCanvases} 个)`);
      }
      this.unsupportedHints = hints;

      this.videosMap.clear();
      const ranked = [];
      for (const item of found) {
        const id = this.getVideoId(item.el);
        this.videosMap.set(id, item.el);
        ranked.push({ id, el: item.el, score: this.scoreVideo(item.el) });
      }

      // Check if user-locked video still exists in DOM
      if (this.userLockedId && !this.videosMap.has(this.userLockedId)) {
        this.userLockedId = null;
      }

      let nextId = this.userLockedId;
      if (!nextId) {
        ranked.sort((a, b) => b.score - a.score);
        nextId = ranked.length > 0 ? ranked[0].id : null;
      }

      if (nextId !== this.selectedVideoId) {
        this.bindVideo(nextId);
      }
    }

    selectVideoByUser(videoId) {
      if (!this.videosMap.has(videoId)) return;
      this.userLockedId = videoId;
      this.bindVideo(videoId);
    }

    bindVideo(videoId) {
      this.unbindCurrentVideo();
      this.selectedVideoId = videoId;
      this.video = videoId ? this.videosMap.get(videoId) || null : null;
      this.protectionSignal = "none";
      this.captureStatus = this.video ? "waiting" : "idle";
      this.lastError = "";
      this.lastCapturedMediaTime = null;
      this.probeAttempts = 0;
      this.resetTrackingAndFade();

      if (!this.video) {
        this.renderMode = "off";
        return;
      }

      const v = this.video;
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
        if (this.enabled && this.captureStatus === "ready") {
          this.renderSingleFrame(performance.now(), { skipInfer: true });
          this.maybeDispatchInference(performance.now(), true);
        } else if (!this.enabled && this.protectionSignal === "none") {
          this.runProtectionAndProbe();
        }
      });
      on("playing", () => {
        if (this.enabled) {
          if (this.captureStatus !== "ready") this.runProtectionAndProbe();
          else this.startFrameLoop();
        } else if (this.captureStatus !== "ready" && this.protectionSignal === "none") {
          this.runProtectionAndProbe();
        }
      });
      on("pause", () => {
        // Hold current beautified frame on blur/pause so popup adjustments stay visible
        this.stopFrameLoop();
        if (this.enabled && this.captureStatus === "ready") {
          this.renderSingleFrame(performance.now(), { skipInfer: true });
        }
      });
      on("ended", () => {
        this.stopFrameLoop();
      });
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

      this.resizeObserver = new ResizeObserver(() => this.syncCanvasGeometry());
      this.resizeObserver.observe(v);

      this.runProtectionAndProbe();
    }

    unbindCurrentVideo() {
      this.stopFrameLoop();
      if (this.probeTimer) {
        clearTimeout(this.probeTimer);
        this.probeTimer = null;
      }
      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }
      for (const cleanup of this.boundDocCleanup) {
        try {
          cleanup();
        } catch (_) {}
      }
      this.boundDocCleanup = [];
      if (this.video) {
        for (const [evt, fn] of this.boundVideoHandlers) {
          this.video.removeEventListener(evt, fn);
        }
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
      this.faceAnchors = null;
      this.validFaceStreak = 0;
      this.fadeWeight = this.workerReady ? 0.0 : 1.0;
      this.lastMediaTime = -1;
      if (this.worker) {
        this.worker.postMessage({ type: "RESET" });
      }
    }

    detectAdapterName(video) {
      if (video.closest(".plyr__video-wrapper, .plyr")) {
        return "Plyr 播放器容器适配";
      }
      if (video.closest("xg-video-container, .xgplayer")) {
        return "XGPlayer 播放器容器适配";
      }
      if (video.closest(".bpx-player-video-wrap, .bilibili-player-video")) {
        return "Bilibili 播放器容器适配";
      }
      if (video.closest(".html5-video-player")) {
        return "YouTube 播放器容器适配";
      }
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
        c.width = 2;
        c.height = 2;
        const gl = c.getContext("webgl2") || c.getContext("webgl");
        if (!gl) {
          throw new Error("WebGL unavailable for frame probe");
        }
        const tex = this.createLinearTexture(gl);
        this.probeCanvas = c;
        this.probeGl = gl;
        this.probeTex = tex;
      }
      const gl = this.probeGl;
      gl.bindTexture(gl.TEXTURE_2D, this.probeTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
      const err = gl.getError();
      if (err !== gl.NO_ERROR) {
        throw new Error(`WebGL error code: ${err}`);
      }
    }

    runProtectionAndProbe() {
      if (!this.video) return;
      if (this.probeTimer) {
        clearTimeout(this.probeTimer);
        this.probeTimer = null;
      }
      if (this.checkProtectionOnly()) {
        this.stopBeautyOverlay("检测到 EME mediaKeys，已跳过取帧。");
        return;
      }
      if (this.video.readyState < 2 || this.video.videoWidth === 0 || this.video.videoHeight === 0) {
        this.captureStatus = "waiting";
        return;
      }

      if (this.enabled && !this.ensureWebGL()) {
        this.captureStatus = "failed_unknown";
        this.stopBeautyOverlay("WebGL 上下文初始化失败，已保持原画。");
        return;
      }

      try {
        if (this.enabled) {
          const gl = this.gl;
          gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
          const err = gl.getError();
          if (err !== gl.NO_ERROR) {
            throw new Error(`WebGL error code: ${err}`);
          }
          this.captureStatus = "ready";
          this.lastCapturedMediaTime = this.video.currentTime;
          this.lastError = "";
          this.probeAttempts = 0;
          this.ensureWorker();
          this.showCanvas();
          this.syncCanvasGeometry();
          this.renderSingleFrame(performance.now(), { skipInfer: false });
          if (!this.video.paused && !this.video.ended) {
            this.startFrameLoop();
          }
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
        // Exponential backoff finite retry (300 / 600 / 1200ms)
        if (this.probeAttempts < 3) {
          const delay = 300 * Math.pow(2, this.probeAttempts);
          this.probeAttempts++;
          this.captureStatus = "waiting";
          this.probeTimer = setTimeout(() => this.runProtectionAndProbe(), delay);
        } else {
          this.captureStatus = "failed_unknown";
          this.stopBeautyOverlay("取帧失败，原因未确认，已恢复原画。");
        }
      }
    }

    getMountContainer(video) {
      const known = video.closest(
        ".plyr__video-wrapper, xg-video-container, .bpx-player-video-wrap, .bilibili-player-video, .html5-video-container"
      );
      if (known) return known;
      return video.parentElement || (video.ownerDocument && video.ownerDocument.body) || document.body;
    }

    findPositionedAncestor(el, win) {
      let cur = el;
      while (cur && cur !== cur.ownerDocument.body && cur !== cur.ownerDocument.documentElement) {
        const cs = win.getComputedStyle(cur);
        if (cs.position !== "static" || cs.transform !== "none" || cs.filter !== "none") {
          return cur;
        }
        cur = cur.parentElement;
      }
      return (el && el.ownerDocument && el.ownerDocument.body) || document.body;
    }

    ensureWebGL() {
      if (this.canvas && this.gl && !this.contextLost) return true;
      if (!this.video) return false;
      this.destroyProbeWebGL();

      const doc = this.video.ownerDocument || document;
      const win = doc.defaultView || window;
      const container = this.getMountContainer(this.video);
      const cs = win.getComputedStyle(container);
      if (cs.position === "static") {
        container.style.position = "relative";
      }

      if (!this.canvas) {
        const canvas = doc.createElement("canvas");
        canvas.className = "wvb-beauty-overlay";
        canvas.style.setProperty("position", "absolute", "important");
        canvas.style.setProperty("pointer-events", "none", "important");
        canvas.style.setProperty("z-index", "2", "important");
        canvas.style.setProperty("display", "none", "important");
        canvas.style.setProperty("visibility", "visible", "important");
        canvas.style.setProperty("opacity", "1", "important");
        canvas.style.setProperty("max-width", "none", "important");
        canvas.style.setProperty("max-height", "none", "important");
        canvas.style.setProperty("min-width", "0", "important");
        canvas.style.setProperty("min-height", "0", "important");
        canvas.style.setProperty("margin", "0", "important");
        canvas.style.setProperty("padding", "0", "important");
        canvas.style.setProperty("border", "0", "important");
        canvas.style.setProperty("transform", "translateZ(0)", "important");
        canvas.style.setProperty("top", "0px", "important");
        canvas.style.setProperty("left", "0px", "important");
        canvas.style.setProperty("width", "0px", "important");
        canvas.style.setProperty("height", "0px", "important");
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
          if (this.enabled) this.runProtectionAndProbe();
        });
        // Insert right after <video> so player controls (.plyr__controls / xg-controls) stay above it
        if (this.video.parentElement === container && this.video.nextSibling) {
          container.insertBefore(canvas, this.video.nextSibling);
        } else {
          container.appendChild(canvas);
        }
        this.canvas = canvas;
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
      this.maskTex = this.createLinearTexture(gl);

      const u = (name) => gl.getUniformLocation(this.program, name);
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
      this.probeGl = null;
      this.probeTex = null;
      this.probeCanvas = null;
    }

    destroyWebGLAndCanvas() {
      const oldCanvas = this.canvas;
      const oldGl = this.gl;
      this.canvas = null;
      this.gl = null;
      if (oldGl) {
        if (this.videoTex) oldGl.deleteTexture(this.videoTex);
        if (this.maskTex) oldGl.deleteTexture(this.maskTex);
        if (this.posBuf) oldGl.deleteBuffer(this.posBuf);
        if (this.program) oldGl.deleteProgram(this.program);
        const ext = oldGl.getExtension("WEBGL_lose_context");
        if (ext) ext.loseContext();
      }
      this.program = null;
      this.videoTex = null;
      this.maskTex = null;
      this.posBuf = null;
      if (oldCanvas && oldCanvas.parentElement) {
        oldCanvas.parentElement.removeChild(oldCanvas);
      }
    }

    computeContentRect(video) {
      const win = (video.ownerDocument && video.ownerDocument.defaultView) || window;
      const vRect = video.getBoundingClientRect();
      const vw = video.videoWidth || vRect.width;
      const vh = video.videoHeight || vRect.height;
      const cw = vRect.width;
      const ch = vRect.height;
      if (!vw || !vh || !cw || !ch) {
        return { x: 0, y: 0, width: cw, height: ch, uv: [1, 1, 0, 0] };
      }

      const fit = win.getComputedStyle(video).objectFit || "contain";
      const videoRatio = vw / vh;
      const boxRatio = cw / ch;

      if (fit === "fill") {
        return { x: 0, y: 0, width: cw, height: ch, uv: [1, 1, 0, 0] };
      }
      if (fit === "cover") {
        // Crop UV coordinates to match CSS object-fit: cover pixel-for-pixel
        let sx = 1;
        let sy = 1;
        let ox = 0;
        let oy = 0;
        if (videoRatio > boxRatio) {
          sx = boxRatio / videoRatio;
          ox = (1 - sx) * 0.5;
        } else if (videoRatio < boxRatio) {
          sy = videoRatio / boxRatio;
          oy = (1 - sy) * 0.5;
        }
        return { x: 0, y: 0, width: cw, height: ch, uv: [sx, sy, ox, oy] };
      }
      // Default contain: exclude letterbox/pillarbox bars
      let renderW = cw;
      let renderH = ch;
      let offsetX = 0;
      let offsetY = 0;
      if (videoRatio > boxRatio) {
        renderH = cw / videoRatio;
        offsetY = (ch - renderH) / 2;
      } else {
        renderW = ch * videoRatio;
        offsetX = (cw - renderW) / 2;
      }
      return { x: offsetX, y: offsetY, width: renderW, height: renderH, uv: [1, 1, 0, 0] };
    }

    syncCanvasGeometry() {
      if (!this.canvas || !this.video) return;
      const doc = this.video.ownerDocument || document;
      const win = doc.defaultView || window;
      const fsEl = doc.fullscreenElement || document.fullscreenElement;
      if (fsEl === this.video) {
        this.hideCanvas();
        this.renderMode = "native_fallback";
        return;
      }

      const parent = this.canvas.parentElement;
      if (!parent) return;
      // Keep canvas strictly above <video> even if player sets numeric z-index on <video>
      const vStyle = win.getComputedStyle(this.video);
      const vZ = parseInt(vStyle.zIndex, 10);
      const targetZ = Number.isFinite(vZ) ? Math.max(2, vZ + 1) : 2;
      this.canvas.style.setProperty("z-index", String(targetZ), "important");

      // Re-assert position:relative on parent if page framework wiped it
      if (win.getComputedStyle(parent).position === "static") {
        parent.style.position = "relative";
      }

      const offsetParent = this.canvas.offsetParent || this.findPositionedAncestor(parent, win);
      const opRect = offsetParent.getBoundingClientRect();
      const opStyle = win.getComputedStyle(offsetParent);
      const borderL = parseFloat(opStyle.borderLeftWidth) || 0;
      const borderT = parseFloat(opStyle.borderTopWidth) || 0;
      const vRect = this.video.getBoundingClientRect();
      const content = this.computeContentRect(this.video);
      this.uvTransform = content.uv || [1, 1, 0, 0];

      const left = vRect.left - opRect.left - borderL + content.x;
      const top = vRect.top - opRect.top - borderT + content.y;
      this.canvas.style.setProperty("left", `${left}px`, "important");
      this.canvas.style.setProperty("top", `${top}px`, "important");
      this.canvas.style.setProperty("width", `${content.width}px`, "important");
      this.canvas.style.setProperty("height", `${content.height}px`, "important");

      const dpr = Math.min(win.devicePixelRatio || 1, 1.5);
      const maxW = this.degradeTier === "L2" ? 1280 : 1920;
      const maxH = this.degradeTier === "L2" ? 720 : 1080;
      const targetW = Math.max(2, Math.min(Math.round(content.width * dpr), this.video.videoWidth || maxW, maxW));
      const targetH = Math.max(2, Math.min(Math.round(content.height * dpr), this.video.videoHeight || maxH, maxH));

      if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
        this.canvas.width = targetW;
        this.canvas.height = targetH;
        if (this.enabled && this.captureStatus === "ready" && this.video.paused) {
          this.renderSingleFrame(performance.now(), { skipInfer: true });
        }
      }
    }

    handleFullscreenChange() {
      if (!this.video) return;
      const doc = this.video.ownerDocument || document;
      const fsEl = doc.fullscreenElement || document.fullscreenElement;
      if (fsEl === this.video) {
        this.hideCanvas();
        this.stopFrameLoop();
        this.renderMode = "native_fallback";
      } else {
        if (this.enabled && this.captureStatus === "ready") {
          this.showCanvas();
          this.syncCanvasGeometry();
          this.renderSingleFrame(performance.now(), { skipInfer: true });
          if (!this.video.paused && !this.video.ended) this.startFrameLoop();
        } else {
          this.syncCanvasGeometry();
        }
      }
    }

    async ensureWorker() {
      if (this.worker || this.workerInitializing || this.workerUnavailable) return;
      this.workerInitializing = true;
      this.workerStatus = "初始化中";
      try {
        const workerUrl = chrome.runtime.getURL("worker/face-worker.js");
        const vendorBaseUrl = chrome.runtime.getURL("vendor/mediapipe/");
        const resp = await fetch(workerUrl);
        const code = await resp.text();
        if (!this.enabled || this.destroyed || this.worker) {
          this.workerInitializing = false;
          if (!this.enabled && !this.workerUnavailable) {
            this.workerStatus = "未启用";
          }
          return;
        }
        const blob = new Blob([code], { type: "application/javascript" });
        this.workerBlobUrl = URL.createObjectURL(blob);
        this.worker = new Worker(this.workerBlobUrl, { type: "module" });
        this.workerInitializing = false;

        this.worker.onmessage = (e) => {
          const msg = e.data;
          if (!msg) return;
          if (msg.type === "READY") {
            this.workerReady = true;
            this.workerStatus = `就绪 (${msg.delegate})`;
            if (this.enabled && this.captureStatus === "ready" && this.video && this.video.paused) {
              this.maybeDispatchInference(performance.now(), true);
            }
          } else if (msg.type === "UNAVAILABLE") {
            this.workerReady = false;
            this.workerUnavailable = true;
            this.workerStatus = msg.reason
              ? `不可用（使用肤色回退）: ${String(msg.reason).slice(0, 60)}`
              : "未放置本地模型（使用肤色回退）";
            this.terminateWorker(true);
          } else if (msg.type === "RESULT") {
            this.workerBusy = false;
            this.detectFrameCount++;
            if (msg.hasFace && msg.landmarks) {
              this.latestLandmarks = msg.landmarks;
              this.latestLandmarkTs = performance.now();
              this.validFaceStreak = Math.min(this.validFaceStreak + 1, 10);
              if (this.enabled && this.captureStatus === "ready" && this.video && this.video.paused) {
                this.validFaceStreak = Math.max(this.validFaceStreak, 2);
                this.fadeWeight = 1.0;
                this.renderSingleFrame(performance.now(), { skipInfer: true });
              }
            } else {
              this.validFaceStreak = 0;
            }
          } else if (msg.type === "ERROR" || msg.type === "NO_MODEL") {
            this.workerBusy = false;
          }
        };
        this.worker.onerror = () => {
          this.workerReady = false;
          this.workerUnavailable = true;
          this.workerStatus = "Worker 受 CSP 限制（使用肤色回退）";
          this.terminateWorker(true);
        };

        this.worker.postMessage({ type: "INIT", vendorBaseUrl, delegate: "CPU" });
      } catch (_) {
        this.workerInitializing = false;
        this.workerReady = false;
        this.workerUnavailable = true;
        this.workerStatus = "Worker 启动受限（使用肤色回退）";
      }
    }

    terminateWorker(preserveStatus = false, immediate = false) {
      this.workerInitializing = false;
      const oldWorker = this.worker;
      const oldBlobUrl = this.workerBlobUrl;
      this.worker = null;
      this.workerBlobUrl = null;
      this.workerReady = false;
      this.workerBusy = false;
      if (!preserveStatus) {
        this.workerStatus = "未启用";
      }
      if (!oldWorker) {
        if (oldBlobUrl) URL.revokeObjectURL(oldBlobUrl);
        return;
      }
      const finalize = () => {
        try {
          oldWorker.terminate();
        } catch (_) {}
        if (oldBlobUrl) {
          try {
            URL.revokeObjectURL(oldBlobUrl);
          } catch (_) {}
        }
      };
      if (immediate) {
        finalize();
        return;
      }
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        finalize();
      };
      const timer = setTimeout(cleanup, 600);
      oldWorker.onmessage = (e) => {
        if (e.data && e.data.type === "CLOSED") cleanup();
      };
      oldWorker.onerror = cleanup;
      try {
        oldWorker.postMessage({ type: "CLOSE" });
      } catch (_) {
        cleanup();
      }
    }

    maybeDispatchInference(nowMs, force = false) {
      if (!this.workerReady || !this.worker || this.workerBusy || !this.video) return;
      const minIntervalMs = this.degradeTier === "L0" ? 55 : 95; // ~18fps vs ~10fps
      if (!force && nowMs - this.lastInferSentMs < minIntervalMs) return;

      const maxEdge = this.degradeTier === "L0" ? 384 : 288;
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      if (!vw || !vh) return;
      const scale = Math.min(1, maxEdge / Math.max(vw, vh));
      const tw = Math.max(32, Math.round(vw * scale));
      const th = Math.max(32, Math.round(vh * scale));

      if (this.inferCanvas.width !== tw || this.inferCanvas.height !== th) {
        this.inferCanvas.width = tw;
        this.inferCanvas.height = th;
      }
      this.inferCtx.drawImage(this.video, 0, 0, tw, th);
      this.workerBusy = true;
      this.lastInferSentMs = nowMs;

      createImageBitmap(this.inferCanvas)
        .then((bitmap) => {
          if (!this.worker) {
            bitmap.close();
            this.workerBusy = false;
            return;
          }
          this.worker.postMessage(
            {
              type: "FRAME",
              bitmap,
              timestampMs: nowMs,
              mediaTime: this.video ? this.video.currentTime : 0,
            },
            [bitmap]
          );
        })
        .catch(() => {
          this.workerBusy = false;
        });
    }

    updateFaceMaskTexture(nowMs) {
      if (!this.workerReady || !this.latestLandmarks) return false;
      const isPaused = !!(this.video && this.video.paused);
      const ageMs = Math.max(0, nowMs - this.latestLandmarkTs);
      if (!isPaused && ageMs > 180) {
        this.fadeWeight = Math.max(0, this.fadeWeight - 0.25);
        return this.fadeWeight > 0.01;
      }

      // Smooth fade-in once face is stable for 2 frames
      if (this.validFaceStreak >= 2) {
        this.fadeWeight = Math.min(1.0, this.fadeWeight + 0.2);
      } else {
        this.fadeWeight = Math.max(0.0, this.fadeWeight - 0.2);
      }

      const ctx = this.maskCtx;
      const w = this.maskCanvas.width;
      const h = this.maskCanvas.height;
      ctx.clearRect(0, 0, w, h);

      // Velocity extrapolation capped at 120ms to compensate for detection latency (disabled while paused)
      const dtSec = isPaused ? 0 : Math.min(ageMs, 120) / 1000;
      const lm = this.latestLandmarks;
      const ptUv = (idx) => {
        const base = idx * 4;
        if (base + 3 >= lm.length) return [0.5, 0.5];
        const x = Math.min(1, Math.max(0, lm[base] + lm[base + 2] * dtSec));
        const y = Math.min(1, Math.max(0, lm[base + 1] + lm[base + 3] * dtSec));
        return [x, y];
      };
      const pt = (idx) => {
        const [x, y] = ptUv(idx);
        return [x * w, y * h];
      };
      const avgUv = (indices) => {
        let sx = 0;
        let sy = 0;
        for (const idx of indices) {
          const [x, y] = ptUv(idx);
          sx += x;
          sy += y;
        }
        return [sx / indices.length, sy / indices.length];
      };
      const aspect =
        this.canvas && this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 16 / 9;
      const distAspect = (a, b) => Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1]);

      // Compute semantic face anchors & yaw symmetry for reshape, contour, under-eye, nasolabial & mouth effects
      const lEye = avgUv([33, 133, 159, 145]);
      const rEye = avgUv([263, 362, 386, 374]);
      const lEyeOuter = ptUv(33);
      const rEyeOuter = ptUv(263);
      const lEyeR = Math.max(0.015, distAspect(lEyeOuter, ptUv(133)) * 1.15);
      const rEyeR = Math.max(0.015, distAspect(rEyeOuter, ptUv(362)) * 1.15);
      const leftEar = ptUv(234);
      const rightEar = ptUv(454);
      const forehead = ptUv(10);
      const chin = ptUv(152);
      const bridgeTop = ptUv(168);
      const noseTip = ptUv(1);
      const mouthCenter = avgUv([13, 14, 61, 291]);
      const leftMouth = ptUv(61);
      const rightMouth = ptUv(291);
      const faceWidth = Math.max(0.04, distAspect(leftEar, rightEar));
      const faceHeight = Math.max(0.05, distAspect(forehead, chin));
      const leftCheek = ptUv(132);
      const leftJaw = ptUv(172);
      const rightCheek = ptUv(361);
      const rightJaw = ptUv(397);
      const leftWing = ptUv(129);
      const rightWing = ptUv(358);

      const dLeft = distAspect(noseTip, leftEar);
      const dRight = distAspect(noseTip, rightEar);
      const sym = Math.min(dLeft, dRight) / Math.max(dLeft, dRight, 1e-4);
      const yawFactor = Math.max(0, Math.min(1, (sym - 0.25) / 0.35));

      this.faceAnchors = {
        eyes: [lEye[0], lEye[1], rEye[0], rEye[1]],
        eyeOuter: [lEyeOuter[0], lEyeOuter[1], rEyeOuter[0], rEyeOuter[1]],
        eyeRadii: [lEyeR, rEyeR, faceWidth, faceHeight],
        noseBridge: [bridgeTop[0], bridgeTop[1], noseTip[0], noseTip[1]],
        chinMouth: [chin[0], chin[1], mouthCenter[0], mouthCenter[1]],
        mouthCorners: [leftMouth[0], leftMouth[1], rightMouth[0], rightMouth[1]],
        leftContour: [leftCheek[0], leftCheek[1], leftJaw[0], leftJaw[1]],
        rightContour: [rightCheek[0], rightCheek[1], rightJaw[0], rightJaw[1]],
        noseWings: [leftWing[0], leftWing[1], rightWing[0], rightWing[1]],
        yawFactor,
      };

      const trace = (indices) => {
        ctx.beginPath();
        indices.forEach((idx, i) => {
          const [x, y] = pt(idx);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
      };

      // Pack 3 independent semantic channels into a single RGBA mask texture:
      // R = face skin oval (with eyes/brows/lips punched out)
      // G = eyes (brightEye)
      // B = lips (lipTint)
      ctx.save();
      ctx.filter = "blur(6px)";
      ctx.fillStyle = "#ff0000";
      trace(FACE_OVAL_IDX);
      ctx.fill();

      // Punch out eyes, brows, and lips from R channel so details stay crisp
      ctx.globalCompositeOperation = "destination-out";
      ctx.filter = "blur(3px)";
      ctx.fillStyle = "#000000";
      [LEFT_EYE_IDX, RIGHT_EYE_IDX, LEFT_BROW_IDX, RIGHT_BROW_IDX, LIPS_IDX].forEach((poly) => {
        trace(poly);
        ctx.fill();
      });

      // Fill opaque black behind R channel so additive G/B draws never leak alpha
      ctx.globalCompositeOperation = "destination-over";
      ctx.filter = "none";
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);

      // Additive G channel for eyes & B channel for lips (crisp 1px feathering on 384x384)
      ctx.globalCompositeOperation = "lighter";
      ctx.filter = "blur(1px)";
      ctx.fillStyle = "#00ff00";
      [LEFT_EYE_IDX, RIGHT_EYE_IDX].forEach((poly) => {
        trace(poly);
        ctx.fill();
      });
      ctx.fillStyle = "#0000ff";
      trace(LIPS_IDX);
      ctx.fill();
      ctx.restore();

      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.maskCanvas);
      return true;
    }

    renderSingleFrame(nowMs = performance.now(), opts = {}) {
      if (!this.enabled || !this.video || !this.gl || this.contextLost || this.captureStatus !== "ready") return;
      const doc = this.video.ownerDocument || document;
      const fsEl = doc.fullscreenElement || document.fullscreenElement;
      if (fsEl === this.video) return;

      // Detect sudden jump / seek
      const mt = this.video.currentTime;
      if (this.lastMediaTime >= 0 && Math.abs(mt - this.lastMediaTime) > 0.6) {
        this.resetTrackingAndFade();
      }
      this.lastMediaTime = mt;

      const t0 = performance.now();
      const gl = this.gl;

      if (!opts.skipInfer) {
        this.maybeDispatchInference(nowMs, false);
      }
      const hasFaceMask = this.updateFaceMaskTexture(nowMs);
      if (!this.workerReady) {
        this.fadeWeight = 1.0;
      }

      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this.program);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
      } catch (err) {
        this.captureStatus = "cors_restricted";
        this.stopBeautyOverlay("运行时取帧受限，已恢复原画。");
        return;
      }
      this.lastCapturedMediaTime = mt;

      const p = this.params;
      const aspect = this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 16 / 9;
      const a = this.faceAnchors;
      const uvT = this.uvTransform || [1, 1, 0, 0];
      const shadeIdx = Math.max(0, Math.min(LIP_SHADE_RGB.length - 1, Math.round(p.lipShade ?? 2)));
      const lipRgb = LIP_SHADE_RGB[shadeIdx];

      gl.uniform4f(this.uniforms.u_uvTransform, uvT[0], uvT[1], uvT[2], uvT[3]);
      gl.uniform2f(this.uniforms.u_texel, 1.0 / this.canvas.width, 1.0 / this.canvas.height);
      gl.uniform1f(this.uniforms.u_hasFaceMask, hasFaceMask ? 1.0 : 0.0);
      gl.uniform1f(this.uniforms.u_compareOriginal, this.compareOriginal ? 1.0 : 0.0);

      gl.uniform4f(this.uniforms.u_skinA, p.smooth, p.skinTexture, p.whiten, p.rosy);
      gl.uniform4f(
        this.uniforms.u_skinB,
        p.underEye,
        p.nasolabial,
        p.matte,
        hasFaceMask && a ? a.yawFactor : 0.0
      );
      gl.uniform4f(this.uniforms.u_reshapeA, p.slimFace, p.slimCheekbone, p.vChin, p.bigEyes);
      gl.uniform4f(this.uniforms.u_reshapeB, p.eyeTilt, p.slimNose, p.mouthSize, p.mouthSmile);
      gl.uniform4f(this.uniforms.u_makeupA, p.brightEye, p.contour, p.lipTint, p.whitenTeeth);
      gl.uniform4f(this.uniforms.u_lipColor, lipRgb[0], lipRgb[1], lipRgb[2], aspect);
      gl.uniform4f(this.uniforms.u_colorA, p.sharpen, p.exposure, p.contrast, p.saturation);
      gl.uniform4f(
        this.uniforms.u_colorB,
        p.temperature,
        p.softGlow,
        this.fadeWeight,
        this.degradeTier === "L2" ? 1.0 : 0.0
      );

      if (hasFaceMask && a) {
        gl.uniform4f(this.uniforms.u_eyes, a.eyes[0], a.eyes[1], a.eyes[2], a.eyes[3]);
        gl.uniform4f(this.uniforms.u_eyeOuter, a.eyeOuter[0], a.eyeOuter[1], a.eyeOuter[2], a.eyeOuter[3]);
        gl.uniform4f(this.uniforms.u_eyeRadii, a.eyeRadii[0], a.eyeRadii[1], a.eyeRadii[2], a.eyeRadii[3]);
        gl.uniform4f(this.uniforms.u_noseBridge, a.noseBridge[0], a.noseBridge[1], a.noseBridge[2], a.noseBridge[3]);
        gl.uniform4f(this.uniforms.u_chinMouth, a.chinMouth[0], a.chinMouth[1], a.chinMouth[2], a.chinMouth[3]);
        gl.uniform4f(
          this.uniforms.u_mouthCorners,
          a.mouthCorners[0],
          a.mouthCorners[1],
          a.mouthCorners[2],
          a.mouthCorners[3]
        );
        gl.uniform4f(
          this.uniforms.u_leftContour,
          a.leftContour[0],
          a.leftContour[1],
          a.leftContour[2],
          a.leftContour[3]
        );
        gl.uniform4f(
          this.uniforms.u_rightContour,
          a.rightContour[0],
          a.rightContour[1],
          a.rightContour[2],
          a.rightContour[3]
        );
        gl.uniform4f(this.uniforms.u_noseWings, a.noseWings[0], a.noseWings[1], a.noseWings[2], a.noseWings[3]);
      }

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      this.renderMode = hasFaceMask ? "face_mask" : "skin_fallback";
      this.recordPerformance(performance.now() - t0, nowMs);
    }

    getDroppedFrames(v) {
      if (v && typeof v.getVideoPlaybackQuality === "function") {
        return v.getVideoPlaybackQuality().droppedVideoFrames || 0;
      }
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

        // Stepwise degradation L0 -> L1 -> L2 -> L3
        if (this.renderP95Ms > 18) {
          this.overBudgetStreak++;
          if (this.overBudgetStreak >= 3) {
            if (this.degradeTier === "L0") this.degradeTier = "L1";
            else if (this.degradeTier === "L1") {
              this.degradeTier = "L2";
              this.syncCanvasGeometry();
            } else if (this.degradeTier === "L2") {
              this.degradeTier = "L3";
              this.stopBeautyOverlay("当前设备性能吃紧，已自动切回原画。");
            }
            this.overBudgetStreak = 0;
          }
        } else {
          this.overBudgetStreak = 0;
        }
      }
    }

    startFrameLoop() {
      this.stopFrameLoop();
      if (!this.video || !this.enabled || this.captureStatus !== "ready") return;

      if (typeof this.video.requestVideoFrameCallback === "function") {
        const onFrame = (now) => {
          this.rvfcHandle = null;
          if (!this.enabled || !this.video || this.video.paused || this.video.ended) return;
          this.renderSingleFrame(now);
          this.rvfcHandle = this.video.requestVideoFrameCallback(onFrame);
        };
        this.rvfcHandle = this.video.requestVideoFrameCallback(onFrame);
      } else {
        const tick = (now) => {
          this.rafHandle = null;
          if (!this.enabled || !this.video || this.video.paused || this.video.ended) return;
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
      if (this.rafHandle !== null) {
        cancelAnimationFrame(this.rafHandle);
        this.rafHandle = null;
      }
    }

    showCanvas() {
      if (this.canvas) this.canvas.style.setProperty("display", "block", "important");
    }

    hideCanvas() {
      if (this.canvas) this.canvas.style.setProperty("display", "none", "important");
    }

    stopBeautyOverlay(errorMessage) {
      this.stopFrameLoop();
      this.hideCanvas();
      this.renderMode = this.enabled && errorMessage ? "native_fallback" : "off";
      if (errorMessage) this.lastError = errorMessage;
    }

    setEnabled(enabled) {
      this.enabled = !!enabled;
      this.degradeTier = "L0";
      this.overBudgetStreak = 0;
      if (!this.enabled) {
        this.stopBeautyOverlay("");
        this.terminateWorker(false);
        return;
      }
      this.workerUnavailable = false;
      if (!this.video) this.scanVideos();
      if (this.video) {
        this.probeAttempts = 0;
        this.runProtectionAndProbe();
      }
    }

    setBeautyParams(partial) {
      this.params = normalizeBeautyParams(partial, this.params);
      this.strength = this.params.smooth;
      if (this.enabled && this.captureStatus === "ready") {
        this.renderSingleFrame(performance.now(), { skipInfer: true });
      }
    }

    setStrength(val) {
      const s = Math.max(0, Math.min(1, Number(val) || 0));
      this.strength = s;
      this.params.smooth = s;
      this.params.whiten = Math.min(1, s * 0.7);
      if (this.enabled && this.captureStatus === "ready") {
        this.renderSingleFrame(performance.now(), { skipInfer: true });
      }
    }

    setCompareOriginal(flag) {
      this.compareOriginal = !!flag;
      if (this.enabled && this.captureStatus === "ready") {
        this.renderSingleFrame(performance.now(), { skipInfer: true });
      }
    }

    teardownAll() {
      this.destroyed = true;
      this.setEnabled(false);
      this.unbindCurrentVideo();
      this.terminateWorker(false, true);
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
        else if (src.startsWith("file:")) scheme = "file:";
        else if (!src && v.srcObject) scheme = "媒体流";
        else if (src) scheme = "other";

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
      const fsEl = doc.fullscreenElement || document.fullscreenElement;
      if (fsEl) {
        fullscreenState =
          fsEl === this.video ? "原生 <video> 全屏（已回退）" : "容器全屏（支持叠层）";
      }

      let overlayInfo = "未挂载";
      if (this.canvas && this.video) {
        const win = (this.video.ownerDocument && this.video.ownerDocument.defaultView) || window;
        const cRect = this.canvas.getBoundingClientRect();
        const cStyle = win.getComputedStyle(this.canvas);
        const vStyle = win.getComputedStyle(this.video);
        const mountTag = (this.canvas.parentElement && this.canvas.parentElement.tagName.toLowerCase()) || "?";
        const vis = cStyle.display !== "none" && cRect.width > 1 && cRect.height > 1 ? "可见" : "隐藏";
        overlayInfo = `${vis} ${Math.round(cRect.width)}×${Math.round(cRect.height)} z=${cStyle.zIndex}/v=${vStyle.zIndex} (${mountTag})`;
      }

      return {
        enabled: this.enabled,
        strength: this.strength,
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

  const engine = new WebVideoBeautyEngine();
  window.__WVB_ENGINE__ = engine;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "WVB_PING":
        sendResponse({ ok: true });
        break;
      case "WVB_INIT":
        if (msg.params && typeof msg.params === "object") {
          engine.setBeautyParams(msg.params);
        } else if (typeof msg.strength === "number") {
          engine.setStrength(msg.strength);
        }
        engine.scanVideos();
        if (engine.video && engine.captureStatus === "waiting") {
          engine.runProtectionAndProbe();
        }
        sendResponse({ state: engine.getStateSnapshot() });
        break;
      case "WVB_GET_STATE":
        sendResponse({ state: engine.getStateSnapshot() });
        break;
      case "WVB_SET_ENABLED":
        engine.setEnabled(msg.enabled);
        sendResponse({ state: engine.getStateSnapshot() });
        break;
      case "WVB_SET_PARAMS":
        engine.setBeautyParams(msg.params);
        sendResponse({ state: engine.getStateSnapshot() });
        break;
      case "WVB_SET_STRENGTH":
        engine.setStrength(msg.strength);
        sendResponse({ state: engine.getStateSnapshot() });
        break;
      case "WVB_SET_COMPARE":
        engine.setCompareOriginal(msg.compareOriginal);
        sendResponse({ state: engine.getStateSnapshot() });
        break;
      case "WVB_SELECT_VIDEO":
        engine.selectVideoByUser(msg.videoId);
        sendResponse({ state: engine.getStateSnapshot() });
        break;
      case "WVB_RETRY_PROBE":
        engine.probeAttempts = 0;
        engine.workerUnavailable = false;
        engine.runProtectionAndProbe();
        sendResponse({ state: engine.getStateSnapshot() });
        break;
      case "WVB_RESCAN":
        engine.scanVideos();
        sendResponse({ state: engine.getStateSnapshot() });
        break;
      default:
        break;
    }
    return true;
  });
})();
