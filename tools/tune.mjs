#!/usr/bin/env node
/** Grid-searches the speech-enhancer parameters against quality-metrics.mjs. */
import { evaluate, formatResult } from './quality-metrics.mjs';

const grid = [];
const push = (name, cfg) => grid.push({ name, cfg });

push('defaults', {});
for (const fftSize of [512, 1024]) {
  for (const maxAttenuationDb of [22, 30]) {
    for (const priorSmoothing of [0.94, 0.98]) {
      push(`fft${fftSize} att${maxAttenuationDb} ds${priorSmoothing}`, { fftSize, maxAttenuationDb, priorSmoothing });
    }
  }
}
for (const strength of [0.5, 0.75, 1.0]) {
  push(`strength ${strength} (fft512)`, { strength });
  push(`strength ${strength} (fft1024)`, { fftSize: 1024, strength });
}
push('fft1024 att30 ds0.98 smooth0.9', { fftSize: 1024, maxAttenuationDb: 30, priorSmoothing: 0.98, spectralSmoothing: 0.9 });
push('fft1024 att30 ds0.98 +over6', { fftSize: 1024, maxAttenuationDb: 30, priorSmoothing: 0.98, overSubtractionDb: 6 });

for (const { name, cfg } of grid) {
  const r = evaluate(cfg);
  console.log(formatResult(name, r));
}
