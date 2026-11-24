"""缓存自动清理 —— 按「多久没看」和「总量超限」两条规则扫盘。

设计取舍：

- **以 `meta.lastAccessAt` 为准**而不是目录 mtime：读分片会刷新 lastAccessAt，
  所以"最近看过"能真实反映热度；目录 mtime 只有写文件时才变。
- **删除一律走 `hls_cache.delete_video()`**，它内部有三层兜底
  （`except BaseException` → `SHFileOperationW` → `_move_aside`）。
  直接 `shutil.rmtree` 会在带文件安全垫片的环境里用 `SystemExit` 打死整个服务。
- 巡检线程**自己吞掉所有异常**，清理失败绝不影响正常播放。
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import config
from hls_proxy import TransparentHlsCache

logger = logging.getLogger("rb-sweep")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_iso(text: str) -> Optional[float]:
    if not text:
        return None
    try:
        raw = str(text).replace("Z", "+00:00")
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except Exception:  # noqa: BLE001
        return None


def _dir_size(path: Path) -> int:
    total = 0
    try:
        for p in path.rglob("*"):
            try:
                if p.is_file():
                    total += p.stat().st_size
            except OSError:
                continue
    except OSError:
        return total
    return total


def _human_gb(n: float) -> float:
    return round(n / (1024**3), 2)


class CacheSweeper:
    """后台巡检线程。所有操作都是幂等的，随时可手动触发。"""

    def __init__(self, cache: TransparentHlsCache) -> None:
        self.cache = cache
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self.last_run_at: Optional[str] = None
        self.last_result: dict[str, Any] = {}
        self.totals = {"runs": 0, "removedEntries": 0, "removedBytes": 0}

    # -- 生命周期 -----------------------------------------------------------
    def start(self) -> None:
        if not config.CACHE_SWEEP_ENABLED:
            logger.info("auto sweep disabled (RB_CACHE_SWEEP=false)")
            return
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="rb-sweep", daemon=True)
        self._thread.start()
        logger.info(
            "auto sweep started: every %dmin, keep %d days / %.1f GB",
            config.CACHE_SWEEP_INTERVAL_MIN,
            config.CACHE_MAX_AGE_DAYS,
            config.CACHE_MAX_GB,
        )

    def stop(self) -> None:
        self._stop.set()
        t = self._thread
        if t and t.is_alive():
            t.join(timeout=2.0)

    def _loop(self) -> None:
        # 先等一会儿再跑第一次，避开启动瞬间的 IO
        if self._stop.wait(max(5, config.CACHE_SWEEP_FIRST_DELAY_SEC)):
            return
        while True:
            try:
                self.sweep()
            except BaseException as exc:  # noqa: BLE001 - 巡检绝不能带崩服务
                logger.warning("sweep crashed: %s: %s", type(exc).__name__, exc)
            if self._stop.wait(max(60, config.CACHE_SWEEP_INTERVAL_MIN * 60)):
                return

    # -- 扫描 ---------------------------------------------------------------
    def scan(self) -> list[dict[str, Any]]:
        root = Path(config.GRAB_CACHE_DIR)
        if not root.is_dir():
            return []
        out: list[dict[str, Any]] = []
        try:
            entries = [p for p in root.iterdir() if p.is_dir() and not p.name.startswith("_")]
        except OSError:
            return []
        for d in entries:
            meta_path = d / "meta.json"
            if not meta_path.exists():
                continue
            meta: dict[str, Any] = {}
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                meta = {}
            ts = _parse_iso(str(meta.get("lastAccessAt") or ""))
            if ts is None:
                try:
                    ts = meta_path.stat().st_mtime
                except OSError:
                    ts = time.time()
            out.append(
                {
                    "key": d.name,
                    "title": meta.get("title") or d.name,
                    "lastAccessAt": meta.get("lastAccessAt") or "",
                    "ts": ts,
                    "size": _dir_size(d),
                }
            )
        out.sort(key=lambda x: x["ts"])
        return out

    # -- 清理 ---------------------------------------------------------------
    def sweep(self, dry_run: bool = False) -> dict[str, Any]:
        if not self._lock.acquire(blocking=False):
            return {"busy": True, "message": "another sweep is running"}
        try:
            entries = self.scan()
            now = time.time()
            max_age_sec = config.CACHE_MAX_AGE_DAYS * 86400 if config.CACHE_MAX_AGE_DAYS > 0 else 0
            limit_bytes = config.CACHE_MAX_GB * (1024**3) if config.CACHE_MAX_GB > 0 else 0

            planned: list[tuple[dict[str, Any], str]] = []
            expired_keys: set[str] = set()

            # 规则 1：太久没看
            if max_age_sec > 0:
                for e in entries:
                    if now - e["ts"] > max_age_sec:
                        planned.append((e, "expired"))
                        expired_keys.add(e["key"])

            # 规则 2：总量超限，按最久没看优先删
            if limit_bytes > 0:
                rest = [e for e in entries if e["key"] not in expired_keys]
                total = sum(e["size"] for e in rest)
                for e in rest:  # rest 已按 ts 升序
                    if total <= limit_bytes:
                        break
                    planned.append((e, "over-quota"))
                    total -= e["size"]

            freed = 0
            removed: list[dict[str, Any]] = []
            failed: list[dict[str, Any]] = []

            if dry_run:
                freed = sum(e["size"] for e, _ in planned)
            else:
                for e, reason in planned:
                    ok = False
                    try:
                        ok = self.cache.delete_video(e["key"])
                    except BaseException as exc:  # noqa: BLE001
                        logger.warning("sweep delete %s crashed: %s", e["key"], exc)
                        ok = False
                    if ok:
                        freed += e["size"]
                        removed.append(
                            {"key": e["key"], "title": e["title"], "size": e["size"], "reason": reason}
                        )
                        logger.info(
                            "[sweep] removed %s (%.1f MB, %s)", e["key"], e["size"] / 1048576, reason
                        )
                    else:
                        failed.append({"key": e["key"], "reason": reason})

            result = {
                "at": _now_iso(),
                "dryRun": dry_run,
                "scannedEntries": len(entries),
                "scannedBytes": sum(e["size"] for e in entries),
                "planned": len(planned),
                "removed": removed,
                "failed": failed,
                "freedBytes": freed,
                "freedGB": _human_gb(freed),
                "rules": {
                    "maxAgeDays": config.CACHE_MAX_AGE_DAYS,
                    "maxGB": config.CACHE_MAX_GB,
                    "intervalMin": config.CACHE_SWEEP_INTERVAL_MIN,
                    "enabled": config.CACHE_SWEEP_ENABLED,
                },
            }
            self.last_run_at = result["at"]
            self.last_result = result
            if not dry_run:
                self.totals["runs"] += 1
                self.totals["removedEntries"] += len(removed)
                self.totals["removedBytes"] += freed
            return result
        finally:
            self._lock.release()

    # -- 状态 ---------------------------------------------------------------
    def status(self) -> dict[str, Any]:
        entries = self.scan()
        total = sum(e["size"] for e in entries)
        limit = config.CACHE_MAX_GB * (1024**3) if config.CACHE_MAX_GB > 0 else 0
        next_in = None
        if self._thread and self._thread.is_alive():
            next_in = config.CACHE_SWEEP_INTERVAL_MIN * 60
        return {
            "enabled": config.CACHE_SWEEP_ENABLED,
            "running": bool(self._thread and self._thread.is_alive()),
            "rules": {
                "maxAgeDays": config.CACHE_MAX_AGE_DAYS,
                "maxGB": config.CACHE_MAX_GB,
                "intervalMin": config.CACHE_SWEEP_INTERVAL_MIN,
                "firstDelaySec": config.CACHE_SWEEP_FIRST_DELAY_SEC,
            },
            "entries": len(entries),
            "totalBytes": total,
            "totalGB": _human_gb(total),
            "limitGB": config.CACHE_MAX_GB,
            "usagePct": round(total / limit * 100, 1) if limit else 0,
            "nextRunInSec": next_in,
            "lastRunAt": self.last_run_at,
            "lastResult": self.last_result,
            "totals": dict(self.totals),
        }
