#!/usr/bin/env node
/**
 * Validates JS syntax, manifest.json integrity, icons, and bundled MediaPipe assets.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REQUIRE_MODELS = process.argv.includes("--require-models");

const JS_FILES = [
  "background/service-worker.js",
  "background/cache-bridge.js",
  "background/grab-bridge.js",
  "content/cache-hook.js",
  "content/cache-relay.js",
  "content/grab-hook.js",
  "content/grab-relay.js",
  "content/engine.js",
  "content/overlay-ui.js",
  "content/subtitles.js",
  "worker/face-worker.js",
  "popup/popup.js",
  "ios/realtime-beauty-ios.user.js",
  "scripts/fetch-mediapipe.mjs",
  "scripts/check.mjs",
  "scripts/build-zip.mjs",
];

const CORE_FILES = [
  "manifest.json",
  "background/service-worker.js",
  "background/cache-bridge.js",
  "background/grab-bridge.js",
  "content/cache-hook.js",
  "content/cache-relay.js",
  "content/grab-hook.js",
  "content/grab-relay.js",
  "content/engine.js",
  "content/overlay-ui.js",
  "content/subtitles.js",
  "worker/face-worker.js",
  "ios/realtime-beauty-ios.user.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "test-page/index.html",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
];

const MODEL_FILES = [
  "vendor/mediapipe/vision_bundle.mjs",
  "vendor/mediapipe/face_landmarker.task",
  "vendor/mediapipe/hair_segmenter.tflite",
  "vendor/mediapipe/wasm/vision_wasm_module_internal.js",
  "vendor/mediapipe/wasm/vision_wasm_module_internal.wasm",
];

// 1. JS syntax check
for (const rel of JS_FILES) {
  const full = path.join(ROOT, rel);
  execFileSync(process.execPath, ["--check", full], { stdio: "inherit" });
  console.log(`[syntax ok] ${rel}`);
}

// 2. Manifest check
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("manifest_version must be 3");
if (!manifest.background?.service_worker && !manifest.action?.default_popup) {
  throw new Error("Missing background.service_worker or action.default_popup");
}
console.log(`[manifest ok] ${manifest.name} v${manifest.version} (MV3)`);

// 3. Core assets check
for (const rel of CORE_FILES) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full) || fs.statSync(full).size <= 0) {
    throw new Error(`Missing or empty core file: ${rel}`);
  }
}
console.log(`[assets ok] ${CORE_FILES.length} core files verified.`);

// 4. MediaPipe offline model check
const missingModels = MODEL_FILES.filter((rel) => {
  const full = path.join(ROOT, rel);
  return !fs.existsSync(full) || fs.statSync(full).size <= 0;
});

if (missingModels.length > 0) {
  const msg = `Offline MediaPipe assets missing (${missingModels.join(", ")}). Run: npm run setup`;
  if (REQUIRE_MODELS) {
    throw new Error(msg);
  }
  console.warn(`[warn] ${msg} (Extension still runs in WebGL skin-beauty fallback mode.)`);
} else {
  console.log(`[models ok] All ${MODEL_FILES.length} offline MediaPipe assets verified.`);
}
