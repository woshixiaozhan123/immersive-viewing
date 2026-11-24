"""
Universal Video Grabber Pipeline (video-cache-spec-v3.md).

Key architecture guarantees:
1. HTTP transport uses `curl_cffi` EXCLUSIVELY (impersonate="chrome") — never `httpx`.
2. HLS (.m3u8) pipeline ALWAYS downloads all TS/fMP4 segments and AES keys to local `parts/`
   using `curl_cffi` first, then concatenates/remuxes offline with local `ffmpeg`
   (`-f concat` or `-protocol_whitelist file,crypto`) — NEVER lets ffmpeg connect to remote URLs.
3. Direct video files (.mp4/.webm/direct) are likewise streamed to disk via `curl_cffi` first,
   then locally faststart-remuxed (or optionally transcoded) with `ffmpeg`.
4. Strict `ffprobe` validation (video stream present, duration > 0, size >= MIN_SIZE_MB),
   atomic `out.part.mp4 -> out.mp4` promotion, `meta.json` state machine, and LRU eviction.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urljoin, urlparse

from curl_cffi import requests as cffi_requests

import config
from grab_models import GrabRequest

logger = logging.getLogger("rb-grab")

_KEY_CLEAN_RE = re.compile(r"[^\w.\-/]")
_SAFE_DIR_RE = re.compile(r"[^\w.\-]")
_ATTR_RE = re.compile(r'([A-Z0-9-]+)=("([^"]*)"|([^,]*))')
_HLS_EXT_RE = re.compile(r"\.m3u8(\?|#|$)", re.IGNORECASE)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def compute_page_key(page_url: str) -> tuple[str, str]:
    """
    Compute canonical (pageKey, safeKey) from top-level pageUrl per spec 1.1:
      https://missav.ws/en/abc123/ -> ("missav.ws/en/abc123", "missav.ws_en_abc123")
    """
    raw = (page_url or "").strip()
    if "://" in raw:
        u = urlparse(raw)
        host = (u.hostname or "").lower()
        path = u.path or "/"
        if path != "/" and path.endswith("/"):
            path = path.rstrip("/")
        page_key = _KEY_CLEAN_RE.sub("_", f"{host}{path}")
    else:
        # Already a pageKey or safeKey passed to lookup/delete endpoints
        cleaned = raw.strip("/")
        page_key = _KEY_CLEAN_RE.sub("_", cleaned)

    if not page_key or page_key in (".", ".."):
        raise ValueError(f"Invalid pageUrl/key: {page_url!r}")

    safe_key = _SAFE_DIR_RE.sub("_", page_key).strip("._")
    if not safe_key or safe_key in (".", ".."):
        raise ValueError(f"Invalid safeKey from: {page_url!r}")
    return page_key, safe_key


def _atomic_write_json(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.02 * (attempt + 1))


def _parse_attr_list(raw: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for m in _ATTR_RE.finditer(raw):
        k = m.group(1).upper()
        v = m.group(3) if m.group(3) is not None else (m.group(4) or "").strip()
        attrs[k] = v
    return attrs


def _strip_fake_image_header_if_ts(data: bytes) -> bytes:
    """
    Spec 8.1(1): NEVER touch pure MPEG-TS packets (offset 0 == 0x47).
    Only if offset 0 is NOT 0x47, look for an exact MPEG-TS PAT packet header (0x47 0x40 0x11)
    aligned on 188-byte packet boundaries; otherwise keep bytes untouched.
    """
    if not data or data[0] == 0x47:
        return data
    if len(data) >= 8 and data[4:8] in (b"ftyp", b"styp", b"moof", b"moov", b"sidx", b"mdat"):
        return data
    idx = data.find(b"\x47\x40\x11", 1, 512)
    if idx > 0 and (idx + 188 >= len(data) or data[idx + 188] == 0x47):
        return data[idx:]
    return data


def _looks_like_html_error(data: bytes) -> bool:
    head = data[:256].lstrip().lower()
    return head.startswith((b"<!doctype html", b"<html", b"<?xml", b"<head"))


def _origin_of(url: str) -> Optional[str]:
    try:
        u = urlparse(url)
        if u.scheme in ("http", "https") and u.netloc:
            return f"{u.scheme}://{u.netloc}"
    except Exception:
        pass
    return None


@dataclass
class _HlsSegment:
    index: int
    uri: str
    duration: float
    byte_range: Optional[tuple[int, int]] = None  # (start, end) inclusive
    key_index: Optional[int] = None
    map_index: Optional[int] = None


@dataclass
class _HlsKey:
    index: int
    method: str
    uri: Optional[str]
    iv: Optional[str]
    local_name: Optional[str] = None


@dataclass
class _HlsMap:
    index: int
    uri: str
    byte_range: Optional[tuple[int, int]] = None
    local_name: Optional[str] = None


@dataclass
class _ParsedMediaPlaylist:
    media_sequence: int
    target_duration: int
    segments: list[_HlsSegment]
    keys: list[_HlsKey]
    maps: list[_HlsMap]


def _parse_byterange(spec: str, prev_end: Optional[int]) -> Optional[tuple[int, int]]:
    parts = spec.strip().split("@")
    try:
        length = int(parts[0])
        if length <= 0:
            return None
        if len(parts) > 1:
            offset = int(parts[1])
        else:
            offset = (prev_end + 1) if prev_end is not None else 0
        return offset, offset + length - 1
    except ValueError:
        return None


def parse_master_playlist(text: str, base_url: str) -> tuple[Optional[str], Optional[str]]:
    """
    Parse an HLS Master Playlist and select the highest-bandwidth video variant
    (plus its linked EXT-X-MEDIA AUDIO playlist URI if separate audio track is declared).
    Returns (best_video_playlist_url, optional_audio_playlist_url).
    """
    audio_groups: dict[str, str] = {}
    variants: list[tuple[int, int, str, Optional[str]]] = []

    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#EXT-X-MEDIA:"):
            attrs = _parse_attr_list(line[len("#EXT-X-MEDIA:") :])
            if attrs.get("TYPE", "").upper() == "AUDIO" and attrs.get("URI"):
                gid = attrs.get("GROUP-ID", "")
                if gid not in audio_groups or attrs.get("DEFAULT", "").upper() == "YES":
                    audio_groups[gid] = urljoin(base_url, attrs["URI"])
        elif line.startswith("#EXT-X-STREAM-INF:"):
            attrs = _parse_attr_list(line[len("#EXT-X-STREAM-INF:") :])
            bw = int(attrs.get("BANDWIDTH", "0") or 0)
            res_pixels = 0
            if "RESOLUTION" in attrs and "x" in attrs["RESOLUTION"].lower():
                try:
                    w, h = attrs["RESOLUTION"].lower().split("x", 1)
                    res_pixels = int(w) * int(h)
                except ValueError:
                    pass
            audio_gid = attrs.get("AUDIO")
            # Next non-comment line is the variant playlist URI
            j = i + 1
            while j < len(lines) and lines[j].startswith("#"):
                j += 1
            if j < len(lines):
                variant_url = urljoin(base_url, lines[j])
                variants.append((bw, res_pixels, variant_url, audio_gid))
                i = j
        i += 1

    if not variants:
        return None, None
    variants.sort(key=lambda x: (x[0], x[1]), reverse=True)
    _, _, best_url, audio_gid = variants[0]
    audio_url = audio_groups.get(audio_gid) if audio_gid else None
    return best_url, audio_url


def parse_media_playlist(text: str, base_url: str) -> _ParsedMediaPlaylist:
    """Parse an HLS Media Playlist into ordered segments, encryption keys, and init maps."""
    media_sequence = 0
    target_duration = 10
    keys: list[_HlsKey] = []
    maps: list[_HlsMap] = []
    segments: list[_HlsSegment] = []

    cur_key_idx: Optional[int] = None
    cur_map_idx: Optional[int] = None
    pending_duration = 0.0
    pending_byterange: Optional[tuple[int, int]] = None
    prev_br_end: Optional[int] = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            try:
                media_sequence = int(line.split(":", 1)[1].strip())
            except ValueError:
                pass
        elif line.startswith("#EXT-X-TARGETDURATION:"):
            try:
                target_duration = max(1, int(float(line.split(":", 1)[1].strip())))
            except ValueError:
                pass
        elif line.startswith("#EXT-X-KEY:"):
            attrs = _parse_attr_list(line[len("#EXT-X-KEY:") :])
            method = attrs.get("METHOD", "NONE").upper()
            if method == "NONE":
                cur_key_idx = None
            else:
                raw_uri = attrs.get("URI")
                key_url = urljoin(base_url, raw_uri) if raw_uri else None
                iv = attrs.get("IV")
                idx = len(keys)
                keys.append(_HlsKey(index=idx, method=method, uri=key_url, iv=iv))
                cur_key_idx = idx
        elif line.startswith("#EXT-X-MAP:"):
            attrs = _parse_attr_list(line[len("#EXT-X-MAP:") :])
            raw_uri = attrs.get("URI")
            if raw_uri:
                br = _parse_byterange(attrs["BYTERANGE"], None) if "BYTERANGE" in attrs else None
                idx = len(maps)
                maps.append(_HlsMap(index=idx, uri=urljoin(base_url, raw_uri), byte_range=br))
                cur_map_idx = idx
        elif line.startswith("#EXTINF:"):
            val = line[len("#EXTINF:") :].split(",", 1)[0].strip()
            try:
                pending_duration = float(val)
            except ValueError:
                pending_duration = 0.0
        elif line.startswith("#EXT-X-BYTERANGE:"):
            pending_byterange = _parse_byterange(line[len("#EXT-X-BYTERANGE:") :], prev_br_end)
        elif line.startswith("#"):
            continue
        else:
            seg_url = urljoin(base_url, line)
            if pending_byterange is not None:
                prev_br_end = pending_byterange[1]
            else:
                prev_br_end = None
            segments.append(
                _HlsSegment(
                    index=len(segments),
                    uri=seg_url,
                    duration=pending_duration or float(target_duration),
                    byte_range=pending_byterange,
                    key_index=cur_key_idx,
                    map_index=cur_map_idx,
                )
            )
            pending_duration = 0.0
            pending_byterange = None

    return _ParsedMediaPlaylist(
        media_sequence=media_sequence,
        target_duration=target_duration,
        segments=segments,
        keys=keys,
        maps=maps,
    )


def detect_hw_encoder(ffmpeg_path: str) -> Optional[str]:
    """
    Detect a genuinely working hardware HEVC/H264 encoder on this host.
    Checks ffmpeg -encoders AND runs a 1-frame synthetic smoke encode so missing GPU drivers never break transcoding.
    """
    try:
        out = subprocess.run(
            [ffmpeg_path, "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout
    except Exception:
        return None

    for enc in ("hevc_nvenc", "hevc_qsv", "hevc_amf", "hevc_videotoolbox"):
        if enc not in out:
            continue
        try:
            probe = subprocess.run(
                [
                    ffmpeg_path,
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=black:s=256x256:d=0.1",
                    "-frames:v",
                    "1",
                    "-c:v",
                    enc,
                    "-f",
                    "null",
                    "-",
                ],
                capture_output=True,
                timeout=8,
            )
            if probe.returncode == 0:
                return enc
        except Exception:
            continue
    return None


def probe_video_file(ffprobe_path: str, file_path: Path) -> dict[str, Any]:
    """Run ffprobe validation per spec 5.8 and return parsed video stream & container info."""
    cmd = [
        ffprobe_path,
        "-v",
        "error",
        "-show_entries",
        "format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,duration,sample_rate,channels",
        "-of",
        "json",
        str(file_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed (rc={proc.returncode}): {proc.stderr.strip()[:300]}")

    info = json.loads(proc.stdout or "{}")
    streams = info.get("streams") or []
    fmt = info.get("format") or {}

    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    if not video_stream:
        raise RuntimeError("ffprobe validation failed: no video stream found")

    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    dur_raw = fmt.get("duration") or video_stream.get("duration")
    try:
        duration_sec = float(dur_raw) if dur_raw is not None else 0.0
    except (TypeError, ValueError):
        duration_sec = 0.0

    size_bytes = file_path.stat().st_size
    if duration_sec <= 0:
        raise RuntimeError(f"ffprobe validation failed: invalid duration={duration_sec}")

    return {
        "durationSec": round(duration_sec, 2),
        "width": int(video_stream.get("width") or 0),
        "height": int(video_stream.get("height") or 0),
        "codec": str(video_stream.get("codec_name") or "unknown"),
        "hasAudio": audio_stream is not None,
        "audioCodec": str(audio_stream.get("codec_name") or "") if audio_stream else None,
        "audioSampleRate": int(audio_stream.get("sample_rate") or 0) if audio_stream else 0,
        "audioChannels": int(audio_stream.get("channels") or 0) if audio_stream else 0,
        "sizeBytes": size_bytes,
    }


class GrabManager:
    """
    Manages v3 grab tasks, queue deduplication by pageKey, curl_cffi TS-first downloads,
    local ffmpeg concatenation/remux/transcode, ffprobe validation, and LRU eviction.
    """

    def __init__(
        self,
        cache_dir: Path | None = None,
        max_cache_gb: float | None = None,
        concurrency: int | None = None,
        ts_workers: int | None = None,
        min_size_mb: float | None = None,
        transcode: bool | None = None,
    ):
        self.cache_dir = Path(cache_dir or config.GRAB_CACHE_DIR)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.max_cache_gb = config.GRAB_MAX_CACHE_GB if max_cache_gb is None else float(max_cache_gb)
        self.concurrency = max(1, config.GRAB_CONCURRENCY if concurrency is None else int(concurrency))
        self.ts_workers = max(1, config.GRAB_TS_WORKERS if ts_workers is None else int(ts_workers))
        self.min_size_mb = config.GRAB_MIN_SIZE_MB if min_size_mb is None else float(min_size_mb)
        self.transcode = config.GRAB_TRANSCODE if transcode is None else bool(transcode)
        self.ffmpeg_path = config.FFMPEG_PATH
        self.ffprobe_path = config.FFPROBE_PATH

        self._lock = threading.RLock()
        self._active_keys: set[str] = set()  # safe_key currently queued or running
        # Spec 8.1(3): strict global concurrency cap (6 total across 1 or 2 active jobs)
        self._global_dl_sem = threading.Semaphore(max(1, config.GRAB_MAX_TOTAL_WORKERS))
        self._executor = ThreadPoolExecutor(
            max_workers=self.concurrency,
            thread_name_prefix="rb-grab",
        )
        self._closed = False
        self._hw_encoder_checked = False
        self._hw_encoder: Optional[str] = None

    @property
    def hw_encoder(self) -> Optional[str]:
        if not self._hw_encoder_checked:
            with self._lock:
                if not self._hw_encoder_checked:
                    self._hw_encoder = detect_hw_encoder(self.ffmpeg_path)
                    self._hw_encoder_checked = True
                    logger.info("[GRAB] Detected working HW encoder: %s", self._hw_encoder or "none (software fallback)")
        return self._hw_encoder

    def _entry_dir(self, safe_key: str) -> Path:
        return self.cache_dir / safe_key

    def _read_meta(self, safe_key: str) -> Optional[dict[str, Any]]:
        meta_path = self._entry_dir(safe_key) / "meta.json"
        with self._lock:
            if not meta_path.exists():
                return None
            try:
                data = json.loads(meta_path.read_text(encoding="utf-8"))
                return data if isinstance(data, dict) else None
            except Exception as e:
                logger.warning("Failed reading %s: %s", meta_path, e)
                return None

    def _write_meta(self, safe_key: str, meta: dict[str, Any]) -> None:
        with self._lock:
            _atomic_write_json(self._entry_dir(safe_key) / "meta.json", meta)

    def submit(self, req: GrabRequest) -> dict[str, Any]:
        """Enqueue a new grab task deduplicated by pageKey (spec 5.4)."""
        if self._closed:
            return {"accepted": False, "key": "", "safeKey": "", "status": "closed", "reason": "server_closed"}

        page_key, safe_key = compute_page_key(req.pageUrl)

        with self._lock:
            existing = self._read_meta(safe_key)
            out_file = self._entry_dir(safe_key) / "out.mp4"
            if existing and existing.get("status") == "complete" and out_file.exists():
                return {
                    "accepted": False,
                    "key": page_key,
                    "safeKey": safe_key,
                    "status": "complete",
                    "reason": "cached",
                }
            if safe_key in self._active_keys:
                cur_status = existing.get("status", "queued") if existing else "queued"
                return {
                    "accepted": False,
                    "key": page_key,
                    "safeKey": safe_key,
                    "status": cur_status,
                    "reason": "already_queued",
                }

            now = utc_now_iso()
            is_hls = self._is_hls_request(req)
            meta: dict[str, Any] = {
                "key": page_key,
                "safeKey": safe_key,
                "pageUrl": req.pageUrl,
                "frameUrl": req.frameUrl,
                "mediaUrl": req.url,
                "title": req.title or "",
                "kind": "hls" if is_hls else "direct",
                "status": "queued",
                "sizeBytes": 0,
                "durationSec": 0.0,
                "width": 0,
                "height": 0,
                "codec": "",
                "hasAudio": False,
                "transcoded": False,
                "downloadedSegments": 0,
                "totalSegments": 0,
                "progressPct": 0.0,
                "error": None,
                "createdAt": now,
                "updatedAt": now,
                "lastAccessAt": now,
                "playCount": 0,
            }
            self._write_meta(safe_key, meta)
            self._active_keys.add(safe_key)

        self._executor.submit(self._run_job, page_key, safe_key, req, meta)
        logger.info("[GRAB QUEUED] key=%s kind=%s url=%s", page_key, meta["kind"], req.url[:140])
        return {
            "accepted": True,
            "key": page_key,
            "safeKey": safe_key,
            "status": "queued",
            "reason": None,
        }

    def _is_hls_request(self, req: GrabRequest) -> bool:
        if req.kind.lower() == "hls":
            return True
        if _HLS_EXT_RE.search(req.url):
            return True
        ct = (req.contentType or "").lower()
        if "mpegurl" in ct:
            return True
        return False

    def _build_referer_candidates(self, req: GrabRequest, media_url: str) -> list[Optional[str]]:
        cands: list[Optional[str]] = []
        for candidate in (req.frameUrl, req.referer, req.pageUrl, _origin_of(media_url), None):
            if candidate and not candidate.endswith("/") and urlparse(candidate).path == "":
                candidate = candidate + "/"
            if candidate not in cands:
                cands.append(candidate)
        return cands

    def _cffi_headers(self, req: GrabRequest, referer: Optional[str], extra: Optional[dict[str, str]] = None) -> dict[str, str]:
        headers: dict[str, str] = {
            "User-Agent": req.userAgent or config.DEFAULT_UA,
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }
        if referer:
            headers["Referer"] = referer
            origin = _origin_of(referer)
            if origin:
                headers["Origin"] = origin
        if req.cookie:
            headers["Cookie"] = req.cookie
        if extra:
            headers.update(extra)
        return headers

    def _cffi_get_bytes(
        self,
        session: cffi_requests.Session,
        url: str,
        req: GrabRequest,
        referer_candidates: list[Optional[str]],
        byte_range: Optional[tuple[int, int]] = None,
        timeout: float = 25.0,
    ) -> tuple[bytes, str, str, Optional[str]]:
        """
        Fetch bytes via curl_cffi with retry + automatic Referer fallback on HTTP 403.
        Returns (content_bytes, final_url, content_type, working_referer).
        """
        extra = {"Range": f"bytes={byte_range[0]}-{byte_range[1]}"} if byte_range else None
        last_err: Optional[Exception] = None

        for ref in referer_candidates:
            backoff = 0.5
            for attempt in range(1, 4):
                if self._closed:
                    raise RuntimeError("server_closed")
                try:
                    resp = session.get(
                        url,
                        headers=self._cffi_headers(req, ref, extra),
                        allow_redirects=True,
                        timeout=timeout,
                    )
                    if resp.status_code == 403:
                        if b"BucketPunish" in resp.content[:512]:
                            raise RuntimeError("HTTP 403 Aliyun OSS BucketPunish (CDN bucket suspended; try another video)")
                        last_err = RuntimeError(f"HTTP 403 with Referer={ref!r}")
                        break  # Try next Referer candidate immediately
                    if resp.status_code not in (200, 206):
                        raise RuntimeError(f"HTTP {resp.status_code}")
                    ct = resp.headers.get("content-type", "")
                    return bytes(resp.content), str(resp.url), ct, ref
                except Exception as e:
                    last_err = e
                    if attempt < 3:
                        time.sleep(backoff)
                        backoff *= 2.0
        raise RuntimeError(f"curl_cffi GET failed for {url[:120]}: {last_err}")

    def _run_job(self, page_key: str, safe_key: str, req: GrabRequest, meta: dict[str, Any]) -> None:
        entry_dir = self._entry_dir(safe_key)
        parts_dir = entry_dir / "parts"
        out_part = entry_dir / "out.part.mp4"
        out_final = entry_dir / "out.mp4"

        try:
            if parts_dir.exists():
                shutil.rmtree(parts_dir, ignore_errors=True)
            parts_dir.mkdir(parents=True, exist_ok=True)
            if out_part.exists():
                out_part.unlink()

            meta["status"] = "downloading"
            meta["updatedAt"] = utc_now_iso()
            self._write_meta(safe_key, meta)

            do_transcode = self.transcode if req.transcode is None else bool(req.transcode)

            # Determine HLS vs direct by inspecting URL/Content-Type (and sniffing playlist header if ambiguous)
            if self._is_hls_request(req):
                meta["kind"] = "hls"
                self._execute_hls_ts_pipeline(safe_key, req, meta, parts_dir, out_part, do_transcode)
            else:
                meta["kind"] = "direct"
                self._execute_direct_pipeline(safe_key, req, meta, parts_dir, out_part, do_transcode)

            # Stage: ffprobe verification (spec 5.8)
            meta["status"] = "verifying"
            meta["updatedAt"] = utc_now_iso()
            self._write_meta(safe_key, meta)

            if not out_part.exists():
                raise RuntimeError("Output file missing after ffmpeg mux")

            probe = probe_video_file(self.ffprobe_path, out_part)
            min_bytes = int(self.min_size_mb * 1024 * 1024)
            if probe["sizeBytes"] < min_bytes:
                raise RuntimeError(
                    f"File too small ({probe['sizeBytes']} B < min {min_bytes} B); likely ad/error clip"
                )

            # Atomic promote out.part.mp4 -> out.mp4 & clean temp TS parts
            os.replace(out_part, out_final)
            shutil.rmtree(parts_dir, ignore_errors=True)

            now = utc_now_iso()
            meta.update(
                {
                    "status": "complete",
                    "sizeBytes": probe["sizeBytes"],
                    "durationSec": probe["durationSec"],
                    "width": probe["width"],
                    "height": probe["height"],
                    "codec": probe["codec"],
                    "hasAudio": probe["hasAudio"],
                    "transcoded": do_transcode,
                    "progressPct": 100.0,
                    "error": None,
                    "updatedAt": now,
                    "lastAccessAt": now,
                }
            )
            self._write_meta(safe_key, meta)
            logger.info(
                "[GRAB COMPLETE] key=%s size=%.2f MB duration=%.1fs %dx%d %s (transcoded=%s)",
                page_key,
                probe["sizeBytes"] / (1024 * 1024),
                probe["durationSec"],
                probe["width"],
                probe["height"],
                probe["codec"],
                do_transcode,
            )

            # Enforce MAX_CACHE_GB via LRU eviction
            self._evict_lru_if_needed(keep_safe_key=safe_key)
        except Exception as e:
            logger.error("[GRAB FAILED] key=%s: %s", page_key, e)
            try:
                if out_part.exists():
                    out_part.unlink()
                if parts_dir.exists():
                    shutil.rmtree(parts_dir, ignore_errors=True)
            except Exception:
                pass
            meta["status"] = "failed"
            meta["error"] = str(e)[:500]
            meta["updatedAt"] = utc_now_iso()
            try:
                self._write_meta(safe_key, meta)
            except Exception:
                pass
        finally:
            with self._lock:
                self._active_keys.discard(safe_key)

    def _download_hls_track(
        self,
        playlist_url: str,
        req: GrabRequest,
        referer_candidates: list[Optional[str]],
        track_dir: Path,
        safe_key: str,
        meta: dict[str, Any],
        progress_offset: int = 0,
        progress_total_override: Optional[int] = None,
    ) -> tuple[_ParsedMediaPlaylist, list[Path], Optional[str]]:
        """
        Download a single HLS media playlist's keys, init maps, and all TS/fMP4 segments via curl_cffi.
        Returns (parsed_playlist, ordered_local_segment_paths, working_referer).
        """
        track_dir.mkdir(parents=True, exist_ok=True)
        with cffi_requests.Session(impersonate=config.GRAB_IMPERSONATE) as master_sess:
            raw_m3u8, final_url, _ct, working_ref = self._cffi_get_bytes(
                master_sess, playlist_url, req, referer_candidates, timeout=20.0
            )

        text = raw_m3u8.decode("utf-8", errors="replace").lstrip("\ufeff")
        if "#EXTM3U" not in text[:256]:
            raise RuntimeError(f"Invalid m3u8 playlist (missing #EXTM3U) from {final_url[:100]}")

        parsed = parse_media_playlist(text, final_url)
        if not parsed.segments:
            raise RuntimeError(f"Empty HLS media playlist from {final_url[:100]}")

        ordered_refs = [working_ref] + [r for r in referer_candidates if r != working_ref]
        total_segs = progress_total_override if progress_total_override is not None else len(parsed.segments)
        meta["totalSegments"] = total_segs
        self._write_meta(safe_key, meta)

        # 1) Download any AES-128 keys & EXT-X-MAP init segments first via curl_cffi
        with cffi_requests.Session(impersonate=config.GRAB_IMPERSONATE) as aux_sess:
            for k in parsed.keys:
                if k.uri:
                    key_bytes, _, _, _ = self._cffi_get_bytes(aux_sess, k.uri, req, ordered_refs, timeout=20.0)
                    if not key_bytes:
                        raise RuntimeError(f"Empty HLS key from {k.uri}")
                    k.local_name = f"key_{k.index}.bin"
                    (track_dir / k.local_name).write_bytes(key_bytes)

            for m in parsed.maps:
                map_bytes, _, _, _ = self._cffi_get_bytes(
                    aux_sess, m.uri, req, ordered_refs, byte_range=m.byte_range, timeout=25.0
                )
                if not map_bytes:
                    raise RuntimeError(f"Empty HLS EXT-X-MAP from {m.uri}")
                m.local_name = f"init_{m.index}.bin"
                (track_dir / m.local_name).write_bytes(map_bytes)

        # 2) Download all TS / media segments concurrently via thread-local curl_cffi Sessions
        tls = threading.local()
        sessions_to_close: list[cffi_requests.Session] = []
        sess_lock = threading.Lock()

        def get_worker_session() -> cffi_requests.Session:
            s = getattr(tls, "session", None)
            if s is None:
                s = cffi_requests.Session(impersonate=config.GRAB_IMPERSONATE)
                tls.session = s
                with sess_lock:
                    sessions_to_close.append(s)
            return s

        has_encryption = len(parsed.keys) > 0
        has_map = len(parsed.maps) > 0
        seg_paths: list[Optional[Path]] = [None] * len(parsed.segments)
        completed_count = 0
        last_flush = time.monotonic()
        progress_lock = threading.Lock()

        def fetch_one(seg: _HlsSegment) -> tuple[int, Path]:
            with self._global_dl_sem:
                sess = get_worker_session()
                data, _fu, ct, _ = self._cffi_get_bytes(
                    sess, seg.uri, req, ordered_refs, byte_range=seg.byte_range, timeout=30.0
                )
            if not data:
                raise RuntimeError(f"Empty segment #{seg.index}")
            if "text/html" in ct.lower() or _looks_like_html_error(data):
                raise RuntimeError(f"Segment #{seg.index} returned HTML error page instead of media")

            if not has_encryption and not has_map:
                data = _strip_fake_image_header_if_ts(data)

            ext = ".m4s" if has_map else ".ts"
            dest = track_dir / f"seg_{seg.index:06d}{ext}"
            tmp = track_dir / f"seg_{seg.index:06d}{ext}.tmp"
            tmp.write_bytes(data)
            os.replace(tmp, dest)
            return seg.index, dest

        try:
            with ThreadPoolExecutor(max_workers=self.ts_workers, thread_name_prefix="rb-ts") as pool:
                futs = [pool.submit(fetch_one, seg) for seg in parsed.segments]
                for fut in as_completed(futs):
                    idx, dest_path = fut.result()
                    seg_paths[idx] = dest_path
                    with progress_lock:
                        completed_count += 1
                        now_m = time.monotonic()
                        if now_m - last_flush >= 2.0 or completed_count == len(parsed.segments):
                            done_total = progress_offset + completed_count
                            meta["downloadedSegments"] = done_total
                            meta["progressPct"] = round(min(99.0, (done_total / max(1, total_segs)) * 100.0), 1)
                            meta["updatedAt"] = utc_now_iso()
                            self._write_meta(safe_key, meta)
                            last_flush = now_m
        finally:
            for s in sessions_to_close:
                try:
                    s.close()
                except Exception:
                    pass

        ordered_paths = [p for p in seg_paths if p is not None]
        if len(ordered_paths) != len(parsed.segments):
            raise RuntimeError(f"Incomplete segment download: {len(ordered_paths)}/{len(parsed.segments)}")

        return parsed, ordered_paths, working_ref

    def _write_local_m3u8(self, track_dir: Path, parsed: _ParsedMediaPlaylist, seg_paths: list[Path]) -> Path:
        """Write an offline-only local.m3u8 referencing purely relative files inside track_dir."""
        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:7" if parsed.maps else "#EXT-X-VERSION:3",
            f"#EXT-X-TARGETDURATION:{parsed.target_duration}",
            f"#EXT-X-MEDIA-SEQUENCE:{parsed.media_sequence}",
            "#EXT-X-PLAYLIST-TYPE:VOD",
        ]
        last_key: Optional[int] = -1
        last_map: Optional[int] = -1

        for seg, path in zip(parsed.segments, seg_paths):
            if seg.key_index != last_key:
                if seg.key_index is None:
                    lines.append("#EXT-X-KEY:METHOD=NONE")
                else:
                    k = parsed.keys[seg.key_index]
                    parts = [f"METHOD={k.method}"]
                    if k.local_name:
                        parts.append(f'URI="{k.local_name}"')
                    if k.iv:
                        parts.append(f"IV={k.iv}")
                    lines.append("#EXT-X-KEY:" + ",".join(parts))
                last_key = seg.key_index

            if seg.map_index != last_map and seg.map_index is not None:
                m = parsed.maps[seg.map_index]
                if m.local_name:
                    lines.append(f'#EXT-X-MAP:URI="{m.local_name}"')
                last_map = seg.map_index

            lines.append(f"#EXTINF:{seg.duration:.6f},")
            lines.append(path.name)

        lines.append("#EXT-X-ENDLIST")
        m3u8_path = track_dir / "local.m3u8"
        m3u8_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return m3u8_path

    def _binary_concat_ts(self, track_dir: Path, seg_paths: list[Path]) -> Path:
        """
        Spec 0.3 & 8.1(2): Binary-concatenate raw MPEG-TS segments in order into `concat.ts`
        (TS is a stream format — direct binary concat is lossless, ultra-fast, and avoids concat demuxer quirks).
        """
        concat_ts = track_dir / "concat.ts"
        with open(concat_ts, "wb") as out_f:
            for p in seg_paths:
                with open(p, "rb") as in_f:
                    shutil.copyfileobj(in_f, out_f, length=1024 * 1024)
                try:
                    p.unlink()
                except Exception:
                    pass
        return concat_ts

    def _write_concat_list(self, track_dir: Path, seg_paths: list[Path]) -> Path:
        """Write ffmpeg concat demuxer file using safe relative filenames."""
        lines = [f"file '{p.name}'" for p in seg_paths]
        concat_path = track_dir / "concat.txt"
        concat_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return concat_path

    def _run_local_ffmpeg(
        self,
        input_args: list[str],
        out_part: Path,
        cwd: Path,
        do_transcode: bool,
        add_aac_bsf: bool,
        has_separate_audio: bool = False,
    ) -> None:
        """Run local ffmpeg strictly against local files (no remote URLs)."""
        base_cmd = [self.ffmpeg_path, "-y", "-hide_banner", "-loglevel", "error", *input_args]
        map_args = ["-map", "0:v:0", "-map", "1:a:0"] if has_separate_audio else []

        if do_transcode:
            enc = self.hw_encoder
            if enc:
                v_args = [
                    "-c:v",
                    enc,
                    "-b:v",
                    config.GRAB_TARGET_BITRATE,
                    "-vf",
                    f"scale=-2:{config.GRAB_TARGET_HEIGHT}",
                ]
                if "nvenc" in enc:
                    v_args.extend(["-preset", "p4"])
            else:
                v_args = [
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-b:v",
                    config.GRAB_TARGET_BITRATE,
                    "-vf",
                    f"scale=-2:{config.GRAB_TARGET_HEIGHT}",
                ]
            cmd = [*base_cmd, *map_args, *v_args, "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(out_part)]
            proc = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, timeout=1800)
            if proc.returncode != 0:
                raise RuntimeError(f"Local ffmpeg transcode failed: {proc.stderr.strip()[:400]}")
            return

        # Fast path: remux (-c copy) with safe fallbacks for non-ADTS audio
        attempts: list[list[str]] = []
        if add_aac_bsf:
            attempts.append([*base_cmd, *map_args, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", str(out_part)])
        attempts.append([*base_cmd, *map_args, "-c", "copy", "-movflags", "+faststart", str(out_part)])
        attempts.append([*base_cmd, *map_args, "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(out_part)])

        last_err = ""
        for cmd in attempts:
            proc = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, timeout=600)
            if proc.returncode == 0 and out_part.exists() and out_part.stat().st_size > 0:
                return
            last_err = proc.stderr.strip()[:400]
        raise RuntimeError(f"Local ffmpeg concat/remux failed: {last_err}")

    def _execute_hls_ts_pipeline(
        self,
        safe_key: str,
        req: GrabRequest,
        meta: dict[str, Any],
        parts_dir: Path,
        out_part: Path,
        do_transcode: bool,
    ) -> None:
        """
        HLS pipeline:
          1) curl_cffi fetches manifest (+ resolves Master Playlist -> highest-bandwidth variant)
          2) curl_cffi concurrently downloads every TS/fMP4 segment & AES key into parts/
          3) local ffmpeg concatenates/remuxes purely from local files on disk
        """
        ref_cands = self._build_referer_candidates(req, req.url)

        with cffi_requests.Session(impersonate=config.GRAB_IMPERSONATE) as sess:
            raw_manifest, final_url, _ct, working_ref = self._cffi_get_bytes(
                sess, req.url, req, ref_cands, timeout=20.0
            )
        manifest_text = raw_manifest.decode("utf-8", errors="replace").lstrip("\ufeff")
        if "#EXTM3U" not in manifest_text[:256]:
            raise RuntimeError(f"Manifest did not contain #EXTM3U (got: {manifest_text[:80]!r})")

        ordered_refs = [working_ref] + [r for r in ref_cands if r != working_ref]
        video_playlist_url = final_url
        audio_playlist_url: Optional[str] = None

        if "#EXT-X-STREAM-INF" in manifest_text:
            best_v, best_a = parse_master_playlist(manifest_text, final_url)
            if not best_v:
                raise RuntimeError("Master playlist contained no playable video variants")
            video_playlist_url = best_v
            audio_playlist_url = best_a
            logger.info("[GRAB HLS] Master playlist resolved -> video=%s audio=%s", video_playlist_url[:120], audio_playlist_url)

        # Download video segments locally via curl_cffi
        video_dir = parts_dir / "video"
        v_parsed, v_paths, working_ref = self._download_hls_track(
            video_playlist_url, req, ordered_refs, video_dir, safe_key, meta
        )

        # Optional separate audio playlist (common on some HLS masters)
        a_parsed: Optional[_ParsedMediaPlaylist] = None
        a_paths: list[Path] = []
        audio_dir = parts_dir / "audio"
        if audio_playlist_url:
            a_parsed, a_paths, _ = self._download_hls_track(
                audio_playlist_url,
                req,
                [working_ref] + ordered_refs,
                audio_dir,
                safe_key,
                meta,
                progress_offset=len(v_paths),
                progress_total_override=len(v_paths) * 2,
            )

        # Local offline concatenation with ffmpeg (zero network access!)
        v_needs_local_m3u8 = bool(v_parsed.keys or v_parsed.maps)
        if not a_parsed:
            if not v_needs_local_m3u8:
                concat_ts = self._binary_concat_ts(video_dir, v_paths)
                self._run_local_ffmpeg(
                    input_args=["-i", concat_ts.name],
                    out_part=out_part,
                    cwd=video_dir,
                    do_transcode=do_transcode,
                    add_aac_bsf=True,
                )
            else:
                local_m3u8 = self._write_local_m3u8(video_dir, v_parsed, v_paths)
                self._run_local_ffmpeg(
                    input_args=[
                        "-allowed_extensions",
                        "ALL",
                        "-protocol_whitelist",
                        "file,crypto",
                        "-i",
                        local_m3u8.name,
                    ],
                    out_part=out_part,
                    cwd=video_dir,
                    do_transcode=do_transcode,
                    add_aac_bsf=not bool(v_parsed.maps),
                )
        else:
            # Dual local HLS track muxing
            v_m3u8 = self._write_local_m3u8(video_dir, v_parsed, v_paths)
            a_m3u8 = self._write_local_m3u8(audio_dir, a_parsed, a_paths)
            self._run_local_ffmpeg(
                input_args=[
                    "-allowed_extensions",
                    "ALL",
                    "-protocol_whitelist",
                    "file,crypto",
                    "-i",
                    str(v_m3u8),
                    "-allowed_extensions",
                    "ALL",
                    "-protocol_whitelist",
                    "file,crypto",
                    "-i",
                    str(a_m3u8),
                ],
                out_part=out_part,
                cwd=parts_dir,
                do_transcode=do_transcode,
                add_aac_bsf=not bool(v_parsed.maps or a_parsed.maps),
                has_separate_audio=True,
            )

    def _execute_direct_pipeline(
        self,
        safe_key: str,
        req: GrabRequest,
        meta: dict[str, Any],
        parts_dir: Path,
        out_part: Path,
        do_transcode: bool,
    ) -> None:
        """
        Direct video (.mp4/.webm/stream) pipeline:
          1) Stream to local parts/raw.media via curl_cffi (never ffmpeg direct URL!)
          2) Local ffmpeg faststart remux (or optional transcode) -> out.part.mp4
        """
        ref_cands = self._build_referer_candidates(req, req.url)
        raw_file = parts_dir / "raw.media"
        last_err: Optional[Exception] = None
        downloaded_ok = False

        with cffi_requests.Session(impersonate=config.GRAB_IMPERSONATE) as sess:
            for ref in ref_cands:
                backoff = 0.5
                for attempt in range(1, 4):
                    if self._closed:
                        raise RuntimeError("server_closed")
                    try:
                        resp = sess.get(
                            req.url,
                            headers=self._cffi_headers(req, ref),
                            allow_redirects=True,
                            stream=True,
                            timeout=60.0,
                        )
                        try:
                            if resp.status_code == 403:
                                last_err = RuntimeError(f"HTTP 403 with Referer={ref!r}")
                                break
                            if resp.status_code not in (200, 206):
                                raise RuntimeError(f"HTTP {resp.status_code}")

                            ct = (resp.headers.get("content-type") or "").lower()
                            if "text/html" in ct:
                                raise RuntimeError(f"Direct URL returned HTML (content-type={ct})")
                            if "mpegurl" in ct:
                                # Server returned an m3u8 playlist behind a non-.m3u8 URL!
                                resp.close()
                                meta["kind"] = "hls"
                                self._execute_hls_ts_pipeline(safe_key, req, meta, parts_dir, out_part, do_transcode)
                                return

                            cl_hdr = resp.headers.get("content-length")
                            total_expected = int(cl_hdr) if cl_hdr and cl_hdr.isdigit() else 0
                            written = 0
                            first_chunk_checked = False
                            last_flush = time.monotonic()

                            with open(raw_file, "wb") as f:
                                for chunk in resp.iter_content(chunk_size=65536):
                                    if not chunk:
                                        continue
                                    if not first_chunk_checked:
                                        first_chunk_checked = True
                                        if _looks_like_html_error(chunk):
                                            raise RuntimeError("Direct stream body starts with HTML error page")
                                        if chunk.lstrip(b"\xef\xbb\xbf").startswith(b"#EXTM3U"):
                                            # Sniffed an HLS playlist served under generic URL
                                            f.close()
                                            resp.close()
                                            meta["kind"] = "hls"
                                            self._execute_hls_ts_pipeline(
                                                safe_key, req, meta, parts_dir, out_part, do_transcode
                                            )
                                            return
                                    f.write(chunk)
                                    written += len(chunk)
                                    now_m = time.monotonic()
                                    if total_expected > 0 and (now_m - last_flush >= 2.0):
                                        meta["progressPct"] = round(min(99.0, (written / total_expected) * 100.0), 1)
                                        meta["updatedAt"] = utc_now_iso()
                                        self._write_meta(safe_key, meta)
                                        last_flush = now_m
                            if written <= 0:
                                raise RuntimeError("Direct download received 0 bytes")
                            downloaded_ok = True
                            break
                        finally:
                            resp.close()
                    except Exception as e:
                        last_err = e
                        if attempt < 3:
                            time.sleep(backoff)
                            backoff *= 2.0
                if downloaded_ok:
                    break

        if not downloaded_ok:
            raise RuntimeError(f"Direct curl_cffi download failed: {last_err}")

        self._run_local_ffmpeg(
            input_args=["-i", raw_file.name],
            out_part=out_part,
            cwd=parts_dir,
            do_transcode=do_transcode,
            add_aac_bsf=False,
        )

    # -----------------------------------------------------------------------
    # Query, serving, unmark, delete, stats, and LRU eviction
    # -----------------------------------------------------------------------
    def get_complete_keys(self) -> list[str]:
        """Return all `complete` pageKeys with valid out.mp4 on disk (for GET /api/keys)."""
        keys: list[str] = []
        if not self.cache_dir.exists():
            return keys
        for sub in sorted(self.cache_dir.iterdir()):
            if not sub.is_dir():
                continue
            out_file = sub / "out.mp4"
            meta_file = sub / "meta.json"
            if not out_file.exists() or not meta_file.exists():
                continue
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
                if meta.get("status") == "complete" and meta.get("key"):
                    keys.append(str(meta["key"]))
            except Exception:
                continue
        return keys

    def resolve_local_mp4(self, key_or_url: str, bump_play_count: bool = False) -> Optional[Path]:
        """Resolve `out.mp4` path for a complete cached entry (supports pageKey or safeKey)."""
        _, safe_key = compute_page_key(key_or_url)
        entry_dir = self._entry_dir(safe_key)
        out_file = entry_dir / "out.mp4"
        meta = self._read_meta(safe_key)
        if not meta or meta.get("status") != "complete" or not out_file.exists():
            return None

        if bump_play_count:
            with self._lock:
                meta["playCount"] = int(meta.get("playCount") or 0) + 1
                meta["lastAccessAt"] = utc_now_iso()
                try:
                    self._write_meta(safe_key, meta)
                except Exception:
                    pass
        return out_file

    def get_video(self, key_or_url: str) -> dict[str, Any]:
        page_key, safe_key = compute_page_key(key_or_url)
        meta = self._read_meta(safe_key)
        if not meta:
            return {"exists": False, "key": page_key, "safeKey": safe_key, "status": "missing"}
        out_file = self._entry_dir(safe_key) / "out.mp4"
        return {
            "exists": True,
            **meta,
            "fileExists": out_file.exists(),
        }

    def list_videos(self, limit: int = 100, offset: int = 0) -> dict[str, Any]:
        items: list[dict[str, Any]] = []
        if self.cache_dir.exists():
            for sub in sorted(self.cache_dir.iterdir()):
                if not sub.is_dir() or not (sub / "meta.json").exists():
                    continue
                try:
                    meta = json.loads((sub / "meta.json").read_text(encoding="utf-8"))
                    meta["fileExists"] = (sub / "out.mp4").exists()
                    items.append(meta)
                except Exception:
                    continue
        items.sort(key=lambda x: x.get("updatedAt") or x.get("createdAt") or "", reverse=True)
        return {"items": items[offset : offset + limit], "total": len(items)}

    def unmark_broken(self, key_or_url: str, reason: str = "client_playback_error") -> dict[str, Any]:
        """Mark a cached video failed & remove corrupted out.mp4 so client falls back next load (spec 6.3)."""
        page_key, safe_key = compute_page_key(key_or_url)
        with self._lock:
            entry_dir = self._entry_dir(safe_key)
            meta = self._read_meta(safe_key)
            out_file = entry_dir / "out.mp4"
            if out_file.exists():
                try:
                    out_file.unlink()
                except Exception:
                    pass
            if meta:
                meta["status"] = "failed"
                meta["error"] = reason
                meta["updatedAt"] = utc_now_iso()
                self._write_meta(safe_key, meta)
                return {"unmarked": True, "key": page_key, "safeKey": safe_key, "status": "failed"}
            return {"unmarked": False, "key": page_key, "safeKey": safe_key, "status": "missing"}

    def delete_video(self, key_or_url: str) -> bool:
        _, safe_key = compute_page_key(key_or_url)
        with self._lock:
            entry_dir = self._entry_dir(safe_key)
            if entry_dir.exists():
                shutil.rmtree(entry_dir, ignore_errors=False)
                return True
            return False

    def get_stats(self) -> dict[str, Any]:
        count = 0
        complete_count = 0
        total_bytes = 0
        if self.cache_dir.exists():
            for sub in self.cache_dir.iterdir():
                if not sub.is_dir() or not (sub / "meta.json").exists():
                    continue
                count += 1
                out_file = sub / "out.mp4"
                if out_file.exists():
                    total_bytes += out_file.stat().st_size
                try:
                    meta = json.loads((sub / "meta.json").read_text(encoding="utf-8"))
                    if meta.get("status") == "complete":
                        complete_count += 1
                except Exception:
                    pass
        usage = shutil.disk_usage(self.cache_dir)
        with self._lock:
            active_jobs = list(self._active_keys)
        return {
            "count": count,
            "completeCount": complete_count,
            "activeJobs": len(active_jobs),
            "activeKeys": active_jobs,
            "totalBytes": total_bytes,
            "maxBytes": int(self.max_cache_gb * (1024**3)),
            "freeBytes": usage.free,
            "cacheDir": str(self.cache_dir),
            "transcodeEnabled": self.transcode,
            "hwEncoder": self._hw_encoder if self._hw_encoder_checked else "lazy",
        }

    def _evict_lru_if_needed(self, keep_safe_key: Optional[str] = None) -> list[str]:
        """Evict least-used / oldest complete entries when total size exceeds MAX_CACHE_GB."""
        max_bytes = int(self.max_cache_gb * (1024**3))
        if max_bytes <= 0 or not self.cache_dir.exists():
            return []

        entries: list[tuple[int, str, str, int, Path]] = []
        total_bytes = 0
        for sub in self.cache_dir.iterdir():
            if not sub.is_dir():
                continue
            out_file = sub / "out.mp4"
            if not out_file.exists():
                continue
            sz = out_file.stat().st_size
            total_bytes += sz
            if sub.name == keep_safe_key:
                continue
            meta = self._read_meta(sub.name) or {}
            if meta.get("status") != "complete":
                continue
            play_cnt = int(meta.get("playCount") or 0)
            last_acc = str(meta.get("lastAccessAt") or meta.get("createdAt") or "")
            entries.append((play_cnt, last_acc, sub.name, sz, sub))

        if total_bytes <= max_bytes:
            return []

        # Evict lowest playCount first, then oldest lastAccessAt
        entries.sort(key=lambda x: (x[0], x[1]))
        evicted: list[str] = []
        with self._lock:
            for _pc, _la, sk, sz, sub in entries:
                if total_bytes <= max_bytes:
                    break
                if sk in self._active_keys:
                    continue
                try:
                    shutil.rmtree(sub, ignore_errors=False)
                    total_bytes -= sz
                    evicted.append(sk)
                    logger.info("[GRAB LRU EVICT] removed %s (%.2f MB)", sk, sz / (1024 * 1024))
                except Exception as e:
                    logger.warning("LRU eviction failed for %s: %s", sk, e)
        return evicted

    def close(self) -> None:
        self._closed = True
        self._executor.shutdown(wait=True, cancel_futures=True)
