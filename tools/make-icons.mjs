/**
 * Generates the extension icons (16/32/48/128 px PNG) with no dependencies:
 * a rounded blue tile with the same waveform mark the popup uses.
 *
 *   node tools/make-icons.mjs
 *
 * Writing PNG by hand keeps the repo free of image tooling; the encoder below
 * is a minimal RGBA writer (8-bit, filter 0, single zlib stream).
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension/icons');

/* ------------------------------------------------------------ PNG writer */

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- rendering */

const WAVEFORM = [
  [0.08, 0.50], [0.24, 0.31], [0.38, 0.69], [0.50, 0.17],
  [0.62, 0.83], [0.74, 0.38], [0.86, 0.58], [0.95, 0.50],
];

/** Shortest distance from a point to a line segment. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const ss = 4;                       // supersampling factor for smooth edges
  const radius = size * 0.24;
  const stroke = Math.max(1.15, size * 0.085);
  const half = stroke / 2;
  const samples = ss * ss;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let insideTile = 0;
      let inkCoverage = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          // rounded-rect coverage
          const cx = Math.min(Math.max(px, radius), size - radius);
          const cy = Math.min(Math.max(py, radius), size - radius);
          if (Math.hypot(px - cx, py - cy) <= radius) insideTile++;
          // waveform ink coverage
          let best = Infinity;
          for (let i = 1; i < WAVEFORM.length; i++) {
            const d = distanceToSegment(
              px, py,
              WAVEFORM[i - 1][0] * size, WAVEFORM[i - 1][1] * size,
              WAVEFORM[i][0] * size, WAVEFORM[i][1] * size,
            );
            if (d < best) best = d;
          }
          if (best <= half) inkCoverage++;
        }
      }
      const tileA = insideTile / samples;
      const inkA = Math.min(inkCoverage / samples, tileA);
      // vertical gradient background: #5b95ff -> #2c56c4
      const t = y / Math.max(1, size - 1);
      const bg = [
        Math.round(0x5b + (0x2c - 0x5b) * t),
        Math.round(0x95 + (0x56 - 0x95) * t),
        Math.round(0xff + (0xc4 - 0xff) * t),
      ];
      const ink = [0xf7, 0xfb, 0xff];
      const r = Math.round(bg[0] * (1 - inkA) + ink[0] * inkA);
      const g = Math.round(bg[1] * (1 - inkA) + ink[1] * inkA);
      const b = Math.round(bg[2] * (1 - inkA) + ink[2] * inkA);
      const o = (y * size + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = Math.round(tileA * 255);
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = resolve(outDir, `icon${size}.png`);
  writeFileSync(file, renderIcon(size));
  console.log(`wrote ${file}`);
}
