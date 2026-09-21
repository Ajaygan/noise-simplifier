/**
 * AudioWorklet glue for Noise Simplifier.
 *
 * AudioWorklet global scope is a classic (non-module) context, so this file is
 * flattened into `extension/dist/denoise.worklet.js` by
 * `tools/build-worklets.mjs`, which inlines:
 *   src/dsp/spectral.js, src/dsp/engine.js, src/dsp/rnnoise-engine.js and the
 *   vendored RNNoise WASM module (tools/build-worklets.mjs).
 *
 * Edit the sources, never the generated file.
 */

/*
 * Emscripten environment shim — must run before the vendored RNNoise module.
 *
 * That build is compiled with `-sENVIRONMENT=web` and its entry point starts with:
 *
 *   if (!(typeof window == "object" || typeof WorkerGlobalScope < "u"))
 *     throw new Error("not compiled for this environment ...");
 *
 * Chrome's AudioWorkletGlobalScope is worker-like but exposes neither `window`
 * nor the `WorkerGlobalScope` constructor, so the feature test threw as soon as
 * the engine initialised ("Clean the tab" failed with exactly that message).
 * Nothing in the module needs the DOM: the WASM is embedded as base64, it
 * instantiates via `WebAssembly.instantiate` and never calls fetch/importScripts/
 * document. Publishing a stand-in global satisfies the feature test — nothing
 * reads `WorkerGlobalScope` for anything else (verified: one occurrence).
 */
if (typeof WorkerGlobalScope === 'undefined') {
  globalThis.WorkerGlobalScope = function WorkerGlobalScope() {};
}

/* BUILD:INCLUDE extension/src/settings.js */
/* BUILD:INCLUDE extension/src/dsp/spectral.js */
/* BUILD:INCLUDE extension/src/dsp/engine.js */
/* BUILD:INCLUDE extension/src/dsp/rnnoise-engine.js */
/* BUILD:INCLUDE extension/vendor/rnnoise.esm.js */

const MAX_CHANNELS = 2;

class NoiseSimplifierProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.engine = null;
    this.channels = Math.min(MAX_CHANNELS, Math.max(1, opts.channels || 1));
    this.settings = opts.settings || {};
    this.frameCounter = 0;
    this.meterInterval = Math.round(sampleRate / 30); // ~30 meter updates / s
    this.inPeak = 0;
    this.outPeak = 0;
    this.inAcc = 0;
    this.outAcc = 0;
    this.inSamples = 0;
    this.outSamples = 0;
    this.tempBuffers = [];
    this.stopped = false;
    this.lastReportedMode = null;
    this._initGen = 0;

    this._init(this.settings);

    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'settings') {
        // Mode changes may need to await the WASM module.
        this._init({ ...this.settings, ...msg.settings });
      } else if (msg.type === 'reset') {
        if (this.engine) this.engine.reset();
      } else if (msg.type === 'stop') {
        this.stopped = true;
      }
    };
  }

  async _init(settings) {
    const generation = ++this._initGen;
    const mode = settings.mode || 'hybrid';
    const needsEngine = !this.engine || this.engineSettings.mode !== mode ||
      this.engineSettings.sampleRate !== sampleRate;
    if (needsEngine) {
      const engine = new NoiseSimplifierEngine({ ...settings, sampleRate });
      try {
        await engine.init();
      } catch (err) {
        this.port.postMessage({ type: 'error', error: String(err && err.message || err) });
        return;
      }
      if (generation !== this._initGen) {
        // A newer settings message won the race; drop this engine.
        engine.destroy();
        return;
      }
      if (this.engine) this.engine.destroy();
      this.engine = engine;
      this.engineSettings = { mode, sampleRate };
    }
    this.settings = { ...this.settings, ...settings };
    if (this.engine) this.engine.setParams(this.settings);
    if (this.lastReportedMode !== this.settings.mode) {
      this.lastReportedMode = this.settings.mode;
      this.port.postMessage({ type: 'ready', mode: this.settings.mode, sampleRate });
    }
  }

  process(inputs, outputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outChannels = output.length;
    const inChannels = input ? input.length : 0;
    const frames = output[0].length;

    if (this.engine) {
      let peakIn = 0;
      let peakOut = 0;
      for (let c = 0; c < outChannels; c++) {
        // Mono capture feeds the same signal to both output channels.
        const src = input && input[Math.min(c, Math.max(0, inChannels - 1))];
        if (!this.tempBuffers[c] || this.tempBuffers[c].length !== frames) {
          this.tempBuffers[c] = new Float32Array(frames);
        }
        const tmp = this.tempBuffers[c];
        if (src) {
          tmp.set(src.length === frames ? src : src.subarray(0, Math.min(src.length, frames)));
          for (let i = 0; i < frames; i++) {
            const a = Math.abs(tmp[i]);
            if (a > peakIn) peakIn = a;
          }
        } else {
          tmp.fill(0);
        }
        this.engine.process(c, tmp, output[c]);
        for (let i = 0; i < frames; i++) {
          const a = Math.abs(output[c][i]);
          if (a > peakOut) peakOut = a;
        }
      }
      this.frameCounter += frames;
      this.inPeak = Math.max(peakIn, this.inPeak * 0.92);
      this.outPeak = Math.max(peakOut, this.outPeak * 0.92);
      this.inAcc += peakIn * peakIn;
      this.outAcc += peakOut * peakOut;
      this.inSamples++;
      this.outSamples++;
      if (this.frameCounter >= this.meterInterval) {
        this.frameCounter = 0;
        const metrics = this.engine.metrics();
        this.port.postMessage({
          type: 'meter',
          inputLevel: LINEAR_TO_DB(this.inPeak),
          outputLevel: LINEAR_TO_DB(this.outPeak),
          speechProbability: metrics.spectral ? metrics.spectral.speechProbability : null,
          vad: metrics.rnnoise ? metrics.rnnoise.vad : null,
          suppressionDb: metrics.spectral ? metrics.spectral.suppressionDb : 0,
          noiseFloorDb: metrics.spectral ? metrics.spectral.noiseFloorDb : null,
        });
      }
    } else {
      // Engine still loading: pass audio through so the user never gets silence.
      for (let c = 0; c < outChannels; c++) {
        const src = input && input[Math.min(c, Math.max(0, inChannels - 1))];
        if (src) output[c].set(src.length === frames ? src : src.subarray(0, frames));
        else output[c].fill(0);
      }
    }
    return true;
  }
}

function LINEAR_TO_DB(x) {
  return 20 * Math.log10(Math.max(x, 1e-7));
}

registerProcessor('noise-simplifier', NoiseSimplifierProcessor);
