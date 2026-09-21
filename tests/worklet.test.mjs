/**
 * Exercises the *generated* AudioWorklet bundle (`extension/dist/denoise.worklet.js`)
 * — the exact artifact Chrome loads — inside a spec-shaped worklet scope.
 *
 * These tests cover the paths the DSP unit tests cannot: the classic-script
 * build, the RNNoise WASM module inside that script, mode switching, metering
 * and bypass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorklet, render } from './worklet-harness.mjs';
import { whiteNoise, pinkNoise, scale, dbRms, speechLike } from './signals.mjs';

const SR = 48000;
const bundle = loadWorklet({ sampleRate: SR });

test('the built worklet registers a processor and loads RNNoise', async () => {
  assert.ok(bundle.registry.has('noise-simplifier'), 'processor was not registered');
  const proc = await bundle.create({ settings: { mode: 'rnnoise' } });
  assert.ok(proc.engine, 'engine did not finish loading');
  assert.equal(bundle.context.sampleRate, SR);
});

test('RNNoise mode suppresses broadband noise in the worklet', async () => {
  const proc = await bundle.create({ settings: { mode: 'rnnoise', strength: 1, voiceFocus: false, autoGain: false } });
  const noise = scale(whiteNoise(SR, 5), 0.08);
  const out = render(proc, noise);
  const reduction = dbRms(noise) - dbRms(out);
  assert.ok(reduction > 10, `RNNoise only removed ${reduction.toFixed(1)} dB`);
  proc.port.send({ type: 'stop' });
});

test('bypass mode is a clean, sample-exact delay line', async () => {
  const alignError = (out, input, delay) => {
    let err = 0;
    const n = Math.min(20000, input.length - delay - 1);
    for (let i = 0; i < n; i++) err += Math.abs(out[delay + i] - input[i]);
    return err / n;
  };

  for (const mode of ['rnnoise', 'spectral', 'hybrid']) {
    const proc = await bundle.create({ settings: { mode, bypass: true } });
    const input = speechLike(SR, SR, { seed: 3 });
    const out = render(proc, input);
    const expected = proc.engine.latency;

    // The latency the engine advertises must be the best alignment, and at that
    // alignment the signal must come back essentially untouched.
    let best = expected;
    let bestErr = Infinity;
    for (let d = Math.max(0, expected - 16); d <= expected + 16; d++) {
      const err = alignError(out, input, d);
      if (err < bestErr) { bestErr = err; best = d; }
    }
    assert.equal(best, expected, `${mode}: best alignment ${best}, advertised latency ${expected}`);
    assert.ok(bestErr < 1e-3, `${mode}: bypass altered the signal (mean abs error ${bestErr})`);
    proc.port.send({ type: 'stop' });
  }
});

test('spectral and hybrid modes produce finite, in-range audio', async () => {
  for (const mode of ['spectral', 'hybrid']) {
    const proc = await bundle.create({ settings: { mode, strength: 0.8, voiceFocus: true, autoGain: true } });
    const noisy = scale(pinkNoise(SR, 8), 0.25);
    const out = render(proc, noisy);
    for (let i = 0; i < out.length; i++) {
      assert.ok(Number.isFinite(out[i]), `${mode}: non-finite sample at ${i}`);
      assert.ok(Math.abs(out[i]) <= 1, `${mode}: sample out of range at ${i}`);
    }
    proc.port.send({ type: 'stop' });
  }
});

test('changing mode at runtime re-initialises the engine', async () => {
  const proc = await bundle.create({ settings: { mode: 'spectral' } });
  assert.equal(proc.engine.settings.mode, 'spectral');
  proc.port.send({ type: 'settings', settings: { mode: 'rnnoise' } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(proc.engine.settings.mode, 'rnnoise');
  const noise = scale(whiteNoise(SR / 2, 12), 0.1);
  const out = render(proc, noise);
  assert.ok(dbRms(noise) - dbRms(out) > 8, 'RNNoise should still suppress after switching');
});

test('the worklet reports meters and readiness over its port', async () => {
  const proc = await bundle.create({ settings: { mode: 'rnnoise' } });
  render(proc, scale(whiteNoise(SR / 2, 3), 0.1));
  const meters = proc.port.take('meter');
  assert.ok(meters.length > 0, 'no meter messages were posted');
  const ready = proc.port.take('ready');
  assert.ok(ready.length > 0, 'no ready message was posted');
  assert.equal(ready[0].mode, 'rnnoise');
});
