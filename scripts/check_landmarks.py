"""Self-check inspector for generated landmarks.bin (+ optional landmarks.json)."""

from __future__ import annotations

import json
import random
import struct
import sys
from pathlib import Path


def _align4(n: int) -> int:
    return (n + 3) & ~3


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python scripts/check_landmarks.py <path/to/landmarks.bin>", file=sys.stderr)
        return 2

    bin_path = Path(sys.argv[1]).expanduser().resolve()
    if not bin_path.is_file():
        print(f"ERROR: file not found: {bin_path}", file=sys.stderr)
        return 1

    data = bin_path.read_bytes()
    if len(data) < 24:
        print(f"ERROR: file too small ({len(data)} bytes)", file=sys.stderr)
        return 1

    magic, version, fps, count, n_points, scale, stride, reserved = struct.unpack_from("<4sHHIHHII", data, 0)
    header_len = _align4(24 + 2 * n_points)
    expected_bytes = header_len + count * stride

    print(
        f"header: magic={magic.decode('ascii', errors='replace')} version={version} fps={fps} "
        f"count={count} nPoints={n_points} scale={scale} stride={stride} reserved={reserved} headerLen={header_len}"
    )
    print(f"size:   actual={len(data)} bytes expected={expected_bytes} bytes ({len(data) / (1024 * 1024):.3f} MB)")

    errors: list[str] = []
    if magic != b"RBPS":
        errors.append(f"bad magic {magic!r}")
    if version != 1:
        errors.append(f"unexpected version {version}")
    if n_points <= 0 or n_points > 478:
        errors.append(f"invalid nPoints={n_points}")
    if scale <= 0:
        errors.append(f"invalid scale={scale}")
    if stride != 16 + 4 * n_points:
        errors.append(f"stride mismatch: {stride} != {16 + 4 * n_points}")
    if len(data) != expected_bytes:
        errors.append(f"byte length mismatch: {len(data)} != {expected_bytes}")
    if errors:
        for err in errors:
            print(f"ERROR: {err}", file=sys.stderr)
        return 1

    idx_table = struct.unpack_from(f"<{n_points}H", data, 24)
    print(f"points: n={len(idx_table)} min={min(idx_table)} max={max(idx_table)} first6={list(idx_table[:6])}")

    rec_struct = struct.Struct("<IHH4h")
    inv_scale = 1.0 / scale
    face_count = 0
    prev_t = -1
    non_monotonic = 0
    records_meta: list[tuple[int, int, int, tuple[float, float, float, float], list[tuple[float, float]]]] = []

    for i in range(count):
        off = header_len + i * stride
        t_ms, flags, _pad, bx, by, bw, bh = rec_struct.unpack_from(data, off)
        if t_ms < prev_t:
            non_monotonic += 1
        prev_t = t_ms
        has_face = bool(flags & 1)
        if has_face:
            face_count += 1
        pts3: list[tuple[float, float]] = []
        for k in range(min(3, n_points)):
            px, py = struct.unpack_from("<2h", data, off + 16 + k * 4)
            pts3.append((px * inv_scale, py * inv_scale))
        records_meta.append(
            (i, t_ms, int(has_face), (bx * inv_scale, by * inv_scale, bw * inv_scale, bh * inv_scale), pts3)
        )

    face_pct = (face_count / count * 100.0) if count else 0.0
    t_start = records_meta[0][1] if records_meta else 0
    t_end = records_meta[-1][1] if records_meta else 0
    print(
        f"stats:  hasFace={face_count}/{count} ({face_pct:.2f}%) | t_ms=[{t_start}..{t_end}] "
        f"| nonMonotonic={non_monotonic}"
    )

    json_path = bin_path.with_name("landmarks.json")
    if json_path.is_file():
        meta = json.loads(json_path.read_text(encoding="utf-8"))
        print(
            f"json:   count={meta.get('count')} fps={meta.get('fps')} nPoints={meta.get('nPoints')} "
            f"binBytes={meta.get('binBytes')} runs={len(meta.get('runs') or [])}"
        )
        if meta.get("count") != count or meta.get("binBytes") != len(data) or meta.get("nPoints") != n_points:
            print("ERROR: landmarks.json header mismatch with landmarks.bin", file=sys.stderr)
            return 1
    else:
        print("WARN: landmarks.json missing beside landmarks.bin")

    rng = random.Random(42)
    sample_n = min(20, count)
    sampled = sorted(rng.sample(range(count), sample_n)) if count else []
    print(f"\n--- Sampled {sample_n} frames ---")
    for idx in sampled:
        i, t_ms, has_face, bbox, pts3 = records_meta[idx]
        b_str = f"({bbox[0]:.3f},{bbox[1]:.3f},{bbox[2]:.3f},{bbox[3]:.3f})"
        p_str = " ".join(f"({x:.3f},{y:.3f})" for x, y in pts3)
        print(f"frame[{i:4d}] t={t_ms:7d}ms hasFace={has_face} bbox={b_str} pts[:3]={p_str}")

    if non_monotonic > 0:
        print("ERROR: timestamps are not monotonic", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
