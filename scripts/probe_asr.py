"""一次性验证脚本：从已缓存的 TS 分片抽 5 分钟音频，用 faster-whisper 转写日语。

不进入正式代码，只为回答一个问题：这类片子的音轨能不能转出可用的日语。

用法：
    python scripts/probe_asr.py <safeKey> [分片数] [模型]
    python scripts/probe_asr.py avbebe.com_archives_357404 60 small
"""
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

CACHE_ROOT = Path(os.environ.get("RB_GRAB_CACHE_DIR", str(Path.home() / "Videos" / "grab-cache")))
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

if len(sys.argv) < 2:
    sys.exit("用法: probe_asr.py <safeKey> [分片数=60] [模型=small]")
ENTRY = CACHE_ROOT / sys.argv[1]
N_SEGS = int(sys.argv[2]) if len(sys.argv) > 2 else 60
MODEL = sys.argv[3] if len(sys.argv) > 3 else "small"

if not (ENTRY / "segs").is_dir():
    sys.exit(f"找不到缓存条目: {ENTRY}")

segs = sorted((ENTRY / "segs").glob("*.ts"))[:N_SEGS]
print(f"[1/3] 用 {len(segs)} 片（约 {len(segs) * 5}s）抽音频", flush=True)
lst = ENTRY / "_sample_concat.txt"
lst.write_text("\n".join(f"file '{p.as_posix()}'" for p in segs), encoding="utf-8")
wav = ENTRY / f"_sample_{N_SEGS}seg.wav"
t0 = time.time()
subprocess.run(
    [FFMPEG, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
     "-vn", "-ac", "1", "-ar", "16000", str(wav)],
    check=True,
)
dur = subprocess.run(
    [FFPROBE, "-v", "error", "-show_entries",
     "format=duration", "-of", "default=nw=1:nk=1", str(wav)],
    capture_output=True, text=True,
).stdout.strip()
print(f"      wav {wav.stat().st_size / 1e6:.1f} MB / {dur}s / 抽音频 {time.time() - t0:.1f}s", flush=True)

print(f"[2/3] 载入 whisper {MODEL}（首次会下载模型）", flush=True)
from faster_whisper import WhisperModel

t0 = time.time()
model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=12)
print(f"      模型就绪 {time.time() - t0:.1f}s", flush=True)

print("[3/3] 转写中…", flush=True)
# 注意：av 19.x 删了 metadata_errors 参数，faster-whisper 1.2.1 直接读文件会 TypeError。
# 绕开它的解码路径，自己读 wav 成 float32 数组喂进去。
import wave

import numpy as np

with wave.open(str(wav), "rb") as wf:
    assert wf.getnchannels() == 1 and wf.getframerate() == 16000
    pcm = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)
audio = pcm.astype(np.float32) / 32768.0

t0 = time.time()
segments, info = model.transcribe(
    audio, language="ja", vad_filter=True, beam_size=5,
    vad_parameters=dict(min_silence_duration_ms=400),
)
rows = []
for s in segments:
    rows.append((s.start, s.end, s.no_speech_prob, s.text.strip()))
elapsed = time.time() - t0
audio_len = float(dur or 0)

out = ENTRY / f"_sample_{N_SEGS}seg_{MODEL}.txt"
with out.open("w", encoding="utf-8") as f:
    for st, en, nsp, tx in rows:
        f.write(f"[{st:07.2f} -> {en:07.2f}] nsp={nsp:.2f} {tx}\n")

speech = sum(en - st for st, en, _, _ in rows)
print("\n" + "=" * 70)
print(f"音频 {audio_len:.0f}s / 有效语音 {speech:.0f}s ({speech / max(audio_len, 1) * 100:.0f}%)")
print(f"转写 {len(rows)} 句 / 耗时 {elapsed:.1f}s → {audio_len / max(elapsed, 1):.1f}x 实时")
print(f"明细已存 {out}")
print("=" * 70)
for st, en, nsp, tx in rows[:40]:
    print(f"{st:7.2f} {nsp:.2f}  {tx}")
