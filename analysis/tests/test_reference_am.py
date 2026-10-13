import numpy as np
import pytest

from fala_audio_check import measure

SR = 48_000
rng = np.random.default_rng(11)


def music_like(seconds=30.0, own_env_hz=20.0):
    """Harmonic tone bed whose own envelope already fluctuates at own_env_hz."""
    t = np.arange(int(SR * seconds)) / SR
    bed = sum(np.sin(2 * np.pi * f * t + p) / k for k, (f, p) in enumerate([(523.3, 0.1), (659.3, 1.0), (784.0, 2.0), (1046.5, 0.4)], 1))
    natural = 1 + 0.4 * np.sin(2 * np.pi * own_env_hz * t)
    x = 0.2 * bed * natural
    return np.stack([x, np.roll(x, 37)], axis=1)


def apply_am(x, rate, m, phase=0.3):
    t = np.arange(len(x)) / SR
    g = (1 + m * np.cos(2 * np.pi * rate * t + phase)) / (1 + m)
    return x * g[:, None]


@pytest.mark.parametrize("m", [0.0, 0.1, 0.37, 0.8])
def test_reference_regression_recovers_applied_depth_despite_natural_envelope(m):
    x = music_like()
    noise = 0.02 * rng.standard_normal(x.shape)
    y = 0.9 * apply_am(x, 20.0, m) + noise
    r = measure.applied_am_depth(y, x, SR, expected_hz=20.0, extra_layers=[noise])
    assert r["depth"] == pytest.approx(m, abs=0.01)
    if m > 0:
        assert r["rate_hz"] == pytest.approx(20.0, abs=0.01)
        assert r["detected"] is True
    else:
        assert r["detected"] is False
    assert r["normalized_residual"] < 1e-6


def test_envelope_spectrum_alone_misattributes_natural_envelope():
    # Shows why the reference-aware fit exists: unmodulated music with its own
    # 20 Hz envelope looks "modulated" to the plain envelope measurement.
    x = music_like()
    plain = measure.amplitude_modulation(x, SR)
    assert plain["rate_hz"] == pytest.approx(20.0, abs=0.05)
    assert plain["peak_prominence_db"] > measure.PROMINENCE_MIN_DB
    assert measure.applied_am_depth(x, x, SR, expected_hz=20.0)["detected"] is False


def test_wrong_expected_rate_is_reported_not_silently_accepted():
    x = music_like()
    y = apply_am(x, 16.0, 0.5)
    r = measure.applied_am_depth(y, x, SR, expected_hz=20.0)
    assert r["rate_at_search_boundary"] is True or r["depth"] < 0.05
