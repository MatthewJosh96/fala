import numpy as np
import pytest
from scipy import signal

from fala_audio_check import continuity, measure
from fala_audio_check import timecode as tc


def test_crc8_matches_the_standard_check_value():
    # CRC-8 (poly 0x07, init 0, no reflection) of "123456789" is 0xF4.
    assert tc.crc8(b"123456789") == 0xF4


@pytest.mark.parametrize("n", [0, 1, 15, 16, 255, 256, 4095, 28_799, 65_535])
def test_payload_round_trip(n):
    nibbles = tc.encode_payload(n)
    assert len(nibbles) == tc.N_SYMBOLS and all(0 <= v < 16 for v in nibbles)
    assert tc.decode_payload(nibbles) == n


def test_single_wrong_nibble_fails_the_crc():
    rejected = 0
    for n in range(0, 28_800, 97):
        good = tc.encode_payload(n)
        for j in range(tc.N_SYMBOLS):
            bad = list(good)
            bad[j] = (bad[j] + 1 + n % 15) % 16
            rejected += tc.decode_payload(bad) is None
    # CRC-8 detects every single-nibble (<= 8-bit burst) error.
    assert rejected == len(range(0, 28_800, 97)) * tc.N_SYMBOLS


def test_block_rendering_is_deterministic_regardless_of_block_size():
    whole = tc.Renderer(12).render(0, 12 * tc.SR)
    for block in (1, 4_799, 48_000, 100_003):
        r = tc.Renderer(12)
        parts = [r.render(s, min(block, 12 * tc.SR - s)) for s in range(0, 12 * tc.SR, block)] if block > 1000 else [
            r.render(s, 1) for s in range(5 * tc.SR - 50, 5 * tc.SR + 50)
        ]
        got = np.concatenate(parts)
        ref = whole if block > 1000 else whole[5 * tc.SR - 50 : 5 * tc.SR + 50]
        assert np.array_equal(got, ref)
    # Random access far into a long file equals sequential rendering of the same span.
    long = tc.Renderer(28_800)
    a = long.render(20_000 * tc.SR - 777, 3 * tc.SR)
    b = tc.Renderer(28_800).render(20_000 * tc.SR - 777, 3 * tc.SR)
    assert np.array_equal(a, b)


def test_background_is_pink_at_the_specified_level():
    white = np.random.default_rng(5).standard_normal(20 * tc.SR)
    noise = signal.fftconvolve(white, tc.pink_fir(), mode="valid")
    assert 20 * np.log10(noise.std()) == pytest.approx(tc.NOISE_RMS_DBFS, abs=0.3)
    assert measure.spectral_slope(noise, tc.SR, band=(200.0, 10_000.0))["db_per_octave"] == pytest.approx(-3.0, abs=0.3)


def test_background_is_stationary_from_the_first_sample():
    x = tc.Renderer(3).render(0, 3 * tc.SR)
    hp = signal.sosfilt(signal.butter(4, tc.BACKGROUND_BAND, "bandpass", fs=tc.SR, output="sos"), x)
    first = np.sqrt(np.mean(hp[2_000:6_800] ** 2))
    later = np.sqrt(np.mean(hp[tc.SR + 20_000 : tc.SR + 40_000] ** 2))
    assert 20 * np.log10(first / later) == pytest.approx(0.0, abs=1.5)


def test_burst_leaves_the_background_band_empty():
    bank = tc._BurstBank()
    sos = signal.butter(8, tc.BACKGROUND_BAND, "bandpass", fs=tc.SR, output="sos")
    for n in (0, 12_345, 28_799):
        b = bank.burst(n)
        leak = signal.sosfiltfilt(sos, np.pad(b, 4_800))
        assert 10 * np.log10(np.sum(leak**2) / np.sum(b**2)) < -60


def test_source_decodes_completely_and_stays_below_minus_1_dbtp():
    D = 30
    x = tc.Renderer(D).render(0, D * tc.SR)
    lv = measure.levels(np.stack([x, x], axis=1), tc.SR)
    assert lv["true_peak_dbtp"] <= -1.0
    bursts = continuity.detect_bursts([continuity.signal.resample_poly(x, 1, 2)])
    assert [b.number for b in bursts] == list(range(D))
    assert all(abs(b.t - b.number) < 1e-4 for b in bursts)
