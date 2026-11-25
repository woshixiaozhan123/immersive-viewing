"""Idle shutdown watchdog for the local cache server."""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable

logger = logging.getLogger("rb-idle")

_NON_ACTIVITY_PATHS = frozenset({"/health", "/favicon.ico"})


def is_activity_path(path: str) -> bool:
    """Return True if a request path counts as real business activity."""
    return path not in _NON_ACTIVITY_PATHS


class IdleWatchdog:
    """Shuts down the server gracefully after ``timeout_sec`` of inactivity."""

    def __init__(
        self,
        *,
        timeout_sec: float,
        check_interval_sec: float,
        is_busy_fn: Callable[[], bool],
        shutdown_fn: Callable[[], None],
    ) -> None:
        self.timeout_sec = float(timeout_sec)
        self.check_interval_sec = max(0.5, float(check_interval_sec))
        self._is_busy_fn = is_busy_fn
        self._shutdown_fn = shutdown_fn

        self._lock = threading.Lock()
        self._last_activity = time.monotonic()
        self._in_flight = 0
        self._stop_event = threading.Event()
        self._triggered = False
        self._thread: threading.Thread | None = None

    @property
    def enabled(self) -> bool:
        return self.timeout_sec > 0

    def touch(self) -> None:
        with self._lock:
            self._last_activity = time.monotonic()

    def enter_request(self) -> None:
        with self._lock:
            self._in_flight += 1
            self._last_activity = time.monotonic()

    def exit_request(self) -> None:
        with self._lock:
            self._in_flight = max(0, self._in_flight - 1)
            self._last_activity = time.monotonic()

    def _safe_is_busy(self) -> bool:
        try:
            return bool(self._is_busy_fn())
        except Exception:  # noqa: BLE001
            return False

    def status(self) -> dict:
        """Return idle diagnostics without refreshing ``_last_activity``."""
        busy = self._safe_is_busy()
        now = time.monotonic()
        with self._lock:
            in_flight = self._in_flight
            idle_sec = 0.0 if (in_flight > 0 or busy) else max(0.0, now - self._last_activity)
        remaining_sec = max(0.0, self.timeout_sec - idle_sec) if self.enabled else 0.0
        return {
            "enabled": self.enabled,
            "timeoutSec": self.timeout_sec if self.enabled else 0.0,
            "idleSec": round(idle_sec, 1),
            "remainingSec": round(remaining_sec, 1),
            "inFlight": in_flight,
            "busy": busy,
        }

    def start(self) -> None:
        if not self.enabled:
            logger.info("Idle watchdog disabled (timeoutSec=%.1f)", self.timeout_sec)
            return
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        with self._lock:
            self._last_activity = time.monotonic()
            self._triggered = False
        self._thread = threading.Thread(
            target=self._loop,
            name="rb-idle-watchdog",
            daemon=True,
        )
        self._thread.start()
        logger.info(
            "Idle watchdog started (timeout=%.1f min, interval=%.1f s)",
            self.timeout_sec / 60.0,
            self.check_interval_sec,
        )

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=2.0)

    def _loop(self) -> None:
        while not self._stop_event.wait(self.check_interval_sec):
            busy = self._safe_is_busy()
            should_shutdown = False
            idle_for = 0.0
            now = time.monotonic()
            with self._lock:
                if self._in_flight > 0 or busy:
                    self._last_activity = now
                else:
                    idle_for = now - self._last_activity
                    if idle_for >= self.timeout_sec and not self._triggered:
                        self._triggered = True
                        should_shutdown = True
            if should_shutdown:
                logger.info(
                    "No business activity for %.1f s (limit %.1f s); shutting down gracefully",
                    idle_for,
                    self.timeout_sec,
                )
                try:
                    self._shutdown_fn()
                except Exception:  # noqa: BLE001
                    logger.exception("Idle shutdown callback failed")
                return
