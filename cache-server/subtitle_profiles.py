"""Find safe local subtitle profiles and time the parts that differ."""
from __future__ import annotations

import ctypes
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass

import subtitle_inference as inference

GIB = 1024 ** 3
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
class Profile:
    threads: int
    binary: str | None = None
    device: str = "none"

    def translator(self, cancel=None):
        return inference.LocalTranslator(binary=self.binary, threads=self.threads,
                                         device=self.device, cancel=cancel)


CPU = Profile(inference.THREADS)


def discover() -> dict[str, Profile]:
    result = {"cpu": CPU}
    count = inference.CPU_COUNT
    total, available = memory_bytes()
    fast = min(count - 2, max(8, CPU.threads))
    if count >= 8 and fast > CPU.threads and total >= 12 * GIB and available >= 4 * GIB:
        result["cpu-fast"] = Profile(fast)

    binary = os.environ.get("RB_SUBS_LLAMA_GPU_BIN") or os.environ.get("RB_SUBS_LLAMA_BIN") or shutil.which("llama-server")
    if binary and (available >= 3 * GIB or not total):
        try:
            devices = subprocess.run([binary, "--list-devices"], capture_output=True, timeout=4,
                                     encoding="utf-8", errors="replace",
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if devices.returncode:
                return result
            matches = re.findall(r"^\s*(Vulkan\d+):[^\n]*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)",
                                 devices.stdout + devices.stderr, flags=re.MULTILINE)
            supported = [(int(free), name) for name, total_mb, free in matches
                         if int(total_mb) >= 3500 and int(free) >= 2500]
            if supported:
                _, name = max(supported)
                result["gpu"] = Profile(CPU.threads, binary, name)
        except (OSError, subprocess.TimeoutExpired):
            pass
    return result


class ProfileSelector:
    def __init__(self):
        self.profiles = {"cpu": CPU}
        self.timings: dict[str, float] = {}
        self.failed: set[str] = set()

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
        return {"requested": requested, "effective": self.best(requested),
                "available": self.usable(), "timings": dict(self.timings)}

    def next_probe(self) -> str | None:
        options = self.usable()
        if len(options) <= 1:
            return None
        return next((name for name in options if name not in self.timings), None)

    def probe(self, name, cancel) -> float:
        profile = self.profiles[name]
        started = time.perf_counter()
        with profile.translator(cancel) as translator:
            translator.translate(PROBE_CUES, [], cancel)
        return round(time.perf_counter() - started, 3)

    def translate(self, requested, cues, prior, cancel):
        name = self.best(requested)
        try:
            with self.profiles[name].translator(cancel) as translator:
                return translator.translate(cues, prior, cancel)
        except (OSError, RuntimeError, ValueError):
            inference.check_cancelled(cancel)
            if name == "cpu":
                raise
            self.failed.add(name)
            with CPU.translator(cancel) as translator:
                return translator.translate(cues, prior, cancel)
