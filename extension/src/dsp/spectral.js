/**
 * Noise Simplifier — real-time speech enhancer DSP core.
 *
 * Deliberately dependency-free, environment-free JavaScript (no DOM, no Node,
 * no `window`): the exact same source powers
 *   - the AudioWorklet running inside the extension (real time, 48 kHz),
 *   - the in-browser demo served by the Python backend,
 *   - the Node test-suite.
 *
 * Algorithm (compact MMSE-style speech enhancer tuned for meeting audio):
 *   1. STFT, 75 % overlap, Hann analysis + synthesis windows (COLA exact).
 *   2. Per-bin noise-floor tracking with asymmetric smoothing
 *      (fast on pauses, slow while speech is present).
 *   3. Decision-directed a-priori SNR + Wiener gain with over-subtraction,
 *      a spectral floor (no musical-noise "bubbling") and gain smoothing
 *      across time and frequency.
 *   4. Optional voice-focus band shaping, slow AGC and a safety limiter.
 */

/* ------------------------------------------------------------------ *
 * Maths helpers
 * ------------------------------------------------------------------ */

export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

export function gainToDb(gain) {
  return 20 * Math.log10(Math.max(gain, 1e-12));
}

export function rmsDb(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return 10 * Math.log10(sum / Math.max(1, buf.length) + 1e-20);
}

/** In-place iterative radix-2 complex FFT. */
export class FFT {
  constructor(size) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.size = size;
    this.levels = Math.log2(size) | 0;
    this.cosTable = new Float64Array(size / 2);
    this.sinTable = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let j = 0; j < this.levels; j++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
  }

  transform(re, im, inverse = false) {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const step = n / len;
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const tw = k * step;
          const wr = this.cosTable[tw];
          const wi = inverse ? this.sinTable[tw] : -this.sinTable[tw];
          const a = i + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }
}

/** Periodic Hann window (COLA-friendly at 75 % overlap). */
export function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  return w;
}

/* ------------------------------------------------------------------ *
 * Spectral denoiser (streaming)
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  fftSize: 512,
  sampleRate: 48000,
  /** 0 = gentle, 1 = aggressive suppression. */
  strength: 0.75,
  /** Never attenuate a bin by more than this (dB) — keeps speech natural. */
  maxAttenuationDb: 26,
  /** Extra over-subtraction applied to the noise estimate (dB). */
  overSubtractionDb: 0,
  /** While a bin sits this far above the tracked floor it is speech-like and
   *  the floor is frozen, so a talker cannot drag the estimate up. */
  leakFreezeDb: 6,
  /** Voice-activity gate depth; 0 disables it. */
  gateThresholdDb: 4,
  /** First-order smoothing of the periodogram used for decisions. */
  spectralSmoothing: 0.8,
  /** Upward leak of the safety minimum per frame (1.004 ~ 1.5 dB/s). */
  minLeak: 1.004,
  /** Noise-power smoothing used while a bin is judged speech-free. */
  noiseUpdateAlpha: 0.85,
  /** Falling rate: when the power drops below the estimate (a pause) the
   *  estimate follows quickly, so a bad start corrects within a syllable. */
  noiseFallAlpha: 0.5,
  /** Bias applied to the tracked noise power. Fast-falling estimators sit a
   *  little below the true mean of a fluctuating periodogram. */
  noiseBias: 1,
  /** A-priori probability that a bin contains noise (0.5 = maximally unsure);
   *  0.2 assumes speech is usually present, which freezes the floor sooner. */
  speechPresenceQ: 0.2,
  /** Safety net: the tracked noise mean may never exceed this multiple of the
   *  running minimum, so a talker cannot walk the estimate away. The running
   *  minimum sits deep below the mean for peaky spectra, hence the loose 16 dB. */
  minGuardFactor: 200,
  /** Frames used to seed the noise floor (min over ~130 ms at 48 kHz). */
  warmupFrames: 30,
  /** Transient (keyboard click / pen tap) gate: a sudden broadband jump over
   *  the slow energy average. Clicks are spectrally flat, the voice is not. */
  transientThresholdDb: 1.5,
  transientAttenDb: 18,
  transientHoldFrames: 8,
  /** Flatness measured above this frequency decides "click, not voice". */
  transientBandHz: 1000,
  transientFlatness: 0.35,
  /** Decision-directed prior-SNR smoothing. */
  priorSmoothing: 0.94,
  /** Gain smoothing across time and frequency. Frequency smoothing must stay
   *  light: speech harmonics are only a bin or two wide at 48 kHz and heavy
   *  cross-bin smoothing would pull the noise floor into them. */
  timeSmoothing: 0.6,
  freqSmoothing: 0.12,
};

export class SpectralDenoiser {
  constructor(options = {}) {
    const o = { ...DEFAULTS, ...options };
    this.params = { ...o };

    this.fftSize = o.fftSize;
    this.hop = o.fftSize / 4;
    this.sampleRate = o.sampleRate;
    this.bins = this.fftSize / 2 + 1;
    /** Input-to-output delay in samples. */
    this.latency = this.fftSize;

    this._mask = this.fftSize - 1;
    this._win = hannWindow(this.fftSize);
    this._fft = new FFT(this.fftSize);

    this._re = new Float64Array(this.fftSize);
    this._im = new Float64Array(this.fftSize);
    this._analysis = new Float32Array(this.fftSize);
    this._ring = new Float32Array(this.fftSize);
    this._ola = new Float32Array(this.fftSize);
    this._fifo = new Float32Array(2 * this.fftSize);
    this._fill = 0;
    this._ringPos = 0;
    // Output delay line. Per frame we produce the next `hop` samples of the
    // output timeline *ahead* of real time, so they are written at
    // (pos + 1 .. pos + hop) and read back at `pos` - a fixed delay of
    // `fftSize` samples. Capacity 2 x fftSize keeps writer and reader apart.
    this._fifoMask = 2 * this.fftSize - 1;
    this._pos = 0;

    this._power = new Float64Array(this.bins);
    this._smoothed = new Float64Array(this.bins);
    this._smoothedPrev = new Float64Array(this.bins);
    this._pmin = new Float64Array(this.bins);
    this._warmupSum = new Float64Array(this.bins);
    this._presence = new Float64Array(this.bins);
    this._noise = new Float64Array(this.bins);
    this._gainPrev = new Float64Array(this.bins);
    this._smoothGain = new Float64Array(this.bins);

    this._olaNorm = 2 / 3; // sum of hann^2 at 75 % overlap
    // Periodogram normalisation: with a Hann window, the average bin power of
    // a signal with mean-square P is ~ N * mean(w^2) * P, so dividing by that
    // makes levels readable in dBFS (and leaves every SNR ratio untouched).
    let winSq = 0;
    for (let i = 0; i < this.fftSize; i++) winSq += this._win[i] * this._win[i];
    this._winSq = winSq / this.fftSize;
    this._powerNorm = 1 / (this.fftSize * this._winSq);
    this._noiseInit = false;
    this.bypass = false;
    this._speechProb = 0;
    this._warmup = 0;
    this._slowPower = 0;
    this._transientHold = 0;
    this._transientFromBin = 0;
    this.lastTransient = false;

    this.lastSpeechProbability = 0;
    this.lastNoiseFloorDb = -90;
    this.lastInputLevelDb = -90;
    this.lastOutputLevelDb = -90;
    this.lastSuppressionDb = 0;
  }

  setParams(patch = {}) {
    Object.assign(this.params, patch);
  }

  reset() {
    this._ring.fill(0);
    this._ola.fill(0);
    this._fifo.fill(0);
    this._noise.fill(0);
    this._smoothed.fill(0);
    this._smoothedPrev.fill(0);
    this._pmin.fill(0);
    this._warmupSum.fill(0);
    this._presence.fill(0);
    this._gainPrev.fill(0);
    this._smoothGain.fill(1);
    this._pos = 0;
    this._fill = 0;
    this._ringPos = 0;
    this._noiseInit = false;
    this._speechProb = 0;
    this._warmup = 0;
    this._slowPower = 0;
    this._transientHold = 0;
    this._transientFromBin = 0;
    this.lastTransient = false;
    this.lastSpeechProbability = 0;
  }

  /** Streaming process; `input`/`output` may alias. Returns samples written. */
  process(input, output) {
    const N = this.fftSize;
    const H = this.hop;
    for (let i = 0; i < input.length; i++) {
      this._ring[this._ringPos] = input[i];
      this._ringPos = (this._ringPos + 1) & this._mask;
      this._fill++;
      if (this._fill === H) {
        this._fill = 0;
        this._processFrame();
      }
      output[i] = this._fifo[this._pos & this._fifoMask];
      this._pos++;
    }
    return input.length;
  }

  _analysisFrame() {
    const N = this.fftSize;
    const ring = this._ring;
    const analysis = this._analysis;
    const win = this._win;
    // ring[ringPos] is the oldest sample; frame runs oldest -> newest.
    for (let i = 0; i < N; i++) {
      analysis[i] = ring[(this._ringPos + i) & this._mask] * win[i];
    }
    return analysis;
  }

  _processFrame() {
    const { fftSize: N, bins, hop: H } = this;
    const params = this.params;
    const ds0 = Math.min(0.99, Math.max(0, params.priorSmoothing));
    const analysis = this._analysisFrame();
    const re = this._re;
    const im = this._im;

    let inEnergy = 0;
    for (let i = 0; i < N; i++) {
      re[i] = analysis[i];
      im[i] = 0;
      inEnergy += analysis[i] * analysis[i];
    }
    this.lastInputLevelDb = 10 * Math.log10(inEnergy / (N * this._winSq) + 1e-20);

    const power = this._power;
    const smoothedPrev = this._smoothedPrev;
    const gainPrev = this._gainPrev;
    const gain = this._smoothGain;
    const smoothed = this._smoothed;
    const noise = this._noise;
    const pmin = this._pmin;

    this._fft.transform(re, im, false);
    for (let k = 0; k < bins; k++) {
      power[k] = (re[k] * re[k] + im[k] * im[k]) * this._powerNorm;
    }
    power[bins - 1] = power[bins - 2]; // Nyquist bin is not meaningful here

    if (!this._noiseInit) {
      // The very first frame only boots the running state; audio passes through.
      for (let k = 0; k < bins; k++) {
        const p = Math.max(power[k], 1e-14);
        smoothed[k] = p;
        pmin[k] = p;
        noise[k] = p;
        this._warmupSum[k] = p;
        this._smoothedPrev[k] = p;
        this._gainPrev[k] = 1;
        this._smoothGain[k] = 1;
        this._presence[k] = 0.5;
      }
      this._noiseInit = true;
      this._synthesisReconstruction(re, im);
      return;
    }

    // --- 1. smoothed periodogram --------------------------------------
    const beta = Math.min(0.95, Math.max(0, params.spectralSmoothing));
    for (let k = 0; k < bins; k++) {
      smoothed[k] = beta * smoothed[k] + (1 - beta) * power[k];
    }

    // --- 2. noise power estimate --------------------------------------
    // Speech-presence-driven mean tracker (Gerkmann & Hendriks): bins that
    // look speech-free average towards the current power, bins that look like
    // speech freeze. That estimates the *mean* noise power - unlike a tracked
    // minimum, which underestimates it by a frequency-dependent factor and
    // then leaks noise through the low bins.
    const effAlpha = Math.min(0.99, Math.max(0, params.noiseUpdateAlpha));
    const fallAlpha = Math.min(0.99, Math.max(0.05, params.noiseFallAlpha));
    const bias = Math.max(0.1, params.noiseBias);
    const q = Math.min(0.99, Math.max(0.01, params.speechPresenceQ));
    const qOdds = q / (1 - q);
    const leak = params.minLeak;
    const freezeFactor = dbToGain(params.leakFreezeDb);
    const guardFactor = Math.max(1, params.minGuardFactor);
    const floorVal = 1e-14;
    const warming = this._warmup < params.warmupFrames;
    this._warmup++;
    const warmupSum = this._warmupSum;
    const presence = this._presence;
    let noiseFloor = 0;
    for (let k = 0; k < bins; k++) {
      const sm = Math.max(smoothed[k], floorVal);
      const prevNoise = Math.max(noise[k], floorVal);

      // (a) safety minimum: falls instantly, creeps up while the bin looks
      //     like noise rather than speech
      let m = pmin[k];
      if (sm < m) m = sm;
      else if (sm < m * freezeFactor) m *= leak;
      if (m < floorVal) m = floorVal;
      pmin[k] = m;

      // (b) speech presence probability for this bin
      const gamma0 = sm / prevNoise;
      const gp = gainPrev[k];
      const xiDD = ds0 * (gp * gp) * (smoothedPrev[k] / prevNoise) + (1 - ds0) * Math.max(gamma0 - 1, 0);
      const xi = Math.max(xiDD, gamma0 - 1, 0);
      const v = (xi / (1 + xi)) * gamma0;
      let p = 1 / (1 + qOdds * (1 + xi) * Math.exp(-v));
      if (!(p >= 0 && p <= 1)) p = 1;
      presence[k] = p;

      // (c) update the mean, then clamp with the safety minimum
      if (warming) {
        warmupSum[k] += sm;
        noise[k] = warmupSum[k] / this._warmup;
      } else {
        // Asymmetric: fall fast (pauses), rise slowly (and only when the bin
        // does not look like speech).
        const a = sm < prevNoise ? fallAlpha : p + (1 - p) * effAlpha;
        let nEst = a * prevNoise + (1 - a) * sm;
        const guard = pmin[k] * guardFactor;
        if (nEst > guard) nEst = guard;
        noise[k] = Math.max(nEst * bias, floorVal);
      }
      noiseFloor += noise[k];
    }
    this.lastNoiseFloorDb = 10 * Math.log10(noiseFloor / bins + 1e-20);

    // --- 3. broadband voice activity (metering + transient gate) -------
    let snrSum = 0;
    let logSum = 0;
    let linSum = 0;
    for (let k = 1; k < bins - 1; k++) {
      snrSum += smoothed[k] / noise[k];
      logSum += Math.log(smoothed[k] + 1e-20);
      linSum += smoothed[k];
    }
    const nbins = bins - 2;
    const meanSnrDb = 10 * Math.log10(snrSum / nbins + 1e-20);
    const flatness = Math.exp(logSum / nbins) / (linSum / nbins + 1e-20);
    const snrWeight = Math.min(1, Math.max(0, (meanSnrDb - 1) / 6));
    const flatWeight = Math.min(1, Math.max(0, (0.7 - flatness) / 0.5));
    const instant = Math.min(1, Math.max(0, snrWeight * (0.55 + 0.45 * flatWeight)));
    const prevProb = this._speechProb;
    const probCoef = instant > prevProb ? 0.6 : 0.08;
    const speechProb = prevProb + (instant - prevProb) * probCoef;
    this._speechProb = speechProb;
    this.lastSpeechProbability = speechProb;

    // --- 3b. transient gate (keyboard clicks, pen taps, door knocks) ---
    // A click is a sudden, spectrally flat burst; a voice onset is sudden but
    // strongly shaped, so flatness measured above `transientBandHz` separates
    // them. Only bins above that band are attenuated, which keeps the voice
    // fundamental (and its harmonics) untouched.
    let framePower = 0;
    for (let k = 1; k < bins - 1; k++) framePower += power[k];
    framePower /= Math.max(1, bins - 2);
    if (this._slowPower <= 0) this._slowPower = framePower;
    const jumpDb = 10 * Math.log10(framePower / Math.max(this._slowPower, 1e-20) + 1e-20);
    const hiBin = Math.max(2, Math.round((params.transientBandHz / (this.sampleRate / 2)) * (bins - 1)));
    let hiLog = 0;
    let hiLin = 0;
    for (let k = hiBin; k < bins - 1; k++) {
      hiLog += Math.log(power[k] + 1e-20);
      hiLin += power[k];
    }
    const hiCount = Math.max(1, bins - 1 - hiBin);
    const hiFlatness = Math.exp(hiLog / hiCount) / (hiLin / hiCount + 1e-20);
    const transient = jumpDb > params.transientThresholdDb && hiFlatness > params.transientFlatness;
    if (transient) this._transientHold = params.transientHoldFrames;
    else if (this._transientHold > 0) this._transientHold -= 1;
    this.lastTransient = this._transientHold > 0;
    if (transient) this._slowPower = framePower;
    else this._slowPower += (framePower - this._slowPower) * (framePower > this._slowPower ? 0.05 : 0.01);
    const transientGain = this._transientHold > 0 ? dbToGain(-params.transientAttenDb) : 1;
    this._transientFromBin = hiBin;

    // --- 4. decision-directed a-priori SNR -> gain --------------------
    const oversub = dbToGain(params.overSubtractionDb);
    const strength = Math.min(1, Math.max(0, params.strength));
    const floorGain = dbToGain(-params.maxAttenuationDb);
    const ds = Math.min(0.99, Math.max(0, params.priorSmoothing));
    const curve = 1 + 1.2 * strength;
    // VAD conditioning is applied per bin through the gain exponent rather
    // than as a broadband multiplier: scaling every bin by a global "speech
    // probability" gain pumps the whole spectrum and mangles speech.
    const curveExtra = params.gateThresholdDb > 0
      ? 1 + (params.gateThresholdDb / 12) * (1 - speechProb)
      : 1;

    let outPower = 0;
    let inPower = 0;
    for (let k = 0; k < bins; k++) {
      const p = smoothed[k];
      // Over-subtraction biases the noise reference; the mean-tracking
      // estimator is unbiased, so the default is deliberately 0 dB.
      const n = noise[k] * oversub;
      const gamma = p / n;
      const gammaPrev = smoothedPrev[k] / n;
      const gp = gainPrev[k];
      const dd = ds * (gp * gp) * gammaPrev + (1 - ds) * Math.max(gamma - 1, 0);
      // The decision-directed recursion alone converges to a biased-low
      // estimate for stationary bins, so it is never allowed below the
      // instantaneous a-priori SNR.
      let xi = Math.max(dd, gamma - 1, 0);
      let g = Math.pow(xi / (1 + xi), curve * curveExtra);
      if (this._transientHold > 0 && k >= this._transientFromBin) g *= transientGain;
      if (g > 1) g = 1;
      else if (g < floorGain) g = floorGain;
      gain[k] = g;
      gainPrev[k] = g;
      smoothedPrev[k] = p;
      outPower += p * g * g;
      inPower += p;
    }
    this.lastSuppressionDb = 10 * Math.log10(outPower / Math.max(inPower, 1e-20) + 1e-20);

    // --- 5. smoothing the gain surface --------------------------------
    const ts = Math.min(0.95, Math.max(0, params.timeSmoothing));
    const fs = Math.min(0.95, Math.max(0, params.freqSmoothing));
    let prev = gain[0];
    for (let k = 0; k < bins; k++) {
      const left = k === 0 ? gain[0] : gain[k - 1];
      const right = k === bins - 1 ? gain[bins - 1] : gain[k + 1];
      const freqAvg = 0.25 * left + 0.5 * gain[k] + 0.25 * right;
      const target = fs * freqAvg + (1 - fs) * gain[k];
      const sm = ts * prev + (1 - ts) * target;
      prev = sm;
      gain[k] = sm;
    }

    // --- 6. apply the gain and resynthesise ---------------------------
    if (this.bypass) {
      this._synthesisReconstruction(re, im);
    } else {
      for (let k = 0; k < bins; k++) {
        re[k] *= gain[k];
        im[k] *= gain[k];
      }
      for (let k = bins; k < N; k++) {
        const src = N - k;
        re[k] = re[src];
        im[k] = -im[src];
      }
      this._synthesisReconstruction(re, im);
    }
  }

  /**
   * IFFT + windowed overlap-add; the ready region of this frame maps to the
   * output indices `pos+1 .. pos+hop`, giving a fixed `fftSize` delay.
   */
  _synthesisReconstruction(re, im) {
    const N = this.fftSize;
    const H = this.hop;
    const win = this._win;
    this._fft.transform(re, im, true);
    const ola = this._ola;
    for (let i = 0; i < N; i++) ola[i] += re[i] * win[i];
    // The ready region of this frame maps to output indices pos+1 .. pos+H.
    let outEnergy = 0;
    for (let i = 0; i < H; i++) {
      const v = ola[i] * this._olaNorm;
      this._fifo[(this._pos + 1 + i) & this._fifoMask] = v;
      outEnergy += v * v;
    }
    ola.copyWithin(0, H, N);
    ola.fill(0, N - H, N);
    this.lastOutputLevelDb = 10 * Math.log10(outEnergy / H + 1e-20);
  }

  metrics() {
    return {
      transient: this.lastTransient,
      inputLevelDb: this.lastInputLevelDb,
      outputLevelDb: this.lastOutputLevelDb,
      noiseFloorDb: this.lastNoiseFloorDb,
      speechProbability: this.lastSpeechProbability,
      suppressionDb: this.lastSuppressionDb,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Post processing
 * ------------------------------------------------------------------ */

/** Biquad filter (RBJ cookbook coefficients). */
export class Biquad {
  constructor(type, sampleRate, freq, q, gainDb = 0) {
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    const cosw = Math.cos(w0);
    let b0; let b1; let b2; let a0; let a1; let a2;
    if (type === 'highpass') {
      b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
    } else if (type === 'lowpass') {
      b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
    } else {
      const A = Math.pow(10, gainDb / 40);
      b0 = 1 + alpha * A; b1 = -2 * cosw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cosw; a2 = 1 - alpha / A;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    // shift history: x[n-2] <- x[n-1] <- x[n] (same for y)
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }

  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/** Keeps the speech band, trims rumble/hiss and adds intelligibility presence. */
export class VoiceFocus {
  constructor(sampleRate = 48000, opts = {}) {
    this.enabled = true;
    this.configure(sampleRate, opts);
  }

  configure(sampleRate, opts = {}) {
    this.sampleRate = sampleRate;
    this.opts = {
      highpassHz: opts.highpassHz ?? 95,
      lowpassHz: opts.lowpassHz ?? 7600,
      presenceDb: opts.presenceDb ?? 2.5,
    };
    this.channels = [];
    return this;
  }

  _make() {
    const { highpassHz, lowpassHz, presenceDb } = this.opts;
    const sr = this.sampleRate;
    return [
      new Biquad('highpass', sr, Math.min(highpassHz, sr / 2 - 100), 0.707),
      new Biquad('lowpass', sr, Math.min(lowpassHz, sr / 2 - 200), 0.707),
      new Biquad('peaking', sr, 2600, 1.0, presenceDb),
    ];
  }

  process(channel, buf) {
    if (!this.enabled) return buf;
    while (this.channels.length <= channel) this.channels.push(this._make());
    const [hp, lp, pk] = this.channels[channel];
    for (let i = 0; i < buf.length; i++) {
      buf[i] = pk.process(lp.process(hp.process(buf[i])));
    }
    return buf;
  }

  reset() {
    this.channels = [];
  }
}

/** Slow AGC that lifts quiet talkers to a comfortable level (never clips). */
export class AutoGain {
  /**
   * Slow, RMS-based automatic gain control.
   *
   * Design notes:
   *  - a mean-square follower with attack/release time constants decides the
   *    gain (per-sample peak AGC would flatten all dynamics),
   *  - the gain is only updated while the input is above a gate, so pauses do
   *    not pump the room noise up,
   *  - output is soft limited, so a boosted signal never clips.
   */
  constructor({
    sampleRate = 48000,
    targetDb = -20,
    maxGainDb = 15,
    minGainDb = -6,
    rmsTimeMs = 120,
    smoothTimeMs = 80,
    gateDb = -55,
  } = {}) {
    this.enabled = true;
    this.sampleRate = sampleRate;
    this.targetDb = targetDb;
    this.maxGainDb = maxGainDb;
    this.minGainDb = minGainDb;
    this.gateDb = gateDb;
    this.rmsCoef = Math.exp(-1 / ((sampleRate * rmsTimeMs) / 1000));
    this.smoothCoef = Math.exp(-1 / ((sampleRate * smoothTimeMs) / 1000));
    this.channels = [];
    this.lastGainDb = 0;
  }

  _channel(index) {
    while (this.channels.length <= index) {
      this.channels.push({ rms2: 1e-8, gain: 1 });
    }
    return this.channels[index];
  }

  process(channel, buf) {
    if (!this.enabled) return buf;
    const ch = this._channel(channel);
    const target = dbToGain(this.targetDb);
    const maxGain = dbToGain(this.maxGainDb);
    const minGain = dbToGain(this.minGainDb);
    const gate = dbToGain(this.gateDb);
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      ch.rms2 += (x * x - ch.rms2) * (1 - this.rmsCoef);
      const rms = Math.sqrt(ch.rms2 + 1e-20);
      if (rms > gate) {
        const desired = Math.min(maxGain, Math.max(minGain, target / rms));
        ch.gain += (desired - ch.gain) * (1 - this.smoothCoef);
      }
      const y = x * ch.gain;
      buf[i] = y > 0.999 ? 0.999 : (y < -0.999 ? -0.999 : y);
    }
    this.lastGainDb = gainToDb(ch.gain);
    return buf;
  }

  reset() {
    this.channels = [];
  }
}

/* ------------------------------------------------------------------ *
 * Full chain
 * ------------------------------------------------------------------ */

export class DenoiseChain {
  constructor(options = {}) {
    const sampleRate = options.sampleRate ?? 48000;
    this.sampleRate = sampleRate;
    this.denoiser = new SpectralDenoiser({ ...options, sampleRate });
    this.voiceFocus = new VoiceFocus(sampleRate, options).configure(sampleRate, options);
    this.agc = new AutoGain({ sampleRate, ...(options.agc ?? {}) });
    this.voiceFocus.enabled = options.voiceFocus !== false;
    this.agc.enabled = options.autoGain !== false;
    this.denoiser.bypass = options.bypass === true;
    this.latency = this.denoiser.latency;
  }

  setParams(opts = {}) {
    const direct = ['strength', 'maxAttenuationDb', 'overSubtractionDb', 'gateThresholdDb'];
    if (direct.some((k) => opts[k] !== undefined)) this.denoiser.setParams(opts);
    if (opts.voiceFocus !== undefined) this.voiceFocus.enabled = !!opts.voiceFocus;
    if (opts.autoGain !== undefined) this.agc.enabled = !!opts.autoGain;
    if (opts.bypass !== undefined) this.denoiser.bypass = !!opts.bypass;
    if (opts.highpassHz !== undefined || opts.lowpassHz !== undefined || opts.presenceDb !== undefined) {
      this.voiceFocus.configure(this.sampleRate, { ...this.voiceFocus.opts, ...opts });
    }
  }

  processChannel(channel, input, output) {
    this.denoiser.process(input, output);
    if (this.denoiser.bypass) {
      // "Hold to hear the original" must be honest: emit the untouched dry
      // signal. The later stages still run so their state stays warm and
      // releasing the button never clicks.
      const n = output.length;
      if (!this._dryCopy || this._dryCopy.length !== n) this._dryCopy = new Float32Array(n);
      this._dryCopy.set(output.subarray(0, n));
      this.voiceFocus.process(channel, output);
      this.agc.process(channel, output);
      output.set(this._dryCopy);
      return output;
    }
    this.voiceFocus.process(channel, output);
    this.agc.process(channel, output);
    return output;
  }

  metrics() {
    return {
      ...this.denoiser.metrics(),
      agcGainDb: this.agc.lastGainDb,
      bypass: this.denoiser.bypass,
    };
  }

  reset() {
    this.denoiser.reset();
    this.voiceFocus.reset();
    this.agc.reset();
  }
}

export const DEFAULTS_EXPORT = DEFAULTS;
