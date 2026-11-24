"""Pydantic schemas for the local video cache server (spec v2)."""

from __future__ import annotations

from typing import Literal, Optional
from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    ok: bool = True
    stage: str = "p1-sparse-storage"
    port: int = 8765
    cacheDir: str = ""


class EnqueueRequest(BaseModel):
    url: str = Field(..., min_length=1)
    videoKey: str = Field(..., min_length=1)
    kind: Literal["video", "audio"] = "video"
    rangeStart: int = Field(default=0, ge=0)
    rangeEnd: Optional[int] = Field(default=None, ge=0)
    referer: Optional[str] = None
    userAgent: Optional[str] = None
    contentType: Optional[str] = None
    title: Optional[str] = None
    pageUrl: Optional[str] = None
    bandwidth: Optional[int] = None
    codecid: Optional[int] = None
    duration: Optional[float] = None
    transport: Optional[str] = None
    matchedRule: Optional[str] = None


class EnqueueResponse(BaseModel):
    taskId: str
    accepted: bool = True
    skipped: bool = False
    reason: Optional[str] = None


class UnmatchedSampleRequest(BaseModel):
    url: str = Field(..., min_length=1)
    range: Optional[str] = None
    referer: Optional[str] = None
    transport: Optional[str] = None
    reason: Optional[str] = None
