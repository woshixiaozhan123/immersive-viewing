"""FastAPI application for local video cache server (spec v3 grabber + preserved v2 endpoints)."""

from __future__ import annotations

import inspect
import logging
import sys
import threading
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware

import config
import prescan
import prescan_api
import webui
from hls_proxy import TransparentHlsCache, b64d, safe_key_of
from maintenance import CacheSweeper
from models import (
    EnqueueRequest,
    EnqueueResponse,
    UnmatchedSampleRequest,
)
from storage import VideoCacheStorage

try:
    from downloader import RangeDownloader
except ImportError:  # v3 only requires curl_cffi; v2 downloader is optional when httpx is absent
    RangeDownloader = None  # type: ignore[assignment]

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("rb-cache")

# v4 transparent HLS cache (segment-level on-demand caching) — 唯一的缓存实现
hls_cache = TransparentHlsCache()

# 定时清理（按「多久没看」+「总量超限」两条规则）
sweeper = CacheSweeper(hls_cache)

# Preserved v2 sparse-range store (kept intact, no longer extended per v3 spec)
storage = VideoCacheStorage(config.CACHE_DIR)
downloader = RangeDownloader(storage) if RangeDownloader is not None else None

RECENT_ENQUEUED: deque[dict] = deque(maxlen=200)
RECENT_CDN_OBSERVED: deque[dict] = deque(maxlen=200)

_serve_stats_lock = threading.Lock()
SERVE_STATS: dict[str, int] = {
    "hits206": 0,
    "hits200": 0,
    "misses416": 0,
    "misses404": 0,
    "bytesServed": 0,
}


def _bump_serve_stat(field: str, bytes_served: int = 0) -> None:
    with _serve_stats_lock:
        SERVE_STATS[field] = SERVE_STATS.get(field, 0) + 1
        if bytes_served:
            SERVE_STATS["bytesServed"] += bytes_served


def _is_v2_key(key: str) -> bool:
    return key.startswith(("bili:", "yt:", "bili_", "yt_"))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    config.GRAB_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    logger.info(
        "Cache server started on http://%s:%d | v3 grabDir=%s | ffmpeg=%s",
        config.HOST,
        config.PORT,
        config.GRAB_CACHE_DIR,
        config.FFMPEG_PATH,
    )
    stale_prescan = prescan.reset_stale_running(config.GRAB_CACHE_DIR)
    if stale_prescan:
        logger.warning("Reset %d stale running prescan state(s) to failed", stale_prescan)
    sweeper.start()
    try:
        yield
    finally:
        logger.info("Shutting down cache server...")
        sweeper.stop()
        hls_cache.close()
        if downloader is not None:
            downloader.close()
        else:
            storage.flush_all()


app = FastAPI(title="Realtime Beauty Local Video Cache Server (v3)", version="3.0.0", lifespan=lifespan)

_cors_kwargs: dict = {
    "allow_origins": ["*"],
    "allow_credentials": False,
    "allow_methods": ["GET", "POST", "DELETE", "OPTIONS", "HEAD"],
    "allow_headers": ["*"],
    "expose_headers": ["Content-Range", "Content-Length", "Accept-Ranges"],
    "max_age": 600,
}
if "allow_private_network" in inspect.signature(CORSMiddleware.__init__).parameters:
    _cors_kwargs["allow_private_network"] = True

app.add_middleware(CORSMiddleware, **_cors_kwargs)

# 内置媒体库 / 播放器（与 /hls 共用同一个 hls_cache 实例）
webui.bind(hls_cache)
app.include_router(webui.router)

# 离线人脸关键点预扫 API 与二进制表下载
prescan_api.bind(hls_cache)
app.include_router(prescan_api.router)


@app.middleware("http")
async def add_pna_and_cors_headers(request: Request, call_next):
    response = await call_next(request)
    # Chrome Private Network Access (public HTTPS page -> http://127.0.0.1 loopback)
    if (
        request.headers.get("access-control-request-private-network") == "true"
        or request.url.path.startswith(("/local/", "/cache/"))
    ):
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


# ===========================================================================
# Health & v3 Universal Video Grabber API (video-cache-spec-v3.md section 5.2)
# ===========================================================================
@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "stage": "v4-transparent-hls",
        "port": config.PORT,
        "cacheDir": str(config.GRAB_CACHE_DIR),
        "ffmpeg": config.FFMPEG_PATH,
        "ffprobe": config.FFPROBE_PATH,
        "transport": "curl_cffi",
        "pipeline": "transparent-hls-segment-cache",
        "hlsStats": dict(hls_cache.stats),
    }


# ===========================================================================
# v4 Transparent HLS cache (video-cache-spec-v4.md section 4)
# 播放器被改指向这三条路由；每条分片请求先问本地，未命中再现场拉。
# ===========================================================================
_HLS_HEADERS: dict[str, str] = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
}


def _m3u8_response(body: str) -> Response:
    return Response(
        content=body.encode("utf-8"),
        media_type="application/vnd.apple.mpegurl",
        headers=dict(_HLS_HEADERS),
    )


@app.get("/hls/{safe_key}/master.m3u8")
def hls_master(safe_key: str, src: str, ref: str = "") -> Response:
    """拉取原始 master，只输出最高码率一档，指向 /v/0.m3u8。"""
    try:
        media_url = b64d(src)
        referer = b64d(ref) if ref else ""
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"bad src/ref: {exc}") from exc
    try:
        body = hls_cache.handle_master(safe_key, media_url, referer)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[hls][master] %s failed: %s", safe_key, exc)
        raise HTTPException(status_code=502, detail=str(exc)[:200]) from exc
    return _m3u8_response(body)


@app.get("/hls/{safe_key}/v/{variant}.m3u8")
def hls_variant(safe_key: str, variant: str, u: str, ref: str = "") -> Response:
    """拉取 media playlist，把分片地址全部改写成 /hls/{key}/seg/{idx}。"""
    try:
        variant_url = b64d(u)
        referer = b64d(ref) if ref else ""
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"bad u/ref: {exc}") from exc
    try:
        body = hls_cache.handle_variant(safe_key, variant_url, referer)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[hls][variant] %s failed: %s", safe_key, exc)
        raise HTTPException(status_code=502, detail=str(exc)[:200]) from exc
    return _m3u8_response(body)


@app.get("/hls/{safe_key}/seg/{idx}")
def hls_segment(safe_key: str, idx: int) -> Response:
    """命中返回本地文件；未命中现场拉取、原子落盘、返回。失败一律 502 让 hls.js 重试。"""
    try:
        data = hls_cache.get_segment(safe_key, idx)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[hls][seg] %s#%d failed: %s", safe_key, idx, exc)
        raise HTTPException(status_code=502, detail=str(exc)[:160]) from exc
    if data is None:
        raise HTTPException(status_code=404, detail="segment not registered")

    hls_cache.prefetch(safe_key, idx)

    headers = dict(_HLS_HEADERS)
    headers["Content-Length"] = str(len(data))
    return Response(content=data, media_type="video/mp2t", headers=headers)


@app.get("/api/video/{key:path}")
def get_video(key: str) -> dict:
    """v2 走 storage；其余一律走 v4 透明缓存的分片 meta。"""
    if _is_v2_key(key):
        return storage.get_video_status(key)
    try:
        sk = safe_key_of(key)
    except Exception:  # noqa: BLE001
        sk = key
    return hls_cache.get_video(sk)


@app.get("/api/videos")
def list_videos(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict:
    """只剩 v2 列表；v4 的统一入口是 /api/library（webui.py）。"""
    return storage.list_videos(limit=limit, offset=offset)


@app.delete("/api/video/{key:path}")
def delete_video(key: str) -> dict:
    if _is_v2_key(key):
        deleted = storage.delete_video(key)
    else:
        try:
            sk = safe_key_of(key)
        except Exception:  # noqa: BLE001
            sk = key
        deleted = hls_cache.delete_video(sk)
    return {"deleted": deleted, "key": key}


@app.get("/api/stats")
def get_stats(scope: str = Query("v4")) -> dict:
    if scope == "v2":
        st = storage.get_stats()
        st["downloader"] = downloader.stats() if downloader else None
        with _serve_stats_lock:
            st["serve"] = dict(SERVE_STATS)
        return st
    return {"hls": dict(hls_cache.stats), "cacheDir": str(config.GRAB_CACHE_DIR)}


# ===========================================================================
# 缓存自动清理
# ===========================================================================
@app.get("/api/maintenance")
def maintenance_status() -> dict:
    return sweeper.status()


@app.post("/api/maintenance/sweep")
def maintenance_sweep(dry_run: bool = Query(False)) -> dict:
    """立即跑一次清理。dry_run=true 只报告会删什么，不动手。"""
    return sweeper.sweep(dry_run=dry_run)


# ===========================================================================
# Preserved v2 endpoints (kept intact, no longer extended per v3 spec)
# ===========================================================================
@app.post("/api/enqueue", response_model=EnqueueResponse)
def enqueue(req: EnqueueRequest) -> EnqueueResponse:
    if downloader is None:
        return EnqueueResponse(taskId="disabled", accepted=False, skipped=True, reason="v2_downloader_disabled")
    parsed = urlparse(req.url)
    task_id, accepted, skipped, reason = downloader.enqueue(req)
    RECENT_ENQUEUED.append(
        {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "taskId": task_id,
            "accepted": accepted,
            "skipped": skipped,
            "reason": reason,
            "videoKey": req.videoKey,
            "kind": req.kind,
            "rangeStart": req.rangeStart,
            "rangeEnd": req.rangeEnd,
            "transport": req.transport or "unknown",
            "matchedRule": req.matchedRule or "default",
            "host": parsed.netloc,
            "path": parsed.path,
            "referer": req.referer,
        }
    )
    return EnqueueResponse(taskId=task_id, accepted=accepted, skipped=skipped, reason=reason)


@app.get("/api/ranges")
def get_ranges() -> dict:
    return {
        "ranges": storage.get_ranges_snapshot(),
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }


def _cache_common_headers() -> dict[str, str]:
    return {
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Range",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
        "Access-Control-Allow-Private-Network": "true",
        "Cache-Control": "no-store",
    }


@app.api_route("/cache/{video_key:path}", methods=["GET", "HEAD"])
def serve_cache(video_key: str, request: Request) -> Response:
    is_head = request.method.upper() == "HEAD"
    range_hdr = request.headers.get("range")
    headers = _cache_common_headers()

    try:
        res = storage.read_for_serve(video_key, range_hdr, head_only=is_head)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    status = res["status"]
    if status == 404:
        _bump_serve_stat("misses404")
        return Response(content=b"", status_code=404, headers=headers)
    if status == 416:
        _bump_serve_stat("misses416")
        total = res.get("totalBytes")
        headers["Content-Range"] = f"bytes */{total}" if total else "bytes */*"
        return Response(content=b"", status_code=416, headers=headers)

    length = res["length"]
    headers["Content-Length"] = str(length)
    if status == 206:
        headers["Content-Range"] = f"bytes {res['start']}-{res['end']}/{res['totalBytes']}"
        _bump_serve_stat("hits206", 0 if is_head else length)
    else:
        _bump_serve_stat("hits200", 0 if is_head else length)
    return Response(
        content=b"" if is_head else res["data"],
        status_code=status,
        media_type=res["contentType"],
        headers=headers,
    )


@app.post("/api/debug/cdn-log")
@app.post("/api/debug/unmatched")
def log_cdn_observation(req: UnmatchedSampleRequest) -> dict:
    parsed = urlparse(req.url)
    RECENT_CDN_OBSERVED.append(
        {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "transport": req.transport or "unknown",
            "reason": req.reason or "cdn_observed",
            "range": req.range,
            "host": parsed.netloc,
            "path": parsed.path,
            "referer": req.referer,
        }
    )
    return {"logged": True}


@app.get("/api/debug/recent")
def get_recent() -> dict:
    return {
        "v4": dict(hls_cache.stats),
        "v2EnqueuedCount": len(RECENT_ENQUEUED),
        "v2CdnObservedCount": len(RECENT_CDN_OBSERVED),
        "v2Downloader": downloader.stats() if downloader else None,
    }
