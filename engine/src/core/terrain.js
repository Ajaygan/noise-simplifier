import * as THREE from 'three';
import { base64ToFloat32, float32ToBase64, clamp, rng } from './util.js';

// Heightfield landscape. Heights and a 3-layer paint mask live in the actor's
// props (base64 Float32Arrays) so they save with the project. Painting uses
// vertex colours (no splat textures = cheap on potato GPUs), and "Bake
// Lighting" writes sun shadows + ambient occlusion into a per-vertex light term
// (a PS2/PS3-era lightmap substitute) so realtime shadows can be switched off.

export const TERRAIN_DEFAULTS = {
  size: 100, resolution: 64,
  heights: null, paint: null, baked: null,
  layers: ['#5d8a3a', '#8a6a44', '#8c8c8c'], // grass, dirt, rock
  autoRock: true, flatShaded: false,
};

export class Terrain {
  constructor(props) {
    this.props = { ...TERRAIN_DEFAULTS, ...props };
    const p = this.props;
    const n = p.resolution + 1;
    this.n = n;
    this.heights = p.heights ? base64ToFloat32(p.heights) : new Float32Array(n * n);
    if (this.heights.length !== n * n) this.heights = new Float32Array(n * n);
    this.paint = p.paint ? base64ToFloat32(p.paint) : new Float32Array(n * n * 3).map((_, i) => (i % 3 === 0 ? 1 : 0));
    if (this.paint.length !== n * n * 3) this.paint = new Float32Array(n * n * 3).map((_, i) => (i % 3 === 0 ? 1 : 0));
    this.baked = p.baked ? base64ToFloat32(p.baked) : null;
    if (this.baked && this.baked.length !== n * n) this.baked = null;
    this.geometry = new THREE.PlaneGeometry(p.size, p.size, p.resolution, p.resolution);
    this.geometry.rotateX(-Math.PI / 2);
    this.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));
    this.layerColors = p.layers.map((c) => new THREE.Color(c));
    this.updateGeometry();
  }

  serialize() {
    return {
      heights: float32ToBase64(this.heights),
      paint: float32ToBase64(this.paint),
      baked: this.baked ? float32ToBase64(this.baked) : null,
    };
  }

  updateGeometry() {
    const pos = this.geometry.attributes.position;
    for (let i = 0; i < this.n * this.n; i++) pos.setY(i, this.heights[i]);
    pos.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.updateColors();
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();
  }

  updateColors() {
    const col = this.geometry.attributes.color;
    const nrm = this.geometry.attributes.normal;
    const [g, d, r] = this.layerColors;
    for (let i = 0; i < this.n * this.n; i++) {
      let wg = this.paint[i * 3], wd = this.paint[i * 3 + 1], wr = this.paint[i * 3 + 2];
      if (this.props.autoRock) {
        const slope = 1 - nrm.getY(i);
        const rock = clamp((slope - 0.25) * 4, 0, 1);
        wg *= 1 - rock; wd *= 1 - rock; wr += rock * (1 - wr);
      }
      const s = wg + wd + wr || 1;
      const light = this.baked ? this.baked[i] : 1;
      // tiny per-vertex noise breaks up the flat vertex-colour look
      const noise = 0.94 + ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 0.1;
      const k = (light * noise) / s;
      col.setXYZ(i, (g.r * wg + d.r * wd + r.r * wr) * k, (g.g * wg + d.g * wd + r.g * wr) * k, (g.b * wg + d.b * wd + r.b * wr) * k);
    }
    col.needsUpdate = true;
  }

  // world-space (local to terrain actor) height lookup with bilinear filtering
  heightAt(x, z) {
    const p = this.props, n = this.n;
    const fx = ((x / p.size) + 0.5) * p.resolution;
    const fz = ((z / p.size) + 0.5) * p.resolution;
    if (fx < 0 || fz < 0 || fx > p.resolution || fz > p.resolution) return null;
    const ix = Math.min(Math.floor(fx), p.resolution - 1), iz = Math.min(Math.floor(fz), p.resolution - 1);
    const tx = fx - ix, tz = fz - iz;
    const h = (a, b) => this.heights[b * n + a];
    const h0 = h(ix, iz) * (1 - tx) + h(ix + 1, iz) * tx;
    const h1 = h(ix, iz + 1) * (1 - tx) + h(ix + 1, iz + 1) * tx;
    return h0 * (1 - tz) + h1 * tz;
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const e = this.props.size / this.props.resolution;
    const hl = this.heightAt(x - e, z) ?? 0, hr = this.heightAt(x + e, z) ?? 0;
    const hd = this.heightAt(x, z - e) ?? 0, hu = this.heightAt(x, z + e) ?? 0;
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  // brush: mode raise|lower|smooth|flatten|noise|paint0..2 ; x,z in local space
  applyBrush(x, z, { mode = 'raise', radius = 6, strength = 0.5, flattenHeight = 0 }, dt = 1 / 60) {
    const p = this.props, n = this.n;
    const cell = p.size / p.resolution;
    const r2 = radius * radius;
    const cx = ((x / p.size) + 0.5) * p.resolution, cz = ((z / p.size) + 0.5) * p.resolution;
    const rc = Math.ceil(radius / cell);
    const hCopy = mode === 'smooth' ? this.heights.slice() : null;
    const rand = rng((x * 1000 + z * 7) | 0);
    let touched = false;
    for (let j = Math.max(0, Math.floor(cz - rc)); j <= Math.min(p.resolution, Math.ceil(cz + rc)); j++) {
      for (let i = Math.max(0, Math.floor(cx - rc)); i <= Math.min(p.resolution, Math.ceil(cx + rc)); i++) {
        const wx = (i / p.resolution - 0.5) * p.size, wz = (j / p.resolution - 0.5) * p.size;
        const d2 = (wx - x) ** 2 + (wz - z) ** 2;
        if (d2 > r2) continue;
        const fall = Math.pow(1 - Math.sqrt(d2) / radius, 2) * (3 - 2 * (1 - Math.sqrt(d2) / radius)) * 0.5 + 0.5 * (1 - Math.sqrt(d2) / radius);
        const k = fall * strength * dt * 10;
        const idx = j * n + i;
        touched = true;
        if (mode === 'raise') this.heights[idx] += k;
        else if (mode === 'lower') this.heights[idx] -= k;
        else if (mode === 'noise') this.heights[idx] += (rand() - 0.5) * k * 2;
        else if (mode === 'flatten') this.heights[idx] += (flattenHeight - this.heights[idx]) * clamp(k, 0, 1);
        else if (mode === 'smooth') {
          let s = 0, c = 0;
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii > p.resolution || jj > p.resolution) continue;
            s += hCopy[jj * n + ii]; c++;
          }
          this.heights[idx] += (s / c - this.heights[idx]) * clamp(k, 0, 1);
        } else if (mode.startsWith('paint')) {
          const layer = +mode.slice(5) || 0;
          const a = clamp(k, 0, 1);
          for (let l = 0; l < 3; l++) {
            const tgt = l === layer ? 1 : 0;
            this.paint[idx * 3 + l] += (tgt - this.paint[idx * 3 + l]) * a;
          }
        }
      }
    }
    if (touched) {
      if (mode.startsWith('paint')) this.updateColors(); else this.updateGeometry();
    }
    return touched;
  }

  generate({ seed = 1, amplitude = 8, scale = 0.04, octaves = 4 } = {}) {
    const rand = rng(seed);
    const perm = new Uint8Array(512);
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
    const grad = (h, x, y) => ((h & 1) ? -x : x) + ((h & 2) ? -y : y);
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    const noise = (x, y) => {
      const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
      x -= Math.floor(x); y -= Math.floor(y);
      const u = fade(x), v = fade(y);
      const a = perm[X] + Y, b = perm[X + 1] + Y;
      const l = (t, a1, b1) => a1 + t * (b1 - a1);
      return l(v, l(u, grad(perm[a], x, y), grad(perm[b], x - 1, y)), l(u, grad(perm[a + 1], x, y - 1), grad(perm[b + 1], x - 1, y - 1)));
    };
    const p = this.props, n = this.n;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const wx = (i / p.resolution - 0.5) * p.size, wz = (j / p.resolution - 0.5) * p.size;
      let h = 0, amp = 1, fr = scale, norm = 0;
      for (let o = 0; o < octaves; o++) { h += noise(wx * fr, wz * fr) * amp; norm += amp; amp *= 0.5; fr *= 2; }
      // keep the middle flatter so there's somewhere to build
      const edge = clamp(Math.hypot(wx, wz) / (p.size * 0.5), 0, 1);
      const f = 0.04 + 0.96 * Math.pow(clamp((edge - 0.15) / 0.6, 0, 1), 1.5);
      this.heights[j * n + i] = (h / norm) * amplitude * f + f * amplitude * 0.15;
    }
    this.updateGeometry();
  }

  // Bake sun shadows (height-field ray-march + occluder boxes) and AO.
  bakeLighting(sunDir, occluders = [], { ambient = 0.35, samples = 6 } = {}) {
    const p = this.props, n = this.n;
    const out = new Float32Array(n * n);
    const dir = sunDir.clone().normalize();
    const nrm = this.geometry.attributes.normal;
    const step = p.size / p.resolution;
    const ray = new THREE.Ray();
    const tmp = new THREE.Vector3();
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const x = (i / p.resolution - 0.5) * p.size, z = (j / p.resolution - 0.5) * p.size, y = this.heights[idx];
      const ndl = Math.max(0, nrm.getX(idx) * dir.x + nrm.getY(idx) * dir.y + nrm.getZ(idx) * dir.z);
      let lit = 1;
      for (let s = 1; s < 60; s++) {
        const t = s * step * 0.75;
        const hx = x + dir.x * t, hz = z + dir.z * t, hy = y + 0.05 + dir.y * t;
        const th = this.heightAt(hx, hz);
        if (th === null) break;
        if (th > hy) { lit = 0; break; }
        if (hy > 60) break;
      }
      if (lit && occluders.length) {
        ray.origin.set(x, y + 0.05, z); ray.direction.copy(dir);
        for (const b of occluders) if (ray.intersectBox(b, tmp)) { lit = 0.15; break; }
      }
      // AO: how much the neighbourhood rises above us
      let occ = 0;
      for (let k = 0; k < samples; k++) {
        const a = (k / samples) * Math.PI * 2;
        const r = step * 3;
        const hh = this.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r);
        if (hh !== null) occ += clamp((hh - y) / r, 0, 1);
      }
      const ao = 1 - clamp(occ / samples, 0, 0.7);
      out[idx] = clamp((ambient + (1 - ambient) * ndl * lit) * (0.55 + 0.45 * ao) * 1.35, 0.1, 1.4);
    }
    this.baked = out;
    this.updateColors();
  }

  clearBake() { this.baked = null; this.updateColors(); }
  dispose() { this.geometry.dispose(); }
}
