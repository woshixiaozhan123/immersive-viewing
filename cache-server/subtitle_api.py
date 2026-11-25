"""FastAPI routes for local subtitle viewing and playback priorities."""
from __future__ import annotations

import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from subtitles import SubtitleService


def require_local(request: Request) -> None:
    loopback = {"127.0.0.1", "localhost", "::1"}
    if request.url.hostname not in loopback:
        raise HTTPException(403, "字幕接口仅供本机使用")
    origin = request.headers.get("origin")
    extension = bool(origin and re.fullmatch(r"chrome-extension://[a-p]{32}", origin))
    if origin and origin != str(request.base_url).rstrip("/") and not extension:
        raise HTTPException(403, "字幕接口仅供本机播放器和扩展使用")
    if request.headers.get("sec-fetch-site") == "cross-site" and not extension:
        raise HTTPException(403, "字幕接口不对网页开放")


router = APIRouter(dependencies=[Depends(require_local)])
service: SubtitleService | None = None


def bind(cache) -> None:
    global service
    service = SubtitleService(cache)


def close() -> None:
    if service:
        service.close()


class FocusRequest(BaseModel):
    session: str = Field(min_length=1, max_length=90, pattern=r"^[\w-]+$")
    time: float = Field(ge=0, le=864000, allow_inf_nan=False)
    until: float | None = Field(default=None, ge=0, le=864001, allow_inf_nan=False)
    seek: bool = False
    active: bool = True
    profile: Literal["auto", "cpu", "cpu-fast", "gpu"] = "auto"


def key_for(key: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,239}", key) or ".." in key:
        raise HTTPException(400, "不合法的视频缓存键")
    return key


@router.get("/api/subs/{key}")
def subtitle_view(key: str, response: Response, time: float = Query(0, ge=0, le=864000)):
    response.headers["Cache-Control"] = "no-store"
    try:
        return service.view(key_for(key), time)
    except FileNotFoundError as exc:
        raise HTTPException(404, "这条视频还没有本地缓存") from exc


@router.post("/api/subs/{key}/focus")
def subtitle_focus(key: str, body: FocusRequest, response: Response):
    response.headers["Cache-Control"] = "no-store"
    try:
        return service.focus(body.session, key_for(key), body.time, body.until, body.seek, body.active, body.profile)
    except FileNotFoundError as exc:
        raise HTTPException(404, "这条视频还没有本地缓存") from exc
