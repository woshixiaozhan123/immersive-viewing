"""FastAPI routes for offline facial landmark prescan and binary lookup download."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

import prescan
from hls_proxy import TransparentHlsCache

hls_cache: Optional[TransparentHlsCache] = None

router = APIRouter()


def bind(cache: TransparentHlsCache) -> None:
    global hls_cache
    hls_cache = cache


def _cache() -> TransparentHlsCache:
    if hls_cache is None:  # pragma: no cover - wiring guard
        raise HTTPException(status_code=500, detail="hls cache not bound")
    return hls_cache


def _validate_key(key: str) -> str:
    clean = (key or "").strip()
    if not clean or "/" in clean or "\\" in clean or ".." in clean or clean.startswith("_"):
        raise HTTPException(status_code=400, detail="invalid video key")
    return clean


def _require_entry(key: str) -> tuple[str, Path]:
    clean = _validate_key(key)
    entry = _cache().entry_dir(clean)
    if not entry.is_dir():
        raise HTTPException(status_code=404, detail="unknown key")
    return clean, entry


@router.get("/api/prescan/{key}")
def api_prescan_status(key: str) -> dict:
    clean, _ = _require_entry(key)
    return prescan.get_status(_cache(), clean)


@router.post("/api/prescan/{key}")
def api_prescan_start(key: str, force: bool = Query(False)) -> dict:
    clean, _ = _require_entry(key)
    code, payload = prescan.start_prescan_async(_cache(), clean, force=force)
    if code >= 400:
        raise HTTPException(status_code=code, detail=payload.get("detail") or payload)
    return payload


@router.delete("/api/prescan/{key}")
def api_prescan_delete(key: str) -> dict:
    clean, _ = _require_entry(key)
    code, payload = prescan.delete_prescan(_cache(), clean)
    if code >= 400:
        raise HTTPException(status_code=code, detail=payload.get("detail") or payload)
    return payload


@router.get("/lm/{key}")
def api_get_landmarks(key: str) -> FileResponse:
    clean = _validate_key(key)
    entry = _cache().entry_dir(clean)
    bin_path = entry / "landmarks.bin"
    json_path = entry / "landmarks.json"
    if not entry.is_dir() or not bin_path.is_file() or not json_path.is_file():
        raise HTTPException(status_code=404, detail="landmarks not found")
    return FileResponse(
        bin_path,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        },
    )
