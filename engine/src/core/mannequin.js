import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { autoRig } from './autorig.js';

// A ~1.2k-triangle T-pose mannequin built from primitives. It's the default
// player character, and it's rigged at runtime by the same auto-rigger users
// run on their own characters (so it doubles as a self-test).

function colored(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function limb(r1, r2, from, to, hex, seg = 8) {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r2, r1, len, seg, 2);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return colored(g, hex);
}

function box(w, h, d, x, y, z, hex, seg = 2) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  g.translate(x, y, z);
  return colored(g, hex);
}

function ball(r, x, y, z, hex, ws = 10, hs = 8) {
  const g = new THREE.SphereGeometry(r, ws, hs);
  g.translate(x, y, z);
  return colored(g, hex);
}

export function buildMannequinGeometry({ body = '#c9d3df', joint = '#5a6a80', accent = '#e0a040' } = {}) {
  const parts = [
    ball(0.11, 0, 1.69, 0, body, 12, 10),                      // head
    box(0.16, 0.04, 0.02, 0, 1.70, 0.1, accent, 1),            // visor
    limb(0.05, 0.05, [0, 1.5, 0], [0, 1.6, 0], joint),         // neck
    box(0.38, 0.3, 0.21, 0, 1.36, 0, body, 3),                 // chest
    box(0.3, 0.2, 0.18, 0, 1.12, 0, joint, 2),                 // abdomen
    box(0.33, 0.15, 0.2, 0, 0.955, 0, body, 2),                // pelvis
  ];
  for (const s of [1, -1]) {
    parts.push(
      ball(0.06, s * 0.21, 1.45, 0, joint, 8, 6),                               // shoulder
      limb(0.048, 0.042, [s * 0.22, 1.45, 0], [s * 0.49, 1.45, 0], body),       // upper arm
      ball(0.042, s * 0.5, 1.45, 0, joint, 8, 6),                               // elbow
      limb(0.042, 0.035, [s * 0.5, 1.45, 0], [s * 0.75, 1.45, 0], body),        // forearm
      box(0.11, 0.045, 0.08, s * 0.81, 1.45, 0, joint, 1),                      // hand
      limb(0.075, 0.06, [s * 0.1, 0.9, 0], [s * 0.1, 0.52, 0], body),           // thigh
      ball(0.055, s * 0.1, 0.5, 0, joint, 8, 6),                                // knee
      limb(0.055, 0.045, [s * 0.1, 0.5, 0], [s * 0.1, 0.08, 0], body),          // shin
      box(0.1, 0.07, 0.25, s * 0.1, 0.035, 0.05, joint, 1),                     // foot
    );
  }
  const g = mergeGeometries(parts.map((p) => p.index ? p : p.toNonIndexed()), false);
  g.computeVertexNormals();
  return g;
}

export function buildMannequinRigged(opts = {}) {
  const geo = buildMannequinGeometry(opts);
  const mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 40, specular: 0x333333 }));
  mesh.name = 'Mannequin';
  const rig = autoRig(mesh, { targetHeight: 1.8, smoothIterations: 2 });
  rig.root.name = 'Mannequin';
  return rig;
}
