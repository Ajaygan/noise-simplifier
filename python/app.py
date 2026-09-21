"""HTTP API for the offline denoiser — the "use Python for this" half.

Run it with::

    /opt/nsvenv/bin/python -m uvicorn app:app --port 8765     # from python/

then

    # clean a file in place and write the result next to it
    curl -s -X POST "http://127.0.0.1:8765/denoise/file?path=meeting.wav&out=meeting.clean.wav"

    # or post raw audio and stream the cleaned audio back
    curl -s -X POST "http://127.0.0.1:8765/denoise/raw?sample_rate=48000&strength=0.8" \\
         --data-binary @meeting.raw --output meeting.clean.raw

The extension never calls this endpoint: live meeting audio cannot survive a
network round-trip, so the browser does the real-time work itself. This service
is here for recordings, and so Python can be used to tune the same algorithm.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated

import numpy as np
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response

from noisesimplifier import __version__, available_backends
from noisesimplifier.backends.spectral import SpectralDenoiser, SpectralSettings

app = FastAPI(
    title="Noise Simplifier (offline)",
    version=__version__,
    description=__doc__.split("Run it with")[0].strip(),
)

#: only these container extensions may be read/written by /denoise/file
AUDIO_SUFFIXES = {".wav", ".flac", ".ogg", ".aiff", ".aif", ".mp3", ".m4a", ".opus"}


def resolve_audio_path(raw: str) -> Path:
    path = Path(raw).expanduser()
    if path.suffix.lower() not in AUDIO_SUFFIXES:
        raise HTTPException(400, f"unsupported audio extension: {path.suffix or '(none)'}")
    path = path.resolve()
    root = Path(os.environ.get("NOISE_SIMPLIFIER_ROOT", Path.cwd())).resolve()
    if root not in path.parents and path != root:
        raise HTTPException(403, f"path must live under {root}")
    if not path.is_file():
        raise HTTPException(404, f"no such file: {path}")
    return path


def settings_dependency(
    strength: float = Query(0.75, ge=0.0, le=1.0),
    voice_focus: bool = True,
    auto_gain: bool = False,
    max_attenuation_db: float | None = Query(None, ge=0.0, le=60.0),
    highpass_hz: float | None = Query(None, ge=20.0, le=500.0),
    lowpass_hz: float | None = Query(None, ge=2000.0, le=20000.0),
) -> SpectralSettings:
    """Query parameters -> settings, so a popup JSON maps onto the URL."""
    settings = SpectralSettings(strength=strength, voice_focus=voice_focus, auto_gain=auto_gain)
    if max_attenuation_db is not None:
        settings.max_attenuation_db = max_attenuation_db
    if highpass_hz is not None:
        settings.highpass_hz = highpass_hz
    if lowpass_hz is not None:
        settings.lowpass_hz = lowpass_hz
    return settings


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "version": __version__, "backends": available_backends()}


@app.post("/denoise/file")
def denoise_file(
    path: Annotated[str, Query(description="input audio file")],
    out: Annotated[str | None, Query(description="output file; defaults to <name>.clean<suffix>")] = None,
    settings: SpectralSettings = Depends(settings_dependency),
) -> JSONResponse:
    """Clean an audio file on disk with soundfile."""
    try:
        import soundfile as sf
    except ImportError:  # pragma: no cover - soundfile is in the venv
        raise HTTPException(500, "soundfile is not installed")

    source = resolve_audio_path(path)
    audio, sample_rate = sf.read(str(source), always_2d=True)
    denoiser = SpectralDenoiser(sample_rate, settings)
    clean = denoiser.denoise_channels(audio.T).T
    peak = float(np.max(np.abs(clean))) if clean.size else 0.0
    if peak > 1.0:  # never clip on write
        clean = clean / peak * 0.999

    if out:
        target = resolve_audio_path(out) if Path(out).is_file() else Path(out).resolve()
    else:
        target = source.with_name(f"{source.stem}.clean{source.suffix}")
    sf.write(str(target), clean, sample_rate)
    return JSONResponse({
        "input": str(source),
        "output": str(target),
        "sampleRate": sample_rate,
        "channels": int(audio.shape[1]),
        "seconds": round(audio.shape[0] / sample_rate, 3),
        "settings": settings.to_json(),
        "metrics": denoiser.metrics(),
    })


@app.post("/denoise/raw")
async def denoise_raw(
    request: Request,
    sample_rate: int = Query(48000, ge=8000, le=192000),
    dtype: str = Query("float32", pattern="^(float32|float64|int16)$"),
    channels: int = Query(1, ge=1, le=8),
    settings: SpectralSettings = Depends(settings_dependency),
) -> Response:
    """Clean a raw PCM body and return raw PCM of the same dtype/length."""
    body = await request.body()
    if not body:
        raise HTTPException(400, "empty body")

    if dtype == "int16":
        data = np.frombuffer(body, dtype="<i2").astype(np.float64) / 32768.0
    elif dtype == "float64":
        data = np.frombuffer(body, dtype="<f8").astype(np.float64)
    else:
        data = np.frombuffer(body, dtype="<f4").astype(np.float64)

    if channels > 1:
        usable = (data.size // channels) * channels
        data = data[:usable].reshape(-1, channels)
    else:
        data = data.reshape(-1)

    denoiser = SpectralDenoiser(sample_rate, settings)
    clean = denoiser.denoise_channels(data)

    headers = {
        "x-noise-simplifier-noise-floor-db": f"{denoiser.last_noise_floor_db:.2f}",
        "x-noise-simplifier-suppression-db": f"{denoiser.last_suppression_db:.2f}",
    }
    if dtype == "int16":
        payload = np.clip(clean, -1.0, 1.0)
        payload = (payload * 32767.0).astype("<i2").tobytes()
    elif dtype == "float64":
        payload = clean.astype("<f8").tobytes()
    else:
        payload = np.clip(clean, -1.0, 1.0).astype("<f4").tobytes()
    return Response(content=payload, media_type="application/octet-stream", headers=headers)
