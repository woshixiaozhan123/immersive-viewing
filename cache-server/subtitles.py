"""Prioritize local subtitle generation around the current playback position."""
from __future__ import annotations

import itertools
import json
import logging
import math
import os
import stat
import threading
import time
from bisect import bisect_right
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

import subtitle_inference as inference
import subtitle_profiles as profiles
import webui

LOG = logging.getLogger("rb-subs")
AHEAD = 30.0
WINDOW = 20.0
FIRST_WINDOW = 10.0
OVERLAP = 1.2
BYTES_PER_SECOND = 32000
TTL = 12.0


class Journal:
    """Each complete JSONL row commits an entire window, including silent windows."""

    def __init__(self, entry: Path):
        self.entry = entry
        self.source: dict[int, dict] = {}
        self.translated: dict[int, dict] = {}
        self.by_segment: dict[int, int] = {}
        self.language = None
        for phase in ("src", "zh"):
            try:
                with self.path(phase).open("rb") as stream:
                    for raw in stream:
                        if not raw.endswith(b"\n"):
                            break
                        try:
                            self.apply(phase, json.loads(raw))
                        except (ValueError, KeyError, TypeError):
                            LOG.warning("Ignoring an invalid subtitle journal row")
            except FileNotFoundError:
                continue

    def path(self, phase: str) -> Path:
        return self.entry / f"subs.{phase}.jsonl"

    def apply(self, phase: str, row: dict) -> None:
        start, end = row["start"], row["end"]
        if not isinstance(start, int) or not isinstance(end, int) or not 0 <= start <= end < start + 1024:
            raise ValueError("invalid subtitle range")
        if phase == "src":
            self.source[start] = row
            for index in range(start, end + 1):
                self.by_segment[index] = start
            if row.get("language") in ("ja", "en"):
                self.language = row["language"]
        else:
            self.translated[start] = row

    def append(self, phase: str, row: dict) -> None:
        data = json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with self.path(phase).open("ab+") as stream:
            stream.seek(0, os.SEEK_END)
            if stream.tell():
                stream.seek(-1, os.SEEK_END)
                if stream.read(1) != b"\n":
                    stream.write(b"\n")
            stream.write(data + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        self.apply(phase, row)

    def cues(self, begin: float, end: float) -> list[dict]:
        rows = []
        for start, block in self.source.items():
            translations = self.translated.get(start, {}).get("zh", {})
            for cue in block["cues"]:
                if cue["t1"] > begin and cue["t0"] < end:
                    rows.append({**cue, "zh": translations.get(cue["id"])})
        rows.sort(key=lambda item: (item["t0"], item["t1"]))
        # Overlap gives Whisper context across windows. It can return the same line
        # twice with slightly different timecodes at a boundary.
        result = []
        for row in rows:
            previous = result[-1] if result else None
            if previous and row["src"] == previous["src"] and row["t0"] < previous["t1"]:
                if row["zh"] and not previous["zh"]:
                    result[-1] = row
                continue
            result.append(row)
        return result

    def prior_text(self, start: int) -> list[str]:
        previous = self.by_segment.get(start - 1)
        if previous is None:
            return []
        return [cue["src"] for cue in self.source[previous]["cues"][-2:]]


@dataclass
class Snapshot:
    starts: list[float]
    cached: set[int]

    @classmethod
    def read(cls, cache, key: str):
        entry = cache.entry_dir(key)
        indices, _ = webui._scan_segs(entry)
        durations = webui._snapshot_durations(entry)
        count = max(len(cache.read_segments(key)), len(durations), max(indices, default=-1) + 1)
        fallback = float(cache.read_meta(key).get("segmentDuration") or 5)
        if not math.isfinite(fallback) or fallback <= 0:
            fallback = 5
        parts = (durations[i] if i < len(durations) and math.isfinite(durations[i]) and durations[i] > 0
                 else fallback for i in range(count))
        return cls(list(itertools.accumulate(parts, initial=0.0)), set(indices))

    def index(self, position: float) -> int:
        return bisect_right(self.starts, position) - 1


@dataclass(frozen=True)
class Work:
    key: str
    phase: str
    start: int
    end: int
    snapshot: Snapshot
    identity: tuple[int, int, int]
    profile: str


@dataclass
class Focus:
    key: str
    position: float
    anchor: float
    until: float | None
    last_seen: float
    priority: int
    profile: str


def source_block(cache, work: Work, cancel=None) -> dict:
    snap = work.snapshot
    start, end = work.start, work.end
    left = start - 1 if start - 1 in snap.cached else start
    right = end + 1 if end + 1 in snap.cached else end
    pcm = inference.extract_pcm([cache.seg_path(work.key, idx) for idx in range(left, right + 1)])
    lower, upper = snap.starts[start], snap.starts[end + 1]
    head = max(0, round((lower - OVERLAP - snap.starts[left]) * BYTES_PER_SECOND / 2) * 2)
    tail = round((upper + OVERLAP - snap.starts[left]) * BYTES_PER_SECOND / 2) * 2
    pcm = pcm[head:tail]
    offset = snap.starts[left] + head / BYTES_PER_SECOND
    actual_end = min(snap.starts[right + 1], offset + len(pcm) / BYTES_PER_SECOND)
    detected = inference.run_whisper(pcm, None, cancel)
    cues = []
    for cue in detected["cues"]:
        t0, t1 = max(offset, offset + cue["t0"]), min(actual_end, offset + cue["t1"])
        if t1 <= t0 or not lower <= (t0 + t1) * 0.5 < upper:
            continue
        t0, t1 = round(t0, 3), round(t1, 3)
        if t0 < t1:
            cues.append({"id": f"{start}:{len(cues)}", "t0": t0, "t1": t1, "src": cue["src"]})
    detected_language = detected["language"] if cues and detected["probability"] >= 0.8 else None
    return {"start": start, "end": end, "language": detected_language, "cues": cues}


def entry_identity(entry: Path) -> tuple[int, int, int]:
    info = entry.stat()
    if not stat.S_ISDIR(info.st_mode):
        raise FileNotFoundError(entry)
    return info.st_dev, info.st_ino, getattr(info, "st_birthtime_ns", 0)


class SubtitleService:
    def __init__(self, cache):
        self.cache = cache
        self.condition = threading.Condition()
        self.focuses: dict[str, Focus] = {}
        self.entries: OrderedDict[str, tuple] = OrderedDict()
        self.errors: dict[tuple[str, str, int], tuple[float, str]] = {}
        self.priority = 0
        self.running: tuple[Work, threading.Event] | None = None
        self.worker: threading.Thread | None = None
        self.closed = False
        self.profiles = profiles.ProfileSelector()
        self.probe_cancel: threading.Event | None = None
        self.has_subtitles = False

    def close(self) -> None:
        with self.condition:
            self.closed = True
            if self.running:
                self.running[1].set()
            if self.probe_cancel:
                self.probe_cancel.set()
            self.condition.notify_all()
        inference.stop_children()
        if self.worker:
            self.worker.join(timeout=5)

    def _entry(self, key: str):
        entry = self.cache.entry_dir(key)
        identity = entry_identity(entry)
        record = self.entries.get(key)
        now = time.monotonic()
        if record is None or record[0] != identity:
            record = (identity, Journal(entry), Snapshot.read(self.cache, key), now)
        elif now - record[3] >= 1.0:
            record = (identity, record[1], Snapshot.read(self.cache, key), now)
        self.entries[key] = record
        self.entries.move_to_end(key)
        if len(self.entries) > 8:
            self.entries.popitem(last=False)
        return record[:3]

    def focus(self, session: str, key: str, position: float, until: float | None, seek: bool, active: bool, profile: str = "auto"):
        with self.condition:
            old = self.focuses.get(session)
            if self.probe_cancel and (not active or not old or old.key != key or old.profile != profile or seek):
                self.probe_cancel.set()
            if active and not self.closed:
                if not old or old.key != key or old.profile != profile or seek:
                    self.priority += 1
                    rank = self.priority
                    anchor = position
                    if self.running:
                        work, cancel = self.running
                        nearby = (work.key == key and work.snapshot.starts[work.start] - 2 <= position
                                  < work.snapshot.starts[work.end + 1])
                        if not nearby:
                            cancel.set()
                else:
                    rank = old.priority
                    anchor = old.anchor
                self.focuses[session] = Focus(key, position, anchor, until, time.monotonic(), rank, profile)
                if self.worker is None:
                    self.worker = threading.Thread(target=self._worker, daemon=True, name="rb-subtitles")
                    self.worker.start()
            elif old and old.key == key:
                self.focuses.pop(session, None)
                if self.running and self.running[0].key == key:
                    if not any(other.key == key for other in self.focuses.values()):
                        self.running[1].set()
            self.condition.notify_all()
            view = self._view(key, position, profile)
            if active and self.probe_cancel and view["state"] == "queued":
                self.probe_cancel.set()
            if active and not self.has_subtitles:
                self.has_subtitles = any(cue["zh"] for cue in view["cues"])
            return view

    def view(self, key: str, position: float):
        with self.condition:
            return self._view(key, position)

    def _view(self, key: str, position: float, profile: str = "auto"):
        _, journal, snap = self._entry(key)
        segment = snap.index(position)
        start = journal.by_segment.get(segment)
        has_cache = segment in snap.cached
        state = "uncached"
        error = None
        if has_cache:
            state = "ready" if start in journal.translated else "queued"
            phase = "zh" if start is not None else "src"
            failure = self.errors.get((key, phase, start if start is not None else segment))
            if failure and failure[0] > time.monotonic():
                state, error = "error", failure[1]
        return {"key": key, "state": state, "error": error, "language": journal.language,
                "profile": self.profiles.status(profile),
                "cues": journal.cues(max(0, position - 5), position + AHEAD + WINDOW)}

    def _pick(self) -> Work | None:
        now = time.monotonic()
        self.errors = {key: value for key, value in self.errors.items() if value[0] > now}
        self.focuses = {key: v for key, v in self.focuses.items() if now - v.last_seen <= TTL}
        for focus in sorted(self.focuses.values(), key=lambda v: v.priority, reverse=True):
            try:
                identity, journal, snap = self._entry(focus.key)
            except FileNotFoundError:
                continue
            index = snap.index(focus.position)
            anchor = snap.index(focus.anchor)
            if (0 <= focus.position - focus.anchor < AHEAD and anchor in snap.cached
                    and journal.by_segment.get(anchor) not in journal.translated):
                index = min(index, anchor)
            horizon = min(focus.position + AHEAD, focus.until if focus.until is not None else math.inf)
            while index in snap.cached and snap.starts[index] < horizon:
                start = journal.by_segment.get(index)
                if start is not None:
                    block = journal.source[start]
                    if start not in journal.translated and (focus.key, "zh", start) not in self.errors:
                        return Work(focus.key, "zh", start, block["end"], snap, identity, focus.profile)
                    index = block["end"] + 1
                    continue
                if (focus.key, "src", index) in self.errors:
                    break
                end = index
                seconds = FIRST_WINDOW if index == anchor else WINDOW
                limit = min(snap.starts[index] + seconds + 0.3, horizon)
                while (end + 1 in snap.cached and end + 1 not in journal.by_segment
                       and snap.starts[end + 2] <= limit):
                    end += 1
                return Work(focus.key, "src", index, end, snap, identity, focus.profile)
        return None

    def _commit(self, work: Work, phase: str, record: dict) -> bool:
        with self.condition:
            if self.closed or entry_identity(self.cache.entry_dir(work.key)) != work.identity:
                return False
            self._entry(work.key)[1].append(phase, record)
            return True

    def _probe(self, name: str, cancel: threading.Event) -> None:
        try:
            seconds = self.profiles.probe(name, cancel)
            if not cancel.is_set():
                with self.condition:
                    self.profiles.timings[name] = seconds
        except inference.InferenceCancelled:
            pass
        except (OSError, RuntimeError, ValueError):
            if not cancel.is_set():
                with self.condition:
                    self.profiles.failed.add(name)
        finally:
            with self.condition:
                self.probe_cancel = None

    def _worker(self) -> None:
        detected = profiles.discover()
        with self.condition:
            self.profiles.profiles = detected
        while True:
            with self.condition:
                if self.closed:
                    return
                work = self._pick()
                candidate = None
                cancel = threading.Event()
                if work is None:
                    if self.has_subtitles and any(focus.profile == "auto" for focus in self.focuses.values()):
                        candidate = self.profiles.next_probe()
                    if not candidate:
                        self.condition.wait(timeout=1)
                        continue
                    self.probe_cancel = cancel
                else:
                    try:
                        _, journal, _ = self._entry(work.key)
                    except FileNotFoundError:
                        continue
                    self.running = (work, cancel)
                    block = journal.source.get(work.start)
                    prior = journal.prior_text(work.start)
            if candidate:
                self._probe(candidate, cancel)
                continue
            phase = work.phase
            try:
                if phase == "src":
                    block = source_block(self.cache, work, cancel=cancel)
                    if not self._commit(work, "src", block):
                        continue
                phase = "zh"
                cues = block["cues"]
                zh = {}
                if cues:
                    inference.check_cancelled(cancel)
                    zh = self.profiles.translate(work.profile, cues, prior, cancel)
                committed = self._commit(work, "zh", {"start": work.start, "end": work.end, "zh": zh})
                if committed and zh:
                    self.has_subtitles = True
            except inference.InferenceCancelled:
                pass
            except FileNotFoundError:
                with self.condition:
                    self.entries.pop(work.key, None)
            except Exception as exc:
                LOG.warning("Subtitle worker failed for %s %s %s: %s", work.key, phase, work.start, type(exc).__name__)
                message = str(exc) if isinstance(exc, RuntimeError) else "本地字幕暂时无法生成"
                with self.condition:
                    self.errors[(work.key, phase, work.start)] = (time.monotonic() + 20, message)
            finally:
                with self.condition:
                    self.running = None
