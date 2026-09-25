import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng } from './util.js';

// Built-in geometry. Segment counts drop with the quality preset so a potato
// device never pays for a 64-segment sphere. Prefabs use vertex colours so they
// need no textures at all.

const SEG = { potato: 0.5, low: 0.75, ps3: 1, high: 1.5 };

function paint(geo, hex, jitter = 0, seed = 1) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const r = rng(seed);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = 1 + (r() - 0.5) * jitter;
    arr[i * 3] = c.r * j; arr[i * 3 + 1] = c.g * j; arr[i * 3 + 2] = c.b * j;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function merge(list) {
  const norm = list.map((g) => {
    let x = g.index ? g.toNonIndexed() : g;
    if (!x.attributes.uv) x.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(x.attributes.position.count * 2), 2));
    if (!x.attributes.color) paint(x, '#ffffff');
    return x;
  });
  const g = mergeGeometries(norm, false);
  g.computeVertexNormals();
  return g;
}

function jitterVerts(geo, amt, seed) {
  const r = rng(seed);
  const pos = geo.attributes.position;
  const map = new Map();
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    if (!map.has(k)) map.set(k, [(r() - 0.5) * amt, (r() - 0.5) * amt, (r() - 0.5) * amt]);
    const d = map.get(k);
    pos.setXYZ(i, pos.getX(i) + d[0], pos.getY(i) + d[1], pos.getZ(i) + d[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

export const SHAPES = {
  box: { label: 'Cube', prefab: false },
  sphere: { label: 'Sphere', prefab: false },
  cylinder: { label: 'Cylinder', prefab: false },
  cone: { label: 'Cone', prefab: false },
  capsule: { label: 'Capsule', prefab: false },
  torus: { label: 'Torus', prefab: false },
  plane: { label: 'Plane', prefab: false },
  ramp: { label: 'Ramp', prefab: false },
  stairs: { label: 'Stairs', prefab: false },
  tree: { label: 'Tree', prefab: true },
  pine: { label: 'Pine Tree', prefab: true },
  rock: { label: 'Rock', prefab: true },
  bush: { label: 'Bush', prefab: true },
  grass: { label: 'Grass', prefab: true },
  crate: { label: 'Crate', prefab: true },
  barrel: { label: 'Barrel', prefab: true },
  coin: { label: 'Coin', prefab: true },
};

const cache = new Map();

export function getShapeGeometry(shape, qualityName = 'ps3', seed = 1) {
  const key = `${shape}|${qualityName}|${seed}`;
  if (cache.has(key)) return cache.get(key);
  const k = SEG[qualityName] || 1;
  const s = (n) => Math.max(3, Math.round(n * k));
  let g;
  switch (shape) {
    case 'sphere': g = new THREE.SphereGeometry(0.5, s(18), s(12)); break;
    case 'cylinder': g = new THREE.CylinderGeometry(0.5, 0.5, 1, s(16)); break;
    case 'cone': g = new THREE.ConeGeometry(0.5, 1, s(16)); break;
    case 'capsule': g = new THREE.CapsuleGeometry(0.3, 0.8, s(4), s(12)); break;
    case 'torus': g = new THREE.TorusGeometry(0.4, 0.14, s(8), s(20)); break;
    case 'plane': g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); break;
    case 'ramp': {
      const shp = new THREE.Shape([new THREE.Vector2(-0.5, -0.5), new THREE.Vector2(0.5, -0.5), new THREE.Vector2(0.5, 0.5)]);
      g = new THREE.ExtrudeGeometry(shp, { depth: 1, bevelEnabled: false });
      g.translate(0, 0, -0.5);
      break;
    }
    case 'stairs': {
      const steps = 5, parts = [];
      for (let i = 0; i < steps; i++) {
        const b = new THREE.BoxGeometry(1, (i + 1) / steps, 1 / steps);
        b.translate(0, -0.5 + (i + 1) / steps / 2, -0.5 + (i + 0.5) / steps);
        parts.push(b);
      }
      g = mergeGeometries(parts.map((p) => p.toNonIndexed()), false);
      break;
    }
    case 'tree': {
      const trunk = paint(new THREE.CylinderGeometry(0.12, 0.18, 1.4, s(6)).translate(0, 0.7, 0), '#6b4a2b', 0.15, seed);
      const r = rng(seed);
      const leaves = [];
      for (let i = 0; i < 3; i++) {
        const l = new THREE.IcosahedronGeometry(0.75 - i * 0.12, 0);
        l.translate((r() - 0.5) * 0.4, 1.6 + i * 0.45, (r() - 0.5) * 0.4);
        leaves.push(paint(jitterVerts(l, 0.18, seed + i), i === 1 ? '#4f8f36' : '#437a2e', 0.25, seed + i));
      }
      g = merge([trunk, ...leaves]);
      break;
    }
    case 'pine': {
      const trunk = paint(new THREE.CylinderGeometry(0.1, 0.15, 1, s(6)).translate(0, 0.5, 0), '#5a3d22', 0.1, seed);
      const tiers = [];
      for (let i = 0; i < 3; i++) tiers.push(paint(new THREE.ConeGeometry(0.9 - i * 0.22, 1.2, s(7)).translate(0, 1.2 + i * 0.65, 0), '#2f5e34', 0.3, seed + i));
      g = merge([trunk, ...tiers]);
      break;
    }
    case 'rock': g = merge([paint(jitterVerts(new THREE.IcosahedronGeometry(0.5, qualityName === 'potato' ? 0 : 1).scale(1, 0.7, 1), 0.25, seed), '#85817a', 0.25, seed)]); break;
    case 'bush': {
      const r = rng(seed), parts = [];
      for (let i = 0; i < 4; i++) parts.push(paint(jitterVerts(new THREE.IcosahedronGeometry(0.35 + r() * 0.15, 0).translate((r() - 0.5) * 0.6, 0.3 + r() * 0.2, (r() - 0.5) * 0.6), 0.1, seed + i), '#3e7d34', 0.3, seed + i));
      g = merge(parts);
      break;
    }
    case 'grass': {
      const parts = [];
      for (let i = 0; i < 3; i++) {
        const p = new THREE.PlaneGeometry(0.6, 0.5, 1, 1).translate(0, 0.25, 0).rotateY((i * Math.PI) / 3);
        const pos = p.attributes.position;
        for (let v = 0; v < pos.count; v++) if (pos.getY(v) > 0.3) pos.setX(v, pos.getX(v) * 0.4);
        parts.push(paint(p, '#6aa84f', 0.2, seed + i));
      }
      g = merge(parts);
      break;
    }
    case 'crate': {
      const body = paint(new THREE.BoxGeometry(1, 1, 1), '#a0703c', 0.1, seed);
      const bars = [];
      for (const [x, y, z, w, h, d] of [[0, 0.46, 0.51, 1, 0.08, 0.02], [0, -0.46, 0.51, 1, 0.08, 0.02], [0, 0.46, -0.51, 1, 0.08, 0.02], [0, -0.46, -0.51, 1, 0.08, 0.02], [0.51, 0, 0, 0.02, 1, 0.08], [-0.51, 0, 0, 0.02, 1, 0.08]]) {
        bars.push(paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), '#6e4a24', 0.05, seed));
      }
      g = merge([body, ...bars]);
      break;
    }
    case 'barrel': {
      const b = new THREE.CylinderGeometry(0.45, 0.45, 1, s(12), 4);
      const pos = b.attributes.position;
      for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); const f = 1 + 0.12 * (1 - 4 * y * y); pos.setX(i, pos.getX(i) * f); pos.setZ(i, pos.getZ(i) * f); }
      const rings = [0.35, -0.35].map((y) => paint(new THREE.TorusGeometry(0.5, 0.025, 4, s(12)).rotateX(Math.PI / 2).translate(0, y, 0), '#444444'));
      g = merge([paint(b, '#8b5a2b', 0.12, seed), ...rings]);
      break;
    }
    case 'coin': g = merge([paint(new THREE.CylinderGeometry(0.3, 0.3, 0.06, s(16)).rotateX(Math.PI / 2), '#ffcc33')]); break;
    case 'box':
    default: g = new THREE.BoxGeometry(1, 1, 1);
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  cache.set(key, g);
  return g;
}

export function isPrefab(shape) { return !!SHAPES[shape]?.prefab; }
