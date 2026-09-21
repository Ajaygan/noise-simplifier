/**
 * Objective quality harness for the speech enhancer.
 *
 * Measures, for a given parameter set:
 *   - noiseReduction: how far the noise floor drops on noise-only input (dB)
 *   - segSnrGain:      segmental SNR improvement at a given input SNR (dB)
 *   - speechDist:      level change of the speech component (dB, 0 = perfect)
 *   - clickReduction:  suppression of keyboard clicks mixed under speech (dB)
 *
 * Used by `node tools/tune.mjs` and by the regression tests.
 */

import { SpectralDenoiser } from '../extension/src/dsp/spectral.js';
import {
  speechLike, pinkNoise, whiteNoise, mixAtSnr, dbRms, scale, add, keyboardClicks, segmentalSnr, hum,
} from '../tests/signals.mjs';

export const SR = 48000;

export function processAll(denoiser, input, chunk = 128) {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += chunk) {
    const n = Math.min(chunk, input.length - i);
    denoiser.process(input.subarray(i, i + n), out.subarray(i, i + n));
  }
  return out;
}

/** Level (dB) of the output over the frames where the reference is active. */
function activeLevelDb(reference, test, activeThresholdDb = -50) {
  const frame = 256;
  let sum = 0;
  let count = 0;
  for (let start = 0; start + frame <= reference.length; start += frame) {
    let rp = 0;
    let tp = 0;
    for (let i = 0; i < frame; i++) {
      rp += reference[start + i] * reference[start + i];
      tp += test[start + i] * test[start + i];
    }
    if (10 * Math.log10(rp / frame + 1e-20) > activeThresholdDb) {
      sum += tp;
      count++;
    }
  }
  return 10 * Math.log10(sum / Math.max(1, count * frame) + 1e-20);
}

export function evaluate(config = {}, { seconds = 4, snrDb = 0, seed = 5, noiseType = 'pink' } = {}) {
  const n = Math.round(SR * seconds);
  const speech = speechLike(n, SR, { seed });
  const pink = noiseType === 'white' ? whiteNoise(n, seed + 4) : pinkNoise(n, seed + 4);
  const delay = (config.fftSize ?? 512);

  // 1. stationary noise only
  const noiseOnly = scale(noiseType === 'white' ? whiteNoise(n, 42) : pinkNoise(n, 42), 0.05);
  const noiseOut = processAll(new SpectralDenoiser({ sampleRate: SR, ...config }), noiseOnly);
  const noiseReduction = dbRms(noiseOnly) - dbRms(noiseOut);
  const noiseFloorOut = dbRms(noiseOut.subarray(delay, noiseOut.length));

  // 2. speech + noise at the target SNR
  const noisy = mixAtSnr(speech, pink, snrDb);
  // out[n] = f(in[n - delay]), so out[delay + m] lines up with in[m].
  const cleanOut = processAll(new SpectralDenoiser({ sampleRate: SR, ...config }), noisy);
  const compareLen = cleanOut.length - delay;
  const alignedOut = cleanOut.subarray(delay, delay + compareLen);
  const noisyAligned = noisy.subarray(0, compareLen);
  const speechRef = speech.subarray(0, compareLen);
  const segIn = segmentalSnr(speechRef, noisyAligned);
  const segOut = segmentalSnr(speechRef, alignedOut);
  const speechDist = activeLevelDb(speechRef, alignedOut) - activeLevelDb(speechRef, speechRef);

  // 3. keyboard clicks under a quiet talker
  const voice = scale(speechLike(n, SR, { seed: seed + 9 }), 0.25);
  const withClicks = add(voice, keyboardClicks(n, SR, { amplitude: 0.45 }), hum(n, SR, 60, 0.05));
  const clickOut = processAll(new SpectralDenoiser({ sampleRate: SR, ...config }), withClicks);
  const clickReduction = dbRms(withClicks) - dbRms(clickOut);

  return {
    noiseReduction,
    noiseFloorOut,
    segSnrGain: segOut - segIn,
    speechDist,
    clickReduction,
  };
}

export function formatResult(name, r) {
  return [
    name.padEnd(28),
    `noise ${r.noiseReduction.toFixed(1).padStart(5)} dB`,
    `segSNR ${r.segSnrGain.toFixed(2).padStart(6)} dB`,
    `speech ${r.speechDist.toFixed(1).padStart(5)} dB`,
    `clicks ${r.clickReduction.toFixed(1).padStart(5)} dB`,
    `floor ${r.noiseFloorOut.toFixed(1).padStart(6)} dBFS`,
  ].join('  ');
}
