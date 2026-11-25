"""Configuration for the local video cache server (v3 grab pipeline + preserved v2 settings)."""

from __future__ import annotations

import os
import shutil
from pathlib import Path


def _resolve_binary(env_var: str, exe_name: str) -> str:
    """Locate ffmpeg/ffprobe via env override, PATH, or common Windows package locations."""
    override = os.environ.get(env_var)
    if override and Path(override).exists():
        return override
    found = shutil.which(exe_name)
    if found:
        return found

    exe_file = f"{exe_name}.exe" if os.name == "nt" else exe_name
    candidates: list[Path] = []
    local_app = os.environ.get("LOCALAPPDATA")
    if local_app:
        winget_root = Path(local_app) / "Microsoft" / "WinGet" / "Packages"
        if winget_root.exists():
            candidates.extend(winget_root.glob(f"*FFmpeg*/**/bin/{exe_file}"))
    candidates.extend(
        [
            Path.home() / "scoop" / "shims" / exe_file,
            Path(r"C:\ffmpeg\bin") / exe_file,
            Path(r"C:\ProgramData\chocolatey\bin") / exe_file,
        ]
    )
    for c in candidates:
        if c.exists():
            return str(c)
    return override or exe_name


HOST: str = os.environ.get("RB_CACHE_HOST", "127.0.0.1")
PORT: int = int(os.environ.get("RB_CACHE_PORT", "8765"))

# ---------------------------------------------------------------------------
# v3 Universal Video Grabber settings (video-cache-spec-v3.md section 5.1)
# ---------------------------------------------------------------------------
GRAB_CACHE_DIR: Path = Path(
    os.environ.get("RB_GRAB_CACHE_DIR", str(Path.home() / "Videos" / "grab-cache"))
)
GRAB_MAX_CACHE_GB: float = float(os.environ.get("RB_GRAB_MAX_CACHE_GB", "30"))
# Preferred fast path: remux (-c copy); set RB_GRAB_TRANSCODE=true to re-encode 720p 1000k
GRAB_TRANSCODE: bool = os.environ.get("RB_GRAB_TRANSCODE", "false").lower() == "true"
GRAB_TARGET_HEIGHT: int = int(os.environ.get("RB_GRAB_TARGET_HEIGHT", "720"))
GRAB_TARGET_BITRATE: str = os.environ.get("RB_GRAB_TARGET_BITRATE", "1000k")
GRAB_CONCURRENCY: int = int(os.environ.get("RB_GRAB_CONCURRENCY", "2"))
GRAB_TS_WORKERS: int = int(os.environ.get("RB_GRAB_TS_WORKERS", "6"))
# Spec 8.1(3): cap global concurrent segment downloads to 6 (1 job x 6 or 2 jobs sharing 6)
GRAB_MAX_TOTAL_WORKERS: int = int(os.environ.get("RB_GRAB_MAX_TOTAL_WORKERS", "6"))
GRAB_MIN_SIZE_MB: float = float(os.environ.get("RB_GRAB_MIN_SIZE_MB", "5"))
GRAB_IMPERSONATE: str = os.environ.get("RB_GRAB_IMPERSONATE", "chrome")

# ---------------------------------------------------------------------------
# v4 Transparent HLS cache (video-cache-spec-v4.md)
# 播放器指向本地 m3u8，分片命中就返回、未命中现拉一份存着。
# ---------------------------------------------------------------------------
# 全局并发：实测 6 并发 ≈ 4.6 MB/s 且不触发限速，这里默认 4 更稳
HLS_MAX_CONCURRENT_FETCH: int = int(os.environ.get("RB_HLS_MAX_FETCH", "4"))
# 预取后续分片数：0 关闭，>3 会退化成整片下载
HLS_PREFETCH_AHEAD: int = int(os.environ.get("RB_HLS_PREFETCH", "3"))
HLS_SEGMENT_MIN_BYTES: int = int(os.environ.get("RB_HLS_SEG_MIN", "512"))
HLS_FETCH_TIMEOUT: int = int(os.environ.get("RB_HLS_TIMEOUT", "30"))
# 首选清晰度上限：选 <= 它的最高档；0 表示直接用最高档
HLS_PREFERRED_HEIGHT: int = int(os.environ.get("RB_HLS_PREFERRED_HEIGHT", "720"))

# ---------------------------------------------------------------------------
# 缓存自动清理（按「多久没看」+「总量超限」两条规则）
# ---------------------------------------------------------------------------
CACHE_SWEEP_ENABLED: bool = os.environ.get("RB_CACHE_SWEEP", "true").lower() == "true"
# 超过这么多天没访问过的条目自动删；0 = 不限
CACHE_MAX_AGE_DAYS: int = int(os.environ.get("RB_CACHE_MAX_AGE_DAYS", "7"))
# 缓存总量上限（GB）；0 = 不限。超了就按「最久没看」从旧到新删
CACHE_MAX_GB: float = float(os.environ.get("RB_CACHE_MAX_GB", "20"))
# 巡检间隔（分钟）
CACHE_SWEEP_INTERVAL_MIN: int = int(os.environ.get("RB_CACHE_SWEEP_INTERVAL_MIN", "60"))
# 服务启动后多久跑第一次（秒），避开启动瞬间的 IO
CACHE_SWEEP_FIRST_DELAY_SEC: int = int(os.environ.get("RB_CACHE_SWEEP_FIRST_DELAY", "45"))

# ---------------------------------------------------------------------------
# 空闲自动关闭（默认 30 分钟无真实业务活动且无后台任务时优雅退出；<=0 关闭）
# ---------------------------------------------------------------------------
IDLE_SHUTDOWN_MINUTES: float = float(os.environ.get("RB_IDLE_SHUTDOWN_MIN", "30"))
IDLE_CHECK_INTERVAL_SEC: float = max(0.5, float(os.environ.get("RB_IDLE_CHECK_SEC", "30")))

# ---------------------------------------------------------------------------
# 离线人脸关键点预扫（HANDOVER-PRESCAN.md）
# ---------------------------------------------------------------------------
PRESCAN_FPS: int = max(1, int(os.environ.get("RB_PRESCAN_FPS", "4")))
PRESCAN_MAX_FRAMES: int = max(100, int(os.environ.get("RB_PRESCAN_MAX_FRAMES", "400000")))
PRESCAN_AUTO: bool = os.environ.get("RB_PRESCAN_AUTO", "false").strip().lower() == "true"

FFMPEG_PATH: str = _resolve_binary("RB_FFMPEG_PATH", "ffmpeg")
FFPROBE_PATH: str = _resolve_binary("RB_FFPROBE_PATH", "ffprobe")

DEFAULT_UA: str = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# ---------------------------------------------------------------------------
# Preserved v2 settings (kept intact, no longer extended per v3 spec)
# ---------------------------------------------------------------------------
CACHE_DIR: Path = Path(os.environ.get("RB_CACHE_DIR", str(Path.home() / "Videos" / "rb-cache")))
MAX_CACHE_GB: float = float(os.environ.get("RB_MAX_CACHE_GB", "20"))
TRANSCODE_ENABLED: bool = os.environ.get("RB_TRANSCODE_ENABLED", "false").lower() == "true"
HW_ACCEL: str = os.environ.get("RB_HW_ACCEL", "auto")
DOWNLOAD_CONCURRENCY: int = int(os.environ.get("RB_DOWNLOAD_CONCURRENCY", "4"))
MAX_TASK_QUEUE: int = int(os.environ.get("RB_MAX_TASK_QUEUE", "2000"))
RANGES_FLUSH_INTERVAL_SEC: float = float(os.environ.get("RB_RANGES_FLUSH_SEC", "2.0"))
