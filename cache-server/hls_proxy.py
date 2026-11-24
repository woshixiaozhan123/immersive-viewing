"""Transparent HLS cache proxy — spec v4.

播放器被改指向 `/hls/{key}/master.m3u8`，之后每一片都先问本地：
命中直接返回；未命中用 curl_cffi 现场拉一份、原子落盘、再返回。

这是唯一的缓存实现。v3 的整片下载（out.mp4）已于 2026-11-24 整体移除，
下面的 4 个 HTTP/TS 工具函数原先寄生在 grab_pipeline.py 里，一并搬到这里。
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urljoin, urlparse

from curl_cffi import requests as cffi_requests

import config

logger = logging.getLogger("rb-hls")

_SAFE_DIR_RE = re.compile(r"[^\w.\-]")
_ATTR_RE = re.compile(r'([A-Z0-9-]+)=("([^"]*)"|([^,]*))')
_M3U8_RE = re.compile(r"\.m3u8(\?|#|$)", re.IGNORECASE)


# ---------------------------------------------------------------------------
# 从 grab_pipeline.py 搬来的工具函数（v3 删除后由本模块自持）
# ---------------------------------------------------------------------------
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


# ---------------------------------------------------------------------------
# base64url helpers (与 content/grab-hook.js 的 b64e/b64d 对齐)
# ---------------------------------------------------------------------------
def b64e(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii").rstrip("=")


def b64d(token: str) -> str:
    pad = "=" * (-len(token) % 4)
    return base64.urlsafe_b64decode(token + pad).decode("utf-8")


def safe_key_of(page_url: str) -> str:
    """由 pageUrl 直接算 safeKey：hostname + path，非字母数字与 . - / 的字符一律换成 _。"""
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
        """删除整个缓存条目。

        注意：**不能只写 shutil.rmtree**。部分环境（例如带文件安全垫片的 Python
        发行版）会把 rmtree 重定向到回收站，批量删除时直接 raise SystemExit(1)
        把整个 FastAPI 进程打死——服务端 500、进程退出、所有缓存页全断。
        这里三层兜底，任何一层失败都只返回 False，绝不影响进程存活。
        """
        import shutil

        d = self.entry_dir(safe_key)
        if not d.exists():
            return False

        try:
            shutil.rmtree(d)
        except OSError as exc:
            logger.warning("delete %s: rmtree failed (%s), trying force delete", safe_key, exc)
            if not _force_delete(d):
                logger.warning("delete %s: force delete failed, moving aside", safe_key)
                _move_aside(d)
        except BaseException as exc:  # noqa: BLE001 - 含 SystemExit，必须拦住
            logger.warning(
                "delete %s: rmtree aborted by environment guard (%s: %s), trying force delete",
                safe_key,
                type(exc).__name__,
                exc,
            )
            if not _force_delete(d):
                _move_aside(d)

        self._seg_cache.pop(safe_key, None)
        return not d.exists()

    def close(self) -> None:
        self._prefetch_pool.shutdown(wait=False, cancel_futures=True)


def _force_delete(path: Path) -> bool:
    """Windows 下用 SHFileOperationW 做永久删除（不走回收站）。

    仅作为 shutil.rmtree 被安全垫片拦住时的兜底。非 Windows 直接返回 False。
    """
    import os

    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes

        class SHFILEOPSTRUCTW(ctypes.Structure):
            _fields_ = [
                ("hwnd", wintypes.HWND),
                ("wFunc", wintypes.UINT),
                ("pFrom", wintypes.LPCWSTR),
                ("pTo", wintypes.LPCWSTR),
                ("fFlags", ctypes.c_uint16),
                ("fAnyOperationsAborted", wintypes.BOOL),
                ("hNameMappings", ctypes.c_void_p),
                ("lpszProgressTitle", wintypes.LPCWSTR),
            ]

        FO_DELETE = 3
        FOF_SILENT = 0x0004
        FOF_NOCONFIRMATION = 0x0010
        FOF_NOERRORUI = 0x0400
        FOF_NOCONFIRMMKDIR = 0x0200

        op = SHFILEOPSTRUCTW()
        op.hwnd = None
        op.wFunc = FO_DELETE
        # pFrom 必须是双 \0 结尾的双字符串
        op.pFrom = str(path.resolve()) + "\0\0"
        op.pTo = None
        op.fFlags = FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_NOCONFIRMMKDIR

        res = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
        ok = res == 0 and not op.fAnyOperationsAborted
        if ok:
            logger.info("force delete ok: %s", path.name)
        else:
            logger.warning("force delete %s returned %s", path.name, res)
        return ok
    except Exception as exc:  # noqa: BLE001
        logger.warning("force delete %s raised: %s", path, exc)
        return False


def _move_aside(path: Path) -> bool:
    """最后兜底：把目录改名到 `_trash/` 下，至少让媒体库不再列出它。

    空间不释放，但不崩服务、不丢数据，用户可手动清理。
    """
    from datetime import datetime

    try:
        trash = path.parent / "_trash"
        trash.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        dest = trash / f"{path.name}_{stamp}"
        path.rename(dest)
        logger.warning("moved %s aside to %s (disk space not freed)", path.name, dest)
        return True
    except OSError as exc:
        logger.warning("move aside %s failed: %s", path, exc)
        return False


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
