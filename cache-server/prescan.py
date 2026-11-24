"""Offline facial landmark prescan for locally cached HLS entries.

Scans ONLY already-cached TS segments under ``GRAB_CACHE_DIR/<safeKey>/segs``
without ever fetching uncached segments from upstream. Outputs compact fixed-stride
little-endian binary table ``landmarks.bin`` plus ``landmarks.json`` manifest.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

import config
import webui
from hls_proxy import TransparentHlsCache, _atomic_write_json

logger = logging.getLogger("rb-prescan")

MODEL_PATH: Path = Path(__file__).resolve().parent.parent / "vendor" / "mediapipe" / "face_landmarker.task"

MAGIC = b"RBPS"
FORMAT_VERSION = 1
SCALE = 10000
HEADER_FIXED_BYTES = 24
META_FLUSH_INTERVAL_FRAMES = 200

# 5 个高倍补检窗口（前 4 个与 engine.js SMALL_FACE_SCAN_ROIS 一致，第 5 个覆盖中下构图）
_SCAN_ROIS: tuple[tuple[float, float, float, float], ...] = (
    (0.16, 0.04, 0.68, 0.72),
    (0.24, 0.14, 0.52, 0.58),
    (0.00, 0.06, 0.56, 0.70),
    (0.44, 0.06, 0.56, 0.70),
    (0.20, 0.28, 0.60, 0.68),
)

# All landmark indices actually consumed by content/engine.js (face oval + eyes + brows + lips + anchors)
_CONSUMED_GROUPS: tuple[tuple[int, ...], ...] = (
    # FACE_OVAL_IDX (36)
    (10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
     397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
     172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109),
    # LEFT_EYE_IDX (16)
    (33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246),
    # RIGHT_EYE_IDX (16)
    (263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466),
    # LEFT_BROW_IDX (10)
    (70, 63, 105, 66, 107, 55, 65, 52, 53, 46),
    # RIGHT_BROW_IDX (10)
    (300, 293, 334, 296, 336, 285, 295, 282, 283, 276),
    # LIPS_OUTER_IDX (20)
    (61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185),
    # LIPS_INNER_IDX (20)
    (78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191),
    # Extra anchors in updateFaceMaskTexture not covered above (4)
    (168, 1, 129, 358),
)

PRESCAN_POINTS: tuple[int, ...] = tuple(
    dict.fromkeys(idx for grp in _CONSUMED_GROUPS for idx in grp)
)


# Global task coordination: max 1 concurrent prescan across the whole server
_active_lock = threading.RLock()
_active_keys: set[str] = set()


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _align4(n: int) -> int:
    return (n + 3) & ~3


def _q16(val: float) -> int:
    clamped = -0.5 if val < -0.5 else (1.5 if val > 1.5 else val)
    iv = int(round(clamped * SCALE))
    return -32768 if iv < -32768 else (32767 if iv > 32767 else iv)


def _clamp01(val: float) -> float:
    return 0.0 if val < 0.0 else (1.0 if val > 1.0 else val)


def _subproc_flags() -> int:
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def active_key() -> Optional[str]:
    with _active_lock:
        return next(iter(_active_keys), None)


def is_running(safe_key: Optional[str] = None) -> bool:
    with _active_lock:
        if safe_key is None:
            return bool(_active_keys)
        return safe_key in _active_keys


def _read_meta_raw(entry: Path, safe_key: str, cache: Optional[TransparentHlsCache]) -> dict[str, Any]:
    if cache is not None:
        return cache.read_meta(safe_key)
    p = entry / "meta.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_meta_prescan(
    entry: Path,
    safe_key: str,
    prescan_state: Optional[dict[str, Any]],
    cache: Optional[TransparentHlsCache],
) -> None:
    """Update only ``meta['prescan']`` safely without clobbering concurrent fields or recreating deleted dirs."""
    if not entry.is_dir():
        return
    meta_path = entry / "meta.json"

    def _apply() -> None:
        if not entry.is_dir():
            return
        cur = {}
        if meta_path.exists():
            try:
                cur = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                cur = {}
        if prescan_state is None:
            cur.pop("prescan", None)
        else:
            cur["prescan"] = prescan_state
        _atomic_write_json(meta_path, cur)

    try:
        if cache is not None:
            with cache._lock_for(safe_key):
                _apply()
        else:
            _apply()
    except OSError as exc:
        logger.debug("skip prescan meta update for %s: %s", safe_key, exc)


def _probe_resolution(seg_path: Path) -> tuple[int, int]:
    cmd = [
        config.FFPROBE_PATH,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0:s=x",
        str(seg_path),
    ]
    res = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=20,
        creationflags=_subproc_flags(),
    )
    if res.returncode != 0:
        raise RuntimeError(f"ffprobe failed ({res.returncode}): {res.stderr.strip()}")
    for line in res.stdout.splitlines():
        line = line.strip()
        if "x" not in line:
            continue
        parts = line.split("x", 1)
        try:
            w, h = int(parts[0]), int(parts[1])
            if w > 0 and h > 0:
                return w, h
        except ValueError:
            continue
    raise RuntimeError(f"ffprobe returned unparseable resolution: {res.stdout!r}")


def _read_exact(stream, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining > 0:
        part = stream.read(remaining)
        if not part:
            break
        chunks.append(part)
        remaining -= len(part)
    if remaining != 0:
        return b""
    return b"".join(chunks) if len(chunks) > 1 else chunks[0]


def _is_plausible_face(pts: list[tuple[float, float]], bbox: tuple[float, float, float, float]) -> bool:
    if len(pts) < 468:
        return False
    _, _, bw, bh = bbox
    if bw < 0.012 or bh < 0.015 or bw > 1.25 or bh > 1.35:
        return False
    eye_dist = math.hypot(pts[263][0] - pts[33][0], pts[263][1] - pts[33][1])
    return eye_dist >= 0.005


def _tracked_crop_roi(
    last_box: Optional[tuple[float, float, float, float]], width: int, height: int
) -> Optional[tuple[float, float, float, float]]:
    if last_box is None or width <= 0 or height <= 0:
        return None
    bx, by, bw, bh = last_box
    if bw >= 0.45 and bh >= 0.55:
        return None
    aspect = width / max(1, height)
    face_size_a = max(bw * aspect, bh, 0.08)
    crop_a = max(0.32, min(0.95, face_size_a * 2.8))
    rw = min(1.0, crop_a / aspect)
    rh = min(1.0, crop_a)
    if rw >= 0.88 and rh >= 0.88:
        return None
    cx = bx + bw * 0.5
    cy = by + bh * 0.5
    rx = max(0.0, min(1.0 - rw, cx - rw * 0.5))
    ry = max(0.0, min(1.0 - rh, cy - rh * 0.5))
    return (rx, ry, rw, rh)


def _detect_on_roi(
    landmarker: vision.FaceLandmarker,
    rgb: np.ndarray,
    width: int,
    height: int,
    rx: float,
    ry: float,
    rw: float,
    rh: float,
) -> Optional[tuple[list[tuple[float, float]], tuple[float, float, float, float]]]:
    is_full = rx == 0.0 and ry == 0.0 and rw == 1.0 and rh == 1.0
    if is_full:
        x0, y0, cw, ch = 0, 0, width, height
        sub = rgb
    else:
        x0 = max(0, int(rx * width))
        y0 = max(0, int(ry * height))
        cw = max(16, min(width - x0, int(round(rw * width))))
        ch = max(16, min(height - y0, int(round(rh * height))))
        if cw < 32 or ch < 32:
            return None
        sub = np.ascontiguousarray(rgb[y0 : y0 + ch, x0 : x0 + cw])

    res = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=sub))
    if not res.face_landmarks:
        return None

    ax = x0 / width
    ay = y0 / height
    aw = cw / width
    ah = ch / height

    best_pts: Optional[list[tuple[float, float]]] = None
    best_bbox: Optional[tuple[float, float, float, float]] = None
    best_area = -1.0
    for face in res.face_landmarks:
        pts: list[tuple[float, float]] = []
        min_x, min_y = 1.0, 1.0
        max_x, max_y = 0.0, 0.0
        for lm in face:
            fx = float(lm.x) if is_full else (ax + float(lm.x) * aw)
            fy = float(lm.y) if is_full else (ay + float(lm.y) * ah)
            pts.append((fx, fy))
            cx = _clamp01(fx)
            cy = _clamp01(fy)
            if cx < min_x:
                min_x = cx
            if cx > max_x:
                max_x = cx
            if cy < min_y:
                min_y = cy
            if cy > max_y:
                max_y = cy
        bw = max(0.0, max_x - min_x)
        bh = max(0.0, max_y - min_y)
        bbox = (min_x, min_y, bw, bh)
        if not _is_plausible_face(pts, bbox):
            continue
        area = bw * bh
        if area > best_area:
            best_area = area
            best_pts = pts
            best_bbox = bbox

    if best_pts is None or best_bbox is None:
        return None
    return best_pts, best_bbox


def _detect_frame(
    landmarker: vision.FaceLandmarker,
    rgb: np.ndarray,
    width: int,
    height: int,
    last_box: Optional[tuple[float, float, float, float]] = None,
) -> Optional[tuple[list[tuple[float, float]], tuple[float, float, float, float]]]:
    tracked = _tracked_crop_roi(last_box, width, height)
    if tracked is not None:
        hit = _detect_on_roi(landmarker, rgb, width, height, *tracked)
        if hit is not None:
            return hit

    hit = _detect_on_roi(landmarker, rgb, width, height, 0.0, 0.0, 1.0, 1.0)
    if hit is not None:
        return hit

    for roi in _SCAN_ROIS:
        hit = _detect_on_roi(landmarker, rgb, width, height, *roi)
        if hit is not None:
            return hit
    return None


def _replace_with_retry(src: Path, dst: Path) -> None:
    for attempt in range(5):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.02 * (attempt + 1))


def scan_entry(
    safe_key: str,
    cache: Optional[TransparentHlsCache] = None,
    fps_override: Optional[int] = None,
    progress_cb: Optional[Callable[[int, int, int, float], None]] = None,
) -> dict[str, Any]:
    """Synchronously scan cached TS segments of ``safe_key`` into landmarks.bin + landmarks.json."""
    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"FaceLandmarker model missing: {MODEL_PATH}")

    entry = cache.entry_dir(safe_key) if cache is not None else (Path(config.GRAB_CACHE_DIR) / safe_key)
    if not entry.is_dir():
        raise FileNotFoundError(f"Cache entry not found: {entry}")

    indices, _ = webui._scan_segs(entry)
    if not indices:
        raise ValueError(f"No cached segments on disk for {safe_key}")

    meta = _read_meta_raw(entry, safe_key, cache)
    durs = webui._snapshot_durations(entry)
    fallback_dur = float(meta.get("segmentDuration") or 0) or 5.0

    def _dur_of(idx: int) -> float:
        if 0 <= idx < len(durs) and durs[idx] > 0:
            return float(durs[idx])
        return fallback_dur

    total_cached_sec = sum(_dur_of(i) for i in indices)
    req_fps = max(1, int(fps_override)) if fps_override is not None else config.PRESCAN_FPS
    fps = req_fps
    if total_cached_sec > 0 and total_cached_sec * fps > config.PRESCAN_MAX_FRAMES:
        fps = max(1, int(config.PRESCAN_MAX_FRAMES // total_cached_sec))
        logger.warning(
            "[prescan] %s exceeds PRESCAN_MAX_FRAMES (%d): scaling fps %d -> %d",
            safe_key,
            config.PRESCAN_MAX_FRAMES,
            req_fps,
            fps,
        )

    expected = max(1, int(round(total_cached_sec * fps)))
    ranges = webui._ranges(indices)

    first_seg = entry / "segs" / f"{indices[0]:06d}.ts"
    width, height = _probe_resolution(first_seg)
    frame_bytes = width * height * 3

    n_points = len(PRESCAN_POINTS)
    stride = 16 + 4 * n_points
    header_len = _align4(HEADER_FIXED_BYTES + 2 * n_points)
    rec_struct = struct.Struct(f"<IHH4h{2 * n_points}h")
    empty_tail = (0,) * (2 * n_points)

    started_at = _now_iso()
    t0 = time.monotonic()

    prescan_meta: dict[str, Any] = {
        "state": "running",
        "frames": 0,
        "expected": expected,
        "fps": fps,
        "error": None,
        "startedAt": started_at,
        "updatedAt": started_at,
    }
    _write_meta_prescan(entry, safe_key, prescan_meta, cache)

    bin_path = entry / "landmarks.bin"
    tmp_bin = entry / "landmarks.bin.tmp"
    json_path = entry / "landmarks.json"

    opts = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(MODEL_PATH)),
        running_mode=vision.RunningMode.IMAGE,
        num_faces=2,
        min_face_detection_confidence=0.22,
        min_face_presence_confidence=0.22,
        min_tracking_confidence=0.22,
    )

    total_frames = 0
    has_face_frames = 0
    last_t_ms = -1
    run_manifests: list[dict[str, Any]] = []

    try:
        landmarker = vision.FaceLandmarker.create_from_options(opts)
    except Exception as exc:
        if entry.is_dir():
            _write_meta_prescan(
                entry,
                safe_key,
                {
                    "state": "failed",
                    "frames": 0,
                    "expected": expected,
                    "fps": fps,
                    "error": f"landmarker init failed: {exc}",
                    "startedAt": started_at,
                    "updatedAt": _now_iso(),
                },
                cache,
            )
        raise

    try:
        with open(tmp_bin, "wb") as fout:
            # Reserve header; final accurate count will be written at offset 0 once done
            fout.write(b"\x00" * header_len)

            for seg_start, seg_end in ranges:
                if not entry.is_dir():
                    raise FileNotFoundError(f"Entry directory disappeared: {entry}")

                run_start_ms = sum(_dur_of(k) for k in range(seg_start)) * 1000.0
                seg_files = [entry / "segs" / f"{k:06d}.ts" for k in range(seg_start, seg_end + 1)]

                with tempfile.NamedTemporaryFile(
                    mode="w", suffix=".txt", delete=False, encoding="utf-8"
                ) as tf:
                    list_txt = Path(tf.name)
                    for sf in seg_files:
                        if not sf.exists():
                            raise FileNotFoundError(f"Segment missing during scan: {sf}")
                        posix = sf.resolve().as_posix().replace("'", "'\\''")
                        tf.write(f"file '{posix}'\n")

                cmd = [
                    config.FFMPEG_PATH,
                    "-v",
                    "error",
                    "-threads",
                    "2",
                    "-f",
                    "concat",
                    "-safe",
                    "0",
                    "-i",
                    str(list_txt),
                    "-an",
                    "-vf",
                    f"fps={fps}",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    "-",
                ]
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    bufsize=frame_bytes * 4,
                    creationflags=_subproc_flags(),
                )

                run_frames = 0
                run_first_t_ms: Optional[int] = None
                run_last_t_ms = int(round(run_start_ms))
                step_ms = 1000.0 / fps
                last_box: Optional[tuple[float, float, float, float]] = None

                try:
                    assert proc.stdout is not None
                    while True:
                        raw = _read_exact(proc.stdout, frame_bytes)
                        if not raw:
                            break
                        if not entry.is_dir():
                            raise FileNotFoundError(f"Entry removed during scan: {entry}")

                        t_ms = int(round(run_start_ms + run_frames * step_ms))
                        if t_ms <= last_t_ms:
                            t_ms = last_t_ms + 1
                        last_t_ms = t_ms
                        if run_first_t_ms is None:
                            run_first_t_ms = t_ms
                        run_last_t_ms = t_ms

                        rgb = np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 3))
                        detected = _detect_frame(landmarker, rgb, width, height, last_box)
                        last_box = detected[1] if detected is not None else None

                        if detected is not None:
                            pts, (bx, by, bw, bh) = detected
                            n_lm = len(pts)
                            flat_pts: list[int] = []
                            for lm_idx in PRESCAN_POINTS:
                                if lm_idx < n_lm:
                                    px, py = pts[lm_idx]
                                    flat_pts.append(_q16(px))
                                    flat_pts.append(_q16(py))
                                else:
                                    flat_pts.append(0)
                                    flat_pts.append(0)
                            fout.write(
                                rec_struct.pack(
                                    t_ms,
                                    1,
                                    0,
                                    _q16(bx),
                                    _q16(by),
                                    _q16(bw),
                                    _q16(bh),
                                    *flat_pts,
                                )
                            )
                            has_face_frames += 1
                        else:
                            fout.write(rec_struct.pack(t_ms, 0, 0, 0, 0, 0, 0, *empty_tail))

                        run_frames += 1
                        total_frames += 1

                        if total_frames % META_FLUSH_INTERVAL_FRAMES == 0:
                            elapsed = time.monotonic() - t0
                            prescan_meta["frames"] = total_frames
                            prescan_meta["updatedAt"] = _now_iso()
                            _write_meta_prescan(entry, safe_key, prescan_meta, cache)
                            if progress_cb is not None:
                                progress_cb(total_frames, expected, has_face_frames, elapsed)

                    proc.wait(timeout=15)
                    err_text = proc.stderr.read().decode("utf-8", errors="replace").strip() if proc.stderr else ""
                    if proc.returncode not in (0, None):
                        if run_frames == 0:
                            raise RuntimeError(f"ffmpeg decode failed ({proc.returncode}): {err_text}")
                        logger.warning("[prescan] ffmpeg non-zero exit (%d) after %d frames: %s", proc.returncode, run_frames, err_text)
                finally:
                    if proc.poll() is None:
                        proc.kill()
                        proc.wait(timeout=5)
                    for pipe in (proc.stdout, proc.stderr):
                        if pipe is not None:
                            try:
                                pipe.close()
                            except OSError:
                                pass
                    list_txt.unlink(missing_ok=True)

                run_dur_end_ms = int(round(run_start_ms + sum(_dur_of(k) for k in range(seg_start, seg_end + 1)) * 1000.0))
                run_manifests.append(
                    {
                        "segStart": seg_start,
                        "segEnd": seg_end,
                        "tStartMs": run_first_t_ms if run_first_t_ms is not None else int(round(run_start_ms)),
                        "tEndMs": max(run_last_t_ms, run_dur_end_ms),
                        "frames": run_frames,
                    }
                )

            if total_frames == 0:
                raise RuntimeError(f"Decoded 0 video frames for {safe_key}")

            header = bytearray(header_len)
            struct.pack_into(
                "<4sHHIHHII",
                header,
                0,
                MAGIC,
                FORMAT_VERSION,
                fps,
                total_frames,
                n_points,
                SCALE,
                stride,
                0,
            )
            struct.pack_into(f"<{n_points}H", header, HEADER_FIXED_BYTES, *PRESCAN_POINTS)
            fout.seek(0)
            fout.write(header)
            fout.flush()
            os.fsync(fout.fileno())

        _replace_with_retry(tmp_bin, bin_path)
        bin_bytes = bin_path.stat().st_size
        scanned_at = _now_iso()
        manifest = {
            "version": FORMAT_VERSION,
            "fps": fps,
            "count": total_frames,
            "nPoints": n_points,
            "hasFaceCount": has_face_frames,
            "hasFaceRatio": round(has_face_frames / total_frames, 4),
            "durationSec": round(total_cached_sec, 3),
            "binBytes": bin_bytes,
            "points": list(PRESCAN_POINTS),
            "runs": run_manifests,
            "scannedAt": scanned_at,
        }
        _atomic_write_json(json_path, manifest)

        done_meta = {
            "state": "done",
            "frames": total_frames,
            "expected": total_frames,
            "fps": fps,
            "hasFaceCount": has_face_frames,
            "hasFaceRatio": manifest["hasFaceRatio"],
            "binBytes": bin_bytes,
            "error": None,
            "startedAt": started_at,
            "updatedAt": scanned_at,
        }
        _write_meta_prescan(entry, safe_key, done_meta, cache)
        elapsed_total = time.monotonic() - t0
        if progress_cb is not None:
            progress_cb(total_frames, total_frames, has_face_frames, elapsed_total)
        return {
            "key": safe_key,
            "state": "done",
            "frames": total_frames,
            "hasFaceCount": has_face_frames,
            "hasFaceRatio": manifest["hasFaceRatio"],
            "fps": fps,
            "nPoints": n_points,
            "binBytes": bin_bytes,
            "elapsedSec": round(elapsed_total, 2),
        }

    except FileNotFoundError as exc:
        try:
            tmp_bin.unlink(missing_ok=True)
        except OSError:
            pass
        if entry.is_dir():
            _write_meta_prescan(
                entry,
                safe_key,
                {
                    "state": "failed",
                    "frames": total_frames,
                    "expected": expected,
                    "fps": fps,
                    "error": f"entry removed ({exc})",
                    "startedAt": started_at,
                    "updatedAt": _now_iso(),
                },
                cache,
            )
        raise
    except Exception as exc:
        try:
            tmp_bin.unlink(missing_ok=True)
        except OSError:
            pass
        if entry.is_dir():
            _write_meta_prescan(
                entry,
                safe_key,
                {
                    "state": "failed",
                    "frames": total_frames,
                    "expected": expected,
                    "fps": fps,
                    "error": str(exc),
                    "startedAt": started_at,
                    "updatedAt": _now_iso(),
                },
                cache,
            )
        raise
    finally:
        try:
            landmarker.close()
        except Exception:
            pass


def get_status(cache: TransparentHlsCache, safe_key: str) -> dict[str, Any]:
    entry = cache.entry_dir(safe_key)
    bin_path = entry / "landmarks.bin"
    json_path = entry / "landmarks.json"
    has_bin = bin_path.exists()
    has_json = json_path.exists()
    bin_bytes = bin_path.stat().st_size if has_bin else 0
    meta = cache.read_meta(safe_key)
    ps = dict(meta.get("prescan") or {"state": "none"})
    if is_running(safe_key):
        ps["state"] = "running"
    return {
        "key": safe_key,
        **ps,
        "hasBin": has_bin,
        "hasJson": has_json,
        "binBytes": bin_bytes,
        "activeKey": active_key(),
    }


def start_prescan_async(
    cache: TransparentHlsCache, safe_key: str, force: bool = False
) -> tuple[int, dict[str, Any]]:
    entry = cache.entry_dir(safe_key)
    if not entry.is_dir():
        return 404, {"detail": "unknown key"}

    indices, _ = webui._scan_segs(entry)
    if not indices:
        return 400, {"detail": "no cached segments on disk"}

    bin_path = entry / "landmarks.bin"
    json_path = entry / "landmarks.json"
    meta = cache.read_meta(safe_key)
    cur_state = (meta.get("prescan") or {}).get("state")

    already_done = False
    with _active_lock:
        if safe_key in _active_keys:
            return 409, {"detail": "prescan already running for this video", "activeKey": safe_key}
        if _active_keys:
            cur = next(iter(_active_keys))
            return 409, {"detail": f"another prescan is running: {cur}", "activeKey": cur}
        if not force and cur_state == "done" and bin_path.exists() and json_path.exists():
            already_done = True
        else:
            _active_keys.add(safe_key)
    if already_done:
        return 200, get_status(cache, safe_key)

    started_at = _now_iso()
    durs = webui._snapshot_durations(entry)
    fallback_dur = float(meta.get("segmentDuration") or 0) or 5.0
    total_sec = sum(float(durs[i]) if i < len(durs) and durs[i] > 0 else fallback_dur for i in indices)
    fps = config.PRESCAN_FPS
    if total_sec > 0 and total_sec * fps > config.PRESCAN_MAX_FRAMES:
        fps = max(1, int(config.PRESCAN_MAX_FRAMES // total_sec))
    running_meta = {
        "state": "running",
        "frames": 0,
        "expected": max(1, int(round(total_sec * fps))),
        "fps": fps,
        "error": None,
        "startedAt": started_at,
        "updatedAt": started_at,
    }
    _write_meta_prescan(entry, safe_key, running_meta, cache)

    def _runner() -> None:
        try:
            res = scan_entry(safe_key, cache=cache)
            logger.info(
                "[prescan] done key=%s frames=%d hasFace=%d/%d (%.1f%%) size=%.2fMB elapsed=%.1fs",
                safe_key,
                res["frames"],
                res["hasFaceCount"],
                res["frames"],
                res["hasFaceRatio"] * 100.0,
                res["binBytes"] / (1024 * 1024),
                res["elapsedSec"],
            )
        except FileNotFoundError as exc:
            logger.warning("[prescan] stopped (%s): %s", safe_key, exc)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[prescan] failed (%s): %s", safe_key, exc)
        finally:
            with _active_lock:
                _active_keys.discard(safe_key)

    threading.Thread(target=_runner, name=f"prescan-{safe_key[:24]}", daemon=True).start()
    return 200, get_status(cache, safe_key)


def delete_prescan(cache: TransparentHlsCache, safe_key: str) -> tuple[int, dict[str, Any]]:
    entry = cache.entry_dir(safe_key)
    if not entry.is_dir():
        return 404, {"detail": "unknown key"}
    if is_running(safe_key):
        return 409, {"detail": "prescan is currently running for this video"}

    for fname in ("landmarks.bin", "landmarks.bin.tmp", "landmarks.json"):
        try:
            (entry / fname).unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("unlink failed %s/%s: %s", safe_key, fname, exc)
    _write_meta_prescan(entry, safe_key, None, cache)
    return 200, {"deleted": True, "key": safe_key}


def reset_stale_running(cache_dir: Path) -> int:
    """Reset any leftover ``prescan.state == 'running'`` across cache entries on server boot."""
    root = Path(cache_dir)
    if not root.is_dir():
        return 0
    fixed = 0
    try:
        entries = [p for p in root.iterdir() if p.is_dir() and not p.name.startswith("_")]
    except OSError:
        return 0
    for entry in entries:
        meta_path = entry / "meta.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        ps = meta.get("prescan")
        if isinstance(ps, dict) and ps.get("state") == "running":
            ps["state"] = "failed"
            ps["error"] = "interrupted by server restart"
            ps["updatedAt"] = _now_iso()
            try:
                (entry / "landmarks.bin.tmp").unlink(missing_ok=True)
            except OSError:
                pass
            try:
                _atomic_write_json(meta_path, meta)
                fixed += 1
            except OSError:
                pass
    return fixed


def main() -> int:
    parser = argparse.ArgumentParser(description="Offline MediaPipe landmark prescan for cached TS entry")
    parser.add_argument("safe_key", help="Directory name under GRAB_CACHE_DIR (e.g. avbebe.com_archives_357404)")
    parser.add_argument("--fps", type=int, default=None, help="Override sampling fps (default: config.PRESCAN_FPS)")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    def _on_progress(frames: int, expected: int, faces: int, elapsed: float) -> None:
        pct = (frames / expected * 100.0) if expected else 0.0
        face_pct = (faces / frames * 100.0) if frames else 0.0
        rate = (frames / elapsed) if elapsed > 0 else 0.0
        print(
            f"[prescan] {frames}/{expected} ({pct:5.1f}%) | hasFace={faces}/{frames} ({face_pct:5.1f}%) "
            f"| {rate:4.1f} fps | {elapsed:5.1f}s",
            flush=True,
        )

    res = scan_entry(args.safe_key, cache=None, fps_override=args.fps, progress_cb=_on_progress)
    print(
        f"\nDONE key={res['key']} frames={res['frames']} nPoints={res['nPoints']} fps={res['fps']} "
        f"hasFace={res['hasFaceCount']}/{res['frames']} ({res['hasFaceRatio'] * 100:.1f}%) "
        f"bin={res['binBytes'] / (1024 * 1024):.2f}MB ({res['binBytes']} bytes) time={res['elapsedSec']:.1f}s"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
