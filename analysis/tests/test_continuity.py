"""Calibration of the continuity detector on a simulated phone -> room -> microphone chain.

Faults are injected into the source (what the player outputs) before the room; the
room is: speaker band 250 Hz - 14 kHz, RIR with RT60 0.4 s and DRR +6 dB, rumble and
hiss, recorder clock +-100 ppm, 24 kHz 16 bit.
"""

import json

import numpy as np
import pytest
import soundfile as sf

import roomsim as rs
from fala_audio_check import continuity as ct

D = 120

# (fault, expected type, source second, magnitude ms)
FAULTS = [
    (("cut", 10.6, 0.010), "skip", 10.6, 10),
    (("cut", 20.6, 0.050), "skip", 20.6, 50),
    (("cut", 30.6, 1.0), "skip", 30.6, 1000),
    (("silence", 40.6, 0.010), "dropout", 40.6, 10),
    (("silence", 50.6, 0.050), "dropout", 50.6, 50),
    (("insert_zeros", 60.6, 0.010), "gap", 60.6, 10),
    (("repeat", 70.6, 0.300), "repeat", 70.9, 300),
    (("repeat", 80.4, 1.0), "repeat", 81.4, 1000),
    (("cut", 90.6, 5.0), "skip", 90.6, 5000),
    (("insert_zeros", 100.6, 0.050), "gap", 100.6, 50),
]
END_S = 112.5


def tolerance_ms(kind, magnitude):
    # Time steps come from chirp timing (~0.01 ms jitter); dropout lengths from the
    # background energy track (1 ms frames).
    return 0.5 if kind in ("skip", "gap", "repeat") else max(2.0, 0.1 * magnitude)


def match(report, expected):
    failures = [e for e in report["events"] if e["failure"]]
    unmatched = list(failures)
    for kind, src, mag in expected:
        hits = [e for e in unmatched if e["type"] == kind and abs(e["source_second"] - src) <= 1.0]
        assert hits, f"{kind} at {src} s not found in {failures}"
        e = hits[0]
        assert e["magnitude_ms"] == pytest.approx(mag, abs=tolerance_ms(kind, mag)), e
        unmatched.remove(e)
    assert unmatched == [], f"unexpected failures: {unmatched}"


@pytest.fixture(scope="module")
def source():
    return rs.source(D)


@pytest.mark.parametrize("drift_ppm", [100.0, -100.0])
def test_every_fault_is_found_with_type_place_and_size(source, drift_ppm):
    faults = [f for f, *_ in FAULTS] + [("truncate", END_S)]
    rec = rs.room(rs.apply_faults(source, faults), drift_ppm=drift_ppm)
    report = ct.analyze_array(rec, 24_000, D)
    expected = [(kind, src, mag) for _, kind, src, mag in FAULTS]
    expected.append(("premature_end", END_S, (D - END_S) * 1e3))
    match(report, expected)
    assert report["drift_ppm"] == pytest.approx(drift_ppm, abs=2.0)
    end = next(e for e in report["events"] if e["type"] == "premature_end")
    assert end["cause_hint"] == "playback_stopped" and end["last_number"] == 112
    assert not report["pass"]


def test_clean_playback_with_drift_level_changes_and_room_passes(source):
    x = rs.gain_step(source, 40.0, -6.0)
    x = rs.gain_ramp(x, 70.0, 100.0, -6.0)
    report = ct.analyze_array(rs.room(x, drift_ppm=100.0), 24_000, D)
    assert [e for e in report["events"] if e["failure"]] == []
    assert report["pass"]
    assert report["bursts_decoded"] == D and report["coverage"] == 1.0
    assert report["jitter_ms"] < 0.05
    levels = [e for e in report["events"] if e["type"] == "level_change"]
    assert any(abs(e["source_second"] - 40) <= 1.5 and e["change_db"] == pytest.approx(-6, abs=1.0) for e in levels)
    assert any(70 <= e["source_second"] <= 100 for e in levels)


def test_aac_round_trip_adds_no_false_alarms_and_keeps_detection(source, tmp_path):
    decoded = rs.aac_roundtrip(source, tmp_path)[: len(source)]
    clean = ct.analyze_array(rs.room(decoded, drift_ppm=-100.0), 24_000, D)
    assert clean["pass"], [e for e in clean["events"] if e["failure"]]
    faults = [("silence", 30.6, 0.010), ("insert_zeros", 60.6, 0.010), ("cut", 90.6, 0.010)]
    report = ct.analyze_array(rs.room(rs.apply_faults(decoded, faults), drift_ppm=100.0), 24_000, D)
    match(report, [("dropout", 30.6, 10), ("gap", 60.6, 10), ("skip", 90.6, 10)])


def test_faults_inside_the_burst_are_found(source):
    faults = [("cut", 20.015, 0.010), ("cut", 40.1, 0.050), ("insert_zeros", 60.015, 0.010), ("silence", 80.12, 0.010)]
    report = ct.analyze_array(rs.room(rs.apply_faults(source, faults), drift_ppm=100.0), 24_000, D)
    match(report, [("skip", 20.0, 10), ("skip", 40.1, 50), ("gap", 60.0, 10), ("dropout", 80.12, 10)])


def test_long_mute_without_time_shift_is_one_dropout(source):
    report = ct.analyze_array(rs.room(rs.silence(source, 50.6, 3.0), drift_ppm=100.0), 24_000, D)
    match(report, [("dropout", 50.6, 3000)])


def test_small_steps_down_to_1_ms_are_detected(source):
    faults = [("cut", 20.6, 0.001), ("insert_zeros", 40.6, 0.002), ("repeat", 60.6, 0.005)]
    report = ct.analyze_array(rs.room(rs.apply_faults(source, faults), drift_ppm=100.0), 24_000, D)
    fails = [e for e in report["events"] if e["failure"]]
    assert len(fails) == 3
    for e, (src, delta) in zip(fails, [(20.6, -1.0), (40.6, 2.0), (60.6, 5.0)]):
        assert abs(e["source_second"] - src) <= 1.0
        assert e["delta_ms"] == pytest.approx(delta, abs=0.1)
    assert fails[0]["type"] == "skip"
    assert fails[1]["type"] in ("gap", "gap_or_repeat")
    assert fails[2]["type"] in ("repeat", "gap_or_repeat")


def test_cli_reads_a_flac_recording_and_writes_json(source, tmp_path, capsys):
    rec = rs.room(rs.apply_faults(source[: 40 * rs.SR], [("insert_zeros", 20.6, 0.050)]), drift_ppm=50.0)
    path = tmp_path / "rec.flac"
    sf.write(path, rec, 24_000, subtype="PCM_16")
    out = tmp_path / "report.json"
    code = ct.main([str(path), "--expected-duration-s", "40", "--json", str(out)])
    report = json.loads(out.read_text())
    assert code == 1 and report["pass"] is False
    assert [e["type"] for e in report["events"] if e["failure"]] == ["gap"]
    assert report["bursts_decoded"] == 40
    assert '"pass": false' in capsys.readouterr().out


def test_silence_only_recording_reports_no_signal():
    rng = np.random.default_rng(1)
    report = ct.analyze_array(rng.standard_normal(10 * 24_000) * 1e-3, 24_000, 10)
    assert not report["pass"] and report["events"][0]["type"] == "no_signal"
