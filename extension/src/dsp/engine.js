/**
 * NoiseSimplifierEngine — one façade over the three processing modes.
 *
 *  - `rnnoise`  : Xiph RNNoise (WASM). Cheapest, great on fans, hum and
 *                 broadband hiss. 480-sample (~10 ms) latency.
 *  - `spectral` : the built-in MMSE/decision-directed speech enhancer.
 *                 Fully adjustable strength, best on stationary noise.
 *  - `hybrid`   : RNNoise first (kills broadband noise), then the spectral
 *                 stage at reduced strength (cleans up what is left).
 *
 * The same class runs inside the extension's AudioWorklet and inside the
 * Node test-suite, so what the tests measure is what users hear.
 */

import { DenoiseChain } from './spectral.js';
import { RnnoiseEngine } from './rnnoise-engine.js';
import { DEFAULT_SETTINGS, MODES } from '../settings.js';

export { MODES, DEFAULT_SETTINGS };

export class NoiseSimplifierEngine {
  constructor(options = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...options };
    this.sampleRate = options.sampleRate ?? 48000;
    this.ready = false;
    this._rnnoise = null;
    this._spectral = null;
    this._temp = null;
    this.lastMetrics = {};
  }

  /** Loads the WASM module when the selected mode needs it. */
  async init() {
    if (this.settings.mode !== 'spectral' && !this._rnnoise) {
      this._rnnoise = await RnnoiseEngine.create({
        mix: rnnoiseMixForStrength(this.settings.strength),
        bypass: this.settings.bypass,
      });
    }
    if (this.settings.mode !== 'rnnoise' && !this._spectral) {
      this._spectral = new DenoiseChain({
        ...this.settings,
        sampleRate: this.sampleRate,
        strength: spectralStrengthFor(this.settings),
      });
    }
    this.ready = true;
    return this;
  }

  /** Switch processing mode at runtime (loads WASM if needed). */
  async setMode(mode) {
    if (!MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`);
    this.settings.mode = mode;
    return this.init();
  }

  setParams(patch = {}) {
    Object.assign(this.settings, patch);
    if (this._rnnoise) {
      this._rnnoise.setParams({
        mix: rnnoiseMixForStrength(this.settings.strength),
        bypass: this.settings.bypass,
      });
    }
    if (this._spectral) {
      this._spectral.setParams({
        ...patch,
        strength: spectralStrengthFor(this.settings),
        bypass: this.settings.bypass,
        voiceFocus: this.settings.voiceFocus,
        autoGain: this.settings.autoGain,
      });
    }
  }

  get latency() {
    const rnnoise = this.settings.mode === 'spectral' ? 0 : 480;
    const spectral = this.settings.mode === 'rnnoise' ? 0 : 512;
    return rnnoise + spectral;
  }

  /**
   * Process one channel. `input` and `output` are Float32Arrays of equal
   * length (they may alias). Any chunk size is accepted.
   */
  process(channel, input, output) {
    const mode = this.settings.mode;

    // Bypass is handled *inside* each stage rather than by short-circuiting,
    // so A/B comparison keeps the same delay and never clicks when toggled.
    if (mode === 'rnnoise') {
      this._rnnoise.process(channel, input, output);
      return output;
    }

    if (mode === 'spectral') {
      this._spectral.processChannel(channel, input, output);
      return output;
    }

    // hybrid: RNNoise -> spectral
    const n = input.length;
    if (!this._temp || this._temp.length !== n) this._temp = new Float32Array(n);
    this._rnnoise.process(channel, input, this._temp);
    this._spectral.processChannel(channel, this._temp, output);
    return output;
  }

  metrics() {
    return {
      mode: this.settings.mode,
      rnnoise: this._rnnoise ? this._rnnoise.metrics() : null,
      spectral: this._spectral ? this._spectral.metrics() : null,
    };
  }

  reset() {
    if (this._rnnoise) this._rnnoise.reset();
    if (this._spectral) this._spectral.reset();
  }

  /** Release WASM memory (call when a capture session ends). */
  destroy() {
    if (this._rnnoise) this._rnnoise.destroy();
    this._rnnoise = null;
    this._spectral = null;
    this.ready = false;
  }
}

/** RNNoise has no strength control, so we blend it with the dry signal. */
export function rnnoiseMixForStrength(strength) {
  const s = Math.min(1, Math.max(0, strength));
  if (s <= 0.1) return 0;
  return Math.min(1, (s - 0.1) / 0.6);
}

/** In hybrid mode the spectral stage only cleans the leftovers. */
export function spectralStrengthFor(settings) {
  const strength = Math.min(1, Math.max(0, settings.strength ?? 0.75));
  return settings.mode === 'hybrid' ? strength * 0.55 : strength;
}
