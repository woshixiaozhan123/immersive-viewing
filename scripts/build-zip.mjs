#!/usr/bin/env node
/**
 * Builds a clean, store-ready release zip in dist/ containing ONLY runtime extension files.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Verify syntax, manifest, and models first
execFileSync(process.execPath, [path.join(__dirname, "check.mjs"), "--require-models"], {
  stdio: "inherit",
});

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const distDir = path.join(ROOT, "dist");
fs.mkdirSync(distDir, { recursive: true });
const outZip = path.join(distDir, `immersive-viewing-v${manifest.version}.zip`);

const INCLUDE_PATHS = [
  "manifest.json",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "icons",
  "background",
  "content",
  "worker",
  "test-page",
  "cache-server",
  "vendor/mediapipe/vision_bundle.mjs",
  "vendor/mediapipe/face_landmarker.task",
  "vendor/mediapipe/hair_segmenter.tflite",
  "vendor/mediapipe/wasm/vision_wasm_module_internal.js",
  "vendor/mediapipe/wasm/vision_wasm_module_internal.wasm",
];

const EXCLUDE_DIRS = new Set([".venv", "runtime", "__pycache__"]);
const EXCLUDE_FILES = new Set([
  ".gitkeep",
  ".DS_Store",
  "Thumbs.db",
  "env.json",
  "profile-cache.json",
  "launch.lock",
  "com.realtime_beauty.cache_host.json",
]);

function shouldSkip(entryName, isDir) {
  if (isDir) return EXCLUDE_DIRS.has(entryName);
  if (EXCLUDE_FILES.has(entryName)) return true;
  if (entryName.endsWith(".pyc") || entryName.endsWith(".log") || entryName.endsWith(".tmp") || entryName.endsWith(".part")) {
    return true;
  }
  return false;
}

function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const child = path.join(src, entry);
      const childSt = fs.statSync(child);
      if (shouldSkip(entry, childSt.isDirectory())) continue;
      copyRecursive(child, path.join(dst, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "wvb-stage-"));
try {
  for (const rel of INCLUDE_PATHS) {
    copyRecursive(path.join(ROOT, rel), path.join(stageDir, rel));
  }
  if (fs.existsSync(outZip)) fs.unlinkSync(outZip);

  if (process.platform === "win32") {
    // Write POSIX forward-slash entry paths so the zip is 100% compatible with Chrome Web Store & Linux/macOS unzip
    const psCmd = `
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = '${stageDir.replace(/'/g, "''")}'
$out = '${outZip.replace(/'/g, "''")}'
$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -Path $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length + 1).Replace('\\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally {
  $zip.Dispose()
}
`.trim();
    execFileSync("powershell.exe", ["-NoProfile", "-Command", psCmd], { stdio: "inherit" });
  } else {
    execFileSync("zip", ["-r", "-9", outZip, "."], { cwd: stageDir, stdio: "inherit" });
  }

  const sizeMb = (fs.statSync(outZip).size / 1024 / 1024).toFixed(2);
  console.log(`\n[release ok] ${path.relative(ROOT, outZip)} (${sizeMb} MB)`);
} finally {
  fs.rmSync(stageDir, { recursive: true, force: true });
}
