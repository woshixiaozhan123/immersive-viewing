/**
 * MediaPipe Hair Segmenter Web Worker
 *
 * 为什么必须独立成 worker：
 *   MediaPipe 的 ES module WASM 在整个 Worker 上下文里只允许 boot 一次 ModuleFactory。
 *   如果把 ImageSegmenter 和 FaceLandmarker 塞进同一个 worker，第二次
 *   createFromOptions 会抛 "ModuleFactory not set"，而且不会自动恢复。
 *   所以人脸和头发必须各占一个 worker。
 *
 * 职责很窄：
 *   收一张已经裁好、缩到 256x256 的 ImageBitmap（主线程用 createImageBitmap(canvas,
 *   {resizeWidth,resizeHeight}) 生成，零额外解码），跑一次头发分割，把 soft matte
 *   量化成 Uint8 单通道发回去。64KB/帧，每 2 帧一次，开销可忽略。
 *
 * 失败策略：
 *   头发分割只是"刘海别被磨掉"的增强项。模型缺失、delegate 不可用、尺寸不符，
 *   一律安静降级，绝不阻塞美颜主链路。
 */

let segmenter = null;
let initialized = false;
let initErr = "";
let activeDelegate = "CPU";
let lastSegFailAt = 0;

/** 连续失败超过这个次数就彻底停用，避免每帧都抛异常刷屏 */
const MAX_SEG_FAILS = 3;
let segFails = 0;

async function createSegmenter(ImageSegmenter, fileset, modelUrl, delegate) {
  return ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelUrl, delegate },
    runningMode: "IMAGE",
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
}

/**
 * 预热：GPU 首次 segment 要编译着色器，实测能阻塞 2–3 秒。
 * 这一步必须在 postMessage(READY) **之前**做完 —— 否则主线程已经认为
 * worker 就绪、开始发帧，而第一帧会把主线程的 busy 标志锁死整整 3 秒，
 * 期间所有帧被挡掉，表现就是"刚打开视频那几秒刘海还是糊的"。
 */
function warmup() {
  try {
    if (typeof OffscreenCanvas !== "function") return;
    const c = new OffscreenCanvas(256, 256);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, 256, 256);
    const bmp = c.transferToImageBitmap();
    let r = null;
    try {
      r = segmenter.segment(bmp);
    } finally {
      try {
        bmp.close();
      } catch (_) {}
      try {
        if (r && typeof r.close === "function") r.close();
      } catch (_) {}
    }
  } catch (_) {
    // 预热失败无所谓，真正的第一帧还能跑，只是会慢一次
  }
}

async function initMediaPipe(vendorBaseUrl, preferredDelegate = "GPU") {
  try {
    const bundleUrl = `${vendorBaseUrl}vision_bundle.mjs`;
    const wasmDir = `${vendorBaseUrl}wasm`;
    const modelUrl = `${vendorBaseUrl}hair_segmenter.tflite`;

    if (segmenter && typeof segmenter.close === "function") {
      try {
        segmenter.close();
      } catch (_) {}
      segmenter = null;
    }

    const visionModule = await import(bundleUrl);
    const { FilesetResolver, ImageSegmenter } = visionModule;
    if (!ImageSegmenter) throw new Error("vision bundle 未导出 ImageSegmenter");

    const tryOrder = preferredDelegate === "CPU" ? ["CPU"] : ["GPU", "CPU"];
    let lastErr = null;

    for (const del of tryOrder) {
      try {
        const fileset = await FilesetResolver.forVisionTasks(wasmDir, true);
        segmenter = await createSegmenter(ImageSegmenter, fileset, modelUrl, del);
        activeDelegate = del;
        initialized = true;
        initErr = "";
        segFails = 0;
        warmup();
        self.postMessage({ type: "READY", delegate: del });
        return;
      } catch (e) {
        lastErr = e;
        // GPU 失败时同一个 worker 里已经 boot 过 ModuleFactory，不能再试 CPU。
        // 让主线程终止当前 worker 并重开一个纯 CPU 的。
        if (del === "GPU" && preferredDelegate !== "CPU") {
          self.postMessage({
            type: "FALLBACK_CPU",
            reason: e && e.message ? e.message : String(e),
          });
          return;
        }
      }
    }
    throw lastErr || new Error("hair segmenter init failed");
  } catch (err) {
    initialized = false;
    initErr = err && err.message ? err.message : String(err);
    self.postMessage({ type: "UNAVAILABLE", reason: initErr.slice(0, 200) });
  }
}

/**
 * 跑一次分割。
 * hair_segmenter 是二分类：[背景, 头发]，置信度遮罩取最后一类。
 */
function runSegmentation(bitmap, roi, seq) {
  let result = null;
  let maskRef = null;
  try {
    result = segmenter.segment(bitmap);
    const masks = result && result.confidenceMasks;
    if (!masks || !masks.length) return;
    maskRef = masks[masks.length - 1];
    if (!maskRef || typeof maskRef.getAsFloat32Array !== "function") return;

    const f32 = maskRef.getAsFloat32Array();
    const u8 = new Uint8Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const v = f32[i] * 255;
      u8[i] = v <= 0 ? 0 : v >= 255 ? 255 : v | 0;
    }
    segFails = 0;
    self.postMessage(
      {
        type: "HAIR",
        mask: u8,
        w: maskRef.width,
        h: maskRef.height,
        roi,
        seq,
      },
      [u8.buffer]
    );
  } catch (e) {
    segFails += 1;
    lastSegFailAt = performance.now();
    if (segFails >= MAX_SEG_FAILS) {
      // 连续失败 → 彻底停用，主线程会收到通知并停止发帧
      try {
        if (segmenter && typeof segmenter.close === "function") segmenter.close();
      } catch (_) {}
      segmenter = null;
      initialized = false;
      self.postMessage({
        type: "UNAVAILABLE",
        reason: (e && e.message ? e.message : String(e)).slice(0, 200),
      });
    }
  } finally {
    try {
      if (maskRef && typeof maskRef.close === "function") maskRef.close();
    } catch (_) {}
    try {
      if (result && typeof result.close === "function") result.close();
    } catch (_) {}
  }
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === "INIT") {
    await initMediaPipe(msg.vendorBaseUrl, msg.delegate || "GPU");
    return;
  }

  if (msg.type === "CLOSE") {
    try {
      if (segmenter && typeof segmenter.close === "function") segmenter.close();
    } catch (_) {}
    segmenter = null;
    initialized = false;
    self.postMessage({ type: "CLOSED" });
    return;
  }

  if (msg.type === "FRAME") {
    const bitmap = msg.bitmap;
    try {
      if (!initialized || !segmenter || !bitmap) {
        if (bitmap) bitmap.close();
        return;
      }
      runSegmentation(bitmap, msg.roi, msg.seq);
    } finally {
      // 无论成功失败都要释放，否则 GPU 内存会一路涨到崩
      try {
        if (bitmap) bitmap.close();
      } catch (_) {}
    }
  }
};
