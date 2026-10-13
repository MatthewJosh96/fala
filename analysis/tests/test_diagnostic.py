import hashlib
import json
import subprocess

import numpy as np
import pytest

from fala_audio_check import diagnostic, measure
from fala_audio_check import timecode as tc

D = 20


@pytest.fixture(scope="module")
def generated(tmp_path_factory):
    out = tmp_path_factory.mktemp("diag") / "fala-diag-20s.m4a"
    res = diagnostic.generate(out, D)
    return out, res


def test_file_is_aac_lc_128k_stereo_48k_with_exact_duration(generated):
    out, res = generated
    info = diagnostic.probe(out)
    assert diagnostic.check_probe(info, D) == []
    assert info["codec"] == "aac" and info["profile"] == "LC"
    assert info["sample_rate"] == 48_000 and info["channels"] == 2
    assert info["duration_s"] == pytest.approx(D, abs=0.05)


def test_moov_atom_is_at_the_front(generated):
    out, _ = generated
    head = out.read_bytes()[:4096]
    assert head.find(b"moov") != -1 and (head.find(b"mdat") == -1 or head.find(b"moov") < head.find(b"mdat"))


def test_sidecar_describes_the_finished_file(generated):
    out, res = generated
    meta = json.loads(out.with_suffix(".json").read_text())
    assert meta["format"] == "fala-diag-v1"
    assert meta["file"] == out.name
    assert meta["content_type"] == "audio/mp4"
    assert meta["duration_s"] == D
    assert meta["size"] == out.stat().st_size
    assert meta["sha256"] == hashlib.sha256(out.read_bytes()).hexdigest()
    assert meta["sample_rate"] == 48_000 and meta["bitrate"] == 128_000
    assert meta["encoder"] in ("aac_at", "aac")
    for key in ("id", "title", "created"):
        assert meta[key]


def test_verify_decodes_every_second(generated):
    out, _ = generated
    rep = diagnostic.verify(out)
    assert rep["ok"], rep["problems"]
    assert rep["last_number"] == D - 1
    assert rep["windows"][0]["decoded"] == D


def test_decoded_file_true_peak_is_at_most_minus_1_dbtp(generated):
    out, _ = generated
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(out), "-f", "f32le", "pipe:1"],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype="<f4").reshape(-1, 2).astype(np.float64)
    assert measure.levels(x, tc.SR)["true_peak_dbtp"] <= -1.0


def test_verify_catches_a_file_that_does_not_match_its_sidecar(generated, tmp_path):
    out, _ = generated
    bad = tmp_path / out.name
    bad.write_bytes(out.read_bytes())
    meta = json.loads(out.with_suffix(".json").read_text())
    meta["sha256"] = "0" * 64
    bad.with_suffix(".json").write_text(json.dumps(meta))
    rep = diagnostic.verify(bad)
    assert not rep["ok"] and any("sha256" in p for p in rep["problems"])


def test_seeked_windows_are_checked_for_long_files(generated):
    out, _ = generated
    # Pretend windows: a 20 s file checked with 6 s windows exercises the seek path.
    rep = diagnostic.verify(out, window_s=6.0, n_random=1)
    assert rep["ok"], rep["problems"]
    assert len(rep["windows"]) == 3
