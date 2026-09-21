"""Offline backend tests: noise goes down, speech stays intact, no clipping.

The acceptance thresholds mirror the Node suite where the two engines overlap
(see `tests/spectral.test.mjs`), so a regression on either side is visible.
"""

from __future__ import annotations

import numpy as np
import pytest

from noisesimplifier import SpectralDenoiser, SpectralSettings, available_backends
from noisesimplifier.backends.spectral import VoiceFocus, peaking_sos

from .conftest import (
    SR,
    db_rms,
    mix_at_snr,
    noise_scale_for,
    pink_noise,
    segmental_snr,
    speech_like,
    white_noise,
)


def clean(signal: np.ndarray, **overrides):
    """Denoise `signal` at SR with the given settings overrides."""
    denoiser = SpectralDenoiser(SR, SpectralSettings(**overrides))
    return denoiser.denoise(signal), denoiser


def active_level(signal: np.ndarray, reference: np.ndarray, frame: int = 512, hop: int = 256) -> float:
    """Mean energy of `signal` over the frames where `reference` is talking."""
    energies = [
        np.sum(signal[i:i + frame] ** 2)
        for i in range(0, min(len(signal), len(reference)) - frame, hop)
        if db_rms(reference[i:i + frame]) > -45.0
    ]
    return 10 * np.log10(np.mean(energies) + 1e-20)


# --------------------------------------------------------------- unit tests


def test_defaults_match_the_extension():
    """One settings vocabulary for JS and Python."""
    settings = SpectralSettings()
    assert settings.strength == 0.75
    assert settings.voice_focus is True
    assert settings.auto_gain is False
    assert settings.highpass_hz == 95.0
    assert settings.lowpass_hz == 7600.0
    assert settings.presence_db == 2.5
    assert settings.max_attenuation_db == 26.0
    assert SpectralSettings.from_json(settings.to_json()) == settings


def test_only_spectral_is_available_without_extra_packages():
    backends = {b["id"]: b for b in available_backends()}
    assert backends["spectral"]["available"] is True
    assert "rnnoise" in backends


def test_output_length_is_exact_and_finite():
    for seconds in (0.35, 1.0, 3.1):
        audio = pink_noise(seconds, seed=7)
        out, _ = clean(audio)
        assert out.shape == audio.shape
        assert np.all(np.isfinite(out))
    out, _ = clean(np.zeros(SR // 4))
    assert np.all(np.isfinite(out))
    assert np.max(np.abs(out)) < 1e-3


def test_peaking_filter_section_is_stable():
    sos = peaking_sos(SR, 2600.0, 0.9, 6.0)
    assert np.all(np.abs(np.roots(sos[0, 3:])) < 1.0)


def test_voice_focus_is_transparent_when_disabled():
    focus = VoiceFocus(SR, SpectralSettings(voice_focus=False))
    audio = speech_like(1.0, seed=27)
    assert np.allclose(focus.process(audio), audio)


# ------------------------------------------------------- what the user hears


def test_white_noise_is_knocked_down_hard():
    """The defaults are strong on stationary broadband noise (fan, hiss, air)."""
    noise = white_noise(4.0, seed=11)
    out, denoiser = clean(noise)
    reduction = db_rms(noise) - db_rms(out)
    assert reduction > 15, f"only {reduction:.1f} dB reduction"
    assert np.max(np.abs(out)) <= 1.0
    # -16.8 dBFS of white noise in, and the report says so (in dBFS)
    assert abs(denoiser.last_noise_floor_db - db_rms(noise)) < 3.0


def test_pink_noise_floor_drops_and_speech_survives():
    noise = pink_noise(6.0, seed=5)
    quiet_noise, _ = clean(noise)
    reduction = db_rms(noise) - db_rms(quiet_noise)
    assert reduction > 12, f"only {reduction:.2f} dB reduction on pink noise"

    speech = speech_like(6.0, seed=3, pauses=True)
    noisy = mix_at_snr(speech, noise, 0.0)
    quiet, _ = clean(noisy, voice_focus=False)
    # the speech is still there (voice focus out of the way, so this measures
    # the denoiser itself and not the band-limiting filter)
    assert segmental_snr(speech, quiet) > segmental_snr(speech, noisy) + 1.5


def test_a_quiet_noise_floor_does_not_cost_voice_level():
    """The acceptance criterion: keep the voice, drop what is behind it.

    At +20 dB SNR the noise is almost inaudible, so the processor has to be
    essentially transparent. This is the case that catches a noise estimate
    which has drifted upwards into the speech.
    """
    speech = speech_like(6.0, seed=3, pauses=True)
    noise = pink_noise(6.0, seed=5)
    noisy = mix_at_snr(speech, noise, 20.0)
    out, _ = clean(noisy, voice_focus=False)

    assert abs(active_level(out, speech) - active_level(speech, speech)) < 1.5
    assert segmental_snr(speech, out) > segmental_snr(speech, noisy)


def test_the_estimator_tracks_the_noise_it_cannot_hear():
    """Estimating from a mixture must land near estimating from the noise."""
    speech = speech_like(6.0, seed=3, pauses=True)
    noise = pink_noise(6.0, seed=5)
    mixture = mix_at_snr(speech, noise, 20.0)
    # the same noise at the level it has inside that mixture
    scaled_noise = noise * noise_scale_for(speech, noise, 20.0)
    denoiser = SpectralDenoiser(SR, SpectralSettings())
    ratio = denoiser.estimate_noise(mixture) / denoiser.estimate_noise(scaled_noise)
    # the first 1.5 kHz carry nearly all of the pink noise energy
    band = slice(1, int(1500 / (SR / denoiser.n_fft)))
    median = float(np.median(ratio[band]))
    assert 0.25 < median < 3.0, f"low-band estimate ratio {median:.2f}"


def test_the_pipeline_is_transparent_when_suppression_is_disabled():
    """With the attenuation floor at 0 dB the output must equal the input."""
    speech = speech_like(1.0, seed=27, pauses=True)
    out, _ = clean(speech, max_attenuation_db=0.0, voice_focus=False)
    assert np.max(np.abs(out - speech)) < 1e-6


def test_speech_is_preserved_better_than_the_mix_is():
    speech = speech_like(6.0, seed=3, pauses=True)
    noisy = mix_at_snr(speech, pink_noise(6.0, seed=5), 0.0)
    out, _ = clean(noisy)
    ref = speech - speech.mean()
    got = out - out.mean()
    corr = float(np.dot(ref, got) / (np.linalg.norm(ref) * np.linalg.norm(got)))
    assert corr > 0.5, f"correlation with clean speech only {corr:.2f}"


def test_segmental_snr_improves_at_every_snr():
    speech = speech_like(6.0, seed=3, pauses=True)
    noise = pink_noise(6.0, seed=5)
    for snr_db in (0.0, 5.0, 10.0, 20.0):
        noisy = mix_at_snr(speech, noise, snr_db)
        out, _ = clean(noisy, voice_focus=False)
        before = segmental_snr(speech, noisy)
        after = segmental_snr(speech, out)
        assert after > before, f"at {snr_db} dB: segSNR {before:.2f} -> {after:.2f}"


def test_more_strength_removes_more_noise():
    noise = mix_at_snr(speech_like(3.0, seed=4), pink_noise(3.0, seed=6), 0.0)
    weak, _ = clean(noise, strength=0.3)
    strong, _ = clean(noise, strength=1.0)
    assert db_rms(strong) < db_rms(weak)


def test_max_attenuation_bounds_the_damage():
    noise = white_noise(3.0, seed=9)
    gentle, _ = clean(noise, voice_focus=False, max_attenuation_db=6.0)
    hard, _ = clean(noise, voice_focus=False, max_attenuation_db=40.0)
    assert db_rms(gentle) - db_rms(hard) > 6.0


def test_voice_focus_removes_rumble_and_hiss():
    rumble = np.sin(2 * np.pi * 40 * np.arange(SR * 2) / SR) * 0.4
    hiss = white_noise(2.0, seed=13, amplitude=0.1)
    out, _ = clean(rumble + hiss, voice_focus=True, strength=0.7)
    assert db_rms(out) < db_rms(rumble + hiss) - 12


def test_auto_gain_lifts_a_quiet_talker():
    quiet = speech_like(3.0, seed=15, amplitude=0.01)
    plain, _ = clean(quiet, auto_gain=False)
    lifted, _ = clean(quiet, auto_gain=True)
    assert db_rms(lifted) > db_rms(plain) + 6
    assert np.max(np.abs(lifted)) <= 1.0


def test_long_and_short_inputs_agree_inside_the_reservoir():
    """The reservoir decimates; the same signal must clean the same either way."""
    audio = mix_at_snr(speech_like(6.0, seed=17), pink_noise(6.0, seed=18), 5.0)
    whole, _ = clean(audio)
    head, _ = clean(audio[: SR * 3])
    a = db_rms(whole[: SR * 3])
    b = db_rms(head)
    assert abs(a - b) < 4.0, f"level mismatch {a:.2f} vs {b:.2f} dB"


def test_stereo_shape_is_preserved():
    left = mix_at_snr(speech_like(2.0, seed=21), pink_noise(2.0, seed=22), 0.0)
    right = mix_at_snr(speech_like(2.0, seed=23), pink_noise(2.0, seed=24), 0.0)
    stereo = np.stack([left, right], axis=1)
    out = SpectralDenoiser(SR).denoise_channels(stereo)
    assert out.shape == stereo.shape
    assert np.all(np.isfinite(out))
