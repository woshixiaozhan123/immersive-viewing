"""Local, CPU-only inference for subtitles from already cached transport streams."""
from __future__ import annotations

import json
import os
import secrets
import shutil
import socket
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

CPU_COUNT = getattr(os, "process_cpu_count", os.cpu_count)() or 1
THREADS = max(1, int(os.environ.get("RB_SUBS_THREADS", str(min(4, CPU_COUNT)))))
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


def extract_pcm(paths: list[Path]) -> bytes:
    for path in paths:
        if not path.is_file():
            raise FileNotFoundError(path)
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
    def __init__(self) -> None:
        from faster_whisper import WhisperModel

        location = os.environ.get("RB_SUBS_WHISPER_DIR") or "small"
        self.model = WhisperModel(location, device="cpu", compute_type="int8",
                                  cpu_threads=THREADS, local_files_only=True)

    def transcribe(self, pcm: bytes, language: str | None) -> dict:
        import numpy as np

        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        cues, info = self.model.transcribe(
            audio, language=language, vad_filter=True, beam_size=5,
            language_detection_segments=3, language_detection_threshold=0.75,
            vad_parameters={"min_silence_duration_ms": 400},
        )
        return {"language": info.language, "probability": info.language_probability,
                "cues": [{"t0": cue.start, "t1": cue.end, "src": cue.text.strip()}
                         for cue in cues if cue.text.strip()]}


def run_whisper(pcm: bytes, language: str | None, cancel=None) -> dict:
    check_cancelled(cancel)
    if len(pcm) < 3200:
        return {"language": language, "probability": 0, "cues": []}
    command = [sys.executable, str(WORKER_FILE), language or "auto"]
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "PYTHONUTF8": "1"}
    if os.name == "nt" and sys.prefix != sys.base_prefix:
        # Launch the interpreter directly so cancelling this Popen handle stops
        # the worker itself, including when the server runs in a Windows venv.
        command[0] = sys._base_executable
        paths = [sysconfig.get_path("purelib"), env.get("PYTHONPATH", "")]
        env["PYTHONPATH"] = os.pathsep.join(dict.fromkeys(path for path in paths if path))
    child = _start_child(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        deadline = time.monotonic() + 150
        payload = pcm
        while True:
            check_cancelled(cancel)
            try:
                output, _ = child.communicate(payload, timeout=0.4)
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() >= deadline:
                    raise
                payload = None
        if child.returncode:
            raise RuntimeError("Whisper small 不可用，请确认已安装字幕依赖并配置本地模型")
        return json.loads(output)
    finally:
        _close_child(child)


class LocalTranslator:
    """Own the temporary llama-server process for a group of translations."""

    def __init__(self, *, binary=None, threads=THREADS, device="none", cancel=None) -> None:
        self.binary = binary
        self.threads = threads
        self.device = device
        self.cancel = cancel
        self.finished = threading.Event()
        self.process = None
        self.token = secrets.token_urlsafe(32)
        self.opener = build_opener(ProxyHandler({}))

    def __enter__(self):
        check_cancelled(self.cancel)
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
        if self.cancel is not None:
            threading.Thread(target=self._watch_cancel, name="rb-subs-cancel", daemon=True).start()
        try:
            deadline = time.monotonic() + 30
            while self.process.poll() is None and time.monotonic() < deadline:
                check_cancelled(self.cancel)
                try:
                    self.request("/health", timeout=0.5)
                    return self
                except (URLError, TimeoutError):
                    time.sleep(0.12)
            raise RuntimeError("本地混元启动失败，请检查 llama-server 和模型格式")
        except (OSError, RuntimeError, InferenceCancelled):
            self.__exit__(None, None, None)
            raise

    def _watch_cancel(self) -> None:
        while not self.finished.wait(0.08):
            if self.cancel.is_set():
                with CHILDREN_LOCK:
                    if self.process.poll() is None:
                        self.process.terminate()
                return

    def __exit__(self, *_exc) -> None:
        self.finished.set()
        self.opener.close()
        if self.process:
            _close_child(self.process)


    def request(self, route: str, payload: dict | None = None, timeout: float = 60) -> dict:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        req = Request(f"http://127.0.0.1:{self.port}{route}", data=data,
                      headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        with self.opener.open(req, timeout=timeout) as response:
            return json.load(response)

    def translate(self, cues: list[dict], prior: list[str], cancel=None) -> dict[str, str]:
        result = {}
        context = prior[-2:]
        for start in range(0, len(cues), 6):
            check_cancelled(cancel)
            batch = cues[start:start + 6]
            parts = self._request_lines(batch, context)
            if len(parts) != len(batch) or not all(parts):
                parts = []
                for cue in batch:
                    check_cancelled(cancel)
                    one = self._request_lines([cue], context)
                    if len(one) != 1 or not one[0]:
                        raise RuntimeError("混元返回的译文与字幕条数不匹配")
                    parts.append(one[0])
            result.update({cue["id"]: zh for cue, zh in zip(batch, parts, strict=True)})
            context = [*context, *(cue["src"] for cue in batch)][-2:]
        return result

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


if __name__ == "__main__":
    language_arg = sys.argv[1]
    print(json.dumps(WhisperCpu().transcribe(sys.stdin.buffer.read(), None if language_arg == "auto" else language_arg),
                     ensure_ascii=False))
