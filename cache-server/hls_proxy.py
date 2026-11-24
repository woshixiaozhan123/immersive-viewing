"""Transparent HLS cache proxy — spec v4.

播放器被改指向 `/hls/{key}/master.m3u8`，之后每一片都先问本地：
命中直接返回；未命中用 curl_cffi 现场拉一份、原子落盘、再返回。

与 v3 的关系：v3 的整片下载（out.mp4）保留，本模块只在没有整片缓存时接管。
"""

from __future__ import annotations

import base64
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urljoin, urlparse

from curl_cffi import requests as cffi_requests

import config
from grab_pipeline import (
    _atomic_write_json,
    _looks_like_html_error,
    _parse_attr_list,
    _strip_fake_image_header_if_ts,
)

logger = logging.getLogger("rb-hls")

_SAFE_DIR_RE = re.compile(r"[^\w.\-]")
_ATTR_RE = re.compile(r'([A-Z0-9-]+)=("([^"]*)"|([^,]*))')
_M3U8_RE = re.compile(r"\.m3u8(\?|#|$)", re.IGNORECASE)


# ---------------------------------------------------------------------------
# base64url helpers (与 content/grab-hook.js 的 b64e/b64d 对齐)
# ---------------------------------------------------------------------------
def b64e(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii").rstrip("=")


def b64d(token: str) -> str:
    pad = "=" * (-len(token) % 4)
    return base64.urlsafe_b64decode(token + pad).decode("utf-8")


def safe_key_of(page_url: str) -> str:
    """与 grab_pipeline.compute_page_key 的 safeKey 保持一致，但从 pageUrl 直接算。"""
    raw = (page_url or "").strip()
    if not raw:
        raise ValueError("empty pageUrl")
    if "://" not in raw:
        raw = "http://" + raw
    u = urlparse(raw)
    host = (u.hostname or "").lower()
    path = u.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    page_key = re.sub(r"[^\w.\-/]", "_", f"{host}{path}")
    safe_key = _SAFE_DIR_RE.sub("_", page_key).strip("._")
    if not safe_key:
        raise ValueError(f"invalid safeKey from {page_url!r}")
    return safe_key


def pick_best_variant(
    text: str, base_url: str, preferred_height: int = 0
) -> Optional[tuple[str, int, str]]:
    """返回 (variant_url, bandwidth, resolution)。

    preferred_height > 0 时优先选高度不超过它的最高码率档；没有可选才退回最高档。
    """
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    variants: list[tuple[str, int, str, int]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#EXT-X-STREAM-INF:"):
            attrs = _parse_attr_list(line[len("#EXT-X-STREAM-INF:") :])
            try:
                bw = int(attrs.get("BANDWIDTH", "0") or 0)
            except ValueError:
                bw = 0
            res = attrs.get("RESOLUTION", "")
            height = 0
            if "x" in res.lower():
                try:
                    height = int(res.lower().split("x", 1)[1])
                except ValueError:
                    height = 0
            j = i + 1
            while j < len(lines) and lines[j].startswith("#"):
                j += 1
            if j < len(lines):
                vurl = inherit_query(urljoin(base_url, lines[j]), base_url)
                variants.append((vurl, bw, res, height))
                i = j
        i += 1

    if not variants:
        return None

    variants.sort(key=lambda v: v[1], reverse=True)
    if preferred_height > 0:
        eligible = [v for v in variants if v[3] and v[3] <= preferred_height]
        if eligible:
            eligible.sort(key=lambda v: v[1], reverse=True)
            url, bw, res, _ = eligible[0]
            return url, bw, res
    url, bw, res, _ = variants[0]
    return url, bw, res


def inherit_query(child_url: str, parent_url: str) -> str:
    """把父 URL 的 query 透传给子 URL。

    HLS 里变体/分片多为相对路径，urljoin 会丢掉父级 query。
    Javrate 的 token 是路径级签名（token_path=/uuid/），子资源必须带同样 query 才能通过。
    """
    if not child_url or not parent_url:
        return child_url
    cp = urlparse(child_url)
    if cp.query:
        return child_url
    pp = urlparse(parent_url)
    if not pp.query:
        return child_url
    return cp._replace(query=pp.query).geturl()


def is_master_playlist(text: str) -> bool:
    return "#EXT-X-STREAM-INF:" in text


class TransparentHlsCache:
    """分片级透明缓存。线程安全，可在多请求并发下使用。"""

    def __init__(self, cache_dir: Optional[Path] = None) -> None:
        self.cache_dir = Path(cache_dir or config.GRAB_CACHE_DIR)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        self._meta_locks: dict[str, threading.Lock] = {}
        self._meta_guard = threading.Lock()

        self._inflight: set[tuple[str, int]] = set()
        self._inflight_guard = threading.Lock()

        # safeKey -> [segment urls]，避免每次请求都读文件
        self._seg_cache: dict[str, list[str]] = {}

        self._fetch_sem = threading.Semaphore(max(1, config.HLS_MAX_CONCURRENT_FETCH))
        self._prefetch_pool = ThreadPoolExecutor(
            max_workers=max(1, config.HLS_PREFETCH_AHEAD),
            thread_name_prefix="rb-hls-prefetch",
        )

        self.stats: dict[str, int] = {
            "hits": 0,
            "misses": 0,
            "errors": 0,
            "prefetched": 0,
            "bytesServed": 0,
        }
        self._stats_lock = threading.Lock()

    # -- 基础路径 / 元数据 -------------------------------------------------
    def entry_dir(self, safe_key: str) -> Path:
        return self.cache_dir / safe_key

    def seg_path(self, safe_key: str, idx: int) -> Path:
        return self.entry_dir(safe_key) / "segs" / f"{idx:06d}.ts"

    # -- 分片 URL 索引（单独文件，避免 meta.json 膨胀到几百 KB）-----------
    def seg_index_path(self, safe_key: str) -> Path:
        return self.entry_dir(safe_key) / "segments.txt"

    def read_segments(self, safe_key: str) -> list[str]:
        cached = self._seg_cache.get(safe_key)
        if cached is not None:
            return cached
        p = self.seg_index_path(safe_key)
        if not p.exists():
            return []
        try:
            urls = p.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        self._seg_cache[safe_key] = urls
        return urls

    def write_segments(self, safe_key: str, urls: list[str]) -> None:
        p = self.seg_index_path(safe_key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".part")
        try:
            tmp.write_text("\n".join(urls), encoding="utf-8")
            tmp.replace(p)
            self._seg_cache[safe_key] = list(urls)
        except OSError as exc:
            logger.warning("write segments index failed %s: %s", safe_key, exc)

    def _lock_for(self, safe_key: str) -> threading.Lock:
        with self._meta_guard:
            lock = self._meta_locks.get(safe_key)
            if lock is None:
                lock = threading.Lock()
                self._meta_locks[safe_key] = lock
            return lock

    def read_meta(self, safe_key: str) -> dict[str, Any]:
        path = self.entry_dir(safe_key) / "meta.json"
        if not path.exists():
            return {}
        try:
            import json

            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def write_meta(self, safe_key: str, meta: dict[str, Any]) -> None:
        with self._lock_for(safe_key):
            try:
                _atomic_write_json(self.entry_dir(safe_key) / "meta.json", meta)
            except Exception as exc:  # noqa: BLE001
                logger.warning("write_meta failed for %s: %s", safe_key, exc)

    def _bump(self, field: str, amount: int = 1) -> None:
        with self._stats_lock:
            self.stats[field] = self.stats.get(field, 0) + amount

    # -- HTTP ---------------------------------------------------------------
    def _headers(self, referer: str, target_url: str = "") -> dict[str, str]:
        headers = {"User-Agent": config.DEFAULT_UA, "Accept": "*/*"}
        if referer:
            headers["Referer"] = referer
            try:
                u = urlparse(referer)
                if u.scheme and u.netloc:
                    headers["Origin"] = f"{u.scheme}://{u.netloc}"
            except Exception:
                pass
        return headers

    def fetch_bytes(self, url: str, referer: str, retries: int = 3) -> bytes:
        last_err: Optional[str] = None
        for attempt in range(retries):
            try:
                with self._fetch_sem:
                    resp = cffi_requests.get(
                        url,
                        impersonate=config.GRAB_IMPERSONATE,
                        headers=self._headers(referer, url),
                        timeout=config.HLS_FETCH_TIMEOUT,
                        allow_redirects=True,
                    )
                if resp.status_code in (200, 206):
                    return resp.content
                last_err = f"HTTP {resp.status_code}"
                # 403/404 多数是桶被罚或 token 过期，重试无意义
                if resp.status_code in (401, 403, 404):
                    break
            except Exception as exc:  # noqa: BLE001
                last_err = str(exc)[:200]
            time.sleep(0.4 * (attempt + 1))
        raise RuntimeError(f"fetch failed {url[:120]}: {last_err}")

    def fetch_text(self, url: str, referer: str) -> str:
        data = self.fetch_bytes(url, referer)
        for enc in ("utf-8", "latin-1"):
            try:
                return data.decode(enc)
            except UnicodeDecodeError:
                continue
        return data.decode("utf-8", errors="replace")

    # -- Master playlist ----------------------------------------------------
    def handle_master(self, safe_key: str, media_url: str, referer: str) -> str:
        text = self.fetch_text(media_url, referer)

        if not is_master_playlist(text):
            # 已经是 media playlist，直接改写
            return self.rewrite_media(safe_key, text, media_url, referer, media_url)

        best = pick_best_variant(text, media_url, config.HLS_PREFERRED_HEIGHT)
        if best is None:
            raise RuntimeError("master playlist has no variant")

        variant_url, bandwidth, resolution = best
        meta = self.read_meta(safe_key)
        meta.update(
            {
                "key": safe_key,
                "safeKey": safe_key,
                "mediaUrl": media_url,
                "referer": referer,
                "mode": "transparent-hls",
                "bandwidth": bandwidth,
                "resolution": resolution,
                "segmentDuration": 0,
                "totalSegments": meta.get("totalSegments", 0),
                "cachedCount": meta.get("cachedCount", 0),
                "status": "streaming",
                "lastAccessAt": _now_iso(),
            }
        )
        self.write_meta(safe_key, meta)

        logger.info(
            "[hls][master] %s -> %sx (bw=%d) variants->1",
            safe_key,
            resolution or "?",
            bandwidth,
        )

        return (
            "#EXTM3U\n"
            "#EXT-X-VERSION:3\n"
            f'#EXT-X-STREAM-INF:BANDWIDTH={bandwidth}'
            + (f",RESOLUTION={resolution}" if resolution else "")
            + "\n"
            f"/hls/{safe_key}/v/0.m3u8?u={b64e(variant_url)}\n"
        )

    # -- Media playlist -----------------------------------------------------
    def rewrite_media(
        self, safe_key: str, text: str, base_url: str, referer: str, playlist_url: str
    ) -> str:
        out_lines: list[str] = []
        seg_urls: list[str] = []
        idx = 0
        seg_duration = 0.0
        last_extinf = 0.0
        has_ext_key = False

        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line:
                out_lines.append(raw_line)
                continue

            if line.startswith("#"):
                if line.startswith("#EXTINF:"):
                    try:
                        last_extinf = float(line[len("#EXTINF:") :].split(",")[0])
                    except ValueError:
                        last_extinf = 0.0
                elif line.startswith("#EXT-X-KEY:"):
                    attrs = _parse_attr_list(line[len("#EXT-X-KEY:") :])
                    if attrs.get("METHOD", "NONE").upper() != "NONE":
                        has_ext_key = True
                out_lines.append(raw_line)
                continue

            # 分片行
            abs_url = inherit_query(urljoin(base_url, line), base_url)
            seg_urls.append(abs_url)
            if seg_duration == 0.0:
                seg_duration = last_extinf
            out_lines.append(f"/hls/{safe_key}/seg/{idx}")
            idx += 1

        if has_ext_key:
            logger.warning(
                "[hls][warn] %s has EXT-X-KEY (encryption); key URL left untouched — "
                "if playback fails the stream is DRM-protected",
                safe_key,
            )

        meta = self.read_meta(safe_key)
        # 保留已有 cachedCount，重写 segments（URL 可能每次不同，idx 稳定）
        meta.update(
            {
                "key": safe_key,
                "safeKey": safe_key,
                "mediaUrl": meta.get("mediaUrl") or playlist_url,
                "referer": referer,
                "mode": "transparent-hls",
                "segmentDuration": seg_duration or meta.get("segmentDuration", 0),
                "totalSegments": idx,
                "status": "streaming",
                "lastAccessAt": _now_iso(),
            }
        )
        self.write_segments(safe_key, seg_urls)
        # 只在首次建立时全量扫描；之后依赖 _touch_cached 增量维护
        if meta.get("cachedCount") is None:
            meta["cachedCount"] = sum(
                1 for i in range(idx) if self.seg_path(safe_key, i).exists()
            )
        self.write_meta(safe_key, meta)

        logger.info(
            "[hls][media] %s segments=%d dur/seg=%.2fs cached=%d",
            safe_key,
            idx,
            seg_duration,
            meta["cachedCount"],
        )

        # 快照，排查用
        try:
            snap = self.entry_dir(safe_key) / "v"
            snap.mkdir(parents=True, exist_ok=True)
            (snap / "0.m3u8").write_text(text, encoding="utf-8")
        except Exception:
            pass

        return "\n".join(out_lines) + "\n"

    def handle_variant(self, safe_key: str, variant_url: str, referer: str) -> str:
        if not referer:
            referer = str(self.read_meta(safe_key).get("referer") or "")
        text = self.fetch_text(variant_url, referer)
        return self.rewrite_media(safe_key, text, variant_url, referer, variant_url)

    # -- Segment ------------------------------------------------------------
    def get_segment(self, safe_key: str, idx: int) -> Optional[bytes]:
        path = self.seg_path(safe_key, idx)

        if path.exists() and path.stat().st_size > config.HLS_SEGMENT_MIN_BYTES:
            self._bump("hits")
            try:
                return path.read_bytes()
            except OSError as exc:
                logger.warning("read cached segment failed %s#%d: %s", safe_key, idx, exc)

        meta = self.read_meta(safe_key)
        urls = self.read_segments(safe_key)
        if idx < 0 or idx >= len(urls) or not urls[idx]:
            logger.warning("[hls][miss] %s#%d not registered", safe_key, idx)
            return None

        self._bump("misses")
        data = self.fetch_bytes(urls[idx], meta.get("referer", ""))
        if len(data) < config.HLS_SEGMENT_MIN_BYTES or _looks_like_html_error(data):
            self._bump("errors")
            raise RuntimeError(f"segment {idx} looks invalid ({len(data)} bytes)")

        data = _strip_fake_image_header_if_ts(data)

        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        try:
            tmp.write_bytes(data)
            tmp.replace(path)
        except OSError as exc:
            logger.warning("write segment failed %s#%d: %s", safe_key, idx, exc)

        self._bump("bytesServed", len(data))
        self._touch_cached(safe_key, idx, len(data))
        return data

    def _touch_cached(self, safe_key: str, idx: int, size: int) -> None:
        meta = self.read_meta(safe_key)
        # 增量计数，避免每次请求都全量 stat 几千个文件
        meta["cachedCount"] = int(meta.get("cachedCount") or 0) + 1
        meta["cachedBytes"] = int(meta.get("cachedBytes") or 0) + size
        meta["lastAccessAt"] = _now_iso()
        self.write_meta(safe_key, meta)

    # -- Prefetch -----------------------------------------------------------
    def prefetch(self, safe_key: str, idx: int) -> None:
        ahead = config.HLS_PREFETCH_AHEAD
        if ahead <= 0:
            return
        meta = self.read_meta(safe_key)
        total = int(meta.get("totalSegments") or 0)
        for n in range(idx + 1, idx + 1 + ahead):
            if total and n >= total:
                break
            if self.seg_path(safe_key, n).exists():
                continue
            key = (safe_key, n)
            with self._inflight_guard:
                if key in self._inflight:
                    continue
                self._inflight.add(key)

            def worker(sk: str = safe_key, i: int = n) -> None:
                try:
                    urls = self.read_segments(sk)
                    if i < 0 or i >= len(urls) or not urls[i]:
                        return
                    data = self.fetch_bytes(urls[i], self.read_meta(sk).get("referer", ""))
                    if len(data) < config.HLS_SEGMENT_MIN_BYTES:
                        return
                    data = _strip_fake_image_header_if_ts(data)
                    p = self.seg_path(sk, i)
                    p.parent.mkdir(parents=True, exist_ok=True)
                    tmp = p.with_suffix(".part")
                    tmp.write_bytes(data)
                    tmp.replace(p)
                    self._bump("prefetched")
                    self._touch_cached(sk, i, len(data))
                except Exception:
                    pass
                finally:
                    with self._inflight_guard:
                        self._inflight.discard(key)

            self._prefetch_pool.submit(worker)

    def scan_cached(self, safe_key: str) -> tuple[int, int]:
        """扫描磁盘，返回 (已缓存片数, 已缓存字节数)。

        meta 里的 cachedCount 是增量累加的，并发预取 / 重试会让它偏大（实测 95 vs 真实 90），
        所以对外报进度一律以磁盘为准。
        """
        segs = self.entry_dir(safe_key) / "segs"
        if not segs.is_dir():
            return 0, 0
        count = 0
        total_bytes = 0
        try:
            for p in segs.iterdir():
                if p.suffix != ".ts":
                    continue
                try:
                    size = p.stat().st_size
                except OSError:
                    continue
                if size > config.HLS_SEGMENT_MIN_BYTES:
                    count += 1
                    total_bytes += size
        except OSError:
            return count, total_bytes
        return count, total_bytes

    # -- 状态 ---------------------------------------------------------------
    def get_video(self, safe_key: str) -> dict[str, Any]:
        meta = self.read_meta(safe_key)
        if not meta:
            return {"exists": False, "key": safe_key, "status": "missing"}
        total = int(meta.get("totalSegments") or 0)
        cached, cached_bytes = self.scan_cached(safe_key)
        duration = float(meta.get("segmentDuration") or 0) * total
        return {
            "exists": True,
            "key": safe_key,
            "mode": meta.get("mode"),
            "status": meta.get("status"),
            "totalSegments": total,
            "cachedSegments": cached,
            "progress": round(cached / total, 4) if total else 0,
            "cachedBytes": cached_bytes or int(meta.get("cachedBytes") or 0),
            "durationSec": round(duration, 2),
            "bandwidth": meta.get("bandwidth"),
            "resolution": meta.get("resolution"),
            "lastAccessAt": meta.get("lastAccessAt"),
        }

    def delete_video(self, safe_key: str) -> bool:
        import shutil

        d = self.entry_dir(safe_key)
        if not d.exists():
            return False
        try:
            shutil.rmtree(d)
            self._seg_cache.pop(safe_key, None)
            return True
        except OSError as exc:
            logger.warning("delete %s failed: %s", safe_key, exc)
            return False

    def close(self) -> None:
        self._prefetch_pool.shutdown(wait=False, cancel_futures=True)


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
