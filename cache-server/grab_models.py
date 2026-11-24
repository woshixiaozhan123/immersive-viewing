"""Pydantic models for v3 universal video grabber API (video-cache-spec-v3.md)."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class GrabRequest(BaseModel):
    url: str = Field(..., min_length=8, description="Detected media source URL (.m3u8 / .mp4 / direct stream)")
    kind: str = Field("auto", description="Hook trigger source or media hint (fetch/xhr/src/dom/hls/direct)")
    contentType: Optional[str] = Field(None, description="Observed Content-Type response header")
    contentLength: Optional[int] = Field(None, ge=0, description="Observed Content-Length in bytes")
    pageUrl: str = Field(..., min_length=8, description="Top-level browser tab URL (authoritative cache key source)")
    frameUrl: Optional[str] = Field(None, description="Nested iframe URL if media was detected inside an iframe")
    referer: Optional[str] = Field(None, description="HTTP Referer header")
    cookie: Optional[str] = Field(None, description="Cookie header harvested via chrome.cookies.getAll")
    userAgent: Optional[str] = Field(None, description="Browser User-Agent header")
    title: Optional[str] = Field(None, description="Page document title")
    transcode: Optional[bool] = Field(None, description="Optional per-task override for GRAB_TRANSCODE")


class GrabResponse(BaseModel):
    accepted: bool
    key: str
    safeKey: str
    status: str
    reason: Optional[str] = None
