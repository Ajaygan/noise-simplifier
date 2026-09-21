"""Noise Simplifier — offline (Python) audio cleaning for the browser extension.

The Chrome extension removes background noise from a meeting tab in real time
inside an ``AudioWorklet``. This package does the same job on *files*: it is the
batch/offline side of the project, and can also run as a small HTTP service so
other tools can post audio and get clean audio back.

Typical use::

    from noisesimplifier import SpectralDenoiser, SpectralSettings
    import soundfile as sf

    audio, sr = sf.read("meeting.wav")
    clean = SpectralDenoiser(sr, SpectralSettings(strength=0.8)).denoise_channels(audio)
    sf.write("meeting.clean.wav", clean, sr)
"""

from __future__ import annotations

from .backends import SpectralDenoiser, SpectralSettings, available_backends, get_backend

__version__ = "0.1.0"

__all__ = [
    "SpectralDenoiser",
    "SpectralSettings",
    "available_backends",
    "get_backend",
    "__version__",
]
