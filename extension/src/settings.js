/**
 * Shared settings model for Noise Simplifier.
 *
 * Imported by the popup, the offscreen capture document, the background
 * service worker and the DSP engine, so there is exactly one definition of
 * what a "setting" is.
 */

export const MODES = ['rnnoise', 'spectral', 'hybrid'];

export const MODE_INFO = {
  rnnoise: {
    label: 'RNNoise (fastest)',
    hint: 'Xiph RNNoise neural net. Great on fans, hiss and hum, ~10 ms delay.',
  },
  spectral: {
    label: 'Spectral (most control)',
    hint: 'Built-in MMSE suppressor. Best on steady noise; strength slider is fully yours.',
  },
  hybrid: {
    label: 'Hybrid (most aggressive)',
    hint: 'RNNoise first, then the spectral stage on what is left. ~20 ms delay.',
  },
};

export const DEFAULT_SETTINGS = {
  mode: 'hybrid',
  strength: 0.75,
  voiceFocus: true,
  autoGain: false,
  bypass: false,
  highpassHz: 95,
  lowpassHz: 7600,
  presenceDb: 2.5,
  maxAttenuationDb: 26,
};

export const PRESETS = {
  balanced: { mode: 'hybrid', strength: 0.75, voiceFocus: true, autoGain: false, maxAttenuationDb: 26 },
  quietRoom: { mode: 'rnnoise', strength: 0.5, voiceFocus: true, autoGain: false, maxAttenuationDb: 18 },
  loudOffice: { mode: 'hybrid', strength: 1, voiceFocus: true, autoGain: true, maxAttenuationDb: 32 },
  softVoice: { mode: 'spectral', strength: 0.7, voiceFocus: true, autoGain: true, maxAttenuationDb: 24 },
};

/** Clamp/validate whatever came back from storage or a message. */
export function normalizeSettings(patch = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(patch || {}) };
  return {
    ...s,
    mode: MODES.includes(s.mode) ? s.mode : DEFAULT_SETTINGS.mode,
    strength: clamp(Number(s.strength), 0, 1, DEFAULT_SETTINGS.strength),
    maxAttenuationDb: clamp(Number(s.maxAttenuationDb), 6, 40, DEFAULT_SETTINGS.maxAttenuationDb),
    highpassHz: clamp(Number(s.highpassHz), 40, 300, DEFAULT_SETTINGS.highpassHz),
    lowpassHz: clamp(Number(s.lowpassHz), 3000, 12000, DEFAULT_SETTINGS.lowpassHz),
    presenceDb: clamp(Number(s.presenceDb), 0, 6, DEFAULT_SETTINGS.presenceDb),
    voiceFocus: !!s.voiceFocus,
    autoGain: !!s.autoGain,
    bypass: !!s.bypass,
  };
}

export function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** The strength slider drives the maximum attenuation of the spectral stage. */
export function strengthToAttenuation(strength) {
  const s = clamp(Number(strength), 0, 1, DEFAULT_SETTINGS.strength);
  return Math.round(12 + s * 24); // 12 dB (gentle) .. 36 dB (aggressive)
}

export function describeSettings(settings) {
  const s = normalizeSettings(settings);
  return `${MODE_INFO[s.mode].label} · strength ${Math.round(s.strength * 100)}%` +
    `${s.voiceFocus ? ' · voice focus' : ''}${s.autoGain ? ' · auto gain' : ''}`;
}
