"""Hardware-adaptive subtitle profiles, warm-pool policy, and benchmark cache."""
from __future__ import annotations

import ctypes
import hashlib
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

import subtitle_inference as inference

LOG = logging.getLogger("rb-subs")

GIB = 1024 ** 3
DEFAULT_PROFILE_CACHE = Path(__file__).resolve().parent / "native-host" / "profile-cache.json"
PROBE_WARMUP_CUE = [{"id": "w", "src": "はい"}]
PROBE_CUES = [
    {"id": "0", "src": "もう帰るの？ 雨がやんでからでも遅くないよ。"},
    {"id": "1", "src": "まさか、まだその話を信じてるの？"},
    {"id": "2", "src": "I didn't say we should leave. I said we should wait here."},
]


def memory_bytes() -> tuple[int, int]:
    if os.name == "nt":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [("size", ctypes.c_ulong), ("load", ctypes.c_ulong),
                        ("total", ctypes.c_ulonglong), ("available", ctypes.c_ulonglong),
                        ("other", ctypes.c_ulonglong * 5)]

        values = MemoryStatus()
        values.size = ctypes.sizeof(values)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(values)):
            return values.total, values.available
    else:
        try:
            pagesize = os.sysconf("SC_PAGE_SIZE")
            return os.sysconf("SC_PHYS_PAGES") * pagesize, os.sysconf("SC_AVPHYS_PAGES") * pagesize
        except (OSError, ValueError):
            pass
    return 0, 0


@dataclass(frozen=True)
class HardwareTier:
    name: str
    whisper_threads: int
    beam_size: int
    cpu_compat_threads: int
    cpu_fast_threads: int
    keep_warm_sec: float
    allow_dual_warm: bool
    min_free_gb_for_warm: float


def detect_hardware_tier(cpu_count: int, total_bytes: int, gpu_available: bool = False) -> HardwareTier:
    """Classify host hardware into low/medium/high tiers with safe defaults."""
    cpus = max(1, int(cpu_count or 1))
    total = max(0, int(total_bytes or 0))
    cpu_compat = min(4, max(1, cpus - 1)) if cpus > 1 else 1

    if total >= 18 * GIB and cpus >= 12:
        name = "high"
        whisper_threads = min(10, max(6, cpus // 2))
        beam_size = 2
        cpu_fast = min(12, max(8, cpus - 4))
        keep_warm_sec = 180.0
        allow_dual_warm = True
        min_free_gb = 3.5
    elif total >= 11 * GIB and cpus >= 8:
        name = "medium"
        whisper_threads = min(6, max(4, cpus - 2))
        beam_size = 2
        cpu_fast = min(8, max(6, cpus - 2))
        keep_warm_sec = 90.0
        allow_dual_warm = True
        min_free_gb = 3.5
    else:
        name = "low"
        whisper_threads = min(4, max(1, cpus - 1)) if cpus > 1 else 1
        beam_size = 1
        cpu_fast = whisper_threads
        keep_warm_sec = 0.0
        allow_dual_warm = False
        min_free_gb = 2.5

    env_threads = os.environ.get("RB_SUBS_THREADS")
    if env_threads and env_threads.strip().isdigit():
        whisper_threads = max(1, int(env_threads.strip()))

    env_beam = os.environ.get("RB_SUBS_BEAM_SIZE")
    if env_beam and env_beam.strip().isdigit():
        beam_size = max(1, min(5, int(env_beam.strip())))

    env_warm = os.environ.get("RB_SUBS_WARM_TTL_SEC")
    if env_warm is not None and env_warm.strip():
        try:
            keep_warm_sec = max(0.0, float(env_warm.strip()))
            if keep_warm_sec <= 0:
                allow_dual_warm = False
        except ValueError:
            pass

    return HardwareTier(
        name=name,
        whisper_threads=whisper_threads,
        beam_size=beam_size,
        cpu_compat_threads=cpu_compat,
        cpu_fast_threads=cpu_fast,
        keep_warm_sec=keep_warm_sec,
        allow_dual_warm=allow_dual_warm,
        min_free_gb_for_warm=min_free_gb,
    )


def effective_runtime(tier: HardwareTier, available_bytes: int) -> dict:
    """Apply live free-memory safety guard on top of the detected hardware tier."""
    guarded = False
    keep_warm = tier.keep_warm_sec > 0
    allow_dual_warm = tier.allow_dual_warm
    whisper_threads = tier.whisper_threads
    if keep_warm and available_bytes > 0 and available_bytes < tier.min_free_gb_for_warm * GIB:
        guarded = True
        keep_warm = False
        allow_dual_warm = False
        whisper_threads = min(4, whisper_threads)
    return {
        "whisper_threads": whisper_threads,
        "beam_size": tier.beam_size,
        "keep_warm": keep_warm,
        "keep_warm_sec": tier.keep_warm_sec if keep_warm else 0.0,
        "allow_dual_warm": allow_dual_warm,
        "memory_guarded": guarded,
    }


@dataclass(frozen=True)
class Profile:
    threads: int
    binary: str | None = None
    device: str = "none"

    def translator(self, cancel=None):
        return inference.LocalTranslator(binary=self.binary, threads=self.threads,
                                         device=self.device, cancel=cancel)


CPU = Profile(inference.THREADS)


def discover() -> tuple[dict[str, Profile], HardwareTier]:
    count = inference.CPU_COUNT
    total, available = memory_bytes()

    gpu_profile: Profile | None = None
    binary = os.environ.get("RB_SUBS_LLAMA_GPU_BIN") or os.environ.get("RB_SUBS_LLAMA_BIN") or shutil.which("llama-server")
    if binary and (available >= 3 * GIB or not total):
        try:
            devices = subprocess.run([binary, "--list-devices"], capture_output=True, timeout=4,
                                     encoding="utf-8", errors="replace",
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if devices.returncode == 0:
                matches = re.findall(r"^\s*(Vulkan\d+):[^\n]*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)",
                                     devices.stdout + devices.stderr, flags=re.MULTILINE)
                supported = [(int(free), name) for name, total_mb, free in matches
                             if int(total_mb) >= 3500 and int(free) >= 2500]
                if supported:
                    _, name = max(supported)
                    gpu_profile = Profile(max(1, min(4, count)), binary, name)
        except (OSError, subprocess.TimeoutExpired):
            pass

    tier = detect_hardware_tier(count, total, gpu_available=gpu_profile is not None)
    result = {"cpu": Profile(tier.cpu_compat_threads)}
    if count >= 8 and tier.cpu_fast_threads > tier.cpu_compat_threads and total >= 11 * GIB and available >= 4 * GIB:
        result["cpu-fast"] = Profile(tier.cpu_fast_threads)
    if gpu_profile is not None:
        result["gpu"] = Profile(tier.cpu_compat_threads, gpu_profile.binary, gpu_profile.device)
    return result, tier


def _file_sig(path_str: str | None) -> str:
    if not path_str:
        return ""
    try:
        st = Path(path_str).stat()
        return f"{Path(path_str).resolve()}:{st.st_size}:{int(st.st_mtime)}"
    except OSError:
        return path_str


def _hardware_fingerprint(profiles_map: dict[str, Profile], tier: HardwareTier, total_bytes: int) -> str:
    payload = {
        "schema": 2,
        "cpus": inference.CPU_COUNT,
        "arch": platform.processor(),
        "totalGiB": round(total_bytes / GIB) if total_bytes else 0,
        "tier": tier.name,
        "warm": tier.keep_warm_sec > 0,
        "profiles": {k: [v.threads, v.device, _file_sig(v.binary)] for k, v in sorted(profiles_map.items())},
        "llama": _file_sig(os.environ.get("RB_SUBS_LLAMA_BIN") or shutil.which("llama-server")),
        "llamaGpu": _file_sig(os.environ.get("RB_SUBS_LLAMA_GPU_BIN")),
        "mtModel": _file_sig(os.environ.get("RB_SUBS_MT_MODEL")),
    }
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


class ProfileSelector:
    def __init__(self, cache_path: Path | None = None):
        total, _ = memory_bytes()
        self.tier = detect_hardware_tier(inference.CPU_COUNT, total)
        self.profiles: dict[str, Profile] = {"cpu": Profile(self.tier.cpu_compat_threads)}
        self.timings: dict[str, float] = {}
        self.failed: set[str] = set()
        self.pool = inference.TranslatorPool()
        self.cache_path = cache_path or DEFAULT_PROFILE_CACHE
        self.fingerprint = ""
        self.cached_benchmark = False
        self._load_cache(self.profiles, self.tier, total)

    def _load_cache(self, profiles_map: dict[str, Profile], tier: HardwareTier, total_bytes: int) -> None:
        self.fingerprint = _hardware_fingerprint(profiles_map, tier, total_bytes)
        self.cached_benchmark = False
        if not self.cache_path.is_file():
            return
        try:
            data = json.loads(self.cache_path.read_text(encoding="utf-8"))
            if data.get("fingerprint") != self.fingerprint:
                return
            saved_timings = data.get("timings")
            if isinstance(saved_timings, dict):
                self.timings = {
                    str(k): float(v)
                    for k, v in saved_timings.items()
                    if k in profiles_map and isinstance(v, (int, float)) and v > 0
                }
                if self.timings:
                    self.cached_benchmark = True
            saved_failed = data.get("failed")
            if isinstance(saved_failed, list):
                self.failed = {str(k) for k in saved_failed if k in profiles_map and k != "cpu"}
        except (OSError, ValueError, TypeError):
            pass

    def save_cache(self) -> None:
        if not self.fingerprint:
            return
        payload = {
            "fingerprint": self.fingerprint,
            "tier": self.tier.name,
            "timings": dict(self.timings),
            "failed": sorted(self.failed),
            "updatedAt": int(time.time()),
        }
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.cache_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(tmp, self.cache_path)
        except OSError:
            pass

    def apply_discovered(self, profiles_map: dict[str, Profile], tier: HardwareTier) -> None:
        total, _ = memory_bytes()
        self.profiles = dict(profiles_map)
        self.tier = tier
        self.timings = {}
        self.failed = set()
        self._load_cache(self.profiles, self.tier, total)

    def runtime_policy(self) -> dict:
        _, available = memory_bytes()
        return effective_runtime(self.tier, available)

    def maintain_warm_pool(self) -> None:
        policy = self.runtime_policy()
        ttl = policy["keep_warm_sec"] if policy["keep_warm"] else 0.0
        if inference.WHISPER_POOL.release_if_idle(ttl):
            LOG.info("Released idle Whisper worker (ttl=%.0fs, guarded=%s)", ttl, policy["memory_guarded"])
        if self.pool.release_if_idle(ttl):
            LOG.info("Released idle translator process (ttl=%.0fs, guarded=%s)", ttl, policy["memory_guarded"])

    def close(self) -> None:
        self.pool.close()
        inference.WHISPER_POOL.close()

    def usable(self) -> list[str]:
        _, available = memory_bytes()
        return [name for name in self.profiles if name not in self.failed
                and (name != "cpu-fast" or available >= 4 * GIB)]

    def best(self, requested: str = "auto") -> str:
        options = self.usable()
        if requested != "auto":
            return requested if requested in options else "cpu"
        baseline = self.timings.get("cpu")
        if baseline is None:
            return "cpu"
        comparable = {name: self.timings[name] for name in options if name in self.timings
                      and self.timings[name] <= baseline * 0.92}
        return min(comparable, key=comparable.get) if comparable else "cpu"

    def status(self, requested: str) -> dict:
        policy = self.runtime_policy()
        return {
            "requested": requested,
            "effective": self.best(requested),
            "available": self.usable(),
            "timings": dict(self.timings),
            "tier": self.tier.name,
            "whisperThreads": policy["whisper_threads"],
            "beamSize": policy["beam_size"],
            "warmTtlSec": policy["keep_warm_sec"],
            "warmActive": {
                "whisper": inference.WHISPER_POOL.is_warm(),
                "translator": self.pool.is_warm(),
            },
            "cachedBenchmark": self.cached_benchmark,
            "memoryGuarded": policy["memory_guarded"],
        }

    def next_probe(self) -> str | None:
        options = self.usable()
        if len(options) <= 1:
            return None
        return next((name for name in options if name not in self.timings), None)

    def probe(self, name, cancel) -> float:
        profile = self.profiles[name]
        policy = self.runtime_policy()
        with profile.translator(cancel) as translator:
            if policy["keep_warm"]:
                # Measure steady-state warm translation speed when warm pooling is active.
                translator.translate(PROBE_WARMUP_CUE, [], cancel)
                started = time.perf_counter()
                translator.translate(PROBE_CUES, [], cancel)
            else:
                started = time.perf_counter()
                translator.translate(PROBE_CUES, [], cancel)
            return round(time.perf_counter() - started, 3)

    def translate(self, requested, cues, prior, cancel):
        name = self.best(requested)
        policy = self.runtime_policy()
        keep_warm = policy["keep_warm"]
        try:
            return self.pool.translate(
                self.profiles[name],
                cues,
                prior,
                cancel=cancel,
                keep_warm=keep_warm,
            )
        except (OSError, RuntimeError, ValueError):
            inference.check_cancelled(cancel)
            if name == "cpu":
                raise
            self.failed.add(name)
            self.save_cache()
            return self.pool.translate(
                self.profiles["cpu"],
                cues,
                prior,
                cancel=cancel,
                keep_warm=keep_warm,
            )
