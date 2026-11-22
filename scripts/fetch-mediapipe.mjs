#!/usr/bin/env node
/**
 * Downloads official MediaPipe Tasks Vision (v1.2.3 ES-module WASM) and
 * the float16 face_landmarker.task model into vendor/mediapipe/ for 100% offline MV3 bundling.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VENDOR = path.join(ROOT, "vendor", "mediapipe");
const FORCE = process.argv.includes("--force");

const MP_VERSION = "1.2.3";
const ASSETS = [
  {
    url: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`,
    dest: path.join(VENDOR, "vision_bundle.mjs"),
    minBytes: 50_000,
  },
  {
    url: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm/vision_wasm_module_internal.js`,
    dest: path.join(VENDOR, "wasm", "vision_wasm_module_internal.js"),
    minBytes: 100_000,
  },
  {
    url: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm/vision_wasm_module_internal.wasm`,
    dest: path.join(VENDOR, "wasm", "vision_wasm_module_internal.wasm"),
    minBytes: 5_000_000,
  },
  {
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    dest: path.join(VENDOR, "face_landmarker.task"),
    minBytes: 1_000_000,
  },
];

async function downloadFile(url, dest, minBytes) {
  if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size >= minBytes) {
    console.log(`[skip] ${path.relative(ROOT, dest)} (${fs.statSync(dest).size} bytes)`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  console.log(`[fetch] ${url}`);
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} while downloading ${url}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < minBytes) {
    throw new Error(`Downloaded file too small (${buf.length} bytes < ${minBytes}): ${url}`);
  }
  fs.writeFileSync(dest, buf);
  console.log(`[ok]   ${path.relative(ROOT, dest)} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
}

async function main() {
  for (const item of ASSETS) {
    await downloadFile(item.url, item.dest, item.minBytes);
  }
  console.log("All offline MediaPipe assets are ready in vendor/mediapipe/.");
}

main().catch((err) => {
  console.error("Failed to fetch MediaPipe assets:", err);
  process.exit(1);
});
