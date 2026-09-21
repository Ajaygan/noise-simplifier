#!/usr/bin/env node
/**
 * Flattens the ESM DSP sources + the vendored RNNoise WASM module into the
 * single classic script that `AudioWorklet.addModule()` can load:
 *
 *     extension/src/worklets/denoise.worklet.src.js
 *        -> extension/dist/denoise.worklet.js
 *
 * `/* BUILD:INCLUDE <path> *\/` markers are replaced by the file contents:
 *   - `import ... from './x.js'` / `export ...` in our own sources is stripped,
 *   - the vendored ESM bundle has its `export { a as B }` rewritten to
 *     `var B = a;`, and `import.meta.url` replaced (the WASM is embedded as
 *     base64 in the bundle, so nothing is ever fetched at runtime).
 *
 * Usage: node tools/build-worklets.mjs [--check]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(root, 'extension/src/worklets/denoise.worklet.src.js');
const OUT = resolve(root, 'extension/dist/denoise.worklet.js');

/** Strip ESM syntax from our own sources (they are inlined into one scope). */
function stripModuleSyntax(source, name) {
  let out = source
    // single-line imports at the top of the file
    .replace(/^\s*import\s+[^;]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '')
    // inline `export ` keywords
    .replace(/^(\s*)export\s+(class|function|const|let|var|async)\b/gm, '$1$2')
    // `export { a, b };` blocks (nothing to re-export in a flat bundle)
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');

  if (/^\s*import\s/m.test(out)) {
    throw new Error(`unhandled import statement after flattening ${name}`);
  }
  if (/^\s*export\s/m.test(out)) {
    throw new Error(`unhandled export statement after flattening ${name}`);
  }
  return out;
}

/** Turn the Emscripten ESM wrapper into a classic script chunk. */
function convertVendoredModule(source) {
  let out = source.replace(/import\.meta\.url/g, '"noise-simplifier://vendor"');
  out = out.replace(/^(\s*)export\s+default\s+/gm, '$1var __default = ');
  out = out.replace(/^\s*export\s*\{([^}]*)\};?\s*$/gm, (_m, body) => {
    return body
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const m = part.match(/^(\S+)\s+as\s+(\S+)$/);
        return m ? `var ${m[2]} = ${m[1]};` : `var ${part} = ${part};`;
      })
      .join('\n');
  });
  out = out.replace(/\bexport\s+(const|let|var|function|class)\b/g, '$1');
  if (/^\s*export\s/m.test(out)) {
    throw new Error('unhandled export in vendored module');
  }
  return out;
}

export function build({ check = false } = {}) {
  const entry = readFileSync(ENTRY, 'utf8');
  const included = [];
  const body = entry.replace(/^([ \t]*)\/\* BUILD:INCLUDE (\S+) \*\/[ \t]*$/gm, (_m, indent, relPath) => {
    const abs = resolve(root, relPath);
    const raw = readFileSync(abs, 'utf8');
    included.push(relPath);
    const isVendor = relPath.includes('/vendor/');
    const code = isVendor ? convertVendoredModule(raw) : stripModuleSyntax(raw, relPath);
    return `${indent}/* ---- inlined: ${relPath} ---- */\n${code}`;
  });

  const header = `/* GENERATED FILE - do not edit.\n * Built from extension/src/worklets/denoise.worklet.src.js by tools/build-worklets.mjs\n * Inlined: ${included.join(', ')}\n */\n`;
  const output = header + body;

  if (check) {
    let current = '';
    try {
      current = readFileSync(OUT, 'utf8');
    } catch {
      throw new Error(`${OUT} is missing - run: node tools/build-worklets.mjs`);
    }
    if (current !== output) {
      throw new Error('extension/dist/denoise.worklet.js is stale - run: node tools/build-worklets.mjs');
    }
    console.log('worklet bundle is up to date');
    return { output, path: OUT, changed: false };
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, output);
  const kb = (Buffer.byteLength(output) / 1024).toFixed(0);
  console.log(`built ${OUT.replace(root + '/', '')} (${kb} kB) from ${included.length} sources`);
  return { output, path: OUT, changed: true };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    build({ check: process.argv.includes('--check') });
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(1);
  }
}
