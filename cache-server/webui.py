"""Local media library + built-in player (spec v4, section 7.2).

网页播放器只负责「发现 m3u8」，之后视频就在本地磁盘上了。本模块把磁盘上的分片
直接喂给一个自带播放器页面，不再依赖原站页面是否还开着、token 是否还有效。

三条主线：

    GET /                        媒体库（列出所有已缓存视频）
    GET /play/{safe_key}         内置播放器（video + 美颜面板）
    GET /l/{safe_key}/index.m3u8 本地生成的播放列表

播放列表**完全由磁盘状态生成**，不回源、不需要原站 token：

    mode=cached  只列已落盘的分片（默认，真正离线可用）
    mode=all     列全部分片，未缓存的请求时回源现拉（适合边看边续缓存）

分片本身仍走 `/hls/{key}/seg/{idx}`，命中就返回本地文件。
"""

from __future__ import annotations

import json
import logging
import math
import re
import threading
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, Response

import config
from hls_proxy import TransparentHlsCache, b64e

logger = logging.getLogger("rb-webui")

WEB_DIR = Path(__file__).resolve().parent / "web"
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 缓存实例由 server.py 注入，保证与 /hls 路由共享同一份状态
hls_cache: Optional[TransparentHlsCache] = None

router = APIRouter()

_SEG_FILE_RE = re.compile(r"^(\d{6})\.ts$")


def bind(cache: TransparentHlsCache) -> None:
    global hls_cache
    hls_cache = cache


def _cache() -> TransparentHlsCache:
    if hls_cache is None:  # pragma: no cover - 只会在装配错误时触发
        raise HTTPException(status_code=500, detail="hls cache not bound")
    return hls_cache


# ---------------------------------------------------------------------------
# 静态资源白名单（只暴露播放器真正需要的几个文件，不做任意目录遍历）
# ---------------------------------------------------------------------------
_MIME = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".task": "application/octet-stream",
    ".html": "text/html; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}

_STATIC_EXACT = {
    "engine.js": PROJECT_ROOT / "content" / "engine.js",
    "overlay-ui.js": PROJECT_ROOT / "content" / "overlay-ui.js",
    "player-bar.js": PROJECT_ROOT / "content" / "player-bar.js",
    "worker/face-worker.js": PROJECT_ROOT / "worker" / "face-worker.js",
    "vendor/hls.min.js": WEB_DIR / "vendor" / "hls.min.js",
    "shim.js": WEB_DIR / "shim.js",
    "app.css": WEB_DIR / "app.css",
}

# 前缀 -> 根目录；拼接后必须仍落在根目录内
_STATIC_PREFIX = {
    "vendor/mediapipe/": PROJECT_ROOT / "vendor" / "mediapipe",
}


def _resolve_static(rel: str) -> Optional[Path]:
    rel = (rel or "").lstrip("/")
    if not rel or ".." in rel.split("/"):
        return None
    direct = _STATIC_EXACT.get(rel)
    if direct is not None:
        return direct if direct.exists() else None
    for prefix, root in _STATIC_PREFIX.items():
        if rel.startswith(prefix):
            candidate = (root / rel[len(prefix) :]).resolve()
            try:
                candidate.relative_to(root.resolve())
            except ValueError:
                return None
            return candidate if candidate.exists() else None
    return None


@router.get("/static/{rel:path}")
def serve_static(rel: str) -> Response:
    path = _resolve_static(rel)
    if path is None:
        raise HTTPException(status_code=404, detail="not found")
    media_type = _MIME.get(path.suffix.lower(), "application/octet-stream")
    # MediaPipe 的 wasm 体积大且不变，允许缓存；页面与 JS 走 no-cache 便于改完即时生效
    cache_control = "public, max-age=86400" if path.suffix.lower() in (".wasm", ".task") else "no-cache"
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": cache_control})


# ---------------------------------------------------------------------------
# 元数据读取
# ---------------------------------------------------------------------------
def _entry(safe_key: str) -> Path:
    return _cache().entry_dir(safe_key)


def _segment_count(entry: Path) -> int:
    return len(_scan_segs(entry)[0])


def _scan_segs(entry: Path) -> tuple[list[int], int]:
    """一次遍历拿到 (已缓存分片下标, 已缓存字节数)，都以磁盘为准。"""
    segs = entry / "segs"
    if not segs.is_dir():
        return [], 0
    idx: list[int] = []
    total = 0
    try:
        for p in segs.iterdir():
            m = _SEG_FILE_RE.match(p.name)
            if not m:
                continue
            try:
                size = p.stat().st_size
            except OSError:
                continue
            if size > config.HLS_SEGMENT_MIN_BYTES:
                idx.append(int(m.group(1)))
                total += size
    except OSError:
        return idx, total
    idx.sort()
    return idx, total


def _cached_indices(entry: Path) -> list[int]:
    return _scan_segs(entry)[0]


def _snapshot_durations(entry: Path) -> list[float]:
    """从 v/0.m3u8 快照解析每个分片的 EXTINF 时长。

    快照是改写前抓到的原始 playlist，EXTINF 与 segments.txt 的下标一一对应。
    """
    snap = entry / "v" / "0.m3u8"
    if not snap.exists():
        return []
    durs: list[float] = []
    try:
        text = snap.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("#EXTINF:"):
            continue
        try:
            durs.append(float(line[len("#EXTINF:") :].split(",")[0]))
        except (ValueError, IndexError):
            durs.append(0.0)
    return durs


def _ranges(indices: list[int]) -> list[list[int]]:
    """把 [0,1,2,5,6,9] 折成 [[0,2],[5,6],[9,9]]（闭区间）。"""
    if not indices:
        return []
    out: list[list[int]] = []
    start = prev = indices[0]
    for i in indices[1:]:
        if i == prev + 1:
            prev = i
            continue
        out.append([start, prev])
        start = prev = i
    out.append([start, prev])
    return out


def _split_key(safe_key: str) -> tuple[str, str]:
    """`avbebe.com_archives_357404` -> ('avbebe.com', 'archives/357404')。"""
    host, _, path = safe_key.partition("_")
    return host, path.replace("_", "/") if path else ""


_TITLE_PREFIXES = ("movie/detail/", "archives/v/", "archives/", "videos/", "watch/", "v/")
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


def _pretty_title(site: str, path: str) -> str:
    """站点没给标题，只能从 URL 路径推一个能读的。

    `www.javrate.com` + `movie/detail/3144ba84-....html`  ->  `javrate.com · 3144ba84`
    `avbebe.com`      + `archives/357404`                ->  `avbebe.com · 357404`
    """
    host = site[4:] if site.startswith("www.") else site
    p = (path or "").strip("/")
    for pref in _TITLE_PREFIXES:
        if p.startswith(pref):
            p = p[len(pref) :]
            break
    if p.endswith(".html"):
        p = p[:-5]
    p = p.strip("/")
    if _UUID_RE.match(p):
        p = p[:8]
    return f"{host} · {p}" if p else host


def _library_item(safe_key: str) -> Optional[dict[str, Any]]:
    entry = _entry(safe_key)
    meta = _cache().read_meta(safe_key)
    if not meta:
        return None

    total = int(meta.get("totalSegments") or 0)
    cached_idx, cached_bytes = _scan_segs(entry)
    if not total:
        total = max(len(_cache().read_segments(safe_key)), (cached_idx[-1] + 1) if cached_idx else 0)

    durs = _snapshot_durations(entry)
    fallback = float(meta.get("segmentDuration") or 0)
    if durs and sum(durs) > 0:
        duration = sum(durs)
    else:
        duration = fallback * total

    cached_dur = 0.0
    for i in cached_idx:
        cached_dur += durs[i] if i < len(durs) and durs[i] > 0 else fallback

    host, path = _split_key(safe_key)
    return {
        "key": safe_key,
        "title": meta.get("title") or _pretty_title(host, path),
        "site": host[4:] if host.startswith("www.") else host,
        "path": path,
        "sourceUrl": meta.get("referer") or "",
        "mode": meta.get("mode"),
        "totalSegments": total,
        "cachedSegments": len(cached_idx),
        "cachedRanges": _ranges(cached_idx),
        "cachedBytes": cached_bytes,
        "durationSec": round(duration, 2),
        "cachedDurationSec": round(cached_dur, 2),
        "resolution": meta.get("resolution") or "",
        "bandwidth": meta.get("bandwidth") or 0,
        "lastAccessAt": meta.get("lastAccessAt") or "",
        "playable": bool(len(cached_idx)),
    }


def list_library() -> list[dict[str, Any]]:
    root = Path(config.GRAB_CACHE_DIR)
    if not root.is_dir():
        return []
    items: list[dict[str, Any]] = []
    try:
        # `_trash` 是删除失败时的兜底目录，不能当成正常条目列出来
        entries = [p for p in root.iterdir() if p.is_dir() and not p.name.startswith("_")]
    except OSError:
        return []
    for d in entries:
        if not (d / "meta.json").exists():
            continue
        try:
            item = _library_item(d.name)
        except Exception as exc:  # noqa: BLE001 - 单个坏条目不该拖垮整个列表
            logger.warning("library item %s failed: %s", d.name, exc)
            continue
        if item:
            items.append(item)
    items.sort(key=lambda x: x.get("lastAccessAt") or "", reverse=True)
    return items


# ---------------------------------------------------------------------------
# 本地播放列表
# ---------------------------------------------------------------------------
def build_playlist(safe_key: str, mode: str = "cached", start: int = 0) -> str:
    entry = _entry(safe_key)
    urls = _cache().read_segments(safe_key)
    cached_idx = _cached_indices(entry)
    meta = _cache().read_meta(safe_key)

    if not urls:
        raise ValueError(f"{safe_key} has no segment index (play it once in the browser first)")

    total = len(urls)
    durs = _snapshot_durations(entry)
    fallback = float(meta.get("segmentDuration") or 0) or 5.0

    def dur_of(i: int) -> float:
        d = durs[i] if i < len(durs) else 0.0
        return d if d > 0 else fallback

    if mode == "all":
        picked = list(range(max(0, start), total))
    else:
        cached_set = set(cached_idx)
        picked = [i for i in cached_idx if i >= max(0, start)]

    if not picked:
        raise ValueError(f"{safe_key} has no cached segments yet")

    durations = [dur_of(i) for i in picked]
    target = max(1, int(math.ceil(max(durations))))

    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        f"#EXT-X-TARGETDURATION:{target}",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
    ]
    for i, d in zip(picked, durations):
        lines.append(f"#EXTINF:{d:.6f},")
        lines.append(f"/hls/{safe_key}/seg/{i}")
    lines.append("#EXT-X-ENDLIST")

    logger.info(
        "[webui][playlist] %s mode=%s segments=%d (%d..%d) dur=%.1fs",
        safe_key,
        mode,
        len(picked),
        picked[0],
        picked[-1],
        sum(durations),
    )
    return "\n".join(lines) + "\n"


@router.get("/l/{safe_key}/index.m3u8")
def local_playlist(
    safe_key: str,
    mode: str = Query("cached"),
    start: int = Query(0, ge=0),
) -> Response:
    try:
        body = build_playlist(safe_key, mode=mode, start=start)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return Response(
        content=body.encode("utf-8"),
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"},
    )


@router.get("/api/library")
def api_library() -> dict:
    items = list_library()
    return {
        "items": items,
        "count": len(items),
        "totalBytes": sum(i["cachedBytes"] for i in items),
        "cacheDir": str(config.GRAB_CACHE_DIR),
    }


@router.get("/api/library/{safe_key}/segments")
def api_segments(safe_key: str) -> dict:
    entry = _entry(safe_key)
    if not entry.exists():
        raise HTTPException(status_code=404, detail="unknown key")
    cached_idx = _cached_indices(entry)
    urls = _cache().read_segments(safe_key)
    durs = _snapshot_durations(entry)
    fallback = float(_cache().read_meta(safe_key).get("segmentDuration") or 0) or 5.0
    return {
        "key": safe_key,
        "totalSegments": len(urls) or (cached_idx[-1] + 1 if cached_idx else 0),
        "cachedSegments": len(cached_idx),
        "ranges": _ranges(cached_idx),
        "segmentDuration": fallback,
        "durations": durs if durs else [],
    }


@router.delete("/api/library/{safe_key}")
def api_delete(safe_key: str) -> dict:
    entry = _entry(safe_key)
    if not entry.exists():
        raise HTTPException(status_code=404, detail="unknown key")
    ok = _cache().delete_video(safe_key)
    logger.info("[webui][delete] %s -> %s", safe_key, ok)
    return {"deleted": ok, "key": safe_key}


@router.delete("/api/library")
def api_delete_by_host(host: str = Query(..., min_length=1)) -> dict:
    """按站点清空缓存（美颜面板里的「清空本站缓存」）。

    只删 `safe_key` 站点部分**完全匹配**的条目，不做后缀模糊匹配，
    避免 `a.com` 误伤 `nota.com`。删除一律走 `delete_video()` 的三层兜底。
    """
    target = (host or "").strip().lower()
    if not target:
        raise HTTPException(status_code=400, detail="empty host")

    deleted: list[str] = []
    failed: list[str] = []
    freed = 0
    for item in list_library():
        if (item.get("site") or "").lower() != target:
            continue
        key = item["key"]
        freed += int(item.get("cachedBytes") or 0)
        if _cache().delete_video(key):
            deleted.append(key)
        else:
            failed.append(key)

    logger.info(
        "[webui][delete-site] %s -> deleted=%d failed=%d freed=%.1fMB",
        target,
        len(deleted),
        len(failed),
        freed / 1048576,
    )
    return {"host": target, "deleted": deleted, "failed": failed, "freedBytes": freed}


# ---------------------------------------------------------------------------
# 缩略图：用 ffmpeg 从已缓存分片里抽一帧（失败就 404，前端用占位色块）
# ---------------------------------------------------------------------------
_thumb_lock = threading.Lock()
_thumb_inflight: set[str] = set()


def _thumbnail_path(safe_key: str) -> Path:
    return _entry(safe_key) / "thumb.jpg"


def _make_thumbnail(safe_key: str) -> Optional[Path]:
    dest = _thumbnail_path(safe_key)
    if dest.exists() and dest.stat().st_size > 1024:
        return dest
    if not _thumb_lock.acquire(blocking=False):
        return None
    _thumb_inflight.add(safe_key)
    try:
        if dest.exists() and dest.stat().st_size > 1024:
            return dest
        idx = _cached_indices(_entry(safe_key))
        if not idx:
            return None
        # 取缓存段的 1/3 处，避开片头黑场/台标
        src = _entry(safe_key) / "segs" / f"{idx[len(idx) // 3]:06d}.ts"
        if not src.exists():
            src = _entry(safe_key) / "segs" / f"{idx[0]:06d}.ts"
        if not src.exists():
            return None
        tmp = dest.with_suffix(".part.jpg")
        for seek in ("2", "0"):  # 2 秒处抽帧，不行就退到片头
            cmd = [
                config.FFMPEG_PATH,
                "-hide_banner",
                "-loglevel", "error",
                "-y",
                "-ss", seek,
                "-i", str(src),
                "-frames:v", "1",
                "-vf", "scale=480:-2",
                "-q:v", "4",
                str(tmp),
            ]
            try:
                proc = __import__("subprocess").run(
                    cmd, capture_output=True, timeout=25
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("thumb ffmpeg failed %s: %s", safe_key, exc)
                continue
            if proc.returncode == 0 and tmp.exists() and tmp.stat().st_size > 1024:
                tmp.replace(dest)
                return dest
        return None
    finally:
        _thumb_inflight.discard(safe_key)
        _thumb_lock.release()


@router.get("/thumb/{safe_key}")
def thumb(safe_key: str) -> Response:
    path = _make_thumbnail(safe_key)
    if path is None:
        raise HTTPException(status_code=404, detail="no thumbnail")
    return FileResponse(
        path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ---------------------------------------------------------------------------
# 页面
# ---------------------------------------------------------------------------
_PAGE_HEADERS = {"Cache-Control": "no-cache"}


@router.get("/", response_class=HTMLResponse)
def page_library() -> Response:
    f = WEB_DIR / "library.html"
    if not f.exists():
        raise HTTPException(status_code=500, detail="library.html missing")
    return Response(content=f.read_bytes(), media_type="text/html; charset=utf-8", headers=_PAGE_HEADERS)


@router.get("/play/{safe_key}", response_class=HTMLResponse)
def page_player(safe_key: str) -> Response:
    f = WEB_DIR / "player.html"
    if not f.exists():
        raise HTTPException(status_code=500, detail="player.html missing")
    return Response(content=f.read_bytes(), media_type="text/html; charset=utf-8", headers=_PAGE_HEADERS)
