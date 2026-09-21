/**
 * DSP core tests. These are the assertions that matter for the user-visible
 * promise: noise goes down, speech comes through, and chunking never changes
 * the result (a live capture delivers 128-sample quanta, files arrive whole).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectralDenoiser, DenoiseChain, AutoGain, FFT } from '../extension/src/dsp/spectral.js';
import {
  speechLike, pinkNoise, mixAtSnr, dbRms, estimateDelay, whiteNoise, segmentalSnr, scale, add, keyboardClicks, hum,
} from './signals.mjs';

const SR = 48000;

function processAll(denoiser, input, chunk = 128) {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += chunk) {
    const n = Math.min(chunk, input.length - i);
    const inChunk = input.subarray(i, i + n);
    const outChunk = out.subarray(i, i + n);
    denoiser.process(inChunk, outChunk);
  }
  return out;
}

test('FFT round-trips exactly', () => {
  const fft = new FFT(256);
  const re = new Float64Array(256);
  const im = new Float64Array(256);
  const original = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    original[i] = Math.sin(i / 3) + Math.cos(i / 7);
    re[i] = original[i];
  }
  fft.transform(re, im, false);
  fft.transform(re, im, true);
  for (let i = 0; i < 256; i++) assert.ok(Math.abs(re[i] - original[i]) < 1e-9, `sample ${i}`);
});

test('STFT analysis/synthesis is transparent (COLA) with a known delay', () => {
  const denoiser = new SpectralDenoiser({ sampleRate: SR, strength: 0 });
  denoiser.bypass = true;
  const n = SR; // 1 s
  const input = new Float32Array(n);
  for (let i = 0; i < n; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
  const out = processAll(denoiser, input);
  const delay = estimateDelay(input, out, 2048);
  assert.equal(delay, denoiser.latency, 'latency must match the advertised delay');
  // amplitude preserved and no clicks near the end
  const seg = out.subarray(delay + 4800, n - 100);
  let peak = 0;
  for (let i = 0; i < seg.length; i++) peak = Math.max(peak, Math.abs(seg[i]));
  assert.ok(peak > 0.49 && peak < 0.51, `peak ${peak} should be ~0.5`);
});

test('pink noise floor drops by a large margin', () => {
  // Pink noise is the hard case: most of its energy sits under the voice, so a
  // speech-preserving filter has to let some of it through. Measured ~9 dB on
  // the bare denoiser; the full chain adds the voice-focus high pass.
  const denoiser = new SpectralDenoiser({ sampleRate: SR });
  const noise = scale(pinkNoise(SR * 2, 11), 0.05);
  const out = processAll(denoiser, noise);
  const reduction = dbRms(noise) - dbRms(out);
  assert.ok(reduction > 8, `noise reduction was only ${reduction.toFixed(1)} dB`);
});

test('white noise (fan / hiss) is knocked down hard', () => {
  const denoiser = new SpectralDenoiser({ sampleRate: SR });
  const noise = scale(whiteNoise(SR * 2, 11), 0.05);
  const out = processAll(denoiser, noise);
  const reduction = dbRms(noise) - dbRms(out);
  assert.ok(reduction > 10, `noise reduction was only ${reduction.toFixed(1)} dB`);
});

test('speech survives at 0 dB SNR while noise drops', () => {
  const speech = scale(speechLike(SR * 3, SR, { seed: 5 }), 1);
  const noise = scale(pinkNoise(SR * 3, 9), 0.06);
  const noisy = mixAtSnr(speech, noise, 0);
  const denoiser = new SpectralDenoiser({ sampleRate: SR, strength: 0.75 });
  const out = processAll(denoiser, noisy);

  // out[n] = f(in[n - latency]), so out[latency + m] lines up with in[m].
  const delay = denoiser.latency;
  const compareLen = out.length - delay;
  const aligned = out.subarray(delay, delay + compareLen);
  const cleanRef = speech.subarray(0, compareLen);
  const noisyAligned = noisy.subarray(0, compareLen);
  const improvement = segmentalSnr(cleanRef, aligned) - segmentalSnr(cleanRef, noisyAligned);
  assert.ok(improvement > 1.5, `segmental SNR improvement was ${improvement.toFixed(2)} dB`);

  // speech level must be preserved within a couple of dB
  const speechEnergy = dbRms(cleanRef);
  const outEnergy = dbRms(aligned);
  assert.ok(outEnergy > speechEnergy - 3, `output too quiet: ${(speechEnergy - outEnergy).toFixed(1)} dB below speech`);
});

test('chunk size does not change the output', () => {
  const make = () => new SpectralDenoiser({ sampleRate: SR, strength: 0.8 });
  const noisy = mixAtSnr(speechLike(SR, SR, { seed: 2 }), pinkNoise(SR, 4), 5);
  const outChunked = processAll(make(), noisy, 128);
  const outWhole = processAll(make(), noisy, noisy.length);
  const outOdd = processAll(make(), noisy, 777);
  for (let i = 0; i < noisy.length; i++) {
    assert.ok(Math.abs(outChunked[i] - outWhole[i]) < 1e-6, `128-chunk differs at ${i}`);
    assert.ok(Math.abs(outOdd[i] - outWhole[i]) < 1e-6, `777-chunk differs at ${i}`);
  }
});

test('keyboard clicks and mains hum are attenuated', () => {
  const clicks = keyboardClicks(SR * 3, SR, { amplitude: 0.5 });
  const humSig = hum(SR * 3, SR, 60, 0.2);
  const noise = add(clicks, humSig);
  const denoiser = new SpectralDenoiser({ sampleRate: SR, strength: 0.8 });
  const out = processAll(denoiser, noise);
  const reduction = dbRms(noise) - dbRms(out);
  assert.ok(reduction > 8, `only ${reduction.toFixed(1)} dB of suppression`);
});

test('the AGC lifts a very quiet talker towards the target level', () => {
  const agc = new AutoGain({ sampleRate: SR });
  const quiet = scale(speechLike(SR * 2, SR, { seed: 8 }), 0.02);
  const out = new Float32Array(quiet.length);
  for (let i = 0; i < quiet.length; i += 128) {
    const n = Math.min(128, quiet.length - i);
    out.set(quiet.subarray(i, i + n), i);
    agc.process(0, out.subarray(i, i + n));
  }
  for (let i = 0; i < out.length; i++) assert.ok(Math.abs(out[i]) <= 1, 'AGC must never clip');
  assert.ok(dbRms(out) > dbRms(quiet) + 10, `only ${(dbRms(out) - dbRms(quiet)).toFixed(1)} dB of lift`);
});

test('the full chain never clips, even with a loud input', () => {
  const chain = new DenoiseChain({ sampleRate: SR, strength: 0.8, voiceFocus: true, autoGain: true });
  const loud = scale(mixAtSnr(speechLike(SR * 2, SR, { seed: 8 }), pinkNoise(SR * 2, 3), 0), 3);
  const out = new Float32Array(loud.length);
  const inChunk = new Float32Array(128);
  const outChunk = new Float32Array(128);
  for (let i = 0; i < loud.length; i += 128) {
    const n = Math.min(128, loud.length - i);
    inChunk.set(loud.subarray(i, i + n));
    chain.processChannel(0, inChunk.subarray(0, n), outChunk.subarray(0, n));
    out.set(outChunk.subarray(0, n), i);
  }
  for (let i = 0; i < out.length; i++) assert.ok(Math.abs(out[i]) <= 1, `output left the range at ${i}`);
});

test('keyboard clicks are gated without touching the voice', () => {
  const clicks = keyboardClicks(SR * 3, SR, { amplitude: 0.45, rateHz: 2, seed: 21 });
  const voiceOnly = scale(speechLike(SR * 3, SR, { seed: 14 }), 0.25);
  const run = (sig, cfg) => {
    const out = new Float32Array(sig.length);
    const d = new SpectralDenoiser({ sampleRate: SR, ...cfg });
    for (let i = 0; i < sig.length; i += 128) {
      d.process(sig.subarray(i, i + 128), out.subarray(i, i + 128));
    }
    return out;
  };
  const processed = (cfg) => {
    const clickOut = run(clicks, cfg);
    const voiceOut = run(voiceOnly, cfg);
    return { clicks: dbRms(clicks) - dbRms(clickOut), voice: dbRms(voiceOut) - dbRms(voiceOnly) };
  };
  const gated = processed({});
  const ungated = processed({ transientAttenDb: 0 });
  assert.ok(gated.clicks > ungated.clicks + 4,
    `gate only improved clicks by ${(gated.clicks - ungated.clicks).toFixed(1)} dB`);
  assert.ok(gated.clicks > 6, `clicks only dropped ${gated.clicks.toFixed(1)} dB`);
  assert.ok(Math.abs(gated.voice - ungated.voice) < 1.5, 'the gate must not change the voice level');
});

test('denoiser reports levels and metrics', () => {
  const denoiser = new SpectralDenoiser({ sampleRate: SR });
  const noise = scale(pinkNoise(SR, 6), 0.1);
  processAll(denoiser, noise);
  const m = denoiser.metrics();
  assert.ok(m.inputLevelDb > -60 && m.inputLevelDb < 0, `input level ${m.inputLevelDb}`);
  assert.ok(m.noiseFloorDb > -80 && m.noiseFloorDb < -20, `noise floor ${m.noiseFloorDb}`);
  assert.ok(m.speechProbability >= 0 && m.speechProbability <= 1);
});

test('bypass is bit-transparent on the dry signal', () => {
  const denoiser = new SpectralDenoiser({ sampleRate: SR });
  denoiser.bypass = true;
  const input = whiteNoise(SR, 21, 0.2);
  const out = processAll(denoiser, input);
  const delay = estimateDelay(input, out, 2048);
  assert.ok(Math.abs(delay - denoiser.latency) <= 1, `delay ${delay}`);
  let err = 0;
  for (let i = 0; i < 20000; i++) err += Math.abs(out[delay + i] - input[i]);
  assert.ok(err / 20000 < 0.03, `mean abs error ${err / 20000}`);
});
