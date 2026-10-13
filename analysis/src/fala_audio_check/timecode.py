"""Protocol "fala-diag-v1": a timecoded diagnostic signal for continuity tests.

Shared by the generator (diagnostic.py) and the detector (continuity.py).

Every second n (n = 0 .. D-1) starts at sample n * SR with a burst:

    [0, 40 ms)     sync chirp, linear 1000 -> 4500 Hz, Tukey(0.25) taper
    [40, 50 ms)    background only
    [50, 230 ms)   6 MFSK-16 symbols x 30 ms with 3 ms raised-cosine ramps;
                   even symbols use set A (1000 + 100 k Hz), odd symbols set B
                   (2700 + 100 k Hz), so the reverb tail of one symbol never sits on
                   the tone grid of the next one
    [230, 1000 ms) background only

Payload: 24 bits = n as 16 bits big-endian + CRC-8 (poly 0x07, init 0) of those two
bytes, sent as six nibbles, most significant first.

Background: continuous pink noise (-3 dB/oct, 100 Hz - 12 kHz, -26 dBFS RMS). White
noise for second n comes from a generator seeded with (seed, n) and is shaped by a
fixed linear-phase FIR, so every output sample depends only on (seed, absolute
position): rendering in blocks of any size gives bit-identical samples.

Change from the first draft (chirp 1500 -> 6000 Hz): the burst now stays below
4.6 kHz so the band 5.5 - 11 kHz carries only background. That band is what the
detector uses for dropouts; at 5.5 kHz wide it gives ~88 degrees of freedom per 8 ms
window instead of ~64 at 7 - 11 kHz, which moves the false-alarm probability of a
-5 dB dip from ~3e-8 to ~1e-10 per window (an 8 h night has ~7e6 windows).
"""

from __future__ import annotations

import numpy as np

FORMAT = "fala-diag-v1"
SR = 48_000

CHIRP_S = 0.040
CHIRP_F0 = 1_000.0
CHIRP_F1 = 4_500.0
CHIRP_TAPER = 0.25
DATA_OFFSET_S = 0.050
SYMBOL_S = 0.030
RAMP_S = 0.003
N_SYMBOLS = 6
SET_A_BASE = 1_000.0
SET_B_BASE = 2_700.0
TONE_STEP = 100.0
N_TONES = 16
BURST_S = DATA_OFFSET_S + N_SYMBOLS * SYMBOL_S  # 0.230

# Kept modest: an abrupt mute inside a loud tone splatters into the background band
# and makes the dip shallower; 0.15 still leaves the chirp ~10 dB above the in-band noise.
CHIRP_PEAK = 0.15
SYMBOL_PEAK = 0.15
NOISE_RMS_DBFS = -26.0
NOISE_BAND = (100.0, 12_000.0)
FIR_TAPS = 4_095  # odd -> type I linear phase; 85 ms covers the 100 Hz edge
DEFAULT_SEED = 20_261_013
MAX_SECONDS = 1 << 16

# Bands the detector relies on; kept here so generator and detector cannot drift apart.
SIGNAL_BAND = (900.0, 4_700.0)
BACKGROUND_BAND = (5_500.0, 11_000.0)


def crc8(data: bytes, poly: int = 0x07, init: int = 0x00) -> int:
    crc = init
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ poly) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def encode_payload(n: int) -> list[int]:
    if not 0 <= n < MAX_SECONDS:
        raise ValueError(f"second {n} outside 0..{MAX_SECONDS - 1}")
    word = (n << 8) | crc8(n.to_bytes(2, "big"))
    return [(word >> (20 - 4 * i)) & 0xF for i in range(N_SYMBOLS)]


def decode_payload(nibbles) -> int | None:
    """Second number, or None when the CRC does not match."""
    if len(nibbles) != N_SYMBOLS:
        return None
    word = 0
    for v in nibbles:
        word = (word << 4) | (int(v) & 0xF)
    n = word >> 8
    return n if crc8(n.to_bytes(2, "big")) == (word & 0xFF) else None


def tone_set(j: int) -> np.ndarray:
    base = SET_A_BASE if j % 2 == 0 else SET_B_BASE
    return base + TONE_STEP * np.arange(N_TONES)


def _tukey(n: int, alpha: float) -> np.ndarray:
    from scipy.signal.windows import tukey

    return tukey(n, alpha)


def chirp(sr: int = SR) -> np.ndarray:
    """Unit-peak sync chirp defined analytically, so the detector can build it at the
    recording's sample rate."""
    n = int(round(CHIRP_S * sr))
    t = np.arange(n) / sr
    k = (CHIRP_F1 - CHIRP_F0) / CHIRP_S
    return np.sin(2 * np.pi * (CHIRP_F0 * t + 0.5 * k * t * t)) * _tukey(n, CHIRP_TAPER)


def _symbol_envelope(sr: int) -> np.ndarray:
    n = int(round(SYMBOL_S * sr))
    r = int(round(RAMP_S * sr))
    env = np.ones(n)
    ramp = 0.5 - 0.5 * np.cos(np.pi * (np.arange(r) + 0.5) / r)
    env[:r] = ramp
    env[-r:] = ramp[::-1]
    return env


class _BurstBank:
    """Pre-rendered chirp and the 2 x 16 tone symbols at SR."""

    def __init__(self, sr: int = SR):
        self.sr = sr
        self.chirp = CHIRP_PEAK * chirp(sr)
        env = _symbol_envelope(sr)
        t = np.arange(len(env)) / sr
        self.tones = {
            parity: [SYMBOL_PEAK * env * np.sin(2 * np.pi * f * t) for f in tone_set(parity)]
            for parity in (0, 1)
        }
        self.length = int(round(BURST_S * sr))
        self.data_offset = int(round(DATA_OFFSET_S * sr))
        self.symbol_len = len(env)

    def burst(self, n: int) -> np.ndarray:
        out = np.zeros(self.length)
        out[: len(self.chirp)] = self.chirp
        for j, k in enumerate(encode_payload(n)):
            s = self.data_offset + j * self.symbol_len
            out[s : s + self.symbol_len] = self.tones[j % 2][k]
        return out


def pink_fir(sr: int = SR, taps: int = FIR_TAPS) -> np.ndarray:
    """Linear-phase FIR with |H| ~ f^-1/2 inside NOISE_BAND, normalised so unit-variance
    white noise comes out at NOISE_RMS_DBFS."""
    nfft = 1 << 15
    f = np.fft.rfftfreq(nfft, 1 / sr)
    fs = np.maximum(f, 1.0)
    lo, hi = NOISE_BAND
    # Smooth band edges (2nd-order high-pass, 4th-order low-pass magnitudes).
    mag = (fs / 1_000.0) ** -0.5
    mag *= (fs / lo) ** 2 / np.sqrt(1 + (fs / lo) ** 4)
    mag *= 1 / np.sqrt(1 + (fs / hi) ** 8)
    mag[0] = 0.0
    h = np.fft.irfft(mag, nfft)
    h = np.roll(h, taps // 2)[:taps] * np.kaiser(taps, 8.0)
    return h * (10 ** (NOISE_RMS_DBFS / 20) / np.sqrt(np.sum(h * h)))


class Renderer:
    """Deterministic mono renderer of a D-second fala-diag-v1 signal at SR.

    render(start, length) returns samples [start, start + length) as float64; samples
    outside [0, D * SR) are zero. A one-second cache makes sequential block rendering
    cost one FIR convolution per second.
    """

    def __init__(self, duration_s: int, seed: int = DEFAULT_SEED):
        if not 1 <= duration_s <= MAX_SECONDS:
            raise ValueError(f"duration must be 1..{MAX_SECONDS} s")
        self.duration_s = int(duration_s)
        self.seed = int(seed)
        self.fir = pink_fir()
        self.bank = _BurstBank()
        self._white_cache: dict[int, np.ndarray] = {}
        self._second_cache: dict[int, np.ndarray] = {}

    @property
    def length(self) -> int:
        return self.duration_s * SR

    def _white(self, n: int) -> np.ndarray:
        w = self._white_cache.get(n)
        if w is None:
            # Second -1 (FIR history of second 0) gets its own key so the background is
            # stationary from the first sample instead of fading in.
            key = n if n >= 0 else MAX_SECONDS
            w = np.random.default_rng([self.seed, key]).standard_normal(SR)
            if len(self._white_cache) > 4:
                self._white_cache.clear()
            self._white_cache[n] = w
        return w

    def second(self, n: int) -> np.ndarray:
        """All SR samples of second n (background + burst)."""
        s = self._second_cache.get(n)
        if s is not None:
            return s
        from scipy.signal import fftconvolve

        hist = len(self.fir) - 1
        white = np.concatenate([self._white(n - 1)[-hist:], self._white(n)])
        s = fftconvolve(white, self.fir, mode="valid")
        s[: self.bank.length] += self.bank.burst(n)
        if len(self._second_cache) > 2:
            self._second_cache.clear()
        self._second_cache[n] = s
        return s

    def render(self, start: int, length: int) -> np.ndarray:
        out = np.zeros(length)
        lo, hi = max(start, 0), min(start + length, self.length)
        pos = lo
        while pos < hi:
            n, off = divmod(pos, SR)
            take = min(SR - off, hi - pos)
            out[pos - start : pos - start + take] = self.second(n)[off : off + take]
            pos += take
        return out
