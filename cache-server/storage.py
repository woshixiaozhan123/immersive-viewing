"""Sparse-file storage & byte-range coverage index for local video cache (spec v2)."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import config

logger = logging.getLogger("rb-cache.storage")

_SAFE_KEY_RE = re.compile(r"[^A-Za-z0-9._-]+")
_HTTP_RANGE_RE = re.compile(r"^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$", re.IGNORECASE)


def parse_http_range(range_header: str, total_bytes: int) -> Optional[tuple[int, int]]:
    """
    Parse a single HTTP Range header against the authoritative `total_bytes` (from meta.json, NEVER st_size).
    Supports:
      - bytes=start-end
      - bytes=start-
      - bytes=-suffix
    Returns (start, end) inclusive if satisfiable, or None if invalid / unsatisfiable (-> 416).
    """
    if not range_header or total_bytes <= 0:
        return None
    if "," in range_header:
        # Multi-range not needed for media players; fall back cleanly with 416
        return None
    m = _HTTP_RANGE_RE.match(range_header)
    if not m:
        return None
    start_s, end_s = m.group(1), m.group(2)
    if not start_s and not end_s:
        return None

    if not start_s:
        # Suffix range: bytes=-N (last N bytes of the true file)
        suffix = int(end_s)
        if suffix <= 0:
            return None
        start = max(0, total_bytes - suffix)
        end = total_bytes - 1
    else:
        start = int(start_s)
        if start < 0 or start >= total_bytes:
            return None
        if not end_s:
            end = total_bytes - 1
        else:
            end = min(int(end_s), total_bytes - 1)
            if end < start:
                return None

    return start, end


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sanitize_key(video_key: str) -> str:
    """Convert videoKey like 'bili:137649199:1:100022' into a safe Windows/POSIX dir name."""
    cleaned = _SAFE_KEY_RE.sub("_", video_key.strip()).strip("._")
    if not cleaned or cleaned in (".", ".."):
        raise ValueError(f"Invalid videoKey: {video_key!r}")
    return cleaned


def infer_site(video_key: str) -> str:
    if video_key.startswith("bili:"):
        return "bilibili"
    if video_key.startswith("yt:"):
        return "youtube"
    return "unknown"


def infer_kind_from_key(video_key: str, fallback: str = "video") -> str:
    parts = video_key.split(":")
    if len(parts) >= 3 and parts[0] == "bili":
        if parts[2] == "2":
            return "audio"
        if parts[2] == "1":
            return "video"
    return fallback


def merge_ranges(ranges: list[list[int]]) -> list[list[int]]:
    """Merge overlapping or adjacent closed byte intervals [start, end]."""
    if not ranges:
        return []
    ordered = sorted((int(s), int(e)) for s, e in ranges if e >= s)
    if not ordered:
        return []
    out: list[list[int]] = [[ordered[0][0], ordered[0][1]]]
    for s, e in ordered[1:]:
        if s <= out[-1][1] + 1:
            if e > out[-1][1]:
                out[-1][1] = e
        else:
            out.append([s, e])
    return out


def is_covered(merged: list[list[int]], start: int, end: int) -> bool:
    """Return True iff closed interval [start, end] is fully covered by sorted disjoint merged ranges."""
    if start < 0 or end < start or not merged:
        return False
    pos = start
    for s, e in merged:
        if s > pos:
            return False
        if e >= end:
            return True
        if e + 1 > pos:
            pos = e + 1
    return False


def covered_bytes(merged: list[list[int]]) -> int:
    return sum(e - s + 1 for s, e in merged)


def _atomic_write_json(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    payload = json.dumps(obj, indent=2, ensure_ascii=False)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(payload)
    os.replace(tmp, path)


class _TrackState:
    def __init__(self, video_key: str, dir_path: Path, meta: dict[str, Any], raw_ranges: list[list[int]]):
        self.video_key = video_key
        self.dir_path = dir_path
        self.meta = meta
        self.raw_ranges = raw_ranges
        self.merged = merge_ranges(raw_ranges)
        self.dirty_ranges = False
        self.dirty_meta = False
        self.last_flush_ts = 0.0
        self.lock = threading.RLock()


class VideoCacheStorage:
    """Thread-safe sparse-file store with throttled ranges.json persistence."""

    def __init__(self, root_dir: Path | None = None):
        self.root_dir = Path(root_dir or config.CACHE_DIR)
        self.root_dir.mkdir(parents=True, exist_ok=True)
        self._global_lock = threading.RLock()
        self._tracks: dict[str, _TrackState] = {}

    def key_dir(self, video_key: str) -> Path:
        return self.root_dir / sanitize_key(video_key)

    def data_filename(self, kind: str) -> str:
        return "audio.bin" if kind == "audio" else "video.bin"

    def _load_or_init_track(
        self,
        video_key: str,
        kind: str = "video",
        page_url: Optional[str] = None,
        title: Optional[str] = None,
        content_type: Optional[str] = None,
        bandwidth: Optional[int] = None,
        codecid: Optional[int] = None,
        duration: Optional[float] = None,
    ) -> _TrackState:
        with self._global_lock:
            existing = self._tracks.get(video_key)
            if existing is not None:
                return existing

            d = self.key_dir(video_key)
            meta_path = d / "meta.json"
            ranges_path = d / "ranges.json"

            resolved_kind = infer_kind_from_key(video_key, kind)
            now = utc_now_iso()
            meta: dict[str, Any] = {
                "videoKey": video_key,
                "site": infer_site(video_key),
                "kind": resolved_kind,
                "title": title or "",
                "pageUrl": page_url or "",
                "contentType": content_type or ("audio/mp4" if resolved_kind == "audio" else "video/mp4"),
                "bandwidth": bandwidth,
                "codecid": codecid,
                "duration": duration,
                "totalBytes": None,
                "complete": False,
                "createdAt": now,
                "lastAccessAt": now,
            }
            if meta_path.exists():
                try:
                    loaded = json.loads(meta_path.read_text(encoding="utf-8"))
                    if isinstance(loaded, dict):
                        meta.update(loaded)
                except Exception as e:
                    logger.warning("Failed to read %s: %s", meta_path, e)

            raw_ranges: list[list[int]] = []
            if ranges_path.exists():
                try:
                    r_obj = json.loads(ranges_path.read_text(encoding="utf-8"))
                    if isinstance(r_obj, dict):
                        raw = r_obj.get("ranges") or r_obj.get("merged") or []
                        raw_ranges = [[int(x[0]), int(x[1])] for x in raw if isinstance(x, list) and len(x) == 2]
                except Exception as e:
                    logger.warning("Failed to read %s: %s", ranges_path, e)

            st = _TrackState(video_key=video_key, dir_path=d, meta=meta, raw_ranges=raw_ranges)
            self._tracks[video_key] = st
            return st

    def is_range_covered(self, video_key: str, start: int, end: Optional[int]) -> bool:
        d = self.key_dir(video_key)
        if video_key not in self._tracks and not (d / "meta.json").exists():
            return False
        st = self._load_or_init_track(video_key)
        with st.lock:
            if end is None:
                total = st.meta.get("totalBytes")
                if not total:
                    return False
                end = int(total) - 1
            return is_covered(st.merged, start, end)

    def write_range_bytes(
        self,
        video_key: str,
        kind: str,
        start: int,
        payload: bytes,
        total_bytes: Optional[int] = None,
        page_url: Optional[str] = None,
        title: Optional[str] = None,
        content_type: Optional[str] = None,
        bandwidth: Optional[int] = None,
        codecid: Optional[int] = None,
        duration: Optional[float] = None,
    ) -> dict[str, Any]:
        """Write downloaded bytes into sparse video.bin / audio.bin at exact offset `start`."""
        if not payload:
            raise ValueError("Empty payload for range write")
        if start < 0:
            raise ValueError(f"Negative range start: {start}")

        st = self._load_or_init_track(
            video_key=video_key,
            kind=kind,
            page_url=page_url,
            title=title,
            content_type=content_type,
            bandwidth=bandwidth,
            codecid=codecid,
            duration=duration,
        )
        end = start + len(payload) - 1

        with st.lock:
            st.dir_path.mkdir(parents=True, exist_ok=True)
            resolved_kind = st.meta.get("kind") or infer_kind_from_key(video_key, kind)
            st.meta["kind"] = resolved_kind
            data_file = st.dir_path / self.data_filename(resolved_kind)

            mode = "r+b" if data_file.exists() else "w+b"
            with open(data_file, mode) as f:
                f.seek(start)
                # Sequential 64KB chunked write per performance budget (spec section 10)
                view = memoryview(payload)
                chunk_size = 65536
                for offset in range(0, len(payload), chunk_size):
                    f.write(view[offset : offset + chunk_size])

            # Update metadata
            now = utc_now_iso()
            st.meta["lastAccessAt"] = now
            if page_url and not st.meta.get("pageUrl"):
                st.meta["pageUrl"] = page_url
            if title and not st.meta.get("title"):
                st.meta["title"] = title
            if content_type:
                st.meta["contentType"] = content_type
            if bandwidth is not None and st.meta.get("bandwidth") is None:
                st.meta["bandwidth"] = bandwidth
            if codecid is not None and st.meta.get("codecid") is None:
                st.meta["codecid"] = codecid
            if duration is not None and st.meta.get("duration") is None:
                st.meta["duration"] = duration
            if total_bytes is not None and total_bytes > 0:
                prev_total = st.meta.get("totalBytes")
                if prev_total is None or total_bytes > prev_total:
                    st.meta["totalBytes"] = int(total_bytes)

            # Record raw range + recompute merged intervals
            st.raw_ranges.append([start, end])
            # Keep raw audit trail bounded if huge long video, while merged stays lossless
            if len(st.raw_ranges) > 5000:
                st.raw_ranges = st.raw_ranges[-3000:]
            st.merged = merge_ranges(st.merged + [[start, end]])

            known_total = st.meta.get("totalBytes")
            if known_total and known_total > 0:
                st.meta["complete"] = is_covered(st.merged, 0, int(known_total) - 1)

            st.dirty_ranges = True
            st.dirty_meta = True

            # Always persist meta/ranges on first write or completion; otherwise throttle to RANGES_FLUSH_INTERVAL_SEC (2s)
            now_mono = time.monotonic()
            need_immediate = (
                st.last_flush_ts == 0.0
                or st.meta.get("complete")
                or (now_mono - st.last_flush_ts) >= config.RANGES_FLUSH_INTERVAL_SEC
            )
            if need_immediate:
                self._flush_track_locked(st)

            return {
                "videoKey": video_key,
                "kind": resolved_kind,
                "written": [start, end],
                "bytes": len(payload),
                "totalBytes": st.meta.get("totalBytes"),
                "cachedBytes": covered_bytes(st.merged),
                "complete": bool(st.meta.get("complete")),
                "mergedCount": len(st.merged),
            }

    def _flush_track_locked(self, st: _TrackState) -> None:
        st.dir_path.mkdir(parents=True, exist_ok=True)
        if st.dirty_meta or not (st.dir_path / "meta.json").exists():
            _atomic_write_json(st.dir_path / "meta.json", st.meta)
            st.dirty_meta = False
        if st.dirty_ranges or not (st.dir_path / "ranges.json").exists():
            _atomic_write_json(
                st.dir_path / "ranges.json",
                {
                    "ranges": st.raw_ranges,
                    "merged": st.merged,
                    "updatedAt": utc_now_iso(),
                },
            )
            st.dirty_ranges = False
        st.last_flush_ts = time.monotonic()

    def flush_track(self, video_key: str) -> None:
        with self._global_lock:
            st = self._tracks.get(video_key)
        if st is None:
            return
        with st.lock:
            if st.dirty_meta or st.dirty_ranges:
                self._flush_track_locked(st)

    def flush_all(self) -> None:
        with self._global_lock:
            tracks = list(self._tracks.values())
        for st in tracks:
            with st.lock:
                if st.dirty_meta or st.dirty_ranges:
                    try:
                        self._flush_track_locked(st)
                    except Exception as e:
                        logger.error("Failed flushing %s: %s", st.video_key, e)

    def get_video_status(self, video_key: str) -> dict[str, Any]:
        d = self.key_dir(video_key)
        if video_key not in self._tracks and not (d / "meta.json").exists():
            return {
                "exists": False,
                "videoKey": video_key,
                "complete": False,
                "totalBytes": None,
                "cachedBytes": 0,
                "merged": [],
            }
        st = self._load_or_init_track(video_key)
        with st.lock:
            if st.dirty_meta or st.dirty_ranges:
                self._flush_track_locked(st)
            kind = st.meta.get("kind", "video")
            data_file = st.dir_path / self.data_filename(kind)
            file_size = data_file.stat().st_size if data_file.exists() else 0
            return {
                "exists": True,
                "videoKey": st.meta.get("videoKey", video_key),
                "dirName": st.dir_path.name,
                "site": st.meta.get("site", "unknown"),
                "kind": kind,
                "title": st.meta.get("title", ""),
                "pageUrl": st.meta.get("pageUrl", ""),
                "contentType": st.meta.get("contentType", "video/mp4"),
                "totalBytes": st.meta.get("totalBytes"),
                "fileSize": file_size,
                "cachedBytes": covered_bytes(st.merged),
                "complete": bool(st.meta.get("complete", False)),
                "merged": [list(x) for x in st.merged],
                "rangesCount": len(st.raw_ranges),
                "createdAt": st.meta.get("createdAt"),
                "lastAccessAt": st.meta.get("lastAccessAt"),
            }

    def list_videos(self, limit: int = 100, offset: int = 0) -> dict[str, Any]:
        self.flush_all()
        items: list[dict[str, Any]] = []
        if self.root_dir.exists():
            for sub in sorted(self.root_dir.iterdir()):
                if not sub.is_dir():
                    continue
                meta_path = sub / "meta.json"
                if not meta_path.exists():
                    continue
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    vkey = meta.get("videoKey") or sub.name
                    items.append(self.get_video_status(vkey))
                except Exception as e:
                    logger.warning("Skipping corrupt cache dir %s: %s", sub, e)
        items.sort(key=lambda x: x.get("lastAccessAt") or "", reverse=True)
        total = len(items)
        return {
            "items": items[offset : offset + limit],
            "total": total,
        }

    def delete_video(self, video_key: str) -> bool:
        d = self.key_dir(video_key)
        with self._global_lock:
            st = self._tracks.pop(video_key, None)
        if st is not None:
            with st.lock:
                if d.exists():
                    shutil.rmtree(d, ignore_errors=False)
                return True
        if d.exists():
            shutil.rmtree(d, ignore_errors=False)
            return True
        return False

    def get_stats(self) -> dict[str, Any]:
        self.flush_all()
        count = 0
        total_cached = 0
        total_file_size = 0
        if self.root_dir.exists():
            for sub in self.root_dir.iterdir():
                if not sub.is_dir() or not (sub / "meta.json").exists():
                    continue
                count += 1
                try:
                    meta = json.loads((sub / "meta.json").read_text(encoding="utf-8"))
                    vkey = meta.get("videoKey") or sub.name
                    st = self.get_video_status(vkey)
                    total_cached += st["cachedBytes"]
                    total_file_size += st["fileSize"]
                except Exception:
                    pass
        usage = shutil.disk_usage(self.root_dir)
        return {
            "count": count,
            "totalBytes": total_cached,
            "fileBytes": total_file_size,
            "freeBytes": usage.free,
            "cacheDir": str(self.root_dir),
        }

    def read_for_serve(
        self,
        video_key: str,
        range_header: Optional[str],
        head_only: bool = False,
    ) -> dict[str, Any]:
        """
        Resolve a GET/HEAD /cache/{videoKey} request safely under per-track lock.
        CRITICAL: Always uses authoritative `meta.json.totalBytes`, NEVER sparse file `st_size`.
        Returns a status dict:
          - {"status": 404}
          - {"status": 416, "totalBytes": int | None, "reason": str}
          - {"status": 200 | 206, "data": bytes, "start": int, "end": int, "length": int,
             "totalBytes": int, "contentType": str}
        """
        d = self.key_dir(video_key)
        if video_key not in self._tracks and not (d / "meta.json").exists():
            return {"status": 404, "reason": "track_not_found"}

        st = self._load_or_init_track(video_key)
        with st.lock:
            kind = st.meta.get("kind") or infer_kind_from_key(video_key, "video")
            data_file = st.dir_path / self.data_filename(kind)
            if not data_file.exists():
                return {"status": 404, "reason": "data_file_missing"}

            total_raw = st.meta.get("totalBytes")
            if not isinstance(total_raw, int) or total_raw <= 0:
                # Never substitute sparse file st_size — tell client 416 so it falls back to CDN
                return {"status": 416, "totalBytes": None, "reason": "missing_total_bytes"}

            total = int(total_raw)
            content_type = st.meta.get("contentType") or ("audio/mp4" if kind == "audio" else "video/mp4")

            if not range_header:
                # Full-object 200 response only allowed when the entire [0, total-1] is cached
                if not st.meta.get("complete") or not is_covered(st.merged, 0, total - 1):
                    return {"status": 416, "totalBytes": total, "reason": "incomplete_full_request"}
                start, end = 0, total - 1
                http_status = 200
            else:
                parsed = parse_http_range(range_header, total)
                if parsed is None:
                    return {"status": 416, "totalBytes": total, "reason": "invalid_or_unsatisfiable_range"}
                start, end = parsed
                if not is_covered(st.merged, start, end):
                    return {"status": 416, "totalBytes": total, "reason": "range_not_covered"}
                http_status = 206

            length = end - start + 1
            if head_only:
                data = b""
            else:
                # Sanity check: physical sparse file must cover offset `end`
                try:
                    file_size = data_file.stat().st_size
                except OSError:
                    return {"status": 404, "reason": "stat_failed"}
                if file_size <= end:
                    return {"status": 416, "totalBytes": total, "reason": "sparse_file_truncated"}

                with open(data_file, "rb") as f:
                    f.seek(start)
                    data = f.read(length)
                if len(data) != length:
                    return {"status": 416, "totalBytes": total, "reason": "short_read"}

            st.meta["lastAccessAt"] = utc_now_iso()
            st.dirty_meta = True
            return {
                "status": http_status,
                "data": data,
                "start": start,
                "end": end,
                "length": length,
                "totalBytes": total,
                "contentType": content_type,
            }

    def get_ranges_snapshot(self) -> dict[str, dict[str, Any]]:
        """
        Return lightweight range coverage table for extension synchronization.
        Combines cold-disk directories with live in-memory track state (without forcing disk flush).
        """
        snapshot: dict[str, dict[str, Any]] = {}

        # First load any disk-only tracks not yet warmed in memory (e.g. after server restart)
        if self.root_dir.exists():
            for sub in self.root_dir.iterdir():
                if not sub.is_dir():
                    continue
                meta_path = sub / "meta.json"
                if not meta_path.exists():
                    continue
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    vkey = meta.get("videoKey")
                    if not vkey:
                        continue
                    if vkey not in self._tracks:
                        self._load_or_init_track(vkey)
                except Exception as e:
                    logger.warning("Failed scanning cache dir %s for snapshot: %s", sub, e)

        with self._global_lock:
            tracks = list(self._tracks.values())

        for st in tracks:
            with st.lock:
                total = st.meta.get("totalBytes")
                snapshot[st.video_key] = {
                    "merged": [list(seg) for seg in st.merged],
                    "totalBytes": int(total) if isinstance(total, int) and total > 0 else None,
                    "complete": bool(st.meta.get("complete", False)),
                    "kind": st.meta.get("kind", "video"),
                }

        return snapshot
