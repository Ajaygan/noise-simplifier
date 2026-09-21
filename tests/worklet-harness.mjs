/**
 * Runs the *generated* AudioWorklet bundle in Node so the exact artifact that
 * ships in the extension can be exercised in tests.
 *
 * `addModule()` parses the bundle as a module, so it is evaluated with
 * `node:vm` in strict mode against a minimal, spec-shaped worklet global scope
 * (which also guarantees the build step never leaves `import`/`export`/
 * `import.meta` in the shipped file).
 *
 * The scope deliberately mirrors Chrome: **no** `window`, `WorkerGlobalScope`,
 * `atob` or `setTimeout`. Faking those here once hid a real failure — the
 * vendored RNNoise build feature-tests `window`/`WorkerGlobalScope` and threw
 * "not compiled for this environment" inside real worklets while the tests
 * stayed green.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKLET_PATH = resolve(root, 'extension/dist/denoise.worklet.js');

class FakePort {
  constructor() {
    this.messages = [];
    this.onmessage = null;
  }

  postMessage(msg) {
    this.messages.push(msg);
  }

  /** Simulate a message from the main thread to the worklet. */
  send(msg) {
    if (this.onmessage) this.onmessage({ data: msg });
  }

  take(type) {
    const found = this.messages.filter((m) => m.type === type);
    this.messages = this.messages.filter((m) => m.type !== type);
    return found;
  }
}

export function loadWorklet({ sampleRate = 48000 } = {}) {
  const code = readFileSync(WORKLET_PATH, 'utf8');
  let Processor = null;
  const registry = new Map();

  // Deliberately *only* what a real AudioWorkletGlobalScope exposes: no
  // `window`, no `WorkerGlobalScope`, no `atob`/`setTimeout`/`performance`.
  // Injecting those here once hid a real bug — the vendored RNNoise build
  // feature-detects `typeof window == "object" || typeof WorkerGlobalScope < "u"`
  // and threw "not compiled for this environment" inside Chrome's worklet.
  const sandbox = {
    console,
    sampleRate,
    currentTime: 0,
    currentFrame: 0,
    TextDecoder,
    WebAssembly,
    Promise,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = new FakePort();
      }
    },
    registerProcessor: (name, cls) => {
      registry.set(name, cls);
      Processor = cls;
    },
  };
  const context = vm.createContext(sandbox);
  // `addModule()` parses the bundle as a *module*, so the worklet runs in strict
  // mode; evaluate it the same way here rather than allowing sloppy code.
  vm.runInContext(`"use strict";\n${code}`, context, { filename: 'denoise.worklet.js' });

  if (!Processor) throw new Error('worklet did not call registerProcessor');

  return {
    Processor,
    registry,
    context,
    /** Create a processor and wait for the engine to finish loading. */
    async create({ channels = 1, settings = {} } = {}) {
      const proc = new Processor({ processorOptions: { channels, settings } });
      const failed = () => proc.port.messages.find((m) => m.type === 'error');
      await waitFor(() => proc.engine !== null || failed(), 20000);
      // Surface the worklet's own error instead of a bare timeout.
      const err = failed();
      if (err) throw new Error(`worklet engine failed to initialise: ${err.error}`);
      if (proc.engine === null) throw new Error('waitFor: engine never finished loading');
      return proc;
    },
  };
}

export async function waitFor(predicate, timeoutMs = 5000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!predicate()) throw new Error('waitFor: condition never became true');
  return true;
}

/** Push `samples` through the processor in 128-frame render quanta. */
export function render(proc, samples, { channels = 1, quantum = 128 } = {}) {
  const out = new Float32Array(samples.length);
  for (let offset = 0; offset < samples.length; offset += quantum) {
    const frames = Math.min(quantum, samples.length - offset);
    const input = new Float32Array(frames);
    input.set(samples.subarray(offset, offset + frames));
    const inputs = channels === 1
      ? [[input]]
      : [Array.from({ length: channels }, () => input.slice())];
    const outs = [];
    for (let c = 0; c < channels; c++) outs.push(new Float32Array(frames));
    proc.process(inputs, [outs]);
    out.set(outs[0].subarray(0, frames), offset);
  }
  return out;
}
