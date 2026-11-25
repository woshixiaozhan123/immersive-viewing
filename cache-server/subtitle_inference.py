"""Local inference for subtitles from already cached transport streams."""
from __future__ import annotations

import json
import os
import queue
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import sysconfig
import tempfile
import threading
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, Request, build_opener

import config

if os.name == "nt":
    import msvcrt

CPU_COUNT = getattr(os, "process_cpu_count", os.cpu_count)() or 1
DEFAULT_COMPAT_THREADS = max(1, min(4, CPU_COUNT))
_ENV_THREADS = os.environ.get("RB_SUBS_THREADS")
THREADS = max(1, int(_ENV_THREADS)) if _ENV_THREADS and _ENV_THREADS.strip().isdigit() else DEFAULT_COMPAT_THREADS
WORKER_FILE = Path(__file__).resolve()
CHILDREN = set()
CHILDREN_LOCK = threading.Lock()


class InferenceCancelled(Exception):
    pass


def check_cancelled(cancel) -> None:
    if cancel is not None and cancel.is_set():
        raise InferenceCancelled


def _start_child(args, **options):
    with CHILDREN_LOCK:
        child = subprocess.Popen(args, **options)
        CHILDREN.add(child)
        return child


def _close_child(child) -> None:
    if child is None:
        return
    with CHILDREN_LOCK:
        CHILDREN.discard(child)
        if child.poll() is None:
            child.terminate()
    try:
        child.wait(timeout=4)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


def stop_children() -> None:
    with CHILDREN_LOCK:
        children = tuple(CHILDREN)
    for child in children:
        _close_child(child)


def extract_pcm(paths: list[Path], init_map: Path | None = None) -> bytes:
    for path in paths:
        if not path.is_file():
            raise FileNotFoundError(path)
    if init_map is not None:
        if not init_map.is_file():
            raise FileNotFoundError(init_map)
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as stream:
            joined = Path(stream.name)
            stream.write(init_map.read_bytes())
            for path in paths:
                stream.write(path.read_bytes())
        try:
            result = subprocess.run(
                [config.FFMPEG_PATH, "-nostdin", "-v", "error", "-i", str(joined), "-map", "0:a:0",
                 "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"],
                capture_output=True, timeout=25, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if result.returncode:
                detail = result.stderr.decode("utf-8", errors="replace")
                if "matches no streams" in detail or "Output file does not contain any stream" in detail:
                    return b""
                raise RuntimeError("无法从本地分片解码音频")
            return result.stdout
        finally:
            joined.unlink(missing_ok=True)

    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".ffconcat", delete=False) as stream:
        manifest = Path(stream.name)
        for path in paths:
            escaped = path.resolve().as_posix().replace("'", "'\\''")
            stream.write(f"file '{escaped}'\n")
    try:
        result = subprocess.run(
            [config.FFMPEG_PATH, "-nostdin", "-v", "error", "-protocol_whitelist", "file",
             "-f", "concat", "-safe", "0", "-i", str(manifest), "-map", "0:a:0",
             "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"],
            capture_output=True, timeout=25, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode:
            detail = result.stderr.decode("utf-8", errors="replace")
            if "matches no streams" in detail or "Output file does not contain any stream" in detail:
                return b""
            raise RuntimeError("无法从本地分片解码音频")
        return result.stdout
    finally:
        manifest.unlink(missing_ok=True)


class WhisperCpu:
    def __init__(self, threads: int = THREADS, beam_size: int = 5) -> None:
        from faster_whisper import WhisperModel

        self.threads = max(1, int(threads))
        self.beam_size = max(1, int(beam_size))
        location = os.environ.get("RB_SUBS_WHISPER_DIR") or "small"
        self.model = WhisperModel(location, device="cpu", compute_type="int8",
                                  cpu_threads=self.threads, local_files_only=True)

    def transcribe(self, pcm: bytes, language: str | None, beam_size: int | None = None) -> dict:
        import numpy as np

        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        beam = max(1, int(beam_size if beam_size is not None else self.beam_size))
        cues, info = self.model.transcribe(
            audio, language=language, vad_filter=True, beam_size=beam,
            language_detection_segments=3, language_detection_threshold=0.75,
            vad_parameters={"min_silence_duration_ms": 400},
        )
        return {"language": info.language, "probability": info.language_probability,
                "cues": [{"t0": cue.start, "t1": cue.end, "src": cue.text.strip()}
                         for cue in cues if cue.text.strip()]}


def _read_exact(stream, size: int) -> bytes:
    buf = b""
    while len(buf) < size:
        chunk = stream.read(size - len(buf))
        if not chunk:
            raise EOFError("unexpected EOF on worker stream")
        buf += chunk
    return buf


def _read_frame(stream) -> bytes | None:
    raw_len = stream.read(4)
    if not raw_len:
        return None
    if len(raw_len) < 4:
        raw_len += _read_exact(stream, 4 - len(raw_len))
    msg_len = struct.unpack("<I", raw_len)[0]
    if msg_len == 0:
        return b""
    return _read_exact(stream, msg_len)


def _write_frame(stream, payload: bytes) -> None:
    stream.write(struct.pack("<I", len(payload)))
    stream.write(payload)
    stream.flush()


def _worker_command(args: list[str]) -> tuple[list[str], dict[str, str]]:
    command = [sys.executable, str(WORKER_FILE), *args]
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "PYTHONUTF8": "1"}
    if os.name == "nt" and sys.prefix != sys.base_prefix:
        # Launch the interpreter directly so cancelling this Popen handle stops
        # the worker itself, including when the server runs in a Windows venv.
        command[0] = sys._base_executable
        paths = [sysconfig.get_path("purelib"), env.get("PYTHONPATH", "")]
        env["PYTHONPATH"] = os.pathsep.join(dict.fromkeys(path for path in paths if path))
    return command, env


class WhisperWorkerPool:
    """Keep a reusable Whisper CPU worker alive between consecutive chunks."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proc = None
        self._signature: tuple[int, int] | None = None
        self._last_used = 0.0
        self._busy = False

    def is_warm(self) -> bool:
        with self._lock:
            return self._proc is not None and self._proc.poll() is None

    def close(self) -> None:
        with self._lock:
            proc = self._proc
            self._proc = None
            self._signature = None
        _close_child(proc)

    def release_if_idle(self, ttl_sec: float) -> bool:
        with self._lock:
            if self._busy or self._proc is None:
                return False
            if self._proc.poll() is not None:
                self._proc = None
                self._signature = None
                return False
            if ttl_sec > 0 and (time.monotonic() - self._last_used) < ttl_sec:
                return False
            proc = self._proc
            self._proc = None
            self._signature = None
        _close_child(proc)
        return True

    def _await_frame(self, proc, cancel, timeout: float) -> bytes:
        box: queue.Queue = queue.Queue(maxsize=1)

        def reader() -> None:
            try:
                frame = _read_frame(proc.stdout)
                if frame is None:
                    box.put(EOFError("whisper worker exited"))
                else:
                    box.put(frame)
            except BaseException as exc:  # noqa: BLE001
                box.put(exc)

        threading.Thread(target=reader, name="rb-whisper-read", daemon=True).start()
        deadline = time.monotonic() + timeout
        while True:
            check_cancelled(cancel)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Whisper worker timed out")
            try:
                item = box.get(timeout=min(0.08, remaining))
                if isinstance(item, BaseException):
                    raise item
                return item
            except queue.Empty:
                continue

    def _spawn(self, threads: int, beam_size: int, cancel) -> subprocess.Popen:
        command, env = _worker_command(["--worker", str(threads), str(beam_size)])
        proc = _start_child(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            ready_raw = self._await_frame(proc, cancel, timeout=45.0)
            ready = json.loads(ready_raw.decode("utf-8"))
            if not ready.get("ready"):
                raise RuntimeError("Whisper worker failed to initialize")
            return proc
        except BaseException:
            _close_child(proc)
            raise

    def transcribe(
        self,
        pcm: bytes,
        language: str | None,
        *,
        threads: int = THREADS,
        beam_size: int = 2,
        cancel=None,
        keep_warm: bool = True,
    ) -> dict:
        check_cancelled(cancel)
        if len(pcm) < 3200:
            return {"language": language, "probability": 0, "cues": []}

        sig = (max(1, int(threads)), max(1, int(beam_size)))
        with self._lock:
            self._busy = True
            proc = self._proc
            old_sig = self._signature
            if proc is not None and (proc.poll() is not None or old_sig != sig):
                self._proc = None
                self._signature = None
            else:
                old_sig = None

        if old_sig is not None and proc is not None:
            _close_child(proc)
            proc = None

        try:
            if proc is None:
                proc = self._spawn(sig[0], sig[1], cancel)
            header = json.dumps(
                {"language": language, "pcmBytes": len(pcm), "beamSize": sig[1]},
                ensure_ascii=False,
            ).encode("utf-8")
            _write_frame(proc.stdin, header)
            proc.stdin.write(pcm)
            proc.stdin.flush()

            resp_raw = self._await_frame(proc, cancel, timeout=150.0)
            result = json.loads(resp_raw.decode("utf-8"))
            if "error" in result:
                raise RuntimeError(str(result["error"]))

            if keep_warm and proc.poll() is None:
                with self._lock:
                    self._proc = proc
                    self._signature = sig
                    self._last_used = time.monotonic()
                proc = None
            return result
        except InferenceCancelled:
            _close_child(proc)
            with self._lock:
                self._proc = None
                self._signature = None
            raise
        except BaseException as exc:  # noqa: BLE001
            _close_child(proc)
            with self._lock:
                self._proc = None
                self._signature = None
            if isinstance(exc, RuntimeError):
                raise
            raise RuntimeError("Whisper small 不可用，请确认已安装字幕依赖并配置本地模型") from exc
        finally:
            if proc is not None:
                _close_child(proc)
            with self._lock:
                self._busy = False


WHISPER_POOL = WhisperWorkerPool()


def run_whisper(
    pcm: bytes,
    language: str | None,
    cancel=None,
    *,
    threads: int | None = None,
    beam_size: int = 2,
    keep_warm: bool = False,
) -> dict:
    return WHISPER_POOL.transcribe(
        pcm,
        language,
        threads=threads or THREADS,
        beam_size=beam_size,
        cancel=cancel,
        keep_warm=keep_warm,
    )


class LocalTranslator:
    """Own the temporary or pooled llama-server process for translations."""

    def __init__(self, *, binary=None, threads=THREADS, device="none", cancel=None) -> None:
        self.binary = binary
        self.threads = max(1, int(threads))
        self.device = device
        self.cancel = cancel
        self.process = None
        self.port: int | None = None
        self.token = secrets.token_urlsafe(32)
        self.opener = build_opener(ProxyHandler({}))

    def is_alive(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def start(self, cancel=None) -> LocalTranslator:
        active_cancel = cancel if cancel is not None else self.cancel
        check_cancelled(active_cancel)
        if self.is_alive():
            return self
        binary = (self.binary or os.environ.get("RB_SUBS_LLAMA_BIN") or shutil.which("llama-server")
                  or os.environ.get("RB_SUBS_LLAMA_GPU_BIN"))
        model = os.environ.get("RB_SUBS_MT_MODEL")
        if not binary or not model or not Path(model).is_file():
            raise RuntimeError("请配置本机 llama-server 和混元 Hy-MT2 1.8B Q4 模型")
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.process = _start_child(
            [binary, "-m", str(Path(model).resolve()), "--host", "127.0.0.1", "--port", str(self.port),
             "--api-key", self.token, "-ngl", "0" if self.device == "none" else "99",
             "--device", self.device, "-c", "2048", "-t", str(self.threads),
             "-tb", str(self.threads), "--parallel", "1", "--no-webui", "--no-warmup"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            deadline = time.monotonic() + 30
            while self.process.poll() is None and time.monotonic() < deadline:
                check_cancelled(active_cancel)
                try:
                    self.request("/health", timeout=0.5)
                    return self
                except (URLError, TimeoutError):
                    time.sleep(0.12)
            raise RuntimeError("本地混元启动失败，请检查 llama-server 和模型格式")
        except (OSError, RuntimeError, InferenceCancelled):
            self.close()
            raise

    def close(self) -> None:
        try:
            self.opener.close()
        except Exception:  # noqa: BLE001
            pass
        if self.process is not None:
            proc = self.process
            self.process = None
            _close_child(proc)

    def __enter__(self):
        return self.start(self.cancel)

    def __exit__(self, *_exc) -> None:
        self.close()

    def request(self, route: str, payload: dict | None = None, timeout: float = 60) -> dict:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        req = Request(f"http://127.0.0.1:{self.port}{route}", data=data,
                      headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        with self.opener.open(req, timeout=timeout) as response:
            return json.load(response)

    def translate(self, cues: list[dict], prior: list[str], cancel=None) -> dict[str, str]:
        active_cancel = cancel if cancel is not None else self.cancel
        done = threading.Event()
        if active_cancel is not None:
            def watch() -> None:
                while not done.wait(0.08):
                    if active_cancel.is_set():
                        proc = self.process
                        if proc is not None:
                            with CHILDREN_LOCK:
                                if proc.poll() is None:
                                    proc.terminate()
                        return

            threading.Thread(target=watch, name="rb-subs-cancel", daemon=True).start()

        try:
            result = {}
            context = prior[-2:]
            for start in range(0, len(cues), 6):
                check_cancelled(active_cancel)
                batch = cues[start:start + 6]
                parts = self._request_lines(batch, context)
                if len(parts) != len(batch) or not all(parts):
                    parts = []
                    for cue in batch:
                        check_cancelled(active_cancel)
                        one = self._request_lines([cue], context)
                        if len(one) != 1 or not one[0]:
                            raise RuntimeError("混元返回的译文与字幕条数不匹配")
                        parts.append(one[0])
                result.update({cue["id"]: zh for cue, zh in zip(batch, parts, strict=True)})
                context = [*context, *(cue["src"] for cue in batch)][-2:]
            return result
        except Exception:
            check_cancelled(active_cancel)
            raise
        finally:
            done.set()

    def _request_lines(self, cues: list[dict], prior: list[str]) -> list[str]:
        delimiter = "|||"
        text = f"\n{delimiter}\n".join(cue["src"].replace(delimiter, " ") for cue in cues)
        hint = ("前文仅作参考，不输出它的译文：\n" + "\n".join(prior) + "\n\n") if prior else ""
        rules = f"原文用 {delimiter} 分隔，每段都要翻译，保留分隔符和条数。\n" if len(cues) > 1 else ""
        prompt = f"{hint}将以下对白译成自然口语的简体中文，保留否定、反问和人名称谓，只输出译文。\n{rules}\n{text}"
        response = self.request("/v1/chat/completions", {
            "messages": [{"role": "user", "content": prompt}], "stream": False,
            "temperature": 0.1, "seed": 42, "max_tokens": 360,
        })
        return [" ".join(part.split()) for part in response["choices"][0]["message"]["content"].split(delimiter)]


class TranslatorPool:
    """Keep the active llama-server process warm across consecutive chunks."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._key: tuple[str, int, str] | None = None
        self._translator: LocalTranslator | None = None
        self._last_used = 0.0
        self._busy = False

    def is_warm(self) -> bool:
        with self._lock:
            return self._translator is not None and self._translator.is_alive()

    def close(self) -> None:
        with self._lock:
            tr = self._translator
            self._translator = None
            self._key = None
        if tr is not None:
            tr.close()

    def release_if_idle(self, ttl_sec: float) -> bool:
        with self._lock:
            if self._busy or self._translator is None:
                return False
            if not self._translator.is_alive():
                self._translator.close()
                self._translator = None
                self._key = None
                return False
            if ttl_sec > 0 and (time.monotonic() - self._last_used) < ttl_sec:
                return False
            tr = self._translator
            self._translator = None
            self._key = None
        tr.close()
        return True

    def translate(
        self,
        profile,
        cues: list[dict],
        prior: list[str],
        *,
        cancel=None,
        keep_warm: bool = True,
    ) -> dict[str, str]:
        check_cancelled(cancel)
        key = (profile.binary or "", int(profile.threads), profile.device)
        with self._lock:
            self._busy = True
            tr = self._translator
            old_tr = None
            if tr is not None and (not tr.is_alive() or self._key != key):
                old_tr = tr
                self._translator = None
                self._key = None
                tr = None

        if old_tr is not None:
            old_tr.close()

        try:
            if tr is None:
                tr = profile.translator(cancel)
                tr.start(cancel)
            result = tr.translate(cues, prior, cancel)
            if keep_warm and tr.is_alive():
                with self._lock:
                    self._translator = tr
                    self._key = key
                    self._last_used = time.monotonic()
                tr = None
            return result
        except BaseException:
            if tr is not None:
                tr.close()
                tr = None
            with self._lock:
                self._translator = None
                self._key = None
            raise
        finally:
            if tr is not None:
                tr.close()
            with self._lock:
                self._busy = False


def _run_persistent_worker(threads: int, beam_size: int) -> int:
    if os.name == "nt":
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

    # Reserve a dedicated binary pipe for protocol frames so C/C++ stdout writes cannot corrupt them.
    proto_fd = os.dup(sys.stdout.fileno())
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull_fd, sys.stdout.fileno())
    os.close(devnull_fd)
    proto_out = os.fdopen(proto_fd, "wb", buffering=0)

    try:
        model = WhisperCpu(threads=threads, beam_size=beam_size)
        _write_frame(proto_out, json.dumps({"ready": True}).encode("utf-8"))
        while True:
            header_raw = _read_frame(sys.stdin.buffer)
            if header_raw is None:
                return 0
            header = json.loads(header_raw.decode("utf-8"))
            pcm_bytes = int(header["pcmBytes"])
            pcm = _read_exact(sys.stdin.buffer, pcm_bytes) if pcm_bytes > 0 else b""
            language = header.get("language")
            beam = int(header.get("beamSize") or beam_size)
            try:
                result = model.transcribe(pcm, language, beam_size=beam)
            except Exception as exc:  # noqa: BLE001
                result = {"error": str(exc)}
            _write_frame(proto_out, json.dumps(result, ensure_ascii=False).encode("utf-8"))
    finally:
        try:
            proto_out.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--worker":
        worker_threads = int(sys.argv[2]) if len(sys.argv) >= 3 else THREADS
        worker_beam = int(sys.argv[3]) if len(sys.argv) >= 4 else 2
        raise SystemExit(_run_persistent_worker(worker_threads, worker_beam))
    language_arg = sys.argv[1]
    print(json.dumps(WhisperCpu().transcribe(sys.stdin.buffer.read(), None if language_arg == "auto" else language_arg),
                     ensure_ascii=False))
