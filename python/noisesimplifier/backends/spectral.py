"""Offline noise suppressor — the Python side of Noise Simplifier.

The extension does *real-time* denoising in an ``AudioWorklet``. This module is
the offline/batch counterpart, used for cleaning recordings (and available over
HTTP via :mod:`noisesimplifier.service`). Offline we do not have to be causal or
cheap, so the algorithm is stronger than the worklet's:

1. **Analysis** — STFT with a Hann window, 75 % overlap, and a bounded reservoir
   of power spectra (so a 30-minute file fits in a few megabytes).
2. **Noise estimate** — per-bin low percentile of the reservoir, times a bias
   that compensates for the percentile sitting below the noise mean. Speech is
   intermittent by nature, so the quiet percentile *is* the noise.
3. **Gain** — Wiener-style ``xi / (1 + xi)`` raised to a strength exponent,
   floored at ``max_attenuation_db``, smoothed across time and frequency so the
   residual noise stays natural instead of turning into musical tones.
4. **Voice focus** — speech-band band-pass plus a presence peak, designed with
   SciPy so long files filter at C speed.
5. **Auto gain** (optional) — rides the level towards a fixed target.

Settings mirror ``extension/src/settings.js`` one-for-one, so the popup JSON can
be handed to the service unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np
from scipy.signal import butter, sosfilt, tf2sos

EPS = 1e-12
SILENCE = 1e-7


@dataclass
class SpectralSettings:
    """Same keys the extension uses, plus offline-only knobs."""

    strength: float = 0.75
    voice_focus: bool = True
    auto_gain: bool = False
    highpass_hz: float = 95.0
    lowpass_hz: float = 7600.0
    presence_hz: float = 2600.0
    presence_db: float = 2.5
    max_attenuation_db: float = 26.0
    fft_size: int = 1024
    hop: int = 256
    #: starting percentile for the noise reservoir ("the quiet 5 %")
    noise_percentile: float = 5.0
    #: trailing average (frames) applied before the percentile is taken. Without
    #: it a single quiet periodogram frame in a *pure speech* bin still reads
    #: ~8 dB below the speech mean, and the estimate mistakes that for noise.
    noise_seed_smoothing: int = 9
    #: trim applied to the converged estimate (dB); negative = assume the
    #: estimate is a little hot, which protects speech
    noise_bias_db: float = 0.0
    #: how many times the presence-weighted mean is re-estimated
    noise_iterations: int = 3
    #: running-average width (bins) used to smooth the noise spectrum
    noise_smooth_bins: int = 5
    #: speech-absence prior in the Gerkmann-Hendriks presence formula
    presence_q: float = 0.2
    #: weight given to a frame = (1 - presence) ** this. 1.0 means "a frame that
    #: looks like speech contributes nothing", which is what stops speech from
    #: inflating the estimate; smaller values make the estimate more forgiving
    #: of always-on speech, larger values make it stricter
    noise_weight_power: float = 1.0
    #: never let a frame's weight drop to zero (keeps the mean well defined)
    noise_weight_floor: float = 0.0
    #: centred moving average (frames) over the periodogram before the gain is
    #: computed; only possible offline, and it is what lets the gains actually
    #: reach the attenuation floor without pumping (9 frames = 21 ms)
    power_smoothing: int = 9
    #: gain exponent - higher attacks the residual harder
    gain_exponent: float = 1.1
    #: Berouti-style over-subtraction on the noise estimate (>1 = deeper holes)
    over_subtraction: float = 1.3
    #: temporal gain smoothing (0 = none, 1 = frozen); keeps the residual natural
    gain_smoothing: float = 0.35
    #: how fast the gain may *rise* again (0 = instant). Speech onsets must not
    #: be swallowed while the gain is still down from the previous pause, so the
    #: attack has to be much faster than the release.
    gain_attack: float = 0.05
    #: frames the reservoir may hold
    reservoir_frames: int = 4096

    def to_json(self) -> dict:
        return asdict(self)

    @classmethod
    def from_json(cls, data: dict | None) -> "SpectralSettings":
        """Accepts the extension's settings JSON, ignoring unknown keys."""
        if not data:
            return cls()
        allowed = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in data.items() if k in allowed})


def _smooth_bins(values: np.ndarray, width: int) -> np.ndarray:
    """Moving average over frequency (edge-clamped), no SciPy needed."""
    if width <= 1 or values.size < 3:
        return values
    half = width // 2
    padded = np.pad(values, (half, half), mode="edge")
    acc = np.zeros_like(values)
    for i in range(width):
        acc += padded[i:i + values.size]
    return acc / width


def hann(n: int) -> np.ndarray:
    return 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n) / n)


# --------------------------------------------------------------------------- #
# voice focus
# --------------------------------------------------------------------------- #


def peaking_sos(sample_rate: float, freq: float, q: float, gain_db: float) -> np.ndarray:
    """RBJ peaking filter as a second-order section."""
    w0 = 2 * np.pi * min(freq, sample_rate * 0.45) / sample_rate
    cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / (2 * q)
    amp = 10 ** (gain_db / 40)
    b = [1 + alpha * amp, -2 * cw, 1 - alpha * amp]
    a = [1 + alpha / amp, -2 * cw, 1 - alpha / amp]
    b = np.asarray(b) / a[0]
    a = np.asarray(a) / a[0]
    return tf2sos(b, a)


class VoiceFocus:
    """Band-limits the signal to the speech band and lifts the presence range."""

    def __init__(self, sample_rate: float, settings: SpectralSettings) -> None:
        self.sample_rate = float(sample_rate)
        self.enabled = settings.voice_focus
        self.configure(settings)
        self.reset()

    def configure(self, settings: SpectralSettings) -> None:
        sr = self.sample_rate
        nyq = sr / 2.0
        self.sections = [
            butter(2, settings.highpass_hz / nyq, btype="highpass", output="sos"),
            peaking_sos(sr, settings.presence_hz, 0.9, settings.presence_db),
            butter(2, min(settings.lowpass_hz / nyq, 0.98), btype="lowpass", output="sos"),
        ]
        self.enabled = settings.voice_focus
        self.reset()

    def reset(self) -> None:
        self._zi = [np.zeros((s.shape[0], 2)) for s in self.sections]

    def process(self, x: np.ndarray) -> np.ndarray:
        if not self.enabled or x.size == 0:
            return x
        y = np.asarray(x, dtype=np.float64).reshape(-1)
        for i, sos in enumerate(self.sections):
            y, self._zi[i] = sosfilt(sos, y, zi=self._zi[i])
        return y


class AutoGain:
    """Slow RMS rider towards a fixed target level (frame based)."""

    def __init__(self, sample_rate: float, target_db: float = -20.0,
                 min_gain_db: float = -6.0, max_gain_db: float = 15.0, alpha: float = 0.35) -> None:
        self.sample_rate = sample_rate
        self.target_db = target_db
        self.min_gain_db = min_gain_db
        self.max_gain_db = max_gain_db
        self.alpha = alpha
        self.enabled = False
        self.last_gain_db = 0.0

    def reset(self) -> None:
        self.last_gain_db = 0.0

    def gains(self, frames: np.ndarray, frame_size: int) -> np.ndarray:
        """One gain per frame of a 2-D (frames, frame_size) view."""
        if not self.enabled or frames.size == 0:
            return np.ones(len(frames))
        rms = np.sqrt(np.mean(frames**2, axis=1) + EPS)
        level_db = 20 * np.log10(np.maximum(rms, 1e-9))
        desired = np.clip(self.target_db - level_db, self.min_gain_db, self.max_gain_db)
        gains = np.empty_like(desired)
        current = 0.0
        for i, target in enumerate(desired):
            # hold the last gain through silence, like the worklet's AGC
            current += (target - current) * (self.alpha if level_db[i] > -55 else 0.0)
            gains[i] = current
        self.last_gain_db = float(gains[-1]) if len(gains) else 0.0
        return 10 ** (gains / 20.0)


# --------------------------------------------------------------------------- #
# the denoiser
# --------------------------------------------------------------------------- #


class SpectralDenoiser:
    """Two-pass offline spectral subtractor (analysis, noise, gains, synthesis)."""

    def __init__(self, sample_rate: float = 48000, settings: SpectralSettings | None = None) -> None:
        self.sample_rate = float(sample_rate)
        self.settings = settings or SpectralSettings()
        self.voice_focus = VoiceFocus(self.sample_rate, self.settings)
        self.auto_gain = AutoGain(self.sample_rate)
        self.auto_gain.enabled = bool(self.settings.auto_gain)
        n_fft = max(256, int(self.settings.fft_size))
        self.n_fft = n_fft if n_fft % 4 == 0 else n_fft + (4 - n_fft % 4)
        self.hop = self.n_fft // 4
        self.bins = self.n_fft // 2 + 1
        self.window = hann(self.n_fft)
        # Hann analysis + Hann synthesis with 75 % overlap sums to 1.5
        self.cola = float(np.sum(self.window**2) / self.hop)
        self.latency = self.n_fft
        self.last_noise_floor_db = float("nan")
        self.last_suppression_db = float("nan")

    # -------------------------------------------------------------- analysis

    #: frames per chunk in the streaming passes over the file
    chunk_frames = 64

    def _padded_view(self, x: np.ndarray) -> np.ndarray:
        """Analysis frames (zero-padded at both ends) as a strided view.

        Built once per pass: the padded copy is O(signal) and the view is free,
        so neither pass ever rebuilds it per chunk.
        """
        padded = np.concatenate([np.zeros(self.n_fft), x, np.zeros(self.n_fft)])
        return np.lib.stride_tricks.sliding_window_view(padded, self.n_fft)[:: self.hop]

    def _spectra_of(self, view: np.ndarray) -> np.ndarray:
        return np.fft.rfft(view * self.window, axis=1)

    # --------------------------------------------------------------- pass 1

    def estimate_noise(self, x: np.ndarray) -> np.ndarray:
        """Per-bin noise power, estimated over the whole file (non-causal).

        Three steps, none of which the streaming browser engine can afford:

        1. The periodogram is low-passed over ~10 frames first. That matters: a
           single quiet periodogram frame in a purely *speech* bin still reads
           ~8 dB below the speech mean, so a percentile of the raw periodogram
           mistakes speech fluctuation for noise. After smoothing, a bin that is
           below the speech level is below it in the pauses, i.e. it is noise.
        2. A low percentile of that smoothed power seeds the estimate.
        3. A Gerkmann-Hendriks speech-presence probability then re-weights every
           frame - speech-like frames are down-weighted, noise-like frames are
           averaged in - and the weighted mean is iterated a few times. Because
           the seed is deliberately low, the estimate only ever grows towards the
           noise mean, which is the safe direction to be wrong in.
        """
        s = self.settings
        view = self._padded_view(x)
        total = view.shape[0]
        stride = max(1, total // max(1, int(s.reservoir_frames)))
        width = max(1, int(s.noise_seed_smoothing))
        chunks: list[np.ndarray] = []
        history = np.zeros((width - 1, self.bins))
        for start in range(0, total, self.chunk_frames):
            chunk = view[start:start + self.chunk_frames]
            raw = np.abs(self._spectra_of(chunk)) ** 2
            if width == 1:
                smoothed = raw
            else:
                stacked = np.concatenate([history, raw], axis=0)
                smoothed = np.zeros_like(raw)
                for k in range(width):  # trailing average ending at each frame
                    smoothed += stacked[k:k + raw.shape[0]]
                smoothed /= width
                history = stacked[-(width - 1):]
            picked = smoothed[(-start) % stride::stride]
            if picked.shape[0]:
                chunks.append(picked)
        power = np.concatenate(chunks, axis=0) if chunks else np.ones((1, self.bins))

        fraction = float(np.clip(s.noise_percentile, 0.5, 60.0)) / 100.0
        seed = np.percentile(power, fraction * 100.0, axis=0)

        q = max(float(s.presence_q), 1e-6)
        noise = seed
        for _ in range(max(1, int(s.noise_iterations))):
            xi = np.maximum(power / (noise + EPS) - 1.0, 0.0)
            presence = 1.0 / (1.0 + q * (1.0 + xi) * np.exp(-xi))
            # update rate: ~1 where the bin looks like speech (leave it alone),
            # low where it looks like noise (average it in)
            weight = np.power(np.clip(1.0 - presence, 0.0, 1.0),
                              max(0.01, float(s.noise_weight_power)))
            weight = np.maximum(weight, max(1e-6, float(s.noise_weight_floor)))
            noise = (weight * power).sum(axis=0) / weight.sum(axis=0)
            noise = _smooth_bins(noise, int(s.noise_smooth_bins))

        noise = noise * 10 ** (min(0.0, float(s.noise_bias_db)) / 10.0)
        # a very small floor keeps the gains finite on digital silence
        return np.maximum(noise, (SILENCE**2) * self.n_fft)

    # --------------------------------------------------------------- pass 2

    def _gains(self, power: np.ndarray, noise: np.ndarray, prev: np.ndarray | None) -> np.ndarray:
        """Wiener-style gains from a (smoothed) periodogram."""
        s = self.settings
        # over-subtraction: subtracting a little more than the estimated noise
        # keeps the residual from fluctuating back up to the noise level
        over = max(1.0, float(s.over_subtraction))
        xi = np.maximum(power / (over * noise + EPS) - 1.0, 0.0)
        wiener = xi / (1.0 + xi)
        gain = wiener ** max(0.1, float(s.gain_exponent))
        # strength scales how deep the suppression may go (same idea as the
        # extension's strengthToAttenuation), so lower = gentler, never inverted
        floor_db = -s.max_attenuation_db * max(0.0, min(1.0, s.strength))
        gain = np.maximum(gain, 10 ** (floor_db / 20.0))
        if self.bins > 2:
            smoothed = gain.copy()
            smoothed[:, 1:-1] = 0.25 * gain[:, :-2] + 0.5 * gain[:, 1:-1] + 0.25 * gain[:, 2:]
            gain = smoothed
        release = float(np.clip(s.gain_smoothing, 0.0, 0.99))
        attack = float(np.clip(s.gain_attack, 0.0, release))
        if gain.shape[0] and (release > 0 or attack > 0):
            # one-pole smoothing with a fast attack and a slow release, carried
            # across chunks so chunk boundaries are seamless
            previous = gain[0] if prev is None else prev
            for i in range(gain.shape[0]):
                target = gain[i]
                alpha = np.where(target > previous, attack, release)
                previous = alpha * previous + (1.0 - alpha) * target
                gain[i] = previous
        return gain

    def _build(self, x: np.ndarray, noise: np.ndarray) -> np.ndarray:
        """Gains + overlap-add synthesis, one chunk of frames at a time.

        The periodogram is smoothed with a *centred* moving average, which
        needs one chunk of lookahead: the previous chunk is therefore held back
        until the next one has been analysed. That is only possible offline,
        and it is what lets the gains reach the attenuation floor without the
        residual pumping up and down.
        """
        s = self.settings
        view = self._padded_view(x)
        total = view.shape[0]
        width = max(1, int(s.power_smoothing))
        half = width // 2
        span = total * self.hop + self.n_fft
        out = np.zeros(span)
        norm = np.zeros(span)
        window_sq = self.window**2
        auto = self.auto_gain.enabled
        prev_gain = None
        history: list[tuple[int, np.ndarray, np.ndarray]] = []

        def emit(start: int, spectra: np.ndarray, power: np.ndarray) -> None:
            nonlocal prev_gain
            gains = self._gains(power, noise, prev_gain)
            prev_gain = gains[-1].copy()
            block = np.fft.irfft(spectra * gains, n=self.n_fft, axis=1) * self.window
            if auto:
                block = block * self.auto_gain.gains(
                    view[start:start + block.shape[0]], self.n_fft)[:, None]
            for i in range(block.shape[0]):
                at = (start + i) * self.hop
                out[at:at + self.n_fft] += block[i]
                norm[at:at + self.n_fft] += window_sq

        def smoothed_power(index: int) -> np.ndarray:
            start, raw = history[index][0], history[index][1]
            if width <= 1:
                return raw
            pad = None
            if index == 0:
                pad = np.repeat(raw[:1], half, axis=0)
            before = history[index - 1][1][-half:] if index > 0 else pad
            if index + 1 < len(history):
                after = history[index + 1][1][:half]
            else:
                after = np.repeat(raw[-1:], half, axis=0)
            stacked = np.concatenate([before, raw, after], axis=0)
            acc = np.zeros_like(raw)
            for k in range(width):
                acc += stacked[k:k + raw.shape[0]]
            return acc / width

        for start in range(0, total, self.chunk_frames):
            chunk = view[start:start + self.chunk_frames]
            spectra = self._spectra_of(chunk)
            history.append((start, np.abs(spectra) ** 2, spectra))
            if len(history) > 3:
                history.pop(0)
            if len(history) < 2:
                continue  # keep one chunk of lookahead
            index = len(history) - 2
            cstart, _, cspectra = history[index]
            emit(cstart, cspectra, smoothed_power(index))

        if history:  # flush the last chunk
            cstart, _, cspectra = history[-1]
            emit(cstart, cspectra, history[-1][1])

        valid = norm > 1e-8
        out[valid] /= norm[valid]
        # Frame i covers output indices i*hop .. i*hop + n_fft, and frame 0 is
        # the front zero pad, so out[t] holds in[t - n_fft]. Dropping one window
        # makes input and output line up sample-for-sample.
        return out[self.n_fft:self.n_fft + x.size]

    # --------------------------------------------------------------- public

    def denoise(self, signal: np.ndarray) -> np.ndarray:
        """Clean one channel; returns audio of exactly the same length."""
        x = np.asarray(signal, dtype=np.float64).reshape(-1)
        if x.size == 0:
            return x.copy()
        noise = self.estimate_noise(x)
        # The periodogram of a windowed frame satisfies E[|X_k|^2] = sigma^2 *
        # sum(w^2) for zero-mean noise, so dividing by sum(w^2) turns the
        # estimate into a signal-domain power, i.e. a dBFS reading.
        window_energy = float(np.sum(self.window**2))
        self.last_noise_floor_db = float(10 * np.log10(np.mean(noise) / window_energy + EPS))
        y = self._build(x, noise)
        y = self.voice_focus.process(y)
        self.last_suppression_db = float(
            20 * np.log10((np.sqrt(np.mean(x**2)) + EPS) / (np.sqrt(np.mean(y**2)) + EPS))
        )
        return y

    def denoise_channels(self, signal: np.ndarray) -> np.ndarray:
        """Clean a (channels, samples) or (samples,) array, keeping the shape."""
        data = np.asarray(signal, dtype=np.float64)
        if data.ndim == 1:
            return self.denoise(data)
        return np.stack([self.denoise(ch) for ch in data])

    def metrics(self) -> dict:
        return {
            "noiseFloorDb": self.last_noise_floor_db,
            "suppressionDb": self.last_suppression_db,
            "fftSize": self.n_fft,
            "hop": self.hop,
        }
