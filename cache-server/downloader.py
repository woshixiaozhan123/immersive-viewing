"""Concurrent HTTP Range downloader writing into sparse cache files (spec v2)."""

from __future__ import annotations

import logging
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import httpx

import config
from models import EnqueueRequest
from storage import VideoCacheStorage

logger = logging.getLogger("rb-cache.downloader")

_CONTENT_RANGE_RE = re.compile(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", re.IGNORECASE)


def _parse_content_range(header_val: Optional[str]) -> tuple[Optional[int], Optional[int], Optional[int]]:
    if not header_val:
        return None, None, None
    m = _CONTENT_RANGE_RE.search(header_val)
    if not m:
        return None, None, None
    start = int(m.group(1))
    end = int(m.group(2))
    total = int(m.group(3)) if m.group(3).isdigit() else None
    return start, end, total


class RangeDownloader:
    """Bounded-queue, bounded-concurrency downloader with exponential backoff retry."""

    def __init__(self, storage: VideoCacheStorage):
        self.storage = storage
        self._executor = ThreadPoolExecutor(
            max_workers=config.DOWNLOAD_CONCURRENCY,
            thread_name_prefix="rb-dl",
        )
        self._client = httpx.Client(
            follow_redirects=True,
            timeout=httpx.Timeout(30.0, connect=10.0),
            limits=httpx.Limits(
                max_connections=config.DOWNLOAD_CONCURRENCY * 2,
                max_keepalive_connections=config.DOWNLOAD_CONCURRENCY,
            ),
        )
        self._lock = threading.Lock()
        self._inflight_keys: set[tuple[str, int, Optional[int]]] = set()
        self._queued_count = 0
        self._completed_count = 0
        self._failed_count = 0
        self._last_error: Optional[str] = None
        self._closed = False

    def enqueue(self, req: EnqueueRequest) -> tuple[str, bool, bool, Optional[str]]:
        """
        Submit a range download task.
        Returns (task_id, accepted, skipped, reason).
        """
        task_id = uuid.uuid4().hex[:12]
        if self._closed:
            return task_id, False, False, "downloader_closed"

        # Skip if already fully covered on disk
        if self.storage.is_range_covered(req.videoKey, req.rangeStart, req.rangeEnd):
            return task_id, True, True, "already_covered"

        dedupe_key = (req.videoKey, req.rangeStart, req.rangeEnd)
        with self._lock:
            if dedupe_key in self._inflight_keys:
                return task_id, True, True, "already_inflight"
            if self._queued_count >= config.MAX_TASK_QUEUE:
                return task_id, False, False, "queue_full"
            self._inflight_keys.add(dedupe_key)
            self._queued_count += 1

        self._executor.submit(self._run_task, task_id, req, dedupe_key)
        return task_id, True, False, None

    def _run_task(self, task_id: str, req: EnqueueRequest, dedupe_key: tuple[str, int, Optional[int]]) -> None:
        try:
            self._download_with_retry(task_id, req)
            with self._lock:
                self._completed_count += 1
        except Exception as e:
            err_msg = f"[{task_id}] {req.videoKey} [{req.rangeStart}-{req.rangeEnd}]: {e}"
            logger.error("Download failed: %s", err_msg)
            with self._lock:
                self._failed_count += 1
                self._last_error = err_msg
        finally:
            with self._lock:
                self._inflight_keys.discard(dedupe_key)
                self._queued_count = max(0, self._queued_count - 1)

    def _download_with_retry(self, task_id: str, req: EnqueueRequest) -> None:
        headers = {
            "User-Agent": req.userAgent or config.DEFAULT_UA,
        }
        if req.referer:
            headers["Referer"] = req.referer
        if req.rangeStart > 0 or req.rangeEnd is not None:
            end_str = "" if req.rangeEnd is None else str(req.rangeEnd)
            headers["Range"] = f"bytes={req.rangeStart}-{end_str}"

        max_attempts = 3
        backoff = 0.5
        last_exc: Optional[Exception] = None

        for attempt in range(1, max_attempts + 1):
            if self._closed:
                return
            try:
                with self._client.stream("GET", req.url, headers=headers) as resp:
                    status = resp.status_code
                    if status in (403, 404, 410):
                        raise RuntimeError(f"HTTP {status} (non-retryable)")
                    resp.raise_for_status()
                    if status not in (200, 206):
                        raise RuntimeError(f"Unexpected HTTP status {status}")

                    chunks: list[bytes] = []
                    for chunk in resp.iter_bytes(65536):
                        if chunk:
                            chunks.append(chunk)
                    raw_body = b"".join(chunks)

                    content_type = resp.headers.get("content-type") or req.contentType
                    cr_start, cr_end, total_bytes = _parse_content_range(resp.headers.get("content-range"))

                    write_start = req.rangeStart
                    payload = raw_body

                    if status == 206:
                        if cr_start is not None:
                            write_start = cr_start
                        if total_bytes is None:
                            # Fallback: probe true total length via HEAD Content-Length when CDN sends `bytes s-e/*` or chunked
                            total_bytes = self._probe_total_bytes_head(req, headers)
                    elif status == 200:
                        # CDN ignored Range header and sent the full object -> slice requested portion accurately
                        total_bytes = len(raw_body)
                        if req.rangeEnd is not None:
                            expected_len = req.rangeEnd - req.rangeStart + 1
                            if len(raw_body) != expected_len and req.rangeStart < len(raw_body):
                                payload = raw_body[req.rangeStart : req.rangeEnd + 1]
                                write_start = req.rangeStart
                        elif req.rangeStart > 0 and req.rangeStart < len(raw_body):
                            payload = raw_body[req.rangeStart :]
                            write_start = req.rangeStart
                        else:
                            write_start = 0

                    if not payload:
                        raise RuntimeError("Empty response body")

                    if total_bytes is None:
                        # Double-check if track still lacks totalBytes on disk; if so, try HEAD once
                        st_info = self.storage.get_video_status(req.videoKey)
                        if not st_info.get("totalBytes"):
                            total_bytes = self._probe_total_bytes_head(req, headers)

                    info = self.storage.write_range_bytes(
                        video_key=req.videoKey,
                        kind=req.kind,
                        start=write_start,
                        payload=payload,
                        total_bytes=total_bytes,
                        page_url=req.pageUrl or req.referer,
                        title=req.title,
                        content_type=content_type,
                        bandwidth=req.bandwidth,
                        codecid=req.codecid,
                        duration=req.duration,
                    )
                    logger.info(
                        "[SAVED #%s] %s (%s) range=%d-%d (%d B) | cached=%d/%s B | merged=%d segs | complete=%s",
                        task_id,
                        req.videoKey,
                        info["kind"],
                        info["written"][0],
                        info["written"][1],
                        info["bytes"],
                        info["cachedBytes"],
                        info["totalBytes"] if info["totalBytes"] is not None else "?",
                        info["mergedCount"],
                        info["complete"],
                    )
                    return
            except OSError as io_err:
                # Disk full / permission error: propagate immediately, never fail silently
                raise RuntimeError(f"Disk I/O error: {io_err}") from io_err
            except Exception as e:
                last_exc = e
                if "non-retryable" in str(e) or attempt >= max_attempts:
                    break
                logger.warning(
                    "[RETRY %d/%d #%s] %s [%d-%s]: %s",
                    attempt,
                    max_attempts,
                    task_id,
                    req.videoKey,
                    req.rangeStart,
                    req.rangeEnd,
                    e,
                )
                time.sleep(backoff)
                backoff *= 2.5

        if last_exc:
            raise last_exc

    def _probe_total_bytes_head(self, req: EnqueueRequest, base_headers: dict[str, str]) -> Optional[int]:
        """Fallback HEAD request to fetch authoritative Content-Length when 206 omitted /total."""
        head_headers = {k: v for k, v in base_headers.items() if k.lower() != "range"}
        try:
            r = self._client.head(req.url, headers=head_headers, timeout=10.0)
            if r.status_code in (200, 206):
                cl = r.headers.get("content-length")
                if cl and cl.isdigit():
                    val = int(cl)
                    if val > 0:
                        logger.info("[HEAD] %s totalBytes=%d", req.videoKey, val)
                        return val
        except Exception as e:
            logger.debug("HEAD totalBytes probe failed for %s: %s", req.videoKey, e)
        return None

    def stats(self) -> dict[str, object]:
        with self._lock:
            return {
                "queued": self._queued_count,
                "inflight": len(self._inflight_keys),
                "completed": self._completed_count,
                "failed": self._failed_count,
                "lastError": self._last_error,
            }

    def close(self) -> None:
        self._closed = True
        self._executor.shutdown(wait=True, cancel_futures=False)
        self._client.close()
        self.storage.flush_all()
