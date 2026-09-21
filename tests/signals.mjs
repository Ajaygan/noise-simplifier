/**
 * Deterministic test signals and objective metrics shared by the Node tests
 * and the benchmark tooling. Everything is seeded, so results are reproducible
 * and the assertions can be tight.
 */

/** Small, fast, seedable PRNG (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function whiteNoise(n, seed = 1, amplitude = 1) {
  const rand = rng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rand() * 2 - 1) * amplitude;
  return out;
}

/** Pink-ish noise (fan / HVAC / room tone) via a few one-pole filters. */
export function pinkNoise(n, seed = 1, amplitude = 1, warmup = 48000) {
  // Warm the filters up first so the signal is stationary from sample 0
  // (otherwise the first frames are much quieter than the rest).
  const total = n + warmup;
  const white = whiteNoise(total, seed, 1);
  const out = new Float32Array(n);
  let b0 = 0; let b1 = 0; let b2 = 0;
  for (let i = 0; i < total; i++) {
    const w = white[i];
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    const v = (b0 + b1 + b2 + w * 0.1848) * 0.19 * amplitude;
    if (i >= warmup) out[i - warmup] = v;
  }
  return out;
}

/** Sum of harmonics at `freq` — models mains hum and its overtones. */
export function hum(n, sampleRate, freq = 60, amplitude = 0.2) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    out[i] = amplitude * (
      Math.sin(2 * Math.PI * freq * t) +
      0.5 * Math.sin(2 * Math.PI * 2 * freq * t) +
      0.25 * Math.sin(2 * Math.PI * 3 * freq * t)
    ) / 1.75;
  }
  return out;
}

/** Short transients, like typing on a mechanical keyboard. */
export function keyboardClicks(n, sampleRate, { seed = 7, rateHz = 3, amplitude = 0.5 } = {}) {
  const rand = rng(seed);
  const out = new Float32Array(n);
  const gap = Math.round(sampleRate / rateHz);
  for (let start = Math.round(gap * 0.5); start < n; start += Math.round(gap * (0.5 + rand()))) {
    const len = Math.round(sampleRate * 0.012);
    for (let i = 0; i < len && start + i < n; i++) {
      const env = Math.exp(-i / (sampleRate * 0.0018));
      out[start + i] += (rand() * 2 - 1) * env * amplitude;
    }
  }
  return out;
}

/**
 * Speech-like probe signal: a voiced source (harmonic stack with jitter) shaped
 * by three formants, gated into syllables with pauses. Not human speech, but it
 * has the same time-frequency structure the denoisers must preserve.
 */
export function speechLike(n, sampleRate, { seed = 3, f0 = 130, amplitude = 0.35 } = {}) {
  const rand = rng(seed);
  const out = new Float32Array(n);
  const formants = [
    { f: 620, bw: 90, g: 1.0 },
    { f: 1180, bw: 120, g: 0.6 },
    { f: 2600, bw: 180, g: 0.35 },
  ];
  // two-pole resonators for the formants
  const states = formants.map(() => ({ y1: 0, y2: 0 }));
  const coeffs = formants.map((fm) => {
    const r = Math.exp((-Math.PI * fm.bw) / sampleRate);
    const theta = (2 * Math.PI * fm.f) / sampleRate;
    return { a1: -2 * r * Math.cos(theta), a2: r * r, g: fm.g * (1 - r) };
  });
  let phase = 0;
  let syllable = 0;
  let syllableLen = Math.round(sampleRate * (0.18 + rand() * 0.12));
  let silence = false;
  for (let i = 0; i < n; i++) {
    if (i % syllableLen === 0) {
      syllable += 1;
      silence = rand() < 0.28;
      syllableLen = Math.round(sampleRate * (silence ? 0.12 + rand() * 0.12 : 0.16 + rand() * 0.14));
    }
    const env = silence ? 0 : 0.5 - 0.5 * Math.cos((2 * Math.PI * (i % syllableLen)) / syllableLen);
    const jitter = 1 + (rand() - 0.5) * 0.01;
    const f0i = f0 * (1 + 0.03 * Math.sin((2 * Math.PI * i) / (sampleRate * 0.35))) * jitter;
    phase += (2 * Math.PI * f0i) / sampleRate;
    let source = 0;
    for (let h = 1; h <= 30; h++) {
      const hf = h * f0i;
      if (hf > sampleRate / 2 - 500) break;
      source += Math.sin(phase * h) / h;
    }
    source *= 0.6;
    let shaped = 0;
    for (let k = 0; k < coeffs.length; k++) {
      const c = coeffs[k];
      const s = states[k];
      const y = c.g * source - c.a1 * s.y1 - c.a2 * s.y2;
      s.y2 = s.y1;
      s.y1 = y;
      shaped += y;
    }
    out[i] = shaped * env * amplitude * 3;
  }
  return out;
}

export function add(...signals) {
  const n = Math.max(...signals.map((s) => s.length));
  const out = new Float32Array(n);
  for (const sig of signals) {
    for (let i = 0; i < sig.length; i++) out[i] += sig[i];
  }
  return out;
}

export function scale(sig, factor) {
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) out[i] = sig[i] * factor;
  return out;
}

/** Scale `noise` so that mixed signal hits the requested SNR in dB. */
export function mixAtSnr(speech, noise, snrDb) {
  const ps = power(speech);
  const pn = power(noise);
  const target = ps / Math.pow(10, snrDb / 10);
  const gain = Math.sqrt(target / Math.max(pn, 1e-20));
  return add(speech, scale(noise, gain));
}

export function power(sig) {
  let sum = 0;
  for (let i = 0; i < sig.length; i++) sum += sig[i] * sig[i];
  return sum / Math.max(1, sig.length);
}

export function dbRms(sig) {
  return 10 * Math.log10(power(sig) + 1e-20);
}

/** Segmental SNR in dB: energy-weighted average of per-frame SNRs. */
export function segmentalSnr(reference, test, { frame = 512, hop = 256, floor = -10, ceil = 35 } = {}) {
  const n = Math.min(reference.length, test.length);
  let total = 0;
  let frames = 0;
  for (let start = 0; start + frame <= n; start += hop) {
    let ps = 0;
    let pe = 0;
    for (let i = 0; i < frame; i++) {
      const r = reference[start + i];
      const d = test[start + i] - r;
      ps += r * r;
      pe += d * d;
    }
    if (ps < 1e-10) continue;
    const snr = 10 * Math.log10(ps / (pe + 1e-20));
    total += Math.min(ceil, Math.max(floor, snr));
    frames += 1;
  }
  return frames ? total / frames : 0;
}

/** Best-matching delay of `test` relative to `reference` (in samples). */
export function estimateDelay(reference, test, maxLag = 4096) {
  const n = Math.min(reference.length, test.length);
  const window = Math.min(n, 24000);
  const limit = Math.min(maxLag, n - window);
  const score = (lag, step) => {
    let dot = 0;
    for (let i = 0; i < window; i += step) dot += reference[i] * test[lag + i];
    return dot;
  };
  let best = 0;
  let bestScore = -Infinity;
  for (let lag = 0; lag <= limit; lag += 8) {
    const s = score(lag, 8);
    if (s > bestScore) { bestScore = s; best = lag; }
  }
  let refined = best;
  let refinedScore = score(best, 1);
  for (let lag = Math.max(0, best - 8); lag <= Math.min(limit, best + 8); lag += 1) {
    const s = score(lag, 1);
    if (s > refinedScore) { refinedScore = s; refined = lag; }
  }
  return refined;
}

/** Noise-only frames attenuation: how much the noise floor dropped (dB). */
export function noiseFloorDropDb(noisyNoiseOnly, denoisedNoiseOnly) {
  return dbRms(noisyNoiseOnly) - dbRms(denoisedNoiseOnly);
}
