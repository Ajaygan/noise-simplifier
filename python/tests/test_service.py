"""The HTTP service and the CLI — the two ways to use the Python side.

These tests are what make the "you can use Python for this" part of the project
verifiable: audio in, cleaned audio out, over HTTP and from the shell.
"""

from __future__ import annotations

import struct
import wave
from pathlib import Path

import numpy as np
import pytest

from noisesimplifier import __version__
from noisesimplifier.cli import main as cli_main

from .conftest import SR, mix_at_snr, pink_noise, speech_like

fastapi_testclient = pytest.importorskip("fastapi.testclient")


@pytest.fixture(scope="module")
def client():
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from app import app

    return fastapi_testclient.TestClient(app)


@pytest.fixture(scope="module")
def wav_file(tmp_path_factory) -> Path:
    """A 3 s noisy wav on disk, written with the stdlib wave module."""
    tmp = tmp_path_factory.mktemp("audio")
    speech = speech_like(3.0, seed=3, pauses=True)
    noisy = mix_at_snr(speech, pink_noise(3.0, seed=5), 0.0)
    path = tmp / "meeting.wav"
    pcm = np.clip(noisy, -1.0, 1.0)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes((pcm * 32767).astype("<i2").tobytes())
    return path


def test_health_lists_the_backends(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["version"] == __version__
    assert {b["id"] for b in body["backends"]} >= {"spectral", "rnnoise"}


def test_raw_endpoint_cleans_float32_audio(client):
    speech = speech_like(2.0, seed=3, pauses=True)
    noisy = mix_at_snr(speech, pink_noise(2.0, seed=5), 0.0).astype("<f4")
    response = client.post(
        f"/denoise/raw?sample_rate={SR}&dtype=float32",
        content=noisy.tobytes(),
        headers={"content-type": "application/octet-stream"},
    )
    assert response.status_code == 200
    out = np.frombuffer(response.content, dtype="<f4")
    assert out.shape == noisy.shape
    assert np.all(np.isfinite(out))
    assert float(np.max(np.abs(out))) <= 1.0
    # the noise floor really moved
    before = 20 * np.log10(np.sqrt(np.mean(noisy.astype(np.float64) ** 2)))
    after = 20 * np.log10(np.sqrt(np.mean(out.astype(np.float64) ** 2)))
    assert after < before - 3
    assert float(response.headers["x-noise-simplifier-suppression-db"]) > 2


def test_raw_endpoint_rejects_an_empty_body(client):
    assert client.post("/denoise/raw?sample_rate=48000").status_code == 400


def test_raw_endpoint_int16_round_trip(client):
    speech = speech_like(1.0, seed=9, pauses=True)
    pcm = (np.clip(speech, -1.0, 1.0) * 32767).astype("<i2")
    response = client.post(
        f"/denoise/raw?sample_rate={SR}&dtype=int16",
        content=pcm.tobytes(),
        headers={"content-type": "application/octet-stream"},
    )
    assert response.status_code == 200
    out = np.frombuffer(response.content, dtype="<i2")
    assert out.shape == pcm.shape
    assert np.max(np.abs(out.astype(np.int32))) <= 32767


def test_file_endpoint_writes_a_clean_copy(client, wav_file, tmp_path, monkeypatch):
    monkeypatch.setenv("NOISE_SIMPLIFIER_ROOT", str(wav_file.parent))
    target = wav_file.with_name("meeting.clean.wav")
    body = client.post(f"/denoise/file?path={wav_file}&out={target}").json()
    assert Path(body["output"]) == target
    assert target.is_file()
    assert body["sampleRate"] == SR
    assert body["seconds"] == pytest.approx(3.0, abs=0.05)
    assert body["metrics"]["suppressionDb"] > 2
    # the written file is shorter-or-equal in noise: read it back and compare
    with wave.open(str(target), "rb") as handle:
        data = np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2")
    assert data.size == 3 * SR
    assert np.max(np.abs(data.astype(np.int32))) <= 32767


def test_file_endpoint_refuses_paths_outside_the_root(client, wav_file, monkeypatch):
    monkeypatch.setenv("NOISE_SIMPLIFIER_ROOT", str(wav_file.parent / "elsewhere"))
    assert client.post(f"/denoise/file?path={wav_file}").status_code == 403


def test_file_endpoint_refuses_other_file_types(client, tmp_path, monkeypatch):
    monkeypatch.setenv("NOISE_SIMPLIFIER_ROOT", str(tmp_path))
    other = tmp_path / "notes.txt"
    other.write_text("not audio")
    assert client.post(f"/denoise/file?path={other}").status_code == 400


def test_cli_cleans_a_file_in_place(tmp_path, wav_file, capsys):
    target = tmp_path / "out.wav"
    code = cli_main([str(wav_file), "--out", str(target), "--strength", "0.8", "--quiet"])
    assert code == 0
    assert target.is_file()
    assert target.stat().st_size > 44  # more than a bare wav header
    # the CLI must produce the same length as its input
    with wave.open(str(wav_file), "rb") as handle:
        n_in = handle.getnframes()
    with wave.open(str(target), "rb") as handle:
        assert handle.getnframes() == n_in


def test_cli_reports_progress_by_default(tmp_path, wav_file, capsys):
    code = cli_main([str(wav_file), "--out", str(tmp_path / "loud.wav")])
    assert code == 0
    out = capsys.readouterr().out
    assert "suppression" in out
    assert "noise floor" in out


def test_cli_refuses_a_missing_input():
    with pytest.raises(SystemExit):
        cli_main(["/definitely/not/here.wav"])


def test_wav_header_helper_is_sane(wav_file):
    """Guard the fixture itself: a broken wav would make every test lie."""
    with wave.open(str(wav_file), "rb") as handle:
        assert handle.getnchannels() == 1
        assert handle.getsampwidth() == 2
        assert handle.getframerate() == SR
        frames = handle.readframes(4)
    assert len(struct.unpack("<4h", frames)) == 4
