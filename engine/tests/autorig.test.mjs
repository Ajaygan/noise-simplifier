import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { autoRig, prepareModel, detectMarkers, BONE_NAMES } from '../src/core/autorig.js';
import { buildMannequinRigged } from '../src/core/mannequin.js';
import { ProceduralAnimator, findHumanoidBones } from '../src/core/anim.js';

// An A-pose figure with different proportions from the mannequin, built in
// centimetres and facing away (-Z), like a typical FBX export.
function aPoseFigure() {
  const parts = [];
  const limb = (r, a, b) => {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const g = new THREE.CapsuleGeometry(r, A.distanceTo(B), 4, 10);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()));
    const m = A.clone().add(B).multiplyScalar(0.5); g.translate(m.x, m.y, m.z);
    parts.push(g);
  };
  const ball = (r, x, y, z) => { const g = new THREE.SphereGeometry(r, 12, 10); g.translate(x, y, z); parts.push(g); };
  ball(12, 0, 158, 0);                       // head
  limb(6, [0, 140], [0, 148]);               // neck
  limb(17, [0, 95], [0, 128]);               // torso
  for (const s of [1, -1]) {
    const sh = [s * 20, 132, 0], el = [s * 38, 108, 0], wr = [s * 55, 86, 0];
    limb(5, sh, el); limb(4.5, el, wr); ball(5.5, s * 59, 81, 0);
    limb(8, [s * 10, 90, 0], [s * 11, 48, 0]); limb(6, [s * 11, 48, 0], [s * 11, 8, 0]);
    const foot = new THREE.BoxGeometry(9, 6, 22); foot.translate(s * 11, 3, 5); parts.push(foot);
  }
  for (const p of parts) p.translate(0, 0, 0);
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)).map((p) => { p.deleteAttribute('uv'); return p; }), false);
  g.rotateY(Math.PI); // facing away, the user must rotate 180 in the tool
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial());
}

function dominant(geo, names, i) {
  const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  let best = 0, bw = -1;
  for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > bw) { bw = sw.getComponent(i, k); best = si.getComponent(i, k); }
  return names[best];
}

test('mannequin: markers land on the right joints', () => {
  const r = buildMannequinRigged();
  const m = r.markers;
  assert.ok(Math.abs(m.groin.y - 0.88) < 0.05, `groin ${m.groin.y}`);
  assert.ok(m.chin.y > 1.5 && m.chin.y < 1.62, `chin ${m.chin.y}`);
  assert.ok(m.wrist_L.x > 0.6 && m.wrist_R.x < -0.6);
  assert.ok(Math.abs(m.knee_L.x - 0.1) < 0.02 && Math.abs(m.knee_R.x + 0.1) < 0.02);
  assert.equal(r.skeleton.bones.length, BONE_NAMES.length);
});

test('mannequin: every vertex has normalised weights and sensible dominant bone', () => {
  const r = buildMannequinRigged();
  const g = r.meshes[0].geometry, pos = g.attributes.position, sw = g.attributes.skinWeight;
  const names = r.boneDefs.map((b) => b.name);
  for (let i = 0; i < pos.count; i++) {
    const s = sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i);
    assert.ok(Math.abs(s - 1) < 1e-4, `weights sum ${s}`);
    const x = pos.getX(i), y = pos.getY(i), b = dominant(g, names, i);
    if (x > 0.7 && y > 1.3) assert.match(b, /_L$/);
    if (x < -0.7 && y > 1.3) assert.match(b, /_R$/);
    if (y > 1.66) assert.match(b, /head|neck/);
    if (y < 0.3) assert.match(b, /shin|foot/);
    if (y < 0.3 && x > 0) assert.match(b, /_L$/, 'left leg never follows right bones');
  }
});

test('A-pose figure in centimetres facing away: normalised, detected and rigged', () => {
  const src = aPoseFigure();
  const r = autoRig(src, { targetHeight: 1.8, rotateY: Math.PI });
  const H = 1.8, m = r.markers;
  // scaled from cm to 1.8 m
  const box = new THREE.Box3();
  for (const p of r.parts) box.union(p.geometry.boundingBox);
  assert.ok(Math.abs(box.max.y - box.min.y - H) < 1e-3);
  // A-pose wrists are well below the shoulders, and on the correct side
  assert.ok(m.wrist_L.x > 0.4 && m.wrist_L.y < 1.15, JSON.stringify(m.wrist_L));
  assert.ok(m.groin.y > 0.75 && m.groin.y < 1.05, `groin ${m.groin.y}`);
  // feet were modelled pointing +Z before the flip: after rotate 180 they must point +Z again
  const foot = r.boneDefs.find((b) => b.name === 'foot_L');
  assert.ok(foot.tail.z > foot.head.z, 'toes point forward');
  const g = r.meshes[0].geometry, pos = g.attributes.position, names = r.boneDefs.map((b) => b.name);
  let wrong = 0, total = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    if (y < 0.4) { total++; if (!/shin|foot/.test(dominant(g, names, i))) wrong++; }
  }
  assert.ok(wrong / total < 0.02, `${wrong}/${total} lower-leg verts on wrong bone`);
});

test('procedural animator finds the bones and poses without NaNs', () => {
  const r = buildMannequinRigged();
  assert.ok(findHumanoidBones(r.root));
  const a = new ProceduralAnimator(r.root);
  assert.ok(a.ok);
  // arms start in T-pose -> they must be dropped by roughly 70 degrees
  assert.ok(a.armDrop.L < -1 && a.armDrop.R < -1);
  for (let i = 0; i < 120; i++) a.update(1 / 60, { speed: i < 60 ? 1.5 : 6, grounded: i % 40 > 5 });
  r.root.updateMatrixWorld(true);
  for (const b of r.skeleton.bones) for (const v of b.matrixWorld.elements) assert.ok(Number.isFinite(v));
  // after dropping, the hands hang below the shoulders
  const hand = new THREE.Vector3(), sh = new THREE.Vector3();
  r.bones.hand_L.getWorldPosition(hand); r.bones.upperarm_L.getWorldPosition(sh);
  assert.ok(hand.y < sh.y - 0.3, `hand ${hand.y} shoulder ${sh.y}`);
});

test('Mixamo-style bone names are recognised', () => {
  const root = new THREE.Group();
  const mk = (n, parent) => { const b = new THREE.Bone(); b.name = n; (parent || root).add(b); return b; };
  const hips = mk('mixamorig:Hips');
  const spine = mk('mixamorig:Spine', hips); const s2 = mk('mixamorig:Spine2', spine);
  for (const s of ['Left', 'Right']) {
    const a = mk(`mixamorig:${s}Arm`, s2); mk(`mixamorig:${s}ForeArm`, a);
    const l = mk(`mixamorig:${s}UpLeg`, hips); mk(`mixamorig:${s}Leg`, l);
  }
  const map = findHumanoidBones(root);
  assert.ok(map);
  assert.equal(map.upperarm_L.name, 'mixamorig:LeftArm');
  assert.equal(map.shin_R.name, 'mixamorig:RightLeg');
});

test('prepareModel keeps multiple sub-meshes separate', () => {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1)), new THREE.Mesh(new THREE.SphereGeometry(0.3)));
  g.children[1].position.y = 1.3;
  const { parts } = prepareModel(g, { targetHeight: 1.8 });
  assert.equal(parts.length, 2);
  const m = detectMarkers(parts, 1.8);
  for (const k of Object.keys(m)) assert.ok(Number.isFinite(m[k].x) && Number.isFinite(m[k].y), k);
});
