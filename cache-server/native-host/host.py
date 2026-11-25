"""Chrome Native Messaging host for on-demand startup of the local cache server."""

from __future__ import annotations

import json
import logging
import os
import struct
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, Request, build_opener

if os.name == "nt":
    import msvcrt

NATIVE_DIR = Path(__file__).resolve().parent
CACHE_SERVER_DIR = NATIVE_DIR.parent
LOG_PATH = NATIVE_DIR / "host.log"
SERVER_LOG_PATH = NATIVE_DIR / "server.log"
ENV_JSON_PATH = NATIVE_DIR / "env.json"
LOCK_PATH = NATIVE_DIR / "launch.lock"

# Keep stdout strictly reserved for Native Messaging 4-byte length-prefixed JSON frames.
logging.basicConfig(
    filename=str(LOG_PATH),
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    encoding="utf-8",
)
logger = logging.getLogger("rb-native-host")


def _configure_stdio_binary() -> None:
    if os.name == "nt":
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)


def _read_message() -> dict | None:
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    if msg_len == 0 or msg_len > 1024 * 1024:
        raise ValueError(f"invalid native message length: {msg_len}")
    payload = b""
    while len(payload) < msg_len:
        chunk = sys.stdin.buffer.read(msg_len - len(payload))
        if not chunk:
            raise EOFError("unexpected EOF reading native message body")
        payload += chunk
    return json.loads(payload.decode("utf-8"))


def _write_message(data: dict) -> None:
    encoded = json.dumps(data, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def _load_env() -> dict[str, str]:
    merged = os.environ.copy()
    if ENV_JSON_PATH.is_file():
        try:
            raw = json.loads(ENV_JSON_PATH.read_text(encoding="utf-8-sig"))
            if isinstance(raw, dict):
                for key, val in raw.items():
                    if val is None:
                        continue
                    sval = str(val).strip()
                    if sval and not merged.get(key):
                        merged[str(key)] = sval
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to parse env.json: %s", exc)
    return merged


def _probe_health(port: int, timeout: float = 0.5) -> dict | None:
    opener = build_opener(ProxyHandler({}))
    try:
        req = Request(f"http://127.0.0.1:{port}/health", headers={"Cache-Control": "no-store"})
        with opener.open(req, timeout=timeout) as resp:
            if resp.status == 200:
                return json.loads(resp.read().decode("utf-8"))
    except (URLError, TimeoutError, OSError, ValueError):
        return None
    finally:
        opener.close()
    return None


def _pick_python() -> Path:
    scripts_dir = CACHE_SERVER_DIR / ".venv" / "Scripts"
    for name in ("pythonw.exe", "python.exe"):
        cand = scripts_dir / name
        if cand.is_file():
            return cand
    return Path(sys.executable)


class _FileLock:
    def __init__(self, path: Path, timeout: float = 12.0) -> None:
        self.path = path
        self.timeout = timeout
        self._fp = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fp = open(self.path, "a+b")
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                if os.name == "nt":
                    self._fp.seek(0)
                    msvcrt.locking(self._fp.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self._fp.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("timed out waiting for launch lock")
                time.sleep(0.1)

    def __exit__(self, *_exc) -> None:
        if self._fp is None:
            return
        try:
            if os.name == "nt":
                self._fp.seek(0)
                msvcrt.locking(self._fp.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self._fp.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            self._fp.close()
            self._fp = None


def _spawn_cache_server(env: dict[str, str]) -> int:
    python_exe = _pick_python()
    main_py = CACHE_SERVER_DIR / "main.py"
    flags = 0
    if os.name == "nt":
        flags = (
            getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        )
    SERVER_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    log_fp = open(SERVER_LOG_PATH, "ab")
    try:
        proc = subprocess.Popen(
            [str(python_exe), str(main_py)],
            cwd=str(CACHE_SERVER_DIR),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log_fp,
            stderr=subprocess.STDOUT,
            close_fds=True,
            creationflags=flags,
        )
        return proc.pid
    finally:
        log_fp.close()


def _ensure_running(reason: str) -> dict:
    env = _load_env()
    port = int(env.get("RB_CACHE_PORT", "8765"))
    if _probe_health(port, timeout=0.5) is not None:
        return {"ok": True, "alreadyRunning": True, "started": False, "port": port}

    with _FileLock(LOCK_PATH, timeout=28.0):
        if _probe_health(port, timeout=0.5) is not None:
            return {"ok": True, "alreadyRunning": True, "started": False, "port": port}

        pid = _spawn_cache_server(env)
        logger.info("Spawned cache-server pid=%d reason=%s port=%d", pid, reason, port)

        deadline = time.monotonic() + 25.0
        while time.monotonic() < deadline:
            if _probe_health(port, timeout=0.4) is not None:
                logger.info("cache-server ready on port %d (pid=%d)", port, pid)
                return {"ok": True, "alreadyRunning": False, "started": True, "port": port, "pid": pid}
            time.sleep(0.15)

    logger.error("cache-server failed to become ready on port %d within 25s", port)
    return {
        "ok": False,
        "error": "server_start_timeout",
        "port": port,
        "log": str(SERVER_LOG_PATH),
    }


def main() -> int:
    _configure_stdio_binary()
    try:
        msg = _read_message()
        if msg is None:
            return 0
        action = str(msg.get("action") or "ensure_running")
        reason = str(msg.get("reason") or "demand")
        if action == "status":
            env = _load_env()
            port = int(env.get("RB_CACHE_PORT", "8765"))
            health = _probe_health(port, timeout=0.5)
            _write_message({"ok": True, "running": health is not None, "port": port})
            return 0
        if action == "ensure_running":
            _write_message(_ensure_running(reason))
            return 0
        _write_message({"ok": False, "error": f"unknown_action:{action}"})
        return 0
    except Exception as exc:  # noqa: BLE001
        logger.exception("Native host error")
        try:
            _write_message({"ok": False, "error": str(exc)})
        except Exception:  # noqa: BLE001
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
