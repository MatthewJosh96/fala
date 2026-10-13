"""Simulated phone -> room -> microphone chain and playback faults for the continuity tests."""

from __future__ import annotations

import subprocess
from math import gcd

import numpy as np
from scipy import signal

from fala_audio_check import timecode as tc

SR = tc.SR
PRE_ROLL_S = 0.7  # the recorder starts before the phone plays
POST_ROLL_S = 1.0


def source(duration_s: int, seed: int = tc.DEFAULT_SEED) -> np.ndarray:
    return tc.Renderer(duration_s, seed).render(0, duration_s * SR)


def _i(at_s: float) -> int:
    return int(round(at_s * SR))


# Faults act on the source (what the phone's player outputs). Apply them from the latest
# position to the earliest so every position stays in source time.
def cut(x, at_s, dur_s):
    return np.concatenate([x[: _i(at_s)], x[_i(at_s + dur_s) :]])


def silence(x, at_s, dur_s):
    y = x.copy()
    y[_i(at_s) : _i(at_s + dur_s)] = 0.0
    return y


def insert_zeros(x, at_s, dur_s):
    return np.concatenate([x[: _i(at_s)], np.zeros(_i(dur_s)), x[_i(at_s) :]])


def repeat(x, at_s, dur_s):
    a, b = _i(at_s), _i(at_s + dur_s)
    return np.concatenate([x[:b], x[a:b], x[b:]])


def truncate(x, at_s):
    return x[: _i(at_s)]


def gain_step(x, at_s, db):
    g = np.ones(len(x))
    g[_i(at_s) :] = 10 ** (db / 20)
    return x * g


def gain_ramp(x, t0_s, t1_s, db):
    g = np.ones(len(x))
    a, b = _i(t0_s), _i(t1_s)
    g[a:b] = 10 ** (np.linspace(0, db, b - a) / 20)
    g[b:] = 10 ** (db / 20)
    return x * g


def apply_faults(x, faults):
    for kind, at_s, *args in sorted(faults, key=lambda f: -f[1]):
        x = {"cut": cut, "silence": silence, "insert_zeros": insert_zeros, "repeat": repeat, "truncate": truncate}[kind](
            x, at_s, *args
        )
    return x


def aac_roundtrip(x: np.ndarray, tmpdir, bitrate: str = "128k") -> np.ndarray:
    """Encode to AAC-LC in M4A with ffmpeg (Apple encoder when present) and decode back."""
    src = tmpdir / "src.f32"
    out = tmpdir / "rt.m4a"
    np.stack([x, x], axis=1).astype("<f4").tofile(src)
    enc = "aac_at" if b"aac_at" in subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True).stdout else "aac"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", str(src),
         "-c:a", enc, "-b:a", bitrate, str(out)],
        check=True,
    )
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(out), "-ac", "1", "-f", "f32le", "pipe:1"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4").astype(np.float64)


def rir(drr_db: float = 6.0, rt60_s: float = 0.4, seed: int = 3, length_s: float = 0.6) -> np.ndarray:
    """Direct impulse + exponentially decaying noise tail with the given direct-to-reverberant ratio."""
    rng = np.random.default_rng(seed)
    n = int(length_s * SR)
    h = np.zeros(n)
    d = int(0.001 * SR)
    h[d] = 1.0
    start = d + int(0.002 * SR)
    t = np.arange(n - start) / SR
    tail = rng.standard_normal(n - start) * np.exp(-6.908 * t / rt60_s)
    tail *= np.sqrt(10 ** (-drr_db / 10) / np.sum(tail**2))
    h[start:] = tail
    return h


def room(
    x: np.ndarray,
    *,
    drift_ppm: float = 0.0,
    drr_db: float | None = 6.0,
    rt60_s: float = 0.4,
    speaker: tuple[float, float] | None = (250.0, 14_000.0),
    hiss_db: float | None = -35.0,
    rumble_db: float | None = -20.0,
    out_sr: int = 24_000,
    seed: int = 11,
) -> np.ndarray:
    """Phone speaker band -> room reverb -> recorder clock drift and resampling -> room noise -> 16 bit."""
    y = np.concatenate([np.zeros(_i(PRE_ROLL_S)), x, np.zeros(_i(POST_ROLL_S))])
    if speaker is not None:
        sos = np.vstack([
            signal.butter(2, speaker[0], "highpass", fs=SR, output="sos"),
            signal.butter(4, speaker[1], "lowpass", fs=SR, output="sos"),
        ])
        y = signal.sosfilt(sos, y)
    if drr_db is not None:
        y = signal.fftconvolve(y, rir(drr_db, rt60_s))[: len(y)]
    up = 1_000_000 + int(round(drift_ppm))
    down = 1_000_000 * SR // out_sr
    g = gcd(up, down)
    y = signal.resample_poly(y, up // g, down // g)
    rng = np.random.default_rng(seed)
    ref = np.sqrt(np.mean(y**2))
    if hiss_db is not None:
        y = y + rng.standard_normal(len(y)) * ref * 10 ** (hiss_db / 20)
    if rumble_db is not None:
        brown = np.cumsum(rng.standard_normal(len(y)))
        brown = signal.sosfilt(signal.butter(2, [20, 300], "bandpass", fs=out_sr, output="sos"), brown)
        y = y + brown / np.sqrt(np.mean(brown**2)) * ref * 10 ** (rumble_db / 20)
    return np.round(np.clip(y, -1, 1) * 32767) / 32767
