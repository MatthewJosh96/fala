import numpy as np
import pytest

from fala_audio_check import measure

SR = 48_000
rng = np.random.default_rng(7)


def tone(freq, seconds=20.0, amp=0.5):
    t = np.arange(int(SR * seconds)) / SR
    return amp * np.sin(2 * np.pi * freq * t)


def coloured_noise(slope_db_per_oct, seconds=20.0):
    n = int(SR * seconds)
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    f[0] = f[1]
    spec *= f ** (slope_db_per_oct / (20 * np.log10(2)))
    x = np.fft.irfft(spec, n)
    return 0.3 * x / np.max(np.abs(x))


def am(x, rate, depth):
    # Contract convention: g(t) = (1 + m cos(2 pi f t)) / (1 + m), m = (gmax - gmin) / (gmax + gmin)
    t = np.arange(len(x)) / SR
    return x * (1 + depth * np.cos(2 * np.pi * rate * t)) / (1 + depth)


@pytest.mark.parametrize("rate,depth", [(16.0, 0.5), (8.0, 0.25), (40.0, 0.8), (1.5, 0.4)])
def test_detects_amplitude_modulation_rate_and_depth(rate, depth):
    x = am(coloured_noise(-3.0), rate, depth)
    r = measure.amplitude_modulation(x, SR)
    assert r["rate_hz"] == pytest.approx(rate, abs=0.1)
    assert r["depth"] == pytest.approx(depth, abs=0.06)
    assert r["peak_prominence_db"] > measure.PROMINENCE_MIN_DB


def test_unmodulated_signal_has_no_prominent_modulation_peak():
    r = measure.amplitude_modulation(coloured_noise(-3.0), SR)
    assert r["depth"] < 0.05
    # Threshold calibrated on the null distribution, see measure.PROMINENCE_MIN_DB.
    assert r["peak_prominence_db"] < measure.PROMINENCE_MIN_DB


@pytest.mark.parametrize("slope", [0.0, -3.0, -6.0])
def test_noise_colour_slope(slope):
    r = measure.spectral_slope(coloured_noise(slope), SR)
    assert r["db_per_octave"] == pytest.approx(slope, abs=0.5)


def test_binaural_beat_offset():
    left, right = tone(200.0), tone(210.0)
    r = measure.binaural(np.stack([left, right], axis=1), SR)
    assert r["left_hz"] == pytest.approx(200.0, abs=0.1)
    assert r["right_hz"] == pytest.approx(210.0, abs=0.1)
    assert r["beat_hz"] == pytest.approx(10.0, abs=0.1)


def test_true_peak_exceeds_sample_peak_for_intersample_overs():
    # fs/4 sine phased 45 degrees: samples sit at 0.707 of the real peak
    t = np.arange(SR) / SR
    x = 0.99 * np.sin(2 * np.pi * (SR / 4) * t + np.pi / 4)
    r = measure.levels(x, SR)
    assert r["sample_peak_dbfs"] == pytest.approx(20 * np.log10(0.99 * np.sqrt(0.5)), abs=0.05)
    assert r["true_peak_dbtp"] == pytest.approx(20 * np.log10(0.99), abs=0.3)


def test_loudness_matches_ebu_tech_3341_reference():
    # EBU Tech 3341 test 1: 1 kHz sine at -23 dBFS in both stereo channels reads -23.0 LUFS
    x = tone(1000.0, seconds=20.0, amp=10 ** (-23 / 20))
    r = measure.levels(np.stack([x, x], axis=1), SR)
    assert r["integrated_lufs"] == pytest.approx(-23.0, abs=0.1)


def test_clipping_count():
    x = tone(440.0, amp=1.2).clip(-1, 1)
    assert measure.levels(x, SR)["clipped_samples"] > 1000


def test_loop_seam_click_detected_and_clean_loop_passes():
    clean = tone(441.0, seconds=2.0)  # exactly 882 periods: seamless
    assert measure.loop_seam(clean, SR)["click"] is False
    broken = tone(437.3, seconds=2.0)
    assert measure.loop_seam(broken, SR)["click"] is True


def test_internal_click_detected():
    x = coloured_noise(-6.0, seconds=5.0) * 0.1
    x[SR * 2] += 0.6
    r = measure.clicks(x, SR)
    assert r["count"] >= 1
    assert abs(r["times_s"][0] - 2.0) < 0.01
    assert measure.clicks(coloured_noise(-6.0, seconds=5.0) * 0.1, SR)["count"] == 0
