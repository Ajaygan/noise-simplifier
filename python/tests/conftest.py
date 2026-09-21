"""Shared test fixtures — the same signals the Node suite uses.

`tests/signals.mjs` is the source of truth for the browser side; these helpers
mirror it (same generator, same seeds) so Python and JavaScript numbers can be
compared directly.
"""

from __future__ import annotations

import numpy as np
import pytest

SR = 48000


def mulberry32(seed: int):
    """bit-exact port of the mulberry32 PRNG in tests/signals.mjs"""
    state = seed & 0xFFFFFFFF

    def rand() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = (t ^ (t >> 15)) * (t | 1) & 0xFFFFFFFF
        t ^= (t + ((t ^ (t >> 7)) * (t | 61) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return rand


def _randn(count: int, seed: int) -> np.ndarray:
    rand = mulberry32(seed)
    return np.array([rand() * 2 - 1 for _ in range(count)])


def white_noise(seconds: float, seed: int = 1, amplitude: float = 0.25) -> np.ndarray:
    n = int(SR * seconds)
    return _randn(n, seed) * amplitude


def pink_noise(seconds: float, seed: int = 2, amplitude: float = 0.25) -> np.ndarray:
    """Paul Kellet's economy pink filter, with the warm-up discarded."""
    n = int(SR * seconds)
    warm = int(SR * 0.25)
    w = _randn(n + warm, seed)
    b = [0.0] * 7
    out = np.empty(n + warm)
    for i in range(n + warm):
        white = w[i]
        b[0] = 0.99886 * b[0] + white * 0.0555179
        b[1] = 0.99332 * b[1] + white * 0.0750759
        b[2] = 0.96900 * b[2] + white * 0.1538520
        b[3] = 0.86650 * b[3] + white * 0.3104856
        b[4] = 0.55000 * b[4] + white * 0.5329522
        b[5] = -0.7616 * b[5] - white * 0.0168980
        out[i] = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + white * 0.5362
        b[6] = white * 0.115926
    out = out[warm:]
    return out / np.max(np.abs(out)) * amplitude


def speech_like(seconds: float, seed: int = 3, amplitude: float = 0.32,
                pauses: bool = False) -> np.ndarray:
    """A crude voiced signal: harmonic stack + formant peaks + syllabic envelope.

    With ``pauses=True`` the utterance gets word-sized gaps, which is what real
    meeting speech looks like and what lets a noise estimator see the noise on
    its own. The no-pause variant is the harder, worst-case signal.
    """
    n = int(SR * seconds)
    t = np.arange(n) / SR
    f0 = 120.0
    sig = np.zeros(n)
    for harmonic in range(1, 40):
        freq = f0 * harmonic
        if freq > 8000:
            break
        formant = (1.0 / (1 + ((freq - 620) / 220) ** 2)
                   + 0.7 / (1 + ((freq - 1180) / 260) ** 2)
                   + 0.5 / (1 + ((freq - 2600) / 420) ** 2))
        sig += np.sin(2 * np.pi * freq * t + harmonic) * formant / harmonic
    sig /= np.max(np.abs(sig)) or 1.0
    rand = mulberry32(seed)
    envelope = np.ones(n)
    for i in range(0, n, int(0.22 * SR)):
        level = 0.35 + 0.65 * rand()
        envelope[i:i + int(0.22 * SR)] = level
    if pauses:
        # ~0.7 s of speech, ~0.3 s of silence, like someone talking in a room
        span = int(1.0 * SR)
        for i in range(0, n, span):
            gap_start = i + int(0.68 * SR)
            envelope[gap_start:gap_start + int(0.30 * SR)] = 0.0
    return sig * envelope * amplitude


def noise_scale_for(signal: np.ndarray, noise: np.ndarray, snr_db: float) -> float:
    """Amplitude factor that puts `noise` at `snr_db` below `signal`."""
    signal_rms = np.sqrt(np.mean(signal**2))
    noise_rms = np.sqrt(np.mean(noise[: signal.size] ** 2)) or 1e-12
    return (signal_rms / (10 ** (snr_db / 20))) / noise_rms


def mix_at_snr(signal: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    noise = noise[: signal.size]
    return signal + noise * noise_scale_for(signal, noise, snr_db)


def db_rms(x: np.ndarray) -> float:
    return 20 * np.log10(np.sqrt(np.mean(np.asarray(x) ** 2)) + 1e-12)


def segmental_snr(reference: np.ndarray, estimate: np.ndarray, frame: int = 512,
                  hop: int = 256, silence_db: float = -45.0) -> float:
    """Frame-wise SNR in dB, clamped to -10..35 and averaged.

    Frames where the *reference* is silent are skipped: with pauses in the
    signal (as in real speech) a frame of pure silence would otherwise dominate
    the average, even though "no speech in, no speech out" is not an error.
    """
    total = 0.0
    frames = 0
    for start in range(0, min(len(reference), len(estimate)) - frame, hop):
        ref = reference[start:start + frame]
        if db_rms(ref) < silence_db:
            continue
        err = estimate[start:start + frame] - ref
        ratio = 10 * np.log10((np.sum(ref**2) + 1e-12) / (np.sum(err**2) + 1e-12))
        total += float(np.clip(ratio, -10, 35))
        frames += 1
    return total / max(1, frames)


@pytest.fixture(scope="session")
def sr() -> int:
    return SR


@pytest.fixture(scope="session")
def noisy_speech():
    """4 s of speech at 0 dB SNR against pink noise (the extension's test case)."""
    speech = speech_like(4.0, seed=3)
    noise = pink_noise(4.0, seed=5)
    return speech, mix_at_snr(speech, noise, 0.0)
