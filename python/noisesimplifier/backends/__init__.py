"""Backends available to the offline (Python) side of Noise Simplifier."""

from __future__ import annotations

from .spectral import SpectralDenoiser, SpectralSettings  # noqa: F401

__all__ = ["SpectralDenoiser", "SpectralSettings", "available_backends", "get_backend"]

#: ids accepted by the CLI / HTTP API
BACKENDS = ("spectral",)


def _rnnoise_available() -> bool:
    """RNNoise is optional on the Python side: the browser does it natively."""
    for module in ("rnnoise", "pyrnnoise"):
        try:
            __import__(module)
            return True
        except Exception:  # pragma: no cover - depends on the environment
            continue
    return False


def available_backends() -> list[dict]:
    """Human-readable description of every backend, for /health and the CLI."""
    return [
        {
            "id": "spectral",
            "name": "Spectral (offline, two-pass)",
            "available": True,
            "description": "Percentile noise estimate + Wiener gain + voice focus.",
        },
        {
            "id": "rnnoise",
            "name": "RNNoise (optional)",
            "available": _rnnoise_available(),
            "description": "Needs the `rnnoise` Python package; the browser uses "
                           "the WASM build of the same model.",
        },
    ]


def get_backend(name: str = "spectral"):
    """Return the backend class for `name`."""
    if name != "spectral":
        raise ValueError(f"unknown backend: {name!r} (available: {', '.join(BACKENDS)})")
    return SpectralDenoiser
