/**
 * RNNoise (WASM) engine wrapper.
 *
 * RNNoise is a small recurrent network trained to suppress non-speech
 * background noise. It is very cheap (< 1 % of one core) and works on
 * 480-sample frames at 48 kHz, with samples scaled to int16 range.
 *
 * This wrapper adds everything needed for live meeting audio:
 *   - arbitrary chunk sizes (the AudioWorklet feeds 128-sample quanta),
 *   - a sample-exact 480-sample delay line so the stream stays in sync,
 *   - wet/dry mixing for live A/B comparison,
 *   - the model's own voice-activity output, exposed as `lastVad`.
 */

import { Rnnoise } from '../../vendor/rnnoise.esm.js';

export const RNNOISE_FRAME = 480;
const INT16_SCALE = 32768;

/**
 * Ring length for the wet/dry delay lines. 2 x frameSize (960) is *not* a
 * power of two, so a `& mask` wrap would silently alias reads onto freshly
 * written samples; round up to the next power of two instead. Any ring longer
 * than one frame works, because a read at time t can only collide with the
 * write from t - frameSize or older.
 */
const RING = 1 << Math.ceil(Math.log2(2 * RNNOISE_FRAME));
const RING_MASK = RING - 1;

export class RnnoiseEngine {
  /** Load the WASM module once; reuse the instance for many engines. */
  static async loadModule() {
    if (!RnnoiseEngine._modulePromise) {
      RnnoiseEngine._modulePromise = Rnnoise.load();
    }
    return RnnoiseEngine._modulePromise;
  }

  static async create(options = {}) {
    const module = await RnnoiseEngine.loadModule();
    return new RnnoiseEngine(module, options);
  }

  constructor(module, options = {}) {
    this.module = module;
    this.frameSize = RNNOISE_FRAME;
    this.mix = options.mix ?? 1; // 1 = fully denoised
    this.bypass = options.bypass === true;
    this.channels = [];
    this.lastVad = 0;
    this.framesProcessed = 0;
  }

  setParams(patch = {}) {
    if (patch.mix !== undefined) this.mix = Math.min(1, Math.max(0, patch.mix));
    if (patch.bypass !== undefined) this.bypass = !!patch.bypass;
  }

  _channel(index) {
    while (this.channels.length <= index) {
      const N = this.frameSize;
      this.channels.push({
        state: this.module.createDenoiseState(),
        input: new Float32Array(N),
        fill: 0,
        // Delay lines (2 x frameSize) hold one produced frame ahead of the
        // read cursor, giving an exact, integer frameSize delay.
        wet: new Float32Array(RING),
        dry: new Float32Array(RING),
        pos: 0,
      });
    }
    return this.channels[index];
  }

  /** Streaming process of one channel; `input`/`output` may alias. */
  process(channel, input, output) {
    const ch = this._channel(channel);
    const N = this.frameSize;
    const mask = RING_MASK;
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      // out[m] must hold in[m - N], so the dry sample at time pos is written
      // to index pos + N and read back N samples later.
      ch.dry[(ch.pos + N) & mask] = x;
      ch.input[ch.fill] = x * INT16_SCALE;
      ch.fill++;
      if (ch.fill === N) {
        ch.fill = 0;
        const vad = ch.state.processFrame(ch.input);
        this.lastVad = vad;
        this.framesProcessed++;
        for (let k = 0; k < N; k++) {
          ch.wet[(ch.pos + 1 + k) & mask] = ch.input[k] / INT16_SCALE;
        }
      }
      // Both delay lines are prefilled with silence, so dry and wet stay
      // phase aligned behind a fixed, integer `frameSize` delay.
      const wet = ch.wet[ch.pos & mask];
      const dry = ch.dry[ch.pos & mask];
      ch.pos++;
      const mixed = this.mix >= 1 ? wet : dry * (1 - this.mix) + wet * this.mix;
      output[i] = this.bypass ? dry : mixed;
    }
    return input.length;
  }

  reset() {
    for (const ch of this.channels) {
      ch.state.destroy();
    }
    this.channels = [];
    this.lastVad = 0;
    this.framesProcessed = 0;
  }

  destroy() {
    this.reset();
  }

  metrics() {
    return { vad: this.lastVad, frames: this.framesProcessed };
  }
}
