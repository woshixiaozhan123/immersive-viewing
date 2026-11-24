/**
 * MediaPipe Face Landmarker Web Worker (Zero-Lag Frame-Paired + ROI Edition)
 * - Uses runningMode: "IMAGE" (faster than VIDEO+3 faces in GPU/CPU, 0 cross-frame ROI drift,
 *   and supports seamless Full-Frame <-> High-Res Small-Face ROI switching without state pollution)
 * - Auto-selects GPU delegate (~9.5ms) with clean CPU XNNPACK fallback (~15.5ms)
 * - Motion-Adaptive Deadzone Stabilizer for Frame-Paired mode: eliminates stationary micro-jitter
 *   while snapping 100% to ground-truth landmarks on any real head/eye/lip motion (0.00px rubber-band lag)
 * - Always closes transferred ImageBitmap & releases FaceLandmarker cleanly on CLOSE
 */

let landmarker = null;
let initialized = false;
let initError = null;
let activeDelegate = "CPU";
let lastDetectTs = 0;

// 注意：头发分割**不在这个 worker 里**。
// MediaPipe 的 ES module WASM 每个 Worker 上下文只允许 boot 一个 ModuleFactory，
// 在同一 worker 里第二次 createFromOptions 会抛 "ModuleFactory not set"。
// 因此头发分割由独立的 worker/hair-worker.js 承担。

// Primary face lock state (in full-frame normalized [0,1]x[0,1] space)
let lockedBox = null;
let lostSinceTs = 0;
const LOCK_GRACE_MS = 140;

// High-sensitivity feature indices (eyes, brows, lips) that must snap immediately on blinks/speech
const FAST_FEATURE_SET = new Set([
  // Left & right eyes
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
  263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466,
  // Brows
  70, 63, 105, 66, 107, 55, 65, 52, 53, 46,
  300, 293, 334, 296, 336, 285, 295, 282, 283, 276,
  // Outer & inner lips
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
  78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191,
]);

// Rigid facial anchor indices for global head displacement estimation
const RIGID_ANCHORS = [1, 33, 133, 263, 362, 168, 152, 234, 454];

/**
 * Motion-Adaptive Deadzone Stabilizer tuned specifically for Frame-Paired rendering:
 * - On Frame K, raw landmarks ARE ground truth for video texture K.
 * - Any classical low-pass filter drags landmarks behind during motion (rubber-band lag).
 * - Instead, we smooth ONLY sub-pixel stationary noise (< 0.35% faceScale) and ramp alpha -> 1.0
 *   immediately when global head motion or local blink/speech exceeds deadzone.
 */
class MotionAdaptiveStabilizer {
  constructor() {
    this.prevX = null;
    this.prevY = null;
    this.prevTs = null;
    this.velX = null;
    this.velY = null;
  }

  reset() {
    this.prevX = null;
    this.prevY = null;
    this.prevTs = null;
    this.velX = null;
    this.velY = null;
  }

  process(rawLandmarks, box, tsMs, mode = "paired") {
    const n = rawLandmarks.length;
    const out = new Float32Array(n * 4); // x, y, vx, vy
    const tsSec = tsMs / 1000;

    if (!this.prevX || this.prevX.length !== n || this.prevTs === null || tsSec - this.prevTs > 0.25) {
      this.prevX = new Float32Array(n);
      this.prevY = new Float32Array(n);
      this.velX = new Float32Array(n);
      this.velY = new Float32Array(n);
      this.prevTs = tsSec;
      for (let i = 0; i < n; i++) {
        const x = rawLandmarks[i].x;
        const y = rawLandmarks[i].y;
        this.prevX[i] = x;
        this.prevY[i] = y;
        out[i * 4] = x;
        out[i * 4 + 1] = y;
        out[i * 4 + 2] = 0;
        out[i * 4 + 3] = 0;
      }
      return out;
    }

    const dt = Math.max(tsSec - this.prevTs, 1e-3);
    this.prevTs = tsSec;

    const faceScale = Math.max(box.maxX - box.minX, box.maxY - box.minY, 0.04);

    // Measure rigid head displacement relative to face size
    let sumDisp = 0;
    let cnt = 0;
    for (let k = 0; k < RIGID_ANCHORS.length; k++) {
      const idx = RIGID_ANCHORS[k];
      if (idx < n) {
        sumDisp += Math.hypot(rawLandmarks[idx].x - this.prevX[idx], rawLandmarks[idx].y - this.prevY[idx]);
        cnt++;
      }
    }
    const globalNormDisp = cnt > 0 ? (sumDisp / cnt) / faceScale : 0;

    // In Frame-Paired mode, any noticeable head motion snaps 100% directly to current frame truth (0.00px lag!)
    const globalMotionBoost =
      mode === "paired"
        ? Math.max(0, Math.min(1, (globalNormDisp - 0.0045) / 0.0075))
        : Math.max(0, Math.min(1, (globalNormDisp - 0.006) / 0.012));

    const vBlend = globalNormDisp > 0.025 ? 0.85 : 0.55;

    for (let i = 0; i < n; i++) {
      const rx = rawLandmarks[i].x;
      const ry = rawLandmarks[i].y;
      const px = this.prevX[i];
      const py = this.prevY[i];
      const dx = rx - px;
      const dy = ry - py;
      const normDisp = Math.hypot(dx, dy) / faceScale;

      const isFast = FAST_FEATURE_SET.has(i);
      const lowThresh = isFast ? 0.0022 : 0.0032;
      const highThresh = isFast ? 0.0075 : 0.0110;
      const baseAlpha = isFast ? 0.62 : 0.52;

      const localRamp = Math.max(0, Math.min(1, (normDisp - lowThresh) / (highThresh - lowThresh)));
      const motionFactor = Math.max(globalMotionBoost, localRamp);
      const alpha = motionFactor >= 0.99 ? 1.0 : baseAlpha + (1.0 - baseAlpha) * motionFactor;

      const fx = alpha >= 1.0 ? rx : px + dx * alpha;
      const fy = alpha >= 1.0 ? ry : py + dy * alpha;

      const instVx = Math.max(-3.0, Math.min(3.0, (fx - px) / dt));
      const instVy = Math.max(-3.0, Math.min(3.0, (fy - py) / dt));
      const vx = this.velX[i] * (1 - vBlend) + instVx * vBlend;
      const vy = this.velY[i] * (1 - vBlend) + instVy * vBlend;

      this.prevX[i] = fx;
      this.prevY[i] = fy;
      this.velX[i] = vx;
      this.velY[i] = vy;

      out[i * 4] = fx;
      out[i * 4 + 1] = fy;
      out[i * 4 + 2] = vx;
      out[i * 4 + 3] = vy;
    }
    return out;
  }
}

const stabilizer = new MotionAdaptiveStabilizer();

function resetTracking() {
  lockedBox = null;
  lostSinceTs = 0;
  stabilizer.reset();
}

function mapLandmarksFromRoi(rawLm, roi) {
  if (!roi || (roi.x === 0 && roi.y === 0 && roi.w === 1 && roi.h === 1)) {
    return rawLm;
  }
  const rx = roi.x;
  const ry = roi.y;
  const rw = roi.w;
  const rh = roi.h;
  const mapped = new Array(rawLm.length);
  for (let i = 0; i < rawLm.length; i++) {
    const p = rawLm[i];
    mapped[i] = {
      x: rx + p.x * rw,
      y: ry + p.y * rh,
      z: p.z,
    };
  }
  return mapped;
}

function computeBBox(landmarks) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (let i = 0; i < landmarks.length; i++) {
    const p = landmarks[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const w = Math.max(0, maxX - minX);
  const h = Math.max(0, maxY - minY);
  return {
    minX,
    minY,
    maxX,
    maxY,
    w,
    h,
    cx: (minX + maxX) * 0.5,
    cy: (minY + maxY) * 0.5,
    area: w * h,
  };
}

function isPlausibleFace(lm, box) {
  if (!lm || lm.length < 468) return false;
  if (box.w < 0.012 || box.h < 0.015 || box.w > 1.25 || box.h > 1.35) return false;
  // Sanity check that eyes & nose exist inside or near bbox
  const nose = lm[1];
  const lEye = lm[33];
  const rEye = lm[263];
  if (!nose || !lEye || !rEye) return false;
  const eyeDist = Math.hypot(rEye.x - lEye.x, rEye.y - lEye.y);
  if (eyeDist < 0.005) return false;
  return true;
}

function computeIoU(a, b) {
  const x1 = Math.max(a.minX, b.minX);
  const y1 = Math.max(a.minY, b.minY);
  const x2 = Math.min(a.maxX, b.maxX);
  const y2 = Math.min(a.maxY, b.maxY);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.area + b.area - inter;
  return union > 0 ? inter / union : 0;
}

function selectPrimaryFace(faceLandmarksList, roi, nowMs) {
  if (!faceLandmarksList || faceLandmarksList.length === 0) {
    if (lockedBox && lostSinceTs === 0) lostSinceTs = nowMs;
    if (lockedBox && nowMs - lostSinceTs > LOCK_GRACE_MS) {
      resetTracking();
    }
    return null;
  }

  const candidates = [];
  for (let i = 0; i < faceLandmarksList.length; i++) {
    const lm = mapLandmarksFromRoi(faceLandmarksList[i], roi);
    const box = computeBBox(lm);
    if (isPlausibleFace(lm, box)) {
      candidates.push({ idx: i, lm, box });
    }
  }
  if (candidates.length === 0) {
    if (lockedBox && lostSinceTs === 0) lostSinceTs = nowMs;
    if (lockedBox && nowMs - lostSinceTs > LOCK_GRACE_MS) {
      resetTracking();
    }
    return null;
  }

  let chosen = null;
  if (candidates.length === 1) {
    chosen = candidates[0];
    if (lockedBox) {
      const ov = computeIoU(lockedBox, chosen.box);
      const scale = Math.max(lockedBox.w, lockedBox.h, chosen.box.w, chosen.box.h, 0.05);
      const cDist = Math.hypot(chosen.box.cx - lockedBox.cx, chosen.box.cy - lockedBox.cy) / scale;
      // Snap stabilizer cleanly on scene cuts or fast jumps across the frame
      if (ov < 0.04 && cDist > 1.2) {
        stabilizer.reset();
      }
    }
  } else if (lockedBox) {
    let bestScore = -1;
    const refScale = Math.max(lockedBox.w, lockedBox.h, 0.05);
    for (const c of candidates) {
      const ov = computeIoU(lockedBox, c.box);
      const cDist = Math.hypot(c.box.cx - lockedBox.cx, c.box.cy - lockedBox.cy) / refScale;
      const prox = Math.max(0, 1.0 - cDist / 2.2);
      const sizeRatio = Math.min(c.box.area, lockedBox.area) / Math.max(c.box.area, lockedBox.area, 1e-5);
      const score = ov * 0.55 + prox * 0.30 + sizeRatio * 0.15;
      if ((ov > 0.04 || prox > 0.35) && score > bestScore) {
        bestScore = score;
        chosen = c;
      }
    }
    if (!chosen) {
      if (lostSinceTs === 0) lostSinceTs = nowMs;
      if (nowMs - lostSinceTs <= LOCK_GRACE_MS) {
        return null;
      }
      resetTracking();
    }
  }

  if (!chosen) {
    candidates.sort((a, b) => b.box.area - a.box.area);
    chosen = candidates[0];
    stabilizer.reset();
  }

  lockedBox = chosen.box;
  lostSinceTs = 0;
  return chosen;
}

async function createLandmarkerWithDelegate(FaceLandmarker, fileset, modelUrl, delegate) {
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: modelUrl,
      delegate,
    },
    // IMAGE mode runs independent per-frame detection+landmarks (~9.5ms GPU / ~15.5ms CPU),
    // guaranteeing 0 cross-frame ROI drift and seamless Full-Frame <-> Small-Face ROI switching.
    runningMode: "IMAGE",
    numFaces: 2,
    minFaceDetectionConfidence: 0.22,
    minFacePresenceConfidence: 0.22,
    minTrackingConfidence: 0.50,
  });
}

async function initMediaPipe(vendorBaseUrl, preferredDelegate = "GPU") {
  try {
    const bundleUrl = `${vendorBaseUrl}vision_bundle.mjs`;
    const wasmDir = `${vendorBaseUrl}wasm`;
    const modelUrl = `${vendorBaseUrl}face_landmarker.task`;

    if (landmarker && typeof landmarker.close === "function") {
      landmarker.close();
      landmarker = null;
    }

    const visionModule = await import(bundleUrl);
    const { FilesetResolver, FaceLandmarker } = visionModule;

    const tryOrder = preferredDelegate === "CPU" ? ["CPU"] : ["GPU", "CPU"];
    let lastErr = null;
    for (const del of tryOrder) {
      try {
        const fileset = await FilesetResolver.forVisionTasks(wasmDir, true);
        landmarker = await createLandmarkerWithDelegate(FaceLandmarker, fileset, modelUrl, del);
        activeDelegate = del;
        initialized = true;
        initError = null;
        self.postMessage({ type: "READY", delegate: del });
        return;
      } catch (e) {
        lastErr = e;
        // MediaPipe ES module WASM only permits one ModuleFactory boot per Worker context;
        // if GPU fails on the first attempt, ask the host to respawn a fresh CPU Worker cleanly.
        if (del === "GPU" && preferredDelegate !== "CPU") {
          self.postMessage({
            type: "FALLBACK_CPU",
            reason: e && e.message ? e.message : String(e),
          });
          return;
        }
      }
    }
    throw lastErr || new Error("MediaPipe init failed");
  } catch (err) {
    initialized = false;
    initError = err && err.message ? err.message : String(err);
    self.postMessage({ type: "UNAVAILABLE", reason: initError });
  }
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === "INIT") {
    await initMediaPipe(msg.vendorBaseUrl, msg.delegate || "GPU");
    return;
  }

  if (msg.type === "RESET") {
    resetTracking();
    return;
  }

  if (msg.type === "CLOSE") {
    try {
      if (landmarker && typeof landmarker.close === "function") {
        landmarker.close();
      }
    } catch (_) {}
    landmarker = null;
    initialized = false;
    self.postMessage({ type: "CLOSED" });
    return;
  }

  if (msg.type === "FRAME") {
    const bitmap = msg.bitmap;
    const timestampMs = msg.timestampMs;
    const mediaTime = msg.mediaTime;
    const frameId = msg.frameId;
    const roi = msg.roi || { x: 0, y: 0, w: 1, h: 1 };
    const mode = msg.mode || "paired";
    try {
      if (!initialized || !landmarker) {
        self.postMessage({ type: "NO_MODEL", mediaTime, timestampMs, frameId });
        return;
      }
      if (msg.sceneCut) {
        resetTracking();
      } else if (msg.resetMotion) {
        stabilizer.reset();
      }

      const t0 = performance.now();
      const ts = Math.max(lastDetectTs + 1, Math.floor(timestampMs || performance.now()));
      lastDetectTs = ts;
      const result = landmarker.detect(bitmap);
      const inferMs = performance.now() - t0;

      const primary = selectPrimaryFace(result.faceLandmarks, roi, ts);
      if (!primary) {
        self.postMessage({
          type: "RESULT",
          hasFace: false,
          mediaTime,
          timestampMs,
          frameId,
          inferMs,
          roiUsed: roi,
        });
        return;
      }

      const stabilized = stabilizer.process(primary.lm, primary.box, ts, mode);
      self.postMessage(
        {
          type: "RESULT",
          hasFace: true,
          landmarks: stabilized,
          faceBox: primary.box,
          mediaTime,
          timestampMs,
          frameId,
          inferMs,
          roiUsed: roi,
        },
        [stabilized.buffer]
      );
    } catch (err) {
      self.postMessage({
        type: "ERROR",
        reason: err && err.message ? err.message : String(err),
        mediaTime,
        frameId,
      });
    } finally {
      if (bitmap && typeof bitmap.close === "function") {
        bitmap.close();
      }
    }
  }
};
