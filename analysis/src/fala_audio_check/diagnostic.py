"""Generator and verifier of fala-diag-v1 diagnostic files (M4A, AAC-LC 128 kb/s).

The signal is rendered in blocks and streamed straight into ffmpeg's stdin, so an 8 h
file needs constant memory and no intermediate WAV (8 h of float stereo is ~11 GB).
A sidecar JSON next to the file carries size and SHA-256 of the finished file, which
the PWA uses to verify its offline download.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import random
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from . import continuity
from . import timecode as tc

BITRATE = 128_000
BLOCK_S = 10
SEEK_SLACK_S = 0.030


def available_encoder(preferred: str = "auto") -> str:
    if preferred != "auto":
        return preferred
    out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    return "aac_at" if " aac_at " in out else "aac"


def _encoder_args(encoder: str) -> list[str]:
    args = ["-c:a", encoder, "-b:a", str(BITRATE)]
    if encoder == "aac_at":
        # Constant bitrate keeps the file size predictable (~461 MB for 8 h); AudioToolbox
        # encodes AAC-LC by default and does not take ffmpeg's profile names.
        args += ["-aac_at_mode", "cbr"]
    else:
        args += ["-profile:a", "aac_low"]
    return args


def probe(path: str | Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=codec_name,profile,sample_rate,channels,bit_rate:format=duration,bit_rate,format_name",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    st, fmt = data["streams"][0], data["format"]
    return {
        "codec": st.get("codec_name"),
        "profile": st.get("profile"),
        "sample_rate": int(st.get("sample_rate", 0)),
        "channels": int(st.get("channels", 0)),
        "stream_bit_rate": int(st["bit_rate"]) if st.get("bit_rate") else None,
        "format_bit_rate": int(fmt["bit_rate"]) if fmt.get("bit_rate") else None,
        "duration_s": float(fmt["duration"]),
        "format_name": fmt.get("format_name"),
    }


def sha256_of(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def generate(out: str | Path, duration_s: int, *, seed: int = tc.DEFAULT_SEED, encoder: str = "auto",
             title: str | None = None, file_id: str | None = None, progress: bool = False) -> dict:
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    encoder = available_encoder(encoder)
    title = title or f"Fala diagnostic {duration_s} s"
    file_id = file_id or f"{tc.FORMAT}-{duration_s}s-{seed}"
    tmp = out.with_name(out.stem + ".partial" + out.suffix)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "f32le", "-ar", str(tc.SR), "-ac", "2",
           "-i", "pipe:0", *_encoder_args(encoder), "-movflags", "+faststart",
           "-metadata", f"title={title}", "-metadata", f"comment={tc.FORMAT} seed={seed}", str(tmp)]
    renderer = tc.Renderer(duration_s, seed)
    t0 = time.monotonic()
    log = tmp.with_suffix(".ffmpeg.txt")
    with open(log, "wb") as errfh:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=errfh)
    try:
        block = BLOCK_S * tc.SR
        for start in range(0, renderer.length, block):
            x = renderer.render(start, min(block, renderer.length - start)).astype("<f4")
            try:
                proc.stdin.write(np.repeat(x, 2).tobytes())
            except BrokenPipeError:
                proc.wait()
                raise RuntimeError(f"ffmpeg exited early: {log.read_text(errors='replace').strip()}") from None
            if progress and start % (600 * tc.SR) == 0:
                print(f"  {start // tc.SR} s / {duration_s} s  ({time.monotonic() - t0:.0f} s)", file=sys.stderr)
        proc.stdin.close()
        if proc.wait() != 0:
            raise RuntimeError(f"ffmpeg failed: {log.read_text(errors='replace').strip()}")
    except BaseException:
        proc.kill()
        proc.wait()
        tmp.unlink(missing_ok=True)
        raise
    finally:
        log.unlink(missing_ok=True)
    os.replace(tmp, out)
    elapsed = time.monotonic() - t0
    info = probe(out)
    meta = {
        "format": tc.FORMAT,
        "id": file_id,
        "title": title,
        "file": out.name,
        "content_type": "audio/mp4",
        "duration_s": duration_s,
        "size": out.stat().st_size,
        "sha256": sha256_of(out),
        "sample_rate": tc.SR,
        "bitrate": BITRATE,
        "encoder": encoder,
        "seed": seed,
        "created": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }
    out.with_suffix(".json").write_text(json.dumps(meta, indent=2) + "\n")
    return {"meta": meta, "probe": info, "generation_s": round(elapsed, 2)}


def check_probe(info: dict, duration_s: int) -> list[str]:
    problems = []
    if info["codec"] != "aac":
        problems.append(f"codec {info['codec']} != aac")
    if info["profile"] != "LC":
        problems.append(f"profile {info['profile']} != LC")
    if info["sample_rate"] != tc.SR or info["channels"] != 2:
        problems.append(f"{info['sample_rate']} Hz / {info['channels']} ch")
    br = info["stream_bit_rate"] or info["format_bit_rate"] or 0
    if not 0.85 * BITRATE <= br <= 1.15 * BITRATE:
        problems.append(f"bitrate {br} not ~{BITRATE}")
    if abs(info["duration_s"] - duration_s) > 0.1:
        problems.append(f"duration {info['duration_s']:.3f} != {duration_s}")
    return problems


def _windows(duration_s: int, window_s: float, n_random: int, seed: int) -> list[tuple[float, float]]:
    if duration_s <= 3 * window_s:
        return [(0.0, float(duration_s))]
    rng = random.Random(seed)
    starts = [0.0] + sorted(rng.uniform(window_s, duration_s - 2 * window_s) for _ in range(n_random))
    starts.append(duration_s - window_s)
    return [(s, window_s) for s in starts]


def verify(path: str | Path, duration_s: int | None = None, *, window_s: float = 30.0, n_random: int = 5,
           seed: int = 1) -> dict:
    """Decode the file (whole when short, otherwise start / random / last windows) and check
    that every second's burst decodes to the number its position implies."""
    path = Path(path)
    sidecar = path.with_suffix(".json")
    if duration_s is None:
        duration_s = int(json.loads(sidecar.read_text())["duration_s"]) if sidecar.exists() else round(probe(path)["duration_s"])
    info = probe(path)
    problems = check_probe(info, duration_s)
    if sidecar.exists():
        meta = json.loads(sidecar.read_text())
        if meta.get("size") != path.stat().st_size:
            problems.append("sidecar size mismatch")
        if meta.get("sha256") != sha256_of(path):
            problems.append("sidecar sha256 mismatch")
    windows = []
    last_number = None
    for start, length in _windows(duration_s, window_s, n_random, seed):
        bursts = continuity.detect_bursts(continuity.ffmpeg_blocks(path, start, length))
        # ffmpeg's -ss into an M4A lands on an AAC frame (1024 samples), so a seeked window
        # is offset by up to ~25 ms: require bursts well inside it, a constant offset within
        # the window (1 ms) and an absolute offset of at most SEEK_SLACK_S.
        slack = SEEK_SLACK_S if start > 0 else 0.0
        first = int(np.ceil(start + slack))
        last = int(np.floor(start + length - tc.BURST_S - slack))
        expected = list(range(first, min(last, duration_s - 1) + 1))
        got = {b.number: b.t for b in bursts if b.number is not None}
        offsets = {n: start + t - n for n, t in got.items()}
        ref = float(np.median(list(offsets.values()))) if offsets else 0.0
        missing = [n for n in expected if n not in got]
        misplaced = [n for n, o in offsets.items() if abs(o - ref) > 0.001 or abs(o) > max(slack, 0.001)]
        unexpected = [n for n in got if not 0 <= n < duration_s or (n not in expected and abs(n - start) > 1 and abs(n - (start + length)) > 1)]
        ok = not missing and not misplaced and not unexpected
        windows.append({"start_s": start, "length_s": length, "expected": len(expected), "decoded": len(got),
                        "offset_ms": round(ref * 1e3, 3),
                        "missing": missing[:10], "misplaced": misplaced[:10], "unexpected": unexpected[:10], "ok": ok})
        if got:
            last_number = max(got) if last_number is None else max(last_number, max(got))
        if not ok:
            problems.append(f"window {start:.1f}+{length:.0f}s: missing {missing[:5]} misplaced {misplaced[:5]} unexpected {unexpected[:5]}")
    if last_number != duration_s - 1:
        problems.append(f"last decoded second {last_number} != {duration_s - 1}")
    return {"file": str(path), "duration_s": duration_s, "probe": info, "windows": windows,
            "last_number": last_number, "ok": not problems, "problems": problems}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=f"{tc.FORMAT} diagnostic file generator / verifier")
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate")
    g.add_argument("--duration-s", type=int, required=True)
    g.add_argument("--out", required=True)
    g.add_argument("--seed", type=int, default=tc.DEFAULT_SEED)
    g.add_argument("--encoder", choices=["auto", "aac_at", "aac"], default="auto")
    g.add_argument("--title")
    g.add_argument("--id")
    g.add_argument("--verify", action="store_true", help="decode and check the timecode afterwards")
    v = sub.add_parser("verify")
    v.add_argument("file")
    v.add_argument("--duration-s", type=int)
    args = ap.parse_args(argv)

    if args.cmd == "generate":
        res = generate(args.out, args.duration_s, seed=args.seed, encoder=args.encoder, title=args.title,
                       file_id=args.id, progress=True)
        problems = check_probe(res["probe"], args.duration_s)
        print(json.dumps({**res, "probe_problems": problems}, indent=2))
        if problems:
            return 1
        if not args.verify:
            return 0
        path = args.out
    else:
        path = args.file
    rep = verify(path, getattr(args, "duration_s", None) if args.cmd == "verify" else args.duration_s)
    print(json.dumps({k: rep[k] for k in ("file", "duration_s", "last_number", "ok", "problems")} |
                     {"windows": [{k: w[k] for k in ("start_s", "expected", "decoded", "offset_ms", "ok")} for w in rep["windows"]]},
                     indent=2))
    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
