"""Objective measurements of rendered audio against its spec.

Every function takes float samples in [-1, 1] (mono 1-D or stereo N x 2) and the
sample rate, and returns plain dicts so results can be dumped to JSON.
"""

from __future__ import annotations

import numpy as np
import pyloudnorm
from scipy import signal

ENV_RATE = 400  # Hz; envelope sample rate, enough for modulation up to ~100 Hz
# The envelope is taken from a band where the carrier is much faster than any
# modulation we measure; below that the "envelope" of broadband noise smears out.
ENV_BAND = (500.0, 8_000.0)
# A modulation peak counts as applied when it stands this far above its local floor.
# Null distribution (30 seeds of unmodulated 20 s pink noise): max 12.2 dB, p95 11.7 dB;
# applied AM at depth >= 0.25 measured >= 36 dB.
PROMINENCE_MIN_DB = 20.0


def _mono(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    return x.mean(axis=1) if x.ndim == 2 else x


def envelope(x: np.ndarray, sr: int) -> np.ndarray:
    """Amplitude envelope (Hilbert magnitude) resampled to ENV_RATE."""
    mono = _mono(x)
    sos = signal.butter(4, ENV_BAND, "bandpass", fs=sr, output="sos")
    env = np.abs(signal.hilbert(signal.sosfiltfilt(sos, mono)))
    # Anti-aliased decimation in stages keeps the modulation band intact.
    up, down = ENV_RATE, sr
    g = np.gcd(up, down)
    return signal.resample_poly(env, up // g, down // g)


def amplitude_modulation(x: np.ndarray, sr: int, band=(0.5, 60.0)) -> dict:
    """Dominant envelope modulation: rate, depth and how far it stands out.

    depth is m in e(t) = A(1 + m sin(2 pi f t)), i.e. the peak-to-peak swing of the
    envelope divided by twice its mean; prominence compares the peak bin with the
    median of the surrounding band, which separates applied modulation from the
    natural envelope fluctuation of music or noise.
    """
    env = envelope(x, sr)
    mean = float(env.mean())
    centred = env - mean
    spec = np.abs(np.fft.rfft(centred * signal.windows.hann(len(env))))
    freqs = np.fft.rfftfreq(len(env), 1 / ENV_RATE)
    df = freqs[1] - freqs[0]
    idx = np.flatnonzero((freqs >= band[0]) & (freqs <= band[1]))
    # Natural envelopes (music, noise) are strongly red; pick the peak that stands out
    # from its local floor (+-2 Hz median), not the largest absolute bin.
    half = max(int(2.0 / df), 3)
    padded = np.pad(spec, half, mode="reflect")
    floor = np.array([np.median(padded[i : i + 2 * half + 1]) for i in idx])
    prominence = spec[idx] / np.maximum(floor, 1e-12)
    peak = idx[np.argmax(prominence)]
    # Refine rate and get the exact amplitude by least-squares projection on a fine grid.
    t = np.arange(len(env)) / ENV_RATE
    grid = freqs[peak] + np.linspace(-df, df, 201)
    best_f, best_amp = grid[0], -1.0
    for f in grid:
        c = 2 * np.dot(centred, np.cos(2 * np.pi * f * t)) / len(env)
        s = 2 * np.dot(centred, np.sin(2 * np.pi * f * t)) / len(env)
        amp = float(np.hypot(c, s))
        if amp > best_amp:
            best_f, best_amp = f, amp
    return {
        "rate_hz": float(best_f),
        "depth": float(best_amp / mean) if mean > 0 else 0.0,
        "peak_prominence_db": float(20 * np.log10(prominence.max())),
    }


def spectral_slope(x: np.ndarray, sr: int, band=(50.0, 10_000.0)) -> dict:
    """Least-squares slope of the power spectrum in dB per octave (white 0, pink -3, brown -6)."""
    f, pxx = signal.welch(_mono(x), sr, nperseg=1 << 14)
    sel = (f >= band[0]) & (f <= band[1]) & (pxx > 0)
    # Fit on log-spaced points so the high octaves (many bins) do not dominate.
    grid = np.geomspace(band[0], band[1], 64)
    db = np.interp(np.log2(grid), np.log2(f[sel]), 10 * np.log10(pxx[sel]))
    slope = np.polyfit(np.log2(grid), db, 1)[0]
    return {"db_per_octave": float(slope)}


def _dominant_tone(ch: np.ndarray, sr: int, band) -> float:
    win = ch * signal.windows.hann(len(ch))
    spec = np.abs(np.fft.rfft(win))
    freqs = np.fft.rfftfreq(len(ch), 1 / sr)
    idx = np.flatnonzero((freqs >= band[0]) & (freqs <= band[1]))
    k = idx[np.argmax(spec[idx])]
    a, b, c = spec[k - 1], spec[k], spec[k + 1]
    shift = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) else 0.0
    return float(freqs[k] + shift * (freqs[1] - freqs[0]))


def binaural(x: np.ndarray, sr: int, carrier_band=(40.0, 1500.0)) -> dict:
    """Carrier frequency per channel and the resulting binaural beat."""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim != 2 or x.shape[1] != 2:
        raise ValueError("binaural measurement needs a stereo N x 2 signal")
    left = _dominant_tone(x[:, 0], sr, carrier_band)
    right = _dominant_tone(x[:, 1], sr, carrier_band)
    return {"left_hz": left, "right_hz": right, "beat_hz": abs(right - left)}


def levels(x: np.ndarray, sr: int) -> dict:
    """Integrated loudness (BS.1770), sample peak, 4x-oversampled true peak, clipping."""
    x = np.asarray(x, dtype=np.float64)
    meter = pyloudnorm.Meter(sr)
    lufs = meter.integrated_loudness(x)
    over = signal.resample_poly(x, 4, 1, axis=0)
    sample_peak = float(np.max(np.abs(x)))
    true_peak = float(max(np.max(np.abs(over)), sample_peak))
    return {
        "integrated_lufs": float(lufs),
        "sample_peak_dbfs": float(20 * np.log10(max(sample_peak, 1e-12))),
        "true_peak_dbtp": float(20 * np.log10(max(true_peak, 1e-12))),
        "clipped_samples": int(np.count_nonzero(np.abs(x) >= 0.999)),
    }


def clicks(x: np.ndarray, sr: int, threshold: float = 12.0, min_jump: float = 1e-4) -> dict:
    """Isolated discontinuities: samples whose high-passed second difference is an
    outlier (threshold x robust sigma) relative to the local signal."""
    mono = _mono(x)
    hp = signal.sosfiltfilt(signal.butter(4, 4_000, "highpass", fs=sr, output="sos"), mono)
    d2 = np.abs(np.diff(hp, n=2))
    # Local robust scale: median of each 50 ms block (thousands of samples, so the
    # estimate is stable), interpolated between block centres.
    block = max(int(0.05 * sr), 16)
    n_blocks = max(len(d2) // block, 1)
    medians = np.median(d2[: n_blocks * block].reshape(n_blocks, -1), axis=1)
    centres = (np.arange(n_blocks) + 0.5) * block
    sigma = 1.4826 * np.interp(np.arange(len(d2)), centres, medians)
    # Below ~-80 dBFS a discontinuity is inaudible; this also ignores float noise in
    # very dark material such as brown noise.
    hits = np.flatnonzero((d2 > threshold * sigma) & (d2 > min_jump))
    # Filter edge transients are not clicks in the file; seams are checked by loop_seam.
    edge = int(0.01 * sr)
    hits = hits[(hits >= edge) & (hits < len(d2) - edge)]
    # Merge hits closer than 5 ms into one event.
    events = []
    for h in hits:
        if not events or h - events[-1] > 0.005 * sr:
            events.append(h)
    return {"count": len(events), "times_s": [float((h + 1) / sr) for h in events]}


def loop_seam(x: np.ndarray, sr: int, context_s: float = 0.05) -> dict:
    """Does playing the file in a loop produce a click at the wrap point?"""
    mono = _mono(x)
    n = int(context_s * sr)
    joined = np.concatenate([mono[-n:], mono[:n]])
    jump = abs(mono[0] - mono[-1])
    typical = float(np.median(np.abs(np.diff(joined)))) or 1e-12
    return {"jump": float(jump), "click": bool(jump > 6 * typical + 1e-4)}
