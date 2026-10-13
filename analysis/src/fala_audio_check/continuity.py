"""Continuity detector for an external (microphone) recording of a fala-diag-v1 file.

The phone plays the diagnostic file; another device records it. This module finds
every sync chirp, decodes the second number that follows it and checks two things:

* the time axis: consecutive bursts must be exactly (n2 - n1) seconds apart, up to a
  slowly varying clock ratio between the phone and the recorder. A deviation is a
  ``skip`` (content lost, negative step), a ``gap`` (silence inserted, positive step
  with a dip of the background) or a ``repeat`` (content played twice, positive step
  without a dip, or the same number twice);
* the background: the pink noise in 5.5 - 11 kHz (no burst energy there) must not dip.
  A dip that does not move the time axis is a ``dropout`` (muted output while the
  player keeps running). A lasting level shift is a ``level_change`` and is only
  informational (volume, ducking).

The file ending before second D-1 is ``premature_end``. Everything is computed at
ANALYSIS_SR = 24 kHz from a mono stream processed in blocks; only the 1 ms energy
track (~115 MB for 8 h) and the burst list are kept.

Resolution (calibration in tests/test_continuity.py and a fault grid; simulated chain:
phone speaker band 250 Hz - 14 kHz, room RIR RT60 0.4 s with DRR +6 dB, rumble and
hiss, recorder clock +-100 ppm, 24 kHz 16 bit recording, optionally AAC 128 kb/s):

* time steps: burst-to-burst jitter is ~0.005 ms (robust sigma); the step threshold
  is max(0.5 ms, 10 sigma). Skips, gaps and repeats of 1 ms and more are detected,
  inside or outside the burst, and their size is measured to better than 0.05 ms.
* gap vs repeat: a positive step is a gap when the background shows a matching dip.
  That works from ~5 ms at DRR +6 dB; below that the type is ``gap_or_repeat``.
* dropouts (background falls, time axis intact): detected when the recorded
  background in 5.5 - 11 kHz falls >= 5 dB for >= 8 ms. At DRR +6 dB a full mute of
  the source gives -7 to -10 dB (the room tail fills the hole), so mutes of >= 8 ms
  are found (5 ms is not); duration is measured to ~2 ms for short mutes and ~1 ms
  for long ones (>= 300 ms, coarse scale with 1 ms edges).
* at DRR +3 dB (microphone too far) a 10 ms mute inside the data symbols is missed
  and a 10 ms gap inside the chirp is typed ``repeat`` (still a failure). Keep the
  microphone close to the phone.
* false alarms: none in 1.5 h of simulated clean playback (3 x 30 min, AAC, +-100 ppm,
  DRR +6/+9 dB) nor with a -6 dB step and a -6 dB ramp; the -5 dB / 8 ms dip test has a
  theoretical false-alarm probability of ~1e-10 per window on stationary background.

Speed and memory: ~1 min of CPU per 8 h recording (dominated by ffmpeg decoding);
peak memory ~1-2 GB for 8 h (1 ms energy track and its float64 working copies).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass, field

import numpy as np
from scipy import signal

from . import timecode as tc

ANALYSIS_SR = 24_000
BLOCK_S = 20.0
PRE_S = 0.05  # pre-roll so FFT edge effects never touch an owned lag
POST_S = 0.30  # >= burst length: a burst owned by a block is fully inside it

CHIRP_RHO_MIN = 0.45  # normalised chirp correlation; clean recordings reach ~0.9
PEAK_DISTANCE_S = 0.5
SYMBOL_WINDOW_S = 0.020  # 20 ms -> tones 100 Hz apart are orthogonal
SYMBOL_WINDOW_OFFSET_S = 0.005  # inside the flat part of the 30 ms symbol
SYMBOL_MARGIN_DB = 3.0  # best tone over runner-up, every symbol

PERIOD_WINDOW = 30  # intervals on each side for the local clock-ratio median
STEP_MIN_S = 0.0005
STEP_SIGMA_K = 10.0

FRAME_S = 0.001
DIP_WINDOW = 8  # frames (ms); a dropout this long reaches full depth
DIP_DB = -5.0
DIP_LENIENT_DB = -3.0  # only used to classify a known positive step as gap
TILE = 100  # frames; reference medians are taken over tiles
REF_TILES = 30  # 3 s on each side
REF_GUARD = 3  # tiles skipped next to the frame under test
DIP_MERGE_FRAMES = 10
COARSE_FRAME = 100  # frames (100 ms) for long dropouts and level changes
COARSE_TILE = 10  # coarse frames per tile (1 s)
COARSE_REF_TILES = 30
COARSE_GUARD = 2
COARSE_MIN_FRAMES = 3
LEVEL_CHANGE_DB = 3.0
MIN_COVERAGE = 0.9

FAILURE_TYPES = ("gap", "skip", "repeat", "gap_or_repeat", "dropout", "premature_end", "no_signal")


def _band_mask(nfft: int, sr: int, band, edge_hz: float = 200.0) -> np.ndarray:
    f = np.fft.rfftfreq(nfft, 1 / sr)
    lo, hi = band
    m = np.clip((f - (lo - edge_hz)) / edge_hz, 0, 1) * np.clip(((hi + edge_hz) - f) / edge_hz, 0, 1)
    return 0.5 - 0.5 * np.cos(np.pi * m)


@dataclass
class Burst:
    t: float  # recording time of the chirp start, s
    rho: float
    number: int | None
    margin_db: float


@dataclass
class _Extractor:
    """Streaming front end: chirp detection + decoding, and 1 ms background energies."""

    sr: int = ANALYSIS_SR
    bursts: list = field(default_factory=list)

    def __post_init__(self):
        self.template = tc.chirp(self.sr)
        self.L = len(self.template)
        self.tnorm = float(np.linalg.norm(self.template))
        self.pre = int(PRE_S * self.sr)
        self.post = int(POST_S * self.sr)
        # Leading zeros let a chirp that starts at the very first sample peak inside an
        # owned lag range (find_peaks needs a neighbour on both sides).
        self.tail = np.zeros(self.pre)
        self.tail_abs = -self.pre  # absolute sample index of tail[0]
        self.bg_sos = signal.butter(4, tc.BACKGROUND_BAND, "bandpass", fs=self.sr, output="sos")
        self.bg_zi = np.zeros((self.bg_sos.shape[0], 2))
        self.frame = int(round(FRAME_S * self.sr))
        self.frame_rem = np.zeros(0)
        self.frames: list[np.ndarray] = []
        self.total = 0
        win = int(round(SYMBOL_WINDOW_S * self.sr))
        tw = np.arange(win) / self.sr
        self.sym_win = win
        self.sym_mats = {p: np.exp(-2j * np.pi * np.outer(tc.tone_set(p), tw)) for p in (0, 1)}
        self.sym_offsets = [
            int(round((tc.DATA_OFFSET_S + j * tc.SYMBOL_S + SYMBOL_WINDOW_OFFSET_S) * self.sr))
            for j in range(tc.N_SYMBOLS)
        ]

    def push(self, x: np.ndarray) -> None:
        x = np.asarray(x, dtype=np.float64)
        self.total += len(x)
        self._background(x)
        buf = np.concatenate([self.tail, x])
        if len(buf) < self.pre + self.post + self.sr:
            self.tail = buf
            return
        self._chirps(buf, self.tail_abs, self.pre, len(buf) - self.post)
        keep = self.pre + self.post
        self.tail_abs += len(buf) - keep
        self.tail = buf[-keep:]

    def finish(self) -> np.ndarray:
        buf = self.tail
        if len(buf) > self.L:
            self._chirps(buf, self.tail_abs, self.pre, len(buf) - self.L + 1)
        if len(self.frame_rem):
            self.frames.append(np.array([np.sum(self.frame_rem**2) * self.frame / len(self.frame_rem)]))
        return np.concatenate(self.frames) if self.frames else np.zeros(0)

    def _background(self, x: np.ndarray) -> None:
        y, self.bg_zi = signal.sosfilt(self.bg_sos, x, zi=self.bg_zi)
        y = np.concatenate([self.frame_rem, y])
        n = len(y) // self.frame
        if n:
            self.frames.append(np.sum(y[: n * self.frame].reshape(n, self.frame) ** 2, axis=1).astype(np.float32))
        self.frame_rem = y[n * self.frame :]

    def _chirps(self, buf: np.ndarray, base: int, own_lo: int, own_hi: int) -> None:
        if own_hi <= own_lo:
            return
        nfft = 1 << int(np.ceil(np.log2(len(buf) + self.L)))
        X = np.fft.rfft(buf, nfft) * _band_mask(nfft, self.sr, tc.SIGNAL_BAND)
        xb = np.fft.irfft(X, nfft)[: len(buf)]
        P = X * np.conj(np.fft.rfft(self.template, nfft))
        full = np.zeros(nfft, dtype=complex)
        full[: nfft // 2 + 1] = P
        full[1 : nfft // 2] *= 2
        nlag = len(buf) - self.L + 1
        env = np.abs(np.fft.ifft(full)[:nlag])
        cs = np.concatenate([[0.0], np.cumsum(xb * xb)])
        energy = cs[self.L : self.L + nlag] - cs[:nlag]
        rho = env / (self.tnorm * np.sqrt(np.maximum(energy, 1e-20)))
        hi = min(own_hi, nlag)
        peaks, _ = signal.find_peaks(rho[:hi], height=CHIRP_RHO_MIN, distance=int(PEAK_DISTANCE_S * self.sr))
        for i in peaks[peaks >= own_lo]:
            frac = 0.0
            if 0 < i < nlag - 1:
                a, b, c = env[i - 1], env[i], env[i + 1]
                den = a - 2 * b + c
                frac = 0.5 * (a - c) / den if den < 0 else 0.0
            number, margin = self._decode(xb, i)
            self.bursts.append(Burst((base + i + frac) / self.sr, float(rho[i]), number, margin))

    def _decode(self, xb: np.ndarray, i: int):
        nibbles, margins = [], []
        for j, off in enumerate(self.sym_offsets):
            s = i + off
            seg = xb[s : s + self.sym_win]
            if len(seg) < self.sym_win:
                return None, 0.0
            p = np.abs(self.sym_mats[j % 2] @ seg) ** 2
            order = np.argsort(p)
            nibbles.append(int(order[-1]))
            margins.append(10 * np.log10(p[order[-1]] / max(p[order[-2]], 1e-30)))
        margin = float(min(margins))
        if margin < SYMBOL_MARGIN_DB:
            return None, margin
        return tc.decode_payload(nibbles), margin


def _sliding_nanmedian(a: np.ndarray, lo: int, hi: int) -> np.ndarray:
    """out[i] = nanmedian(a[i+lo : i+hi]) with out-of-range entries ignored."""
    width = hi - lo
    pad = np.full(len(a) + 2 * (abs(lo) + abs(hi)), np.nan)
    off = abs(lo) + abs(hi)
    pad[off : off + len(a)] = a
    view = np.lib.stride_tricks.sliding_window_view(pad, width)
    idx = np.arange(len(a)) + off + lo
    with np.errstate(all="ignore"):
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            return np.nanmedian(view[idx], axis=1)


def _reference(e: np.ndarray, tile: int, ref_tiles: int, guard: int):
    """Per-tile reference level: the lower of the medians before and after (each over
    ref_tiles tiles, skipping `guard` tiles), so a level step is not mistaken for a dip.
    Returns (reference, before, after) per tile; expand with np.repeat(v, tile)."""
    nt = int(np.ceil(len(e) / tile))
    padded = np.full(nt * tile, np.nan)
    padded[: len(e)] = e
    with np.errstate(all="ignore"):
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            tm = np.nanmedian(padded.reshape(nt, tile), axis=1)
    before = _sliding_nanmedian(tm, -ref_tiles, -guard + 1)
    after = _sliding_nanmedian(tm, guard, ref_tiles + 1)
    return np.fmin(before, after), before, after


def _runs(mask: np.ndarray, merge: int = 0) -> list[tuple[int, int]]:
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    starts, ends = np.flatnonzero(d == 1), np.flatnonzero(d == -1)
    out: list[list[int]] = []
    for s, e in zip(starts, ends):
        if out and s - out[-1][1] <= merge:
            out[-1][1] = e
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


def _fit_dip(e: np.ndarray, ref: np.ndarray, s: int, t: int) -> tuple[float, float, float]:
    """Gamma maximum-likelihood fit of a rectangular dip on 1 ms frame energies.

    The run [s, t) of the W-frame smoothed track brackets the dip [a, b) (frames, with
    sub-frame edges): a in [s, s + W], b in [t - 1, t + W - 1]. Only the two edge
    frames depend on the sub-frame position, so the likelihood over the (a, b) grid is
    built from cumulative sums. Returns (a, b, floor_ratio)."""
    W = DIP_WINDOW
    lo, hi = max(s - 3, 0), min(t + W + 3, len(e))
    ratio = e[lo:hi].astype(np.float64) / np.maximum(ref[lo:hi] / W, 1e-30)
    ratio = np.nan_to_num(ratio, nan=1.0)
    m = len(ratio)
    ga = np.arange(max(s - 2, lo), min(s + W + 2, hi) + 1e-9, 0.1) - lo
    gb = np.arange(max(t - 2, lo), min(t + W + 2, hi) + 1e-9, 0.1) - lo
    floor = float(np.clip(np.mean(np.sort(ratio)[: max(1, m // 3)]), 1e-3, 0.95))
    for _ in range(2):
        ll_out = -ratio
        ll_in = -np.log(floor) - ratio / floor
        c_in = np.concatenate([[0.0], np.cumsum(ll_in)])
        c_out = np.concatenate([[0.0], np.cumsum(ll_out)])

        def edge(pos, inside_after):
            k = np.minimum(np.floor(pos).astype(int), m - 1)
            o = (k + 1 - pos) if inside_after else (pos - k)
            mu = 1 - (1 - floor) * np.clip(o, 0, 1)
            return k, -np.log(mu) - ratio[k] / mu - ll_out[k]

        ka, pa = edge(ga, True)
        kb, pb = edge(gb, False)
        full_lo = ka + 1  # first frame fully inside
        full_hi = kb  # one past last frame fully inside
        gain = (c_in[full_hi][None, :] - c_in[full_lo][:, None]) - (c_out[full_hi][None, :] - c_out[full_lo][:, None])
        ll = gain + pa[:, None] + pb[None, :]
        ll[(full_hi[None, :] < full_lo[:, None]) | (gb[None, :] - ga[:, None] < 1.0)] = -np.inf
        ia, ib = np.unravel_index(np.argmax(ll), ll.shape)
        a, b = ga[ia], gb[ib]
        inside = ratio[int(np.ceil(a)) : int(np.floor(b))]
        if len(inside) == 0:
            break
        floor = float(np.clip(np.mean(inside), 1e-3, 0.95))
    return lo + a, lo + b, floor


def _within(e: np.ndarray, span: tuple[int, int]) -> np.ndarray:
    """Energies as float64 with everything outside the signal span set to NaN, so the
    room noise before and after playback never enters a reference median."""
    out = np.full(len(e), np.nan)
    lo, hi = max(span[0], 0), min(span[1], len(e))
    out[lo:hi] = e[lo:hi]
    return out


def _dips(e: np.ndarray, span: tuple[int, int], threshold_db: float) -> list[dict]:
    """Background dips on the fine (ms) scale, inside frames [span)."""
    if len(e) < DIP_WINDOW + 1:
        return []
    e = _within(e, span)
    ew = np.convolve(e, np.ones(DIP_WINDOW), mode="valid")
    ref = np.repeat(_reference(ew, TILE, REF_TILES, REF_GUARD)[0], TILE)[: len(ew)]
    with np.errstate(all="ignore"):
        rdb = 10 * np.log10(np.maximum(ew, 1e-30) / ref)
    rdb = np.nan_to_num(rdb, nan=0.0)
    mask = np.zeros(len(ew), bool)
    lo, hi = max(span[0], 0), min(span[1] - DIP_WINDOW, len(ew))
    if hi <= lo:
        return []
    mask[lo:hi] = rdb[lo:hi] < threshold_db
    out = []
    for s, t in _runs(mask, DIP_MERGE_FRAMES):
        if t >= hi:
            continue  # never recovers inside the span: that is the end of the signal
        a, b, floor = _fit_dip(e, np.concatenate([ref, np.full(DIP_WINDOW - 1, ref[-1])]), s, t)
        out.append(
            {
                "start_s": a * FRAME_S,
                "end_s": b * FRAME_S,
                "duration_ms": (b - a) * FRAME_S * 1e3,
                "depth_db": float(10 * np.log10(floor)),
                "min_db": float(rdb[s:t].min()),
            }
        )
    return out


def _coarse(e: np.ndarray, span: tuple[int, int]):
    """Long dropouts (>= 300 ms) and level changes on 100 ms frames."""
    n = len(e) // COARSE_FRAME
    if n < 3 * COARSE_TILE:
        return [], []
    ec = _within(e, span)[: n * COARSE_FRAME].reshape(n, COARSE_FRAME).sum(axis=1)
    ref, before, after = (np.repeat(v, COARSE_TILE)[:n] for v in _reference(ec, COARSE_TILE, COARSE_REF_TILES, COARSE_GUARD))
    lo, hi = span[0] // COARSE_FRAME + 1, min(span[1] // COARSE_FRAME, n)
    with np.errstate(all="ignore"):
        rdb = np.nan_to_num(10 * np.log10(np.maximum(ec, 1e-30) / ref), nan=0.0)
        diff = np.nan_to_num(10 * np.log10(after / before), nan=0.0)
    dmask = np.zeros(n, bool)
    dmask[lo:hi] = rdb[lo:hi] < DIP_DB
    ef = _within(e, span)
    e8 = np.convolve(np.nan_to_num(ef, nan=0.0), np.ones(DIP_WINDOW), mode="full")[DIP_WINDOW - 1 :]
    dips = []
    for s, t in _runs(dmask, 1):
        if t - s < COARSE_MIN_FRAMES or t >= hi:
            continue
        depth = float(np.median(rdb[s:t]))
        # Edges to ~1 ms: -3 dB crossings of the 8 ms track against the coarse reference.
        # A mute drops the direct sound at once, while the room tail inside the dip keeps
        # decaying, so a shallow crossing marks the edge and a mid-depth one would not.
        level = ref[s] * DIP_WINDOW / COARSE_FRAME * 10 ** (DIP_LENIENT_DB / 10)
        a0, a1 = max((s - 2) * COARSE_FRAME, 0), min((s + 2) * COARSE_FRAME, len(e8))
        b0, b1 = max((t - 2) * COARSE_FRAME, 0), min((t + 2) * COARSE_FRAME, len(e8))
        low_a = np.flatnonzero(e8[a0:a1] < level)
        low_b = np.flatnonzero(e8[b0:b1] < level)
        start = (a0 + low_a[0] + DIP_WINDOW / 2) if len(low_a) else s * COARSE_FRAME
        end = (b0 + low_b[-1] + 1 + DIP_WINDOW / 2) if len(low_b) else t * COARSE_FRAME
        dips.append(
            {
                "start_s": start * FRAME_S,
                "end_s": end * FRAME_S,
                "duration_ms": (end - start) * FRAME_S * 1e3,
                "depth_db": depth,
                "min_db": float(rdb[s:t].min()),
            }
        )
    # Level changes need a full reference window on both sides inside the signal.
    lmask = np.zeros(n, bool)
    edge = COARSE_TILE * COARSE_REF_TILES // 2
    l_lo, l_hi = lo + edge, hi - edge
    if l_hi > l_lo:
        lmask[l_lo:l_hi] = np.abs(diff[l_lo:l_hi]) > LEVEL_CHANGE_DB
    levels = []
    for s, t in _runs(lmask, COARSE_TILE):
        # A step gives a plateau of |diff| centred on it; a ramp a plateau around its middle.
        k = s + int(np.argmax(np.abs(diff[s:t])))
        levels.append({"t_s": 0.5 * (s + t) * COARSE_FRAME * FRAME_S, "change_db": float(diff[k])})
    return dips, levels


def _signal_end(e: np.ndarray, t_last: float, p: float) -> float:
    """Where the background stops after the last burst (10 ms resolution): the end of
    the last 10 ms frame within one period that is no more than 10 dB below the level
    of the preceding 3 s."""
    f = 10
    lo = int(max(t_last - 3.0, 0) / FRAME_S)
    hi = min(int((t_last + p) / FRAME_S), len(e))
    k = int(t_last / FRAME_S)
    if hi - k < f:
        return min(t_last + p, len(e) * FRAME_S)
    seg = e[lo:hi].astype(np.float64)
    m = len(seg) // f
    ec = seg[: m * f].reshape(m, f).sum(axis=1)
    k0 = (k - lo) // f
    ref = np.median(ec[:k0]) if k0 > 0 else np.median(ec)
    alive = np.flatnonzero(ec[k0:] > ref * 0.1)
    if len(alive) == 0:
        return t_last
    return (lo + (k0 + alive[-1] + 1) * f) * FRAME_S


def _rolling_median(v: np.ndarray, half: int) -> np.ndarray:
    out = np.empty(len(v))
    for i in range(len(v)):
        w = v[max(0, i - half) : i + half + 1]
        w = w[np.isfinite(w)]
        out[i] = np.median(w) if len(w) else 1.0
    return out


def analyze_stream(blocks, expected_duration_s: int, sr: int = ANALYSIS_SR) -> dict:
    """Analyse an iterable of mono float blocks at ANALYSIS_SR."""
    if sr != ANALYSIS_SR:
        raise ValueError("analyze_stream expects ANALYSIS_SR blocks; use analyze_array")
    ex = _Extractor(sr)
    for block in blocks:
        ex.push(block)
    e = ex.finish()
    return _analyse(ex.bursts, e, ex.total / sr, int(expected_duration_s))


def analyze_array(x: np.ndarray, sr: int, expected_duration_s: int) -> dict:
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 2:
        x = x.mean(axis=1)
    if sr != ANALYSIS_SR:
        g = np.gcd(ANALYSIS_SR, sr)
        x = signal.resample_poly(x, ANALYSIS_SR // g, sr // g)
    step = int(BLOCK_S * ANALYSIS_SR)
    return analyze_stream((x[i : i + step] for i in range(0, len(x), step)), expected_duration_s)


def ffmpeg_blocks(path: str, start_s: float | None = None, duration_s: float | None = None, block_s: float = BLOCK_S):
    """Decode any ffmpeg-readable file to mono float blocks at ANALYSIS_SR."""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
    if start_s:
        cmd += ["-ss", f"{start_s:.6f}"]
    cmd += ["-i", str(path)]
    if duration_s is not None:
        cmd += ["-t", f"{duration_s:.6f}"]
    cmd += ["-vn", "-ac", "1", "-ar", str(ANALYSIS_SR), "-f", "f32le", "pipe:1"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    nbytes = int(block_s * ANALYSIS_SR) * 4
    try:
        while True:
            chunk = proc.stdout.read(nbytes)
            if not chunk:
                break
            usable = len(chunk) - len(chunk) % 4
            yield np.frombuffer(chunk[:usable], dtype="<f4").astype(np.float64)
    finally:
        proc.stdout.close()
        err = proc.stderr.read().decode(errors="replace")
        proc.stderr.close()
        if proc.wait() != 0:
            raise RuntimeError(f"ffmpeg failed on {path}: {err.strip()}")


def analyze_file(path: str, expected_duration_s: int) -> dict:
    return analyze_stream(ffmpeg_blocks(path), expected_duration_s)


def detect_bursts(blocks) -> list[Burst]:
    """Chirp detections with decoded numbers only (used by the generator's verifier)."""
    ex = _Extractor(ANALYSIS_SR)
    for block in blocks:
        ex.push(block)
    ex.finish()
    return _dedupe(ex.bursts)


def _dedupe(bursts: list[Burst]) -> list[Burst]:
    bursts = sorted(bursts, key=lambda b: b.t)
    out: list[Burst] = []
    for b in bursts:
        if out and b.t - out[-1].t < PEAK_DISTANCE_S:
            if b.rho > out[-1].rho:
                out[-1] = b
        else:
            out.append(b)
    return out


def _event(kind, t_rec, source_second, magnitude_ms, **extra) -> dict:
    ev = {
        "type": kind,
        "failure": kind in FAILURE_TYPES,
        "t_recording_s": round(float(t_rec), 4),
        "source_second": None if source_second is None else round(float(source_second), 3),
        "magnitude_ms": None if magnitude_ms is None else round(float(magnitude_ms), 3),
    }
    ev.update(extra)
    return ev


def _analyse(raw_bursts: list[Burst], e: np.ndarray, rec_s: float, D: int) -> dict:
    bursts = _dedupe(raw_bursts)
    dec = [b for b in bursts if b.number is not None and 0 <= b.number < max(D, 1)]
    report = {
        "format": tc.FORMAT,
        "expected_duration_s": D,
        "recording_duration_s": round(rec_s, 3),
        "analysis_sample_rate": ANALYSIS_SR,
        "bursts_expected": D,
        "bursts_detected": len(bursts),
        "bursts_decoded": len(dec),
        "params": {
            "chirp_rho_min": CHIRP_RHO_MIN,
            "symbol_margin_db": SYMBOL_MARGIN_DB,
            "step_min_ms": STEP_MIN_S * 1e3,
            "step_sigma_k": STEP_SIGMA_K,
            "background_band_hz": list(tc.BACKGROUND_BAND),
            "dip_db": DIP_DB,
            "dip_window_ms": DIP_WINDOW * FRAME_S * 1e3,
            "level_change_db": LEVEL_CHANGE_DB,
        },
        # Declared from the calibration (see module docstring), for DRR >= +6 dB.
        "resolution": {
            "min_step_ms": 1.0,
            "step_size_accuracy_ms": 0.05,
            "gap_vs_repeat_min_ms": 5.0,
            "dropout_min_ms": DIP_WINDOW * FRAME_S * 1e3,
            "dropout_min_depth_db": -DIP_DB,
            "dropout_duration_accuracy_ms": 2.0,
        },
    }
    events: list[dict] = []
    if len(dec) < 2:
        events.append(_event("no_signal", rec_s, None, None, detail="fewer than 2 decoded bursts"))
        report.update(events=events, coverage=0.0)
        report["pass"] = False
        return _finish(report)

    t = np.array([b.t for b in dec])
    n = np.array([b.number for b in dec], dtype=np.int64)
    dt, dn = np.diff(t), np.diff(n)
    r = np.where(dn >= 1, dt / np.maximum(dn, 1), np.nan)
    p = _rolling_median(r, PERIOD_WINDOW)
    delta = dt - dn * p
    unit = dn == 1
    base = delta[unit] if unit.any() else delta
    sigma = 1.4826 * float(np.median(np.abs(base - np.median(base)))) if len(base) else 0.0
    thr = max(STEP_MIN_S, STEP_SIGMA_K * sigma)
    pbar = float(np.nanmedian(r))
    report.update(
        first_number=int(n[0]),
        last_number=int(n[-1]),
        coverage=round(len(set(n.tolist())) / D, 5),
        drift_ppm=round((pbar - 1.0) * 1e6, 2),
        jitter_ms=round(sigma * 1e3, 5),
        step_threshold_ms=round(thr * 1e3, 4),
    )

    # Signal span in 1 ms frames: from the first burst to the end of the last second,
    # or to where the background stops when the file did not play to the end.
    end_t = t[-1] + pbar if n[-1] >= D - 1 else _signal_end(e, t[-1], pbar)
    span = (int(t[0] / FRAME_S), int(end_t / FRAME_S))
    cdips, levels = _coarse(e, span)
    fine = _dips(e, span, DIP_DB)
    dips = cdips + [
        d for d in fine if not any(c["start_s"] - 0.2 <= d["start_s"] <= c["end_s"] + 0.2 for c in cdips)
    ]
    used = [False] * len(dips)

    anomalous = np.abs(delta) > thr
    clusters = _runs(anomalous)
    for s, q in clusters:
        total = float(delta[s:q].sum()) / pbar  # source seconds
        t0, t1 = t[s], t[q]
        k_dn = dn[s:q]
        src0 = n[s]
        if abs(total) <= thr:
            events.append(_event("timing_outlier", 0.5 * (t0 + t1), src0, abs(total) * 1e3, delta_ms=round(total * 1e3, 3)))
            continue
        if total < 0:
            tm = 0.5 * (t0 + t1)
            events.append(_event("skip", tm, src0 + (tm - t0) / pbar, -total * 1e3, delta_ms=round(total * 1e3, 3)))
            continue
        # Positive step: silence inserted (gap) or content replayed (repeat).
        hit = None
        for i, d in enumerate(dips):
            if not used[i] and t0 - 0.05 <= 0.5 * (d["start_s"] + d["end_s"]) <= t1 + 0.05:
                if hit is None or d["duration_ms"] > dips[hit]["duration_ms"]:
                    hit = i
        if hit is None:
            lenient = [
                d
                for d in _dips(e, (int(t0 / FRAME_S), int(t1 / FRAME_S) + DIP_WINDOW), DIP_LENIENT_DB)
                if d["duration_ms"] >= 0.5 * total * 1e3
            ]
            dip = max(lenient, key=lambda d: d["duration_ms"]) if lenient else None
        else:
            used[hit] = True
            dip = dips[hit]
        if np.any(k_dn <= 0):
            kind = "repeat"
        elif dip is not None and dip["duration_ms"] >= 0.5 * total * 1e3:
            kind = "gap"
        elif total * 1e3 < DIP_WINDOW * FRAME_S * 1e3:
            kind = "gap_or_repeat"
        else:
            kind = "repeat"
        tm = dip["start_s"] if (kind == "gap" and dip) else 0.5 * (t0 + t1)
        extra = {"delta_ms": round(total * 1e3, 3)}
        if kind == "gap" and dip:
            extra.update(dip_ms=round(float(dip["duration_ms"]), 2), depth_db=round(float(dip["depth_db"]), 2))
        events.append(_event(kind, tm, src0 + (tm - t0) / pbar, total * 1e3, **extra))

    def source_at(time_s: float) -> float:
        k = max(int(np.searchsorted(t, time_s)) - 1, 0)
        return n[k] + (time_s - t[k]) / pbar

    for i, d in enumerate(dips):
        if used[i]:
            continue
        st = float(d["start_s"])
        if any(ev["type"] == "gap" and abs(ev["t_recording_s"] - st) < 0.05 for ev in events):
            continue
        events.append(_event("dropout", st, source_at(st), d["duration_ms"] / pbar, depth_db=round(float(d["depth_db"]), 2)))

    for lv in levels:
        events.append(_event("level_change", lv["t_s"], source_at(lv["t_s"]), None, change_db=round(lv["change_db"], 2)))

    if n[0] > 0:
        events.append(_event("late_start", t[0], n[0], n[0] * 1e3, detail="first decoded second > 0"))
    if n[-1] < D - 1:
        signal_at_end = end_t >= rec_s - 0.05
        lost = D - (n[-1] + (end_t - t[-1]) / pbar)
        events.append(
            _event(
                "premature_end",
                end_t,
                n[-1] + (end_t - t[-1]) / pbar,
                lost * 1e3,
                last_number=int(n[-1]),
                cause_hint="recording_ended_while_signal_present" if signal_at_end else "playback_stopped",
            )
        )

    events.sort(key=lambda ev: ev["t_recording_s"])
    report["events"] = events
    report["pass"] = not any(ev["failure"] for ev in events) and report["coverage"] >= MIN_COVERAGE
    if report["coverage"] < MIN_COVERAGE:
        report["inconclusive"] = f"coverage {report['coverage']:.3f} < {MIN_COVERAGE}"
    return _finish(report)


def _finish(report: dict) -> dict:
    counts: dict[str, int] = {}
    for ev in report.get("events", []):
        counts[ev["type"]] = counts.get(ev["type"], 0) + 1
    report["event_counts"] = counts
    return report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Continuity check of a recorded fala-diag-v1 playback")
    ap.add_argument("recording")
    ap.add_argument("--expected-duration-s", type=int, required=True)
    ap.add_argument("--json", help="write the full report here")
    args = ap.parse_args(argv)
    report = analyze_file(args.recording, args.expected_duration_s)
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(report, fh, indent=2)
    keys = ("bursts_expected", "bursts_detected", "bursts_decoded", "coverage", "drift_ppm", "jitter_ms", "step_threshold_ms")
    print(json.dumps({k: report.get(k) for k in keys} | {"event_counts": report["event_counts"], "pass": report["pass"]}, indent=2))
    for ev in report["events"]:
        print(json.dumps(ev))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
