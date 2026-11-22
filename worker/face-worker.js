/**
 * MediaPipe Face Landmarker Web Worker
 * - Runs off the main thread on downscaled ImageBitmaps
 * - Defaults to CPU (XNNPACK / WASM SIMD) delegate to keep GPU free for WebGL rendering
 * - Single-slot drop-old queue: caller only sends when idle; always closes ImageBitmap
 * - Includes primary face locking (IoU + area), One-Euro smoothing, and velocity extrapolation (<=120ms)
 */

let landmarker = null;
let initialized = false;
let initError = null;
let lastDetectTs = 0;

// Primary face lock state
let lockedBox = null;
let lostSinceTs = 0;
const LOCK_GRACE_MS = 220;

// One-Euro filter state per landmark coordinate
class LowPassFilter {
  constructor(alpha) {
    this.y = null;
    this.s = null;
    this.alpha = alpha;
  }
  filter(value, alpha) {
    if (alpha !== undefined) this.alpha = alpha;
    if (this.y === null) {
      this.s = value;
    } else {
      this.s = this.alpha * value + (1 - this.alpha) * this.s;
    }
    this.y = value;
    return this.s;
  }
  reset() {
    this.y = null;
    this.s = null;
  }
}

class OneEuroFilter {
  constructor(minCutoff = 1.4, beta = 0.08, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilter = new LowPassFilter(1.0);
    this.dxFilter = new LowPassFilter(1.0);
    this.lastTime = null;
    this.lastVelocity = 0;
  }
  alpha(cutoff, dt) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / Math.max(dt, 1e-4));
  }
  filter(x, tsSec) {
    if (this.lastTime === null) {
      this.lastTime = tsSec;
      this.lastVelocity = 0;
      return this.xFilter.filter(x, 1.0);
    }
    const dt = Math.max(tsSec - this.lastTime, 1e-3);
    this.lastTime = tsSec;
    const dx = this.xFilter.y !== null ? (x - this.xFilter.y) / dt : 0;
    const edx = this.dxFilter.filter(dx, this.alpha(this.dCutoff, dt));
    this.lastVelocity = edx;
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xFilter.filter(x, this.alpha(cutoff, dt));
  }
  reset() {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTime = null;
    this.lastVelocity = 0;
  }
}

let landmarkFilters = null;

function resetTracking() {
  lockedBox = null;
  lostSinceTs = 0;
  if (landmarkFilters) {
    for (const pair of landmarkFilters) {
      pair.x.reset();
      pair.y.reset();
    }
  }
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
  return { minX, minY, maxX, maxY, area: Math.max(0, (maxX - minX) * (maxY - minY)) };
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

function selectPrimaryFace(faceLandmarksList, nowMs) {
  if (!faceLandmarksList || faceLandmarksList.length === 0) {
    if (lockedBox && lostSinceTs === 0) lostSinceTs = nowMs;
    if (lockedBox && nowMs - lostSinceTs > LOCK_GRACE_MS) {
      resetTracking();
    }
    return null;
  }

  const candidates = faceLandmarksList.map((lm, idx) => ({
    idx,
    lm,
    box: computeBBox(lm),
  }));

  let chosen = null;
  if (lockedBox) {
    let bestScore = -1;
    for (const c of candidates) {
      const iou = computeIoU(lockedBox, c.box);
      const score = iou * 0.75 + Math.min(c.box.area * 2.5, 0.25);
      if (iou > 0.15 && score > bestScore) {
        bestScore = score;
        chosen = c;
      }
    }
    if (!chosen) {
      if (lostSinceTs === 0) lostSinceTs = nowMs;
      if (nowMs - lostSinceTs <= LOCK_GRACE_MS) {
        return null; // Wait for grace period before jumping to another face
      }
      resetTracking();
    }
  }

  if (!chosen) {
    candidates.sort((a, b) => b.box.area - a.box.area);
    chosen = candidates[0];
  }

  lockedBox = chosen.box;
  lostSinceTs = 0;
  return chosen.lm;
}

function smoothLandmarks(rawLandmarks, tsMs) {
  const tsSec = tsMs / 1000;
  if (!landmarkFilters || landmarkFilters.length !== rawLandmarks.length) {
    landmarkFilters = rawLandmarks.map(() => ({
      x: new OneEuroFilter(1.4, 0.08, 1.0),
      y: new OneEuroFilter(1.4, 0.08, 1.0),
    }));
  }
  const out = new Float32Array(rawLandmarks.length * 4); // x, y, vx, vy
  for (let i = 0; i < rawLandmarks.length; i++) {
    const fx = landmarkFilters[i].x.filter(rawLandmarks[i].x, tsSec);
    const fy = landmarkFilters[i].y.filter(rawLandmarks[i].y, tsSec);
    out[i * 4] = fx;
    out[i * 4 + 1] = fy;
    out[i * 4 + 2] = landmarkFilters[i].x.lastVelocity;
    out[i * 4 + 3] = landmarkFilters[i].y.lastVelocity;
  }
  return out;
}

async function initMediaPipe(vendorBaseUrl, delegate = "CPU") {
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
    // Pass isModule=true because this worker runs as an ES module and loads vision_wasm_module_internal.js
    const fileset = await FilesetResolver.forVisionTasks(wasmDir, true);
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: modelUrl,
        delegate,
      },
      runningMode: "VIDEO",
      numFaces: 3,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    initialized = true;
    initError = null;
    self.postMessage({ type: "READY", delegate });
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
    await initMediaPipe(msg.vendorBaseUrl, msg.delegate || "CPU");
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
    try {
      if (!initialized || !landmarker) {
        self.postMessage({ type: "NO_MODEL", mediaTime, timestampMs });
        return;
      }
      const t0 = performance.now();
      // MediaPipe VIDEO mode requires strictly monotonically increasing integer timestamps
      const ts = Math.max(lastDetectTs + 1, Math.floor(timestampMs || performance.now()));
      lastDetectTs = ts;
      const result = landmarker.detectForVideo(bitmap, ts);
      const inferMs = performance.now() - t0;

      const primary = selectPrimaryFace(result.faceLandmarks, ts);
      if (!primary) {
        self.postMessage({ type: "RESULT", hasFace: false, mediaTime, timestampMs, inferMs });
        return;
      }

      const smoothed = smoothLandmarks(primary, ts);
      self.postMessage(
        {
          type: "RESULT",
          hasFace: true,
          landmarks: smoothed,
          mediaTime,
          timestampMs,
          inferMs,
        },
        [smoothed.buffer]
      );
    } catch (err) {
      self.postMessage({
        type: "ERROR",
        reason: err && err.message ? err.message : String(err),
        mediaTime,
      });
    } finally {
      if (bitmap && typeof bitmap.close === "function") {
        bitmap.close();
      }
    }
  }
};
