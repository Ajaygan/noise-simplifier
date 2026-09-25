import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Auto-rigger
//
// Input : any humanoid mesh (OBJ / FBX / GLB), standing, Y-up, facing +Z,
//         ideally in T-pose or A-pose.
// Output: a THREE.Group containing a 19-bone humanoid skeleton and one
//         SkinnedMesh per source mesh, with 4-influence skin weights.
//
// Pipeline (all pure geometry, no ML, runs in ~100ms for a 20k-tri model):
//   1. prepareModel        bake transforms, centre, scale to a target height
//   2. detectMarkers       find chin / wrists / elbows / knees / groin by
//                          slicing the mesh horizontally (like Mixamo's markers)
//   3. buildSkeleton       derive 19 joint positions from the 8 markers
//   4. computeSkinWeights  distance-to-bone-segment weights, masked by body
//                          region (left arm can't grab right leg), then
//                          smoothed over the mesh surface (Laplacian)
//   5. createRig           Bones + SkinnedMeshes, bound and ready to animate
// ---------------------------------------------------------------------------

export const BONE_NAMES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'shoulder_L', 'upperarm_L', 'forearm_L', 'hand_L',
  'shoulder_R', 'upperarm_R', 'forearm_R', 'hand_R',
  'thigh_L', 'shin_L', 'foot_L',
  'thigh_R', 'shin_R', 'foot_R',
];

export const BONE_PARENT = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  shoulder_L: 'chest', upperarm_L: 'shoulder_L', forearm_L: 'upperarm_L', hand_L: 'forearm_L',
  shoulder_R: 'chest', upperarm_R: 'shoulder_R', forearm_R: 'upperarm_R', hand_R: 'forearm_R',
  thigh_L: 'hips', shin_L: 'thigh_L', foot_L: 'shin_L',
  thigh_R: 'hips', shin_R: 'thigh_R', foot_R: 'shin_R',
};

export const MARKER_NAMES = ['chin', 'wrist_L', 'wrist_R', 'elbow_L', 'elbow_R', 'knee_L', 'knee_R', 'groin'];

function regionOf(name) {
  if (name.endsWith('_L')) return name.startsWith('thigh') || name.startsWith('shin') || name.startsWith('foot') ? 'legL' : 'armL';
  if (name.endsWith('_R')) return name.startsWith('thigh') || name.startsWith('shin') || name.startsWith('foot') ? 'legR' : 'armR';
  if (name === 'neck' || name === 'head') return 'head';
  return 'torso';
}

// ---------------------------------------------------------------------------
// 1. prepare
// ---------------------------------------------------------------------------
export function prepareModel(object, { targetHeight = 1.8, rotateY = 0 } = {}) {
  object.updateMatrixWorld(true);
  const parts = [];
  object.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    let g = o.geometry.clone();
    // drop any existing skinning / morphs; we bake the bind pose
    g.deleteAttribute('skinIndex'); g.deleteAttribute('skinWeight');
    g.morphAttributes = {};
    g.applyMatrix4(o.matrixWorld);
    parts.push({ geometry: g, material: o.material, name: o.name || 'mesh' });
  });
  if (!parts.length) throw new Error('No meshes found in the model');
  const rot = new THREE.Matrix4().makeRotationY(rotateY);
  const box = new THREE.Box3();
  for (const p of parts) { p.geometry.applyMatrix4(rot); p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); }
  const size = box.getSize(new THREE.Vector3());
  const s = size.y > 1e-6 ? targetHeight / size.y : 1;
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  const m = new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(-cx, -box.min.y, -cz));
  for (const p of parts) {
    p.geometry.applyMatrix4(m);
    if (!p.geometry.attributes.normal) p.geometry.computeVertexNormals();
    p.geometry.computeBoundingBox(); p.geometry.computeBoundingSphere();
  }
  return { parts, height: targetHeight };
}

function allPositions(parts) {
  let n = 0;
  for (const p of parts) n += p.geometry.attributes.position.count;
  const out = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    const a = p.geometry.attributes.position;
    for (let i = 0; i < a.count; i++) { out[o++] = a.getX(i); out[o++] = a.getY(i); out[o++] = a.getZ(i); }
  }
  return out;
}

// Iterate triangles of all parts: cb(ax,ay,az,bx,by,bz,cx,cy,cz)
function forEachTri(parts, cb) {
  for (const p of parts) {
    const pos = p.geometry.attributes.position;
    const idx = p.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < n; i += 3) {
      const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
      cb(pos.getX(a), pos.getY(a), pos.getZ(a), pos.getX(b), pos.getY(b), pos.getZ(b), pos.getX(c), pos.getY(c), pos.getZ(c));
    }
  }
}

// Horizontal slice at height y -> merged x-intervals of the cross-section.
export function sliceIntervals(parts, y) {
  const iv = [];
  forEachTri(parts, (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const xs = [];
    const edge = (x1, y1, x2, y2) => {
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    };
    edge(ax, ay, bx, by); edge(bx, by, cx, cy); edge(cx, cy, ax, ay);
    if (xs.length >= 2) iv.push([Math.min(xs[0], xs[1]), Math.max(xs[0], xs[1])]);
  });
  iv.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const it of iv) {
    const last = merged[merged.length - 1];
    if (last && it[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], it[1]);
    else merged.push([it[0], it[1]]);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 2. markers
// ---------------------------------------------------------------------------
export function detectMarkers(parts, H) {
  const pos = allPositions(parts);
  const covers = (ivs, x) => ivs.some(([a, b]) => a <= x && b >= x);

  // groin: scanning up from the ankles, the first height where the gap between
  // the legs closes.
  let groinY = null, sawGap = false;
  for (let t = 0.06; t <= 0.62; t += 0.005) {
    const ivs = sliceIntervals(parts, t * H).filter(([a, b]) => Math.min(Math.abs(a), Math.abs(b)) < 0.2 * H || (a < 0 && b > 0));
    if (!ivs.length) continue;
    const c = covers(ivs, 0);
    if (!c) sawGap = true;
    else if (sawGap && t > 0.25) { groinY = t * H; break; }
  }
  if (groinY === null) groinY = 0.47 * H;

  // neck: narrowest central cross-section between the shoulders and the head
  let neckY = 0.84 * H, best = Infinity;
  for (let t = 0.76; t <= 0.93; t += 0.005) {
    const ivs = sliceIntervals(parts, t * H);
    const c = ivs.find(([a, b]) => a <= 0 && b >= 0);
    if (!c) continue;
    const w = c[1] - c[0];
    if (w < best - 1e-6) { best = w; neckY = t * H; }
  }
  const chinY = Math.min(0.93 * H, neckY + 0.025 * H);

  // wrists / elbows: extreme vertices left and right above the knees
  const shoulderY = chinY - 0.06 * H;
  let tipL = null, tipR = null;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1];
    if (y < groinY * 0.7) continue;
    if (!tipL || x > tipL.x) tipL = { x, y };
    if (!tipR || x < tipR.x) tipR = { x, y };
  }
  const shoulderX = 0.11 * H;
  const armFrom = (tip, sgn) => {
    const sh = new THREE.Vector2(sgn * shoulderX, shoulderY);
    if (!tip || Math.abs(tip.x) < shoulderX + 0.08 * H) {
      // arms down or missing: assume hanging arms
      return { wrist: new THREE.Vector2(sgn * 0.19 * H, groinY + 0.02 * H), elbow: new THREE.Vector2(sgn * 0.17 * H, (shoulderY + groinY) / 2 + 0.02 * H) };
    }
    const t = new THREE.Vector2(tip.x, tip.y);
    const dir = sh.clone().sub(t).normalize();
    const wrist = t.clone().addScaledVector(dir, 0.1 * H);
    const elbow = sh.clone().lerp(wrist, 0.5);
    return { wrist, elbow };
  };
  const L = armFrom(tipL, 1), R = armFrom(tipR, -1);

  // knees: centre of each leg's cross-section at knee height
  const kneeY = groinY * 0.6;
  const kivs = sliceIntervals(parts, kneeY);
  const legL = kivs.filter(([a, b]) => (a + b) / 2 > 0 && (a + b) / 2 < 0.2 * H);
  const legR = kivs.filter(([a, b]) => (a + b) / 2 < 0 && (a + b) / 2 > -0.2 * H);
  const mid = (arr, fb) => (arr.length ? (Math.min(...arr.map((v) => v[0])) + Math.max(...arr.map((v) => v[1]))) / 2 : fb);
  const kneeLX = mid(legL, 0.05 * H), kneeRX = mid(legR, -0.05 * H);

  const v = (x, y) => ({ x: +x.toFixed(4), y: +y.toFixed(4) });
  return {
    chin: v(0, chinY),
    wrist_L: v(L.wrist.x, L.wrist.y), wrist_R: v(R.wrist.x, R.wrist.y),
    elbow_L: v(L.elbow.x, L.elbow.y), elbow_R: v(R.elbow.x, R.elbow.y),
    knee_L: v(kneeLX, kneeY), knee_R: v(kneeRX, kneeY),
    groin: v(0, groinY),
  };
}

// ---------------------------------------------------------------------------
// 3. skeleton
// ---------------------------------------------------------------------------
function makeZLookup(parts, H) {
  const pos = allPositions(parts);
  // coarse 2D grid in XY storing min/max z -> centre of the body at (x,y)
  const cell = 0.03 * H;
  const grid = new Map();
  for (let i = 0; i < pos.length; i += 3) {
    const k = `${Math.floor(pos[i] / cell)},${Math.floor(pos[i + 1] / cell)}`;
    const z = pos[i + 2];
    const g = grid.get(k);
    if (g) { if (z < g[0]) g[0] = z; if (z > g[1]) g[1] = z; } else grid.set(k, [z, z]);
  }
  const zc = (x, y) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    let lo = Infinity, hi = -Infinity;
    for (let r = 0; r <= 3; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        const g = grid.get(`${cx + dx},${cy + dy}`);
        if (g) { lo = Math.min(lo, g[0]); hi = Math.max(hi, g[1]); }
      }
      if (lo !== Infinity) return (lo + hi) / 2;
    }
    return 0;
  };
  const maxZNear = (x, y, rx, ry) => {
    let best = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      if (Math.abs(pos[i] - x) < rx && Math.abs(pos[i + 1] - y) < ry && pos[i + 2] > best) best = pos[i + 2];
    }
    return best === -Infinity ? null : best;
  };
  return { zc, maxZNear };
}

export function buildSkeleton(markers, parts, H) {
  const { zc, maxZNear } = makeZLookup(parts, H);
  const V = (x, y, z) => new THREE.Vector3(x, y, z === undefined ? zc(x, y) : z);
  const m = markers;
  const gy = m.groin.y, chinY = m.chin.y;
  const hips = V(0, gy + 0.03 * H);
  const neck = V(0, chinY - 0.055 * H);
  const spine = hips.clone().lerp(neck, 0.3); spine.z = zc(0, spine.y);
  const chest = hips.clone().lerp(neck, 0.62); chest.z = zc(0, chest.y);
  const head = V(0, chinY - 0.005 * H);
  const bones = {};
  const def = (name, h, t) => { bones[name] = { name, parent: BONE_PARENT[name], head: h, tail: t }; };

  const arm = (s, sgn) => {
    const e = new THREE.Vector2(m[`elbow_${s}`].x, m[`elbow_${s}`].y);
    const w = new THREE.Vector2(m[`wrist_${s}`].x, m[`wrist_${s}`].y);
    const sj2 = e.clone().multiplyScalar(2).sub(w);
    const sx = sgn > 0 ? Math.max(0.07 * H, sj2.x) : Math.min(-0.07 * H, sj2.x);
    const sy = Math.min(Math.max(sj2.y, chest.y), neck.y + 0.01 * H);
    const sj = V(sx, sy);
    const clav = V(sgn * 0.025 * H, chest.y + (neck.y - chest.y) * 0.75);
    const elbow = V(e.x, e.y), wrist = V(w.x, w.y);
    const handTail = wrist.clone().add(wrist.clone().sub(elbow).multiplyScalar(0.42));
    def(`shoulder_${s}`, clav, sj);
    def(`upperarm_${s}`, sj, elbow);
    def(`forearm_${s}`, elbow, wrist);
    def(`hand_${s}`, wrist, handTail);
  };
  const leg = (s) => {
    const k = m[`knee_${s}`];
    const hipJ = V(k.x * 0.92, gy + 0.005 * H);
    const knee = V(k.x, k.y);
    const ankle = V(k.x, 0.045 * H);
    const toeZ = maxZNear(k.x, 0.03 * H, 0.09 * H, 0.05 * H);
    const toe = new THREE.Vector3(k.x, 0.015 * H, toeZ !== null ? Math.max(ankle.z + 0.04 * H, toeZ - 0.02 * H) : ankle.z + 0.11 * H);
    def(`thigh_${s}`, hipJ, knee);
    def(`shin_${s}`, knee, ankle);
    def(`foot_${s}`, ankle, toe);
  };
  def('hips', hips, spine);
  def('spine', spine, chest);
  def('chest', chest, neck);
  def('neck', neck, head);
  def('head', head, new THREE.Vector3(0, H, head.z));
  arm('L', 1); arm('R', -1);
  leg('L'); leg('R');
  return BONE_NAMES.map((n) => bones[n]);
}

// ---------------------------------------------------------------------------
// 4. skin weights
// ---------------------------------------------------------------------------
function segDist(px, py, pz, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = px - a.x, apy = py - a.y, apz = pz - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 0 ? (apx * abx + apy * aby + apz * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function computeSkinWeights(geometry, boneDefs, H, { smoothIterations = 3, falloff = 0.022 } = {}) {
  const pos = geometry.attributes.position;
  const n = pos.count;
  const B = boneDefs.length;
  const byName = Object.fromEntries(boneDefs.map((b, i) => [b.name, i]));
  const groinY = boneDefs[byName.thigh_L].head.y;
  const kneeY = (boneDefs[byName.shin_L].head.y + boneDefs[byName.shin_R].head.y) / 2;
  const chestY = boneDefs[byName.chest].head.y;
  const regions = boneDefs.map((b) => regionOf(b.name));
  const f = falloff * H;

  // merge coincident vertices (UV seams) so smoothing crosses seams
  const q = 1e4 / H;
  const keyMap = new Map();
  const uniq = new Int32Array(n);
  const up = [];
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let u = keyMap.get(k);
    if (u === undefined) { u = up.length / 3; keyMap.set(k, u); up.push(x, y, z); }
    uniq[i] = u;
  }
  const U = up.length / 3;
  const W = new Float32Array(U * B);
  const allowed = new Uint8Array(B);
  for (let u = 0; u < U; u++) {
    const x = up[u * 3], y = up[u * 3 + 1], z = up[u * 3 + 2];
    const side = 0.015 * H;
    for (let b = 0; b < B; b++) {
      const r = regions[b];
      let ok = true;
      if (r === 'legL') ok = y < groinY + 0.07 * H && x > -side;
      else if (r === 'legR') ok = y < groinY + 0.07 * H && x < side;
      else if (r === 'armL') ok = x > side;
      else if (r === 'armR') ok = x < -side;
      else if (r === 'head') ok = y > chestY;
      else if (r === 'torso') ok = y > kneeY;
      allowed[b] = ok ? 1 : 0;
    }
    let dmin = Infinity;
    const d = new Float32Array(B);
    for (let b = 0; b < B; b++) {
      d[b] = segDist(x, y, z, boneDefs[b].head, boneDefs[b].tail);
      if (allowed[b] && d[b] < dmin) dmin = d[b];
    }
    if (dmin === Infinity) { // nothing allowed (weird geometry) -> nearest overall
      for (let b = 0; b < B; b++) { allowed[b] = 1; dmin = Math.min(dmin, d[b]); }
    }
    let sum = 0;
    for (let b = 0; b < B; b++) {
      if (!allowed[b]) continue;
      const e = (d[b] - dmin) / f;
      if (e > 5) continue;
      const w = Math.exp(-e * e);
      W[u * B + b] = w; sum += w;
    }
    for (let b = 0; b < B; b++) W[u * B + b] /= sum;
  }

  // adjacency over unique vertices
  const idx = geometry.index;
  const triCount = idx ? idx.count / 3 : n / 3;
  const nb = Array.from({ length: U }, () => new Set());
  for (let t = 0; t < triCount; t++) {
    const a = uniq[idx ? idx.getX(t * 3) : t * 3], b = uniq[idx ? idx.getX(t * 3 + 1) : t * 3 + 1], c = uniq[idx ? idx.getX(t * 3 + 2) : t * 3 + 2];
    nb[a].add(b); nb[a].add(c); nb[b].add(a); nb[b].add(c); nb[c].add(a); nb[c].add(b);
  }
  const nbArr = nb.map((s) => Int32Array.from(s));
  let cur = W, next = new Float32Array(U * B);
  for (let it = 0; it < smoothIterations; it++) {
    for (let u = 0; u < U; u++) {
      const ns = nbArr[u];
      if (!ns.length) { for (let b = 0; b < B; b++) next[u * B + b] = cur[u * B + b]; continue; }
      for (let b = 0; b < B; b++) {
        let s = 0;
        for (let j = 0; j < ns.length; j++) s += cur[ns[j] * B + b];
        next[u * B + b] = 0.5 * cur[u * B + b] + (0.5 * s) / ns.length;
      }
    }
    [cur, next] = [next, cur];
  }

  // top-4 per vertex
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const topI = new Int32Array(4), topW = new Float32Array(4);
  const uTop = new Array(U);
  for (let u = 0; u < U; u++) {
    topI.fill(0); topW.fill(0);
    for (let b = 0; b < B; b++) {
      const w = cur[u * B + b];
      if (w <= topW[3]) continue;
      let k = 3;
      while (k > 0 && topW[k - 1] < w) { topW[k] = topW[k - 1]; topI[k] = topI[k - 1]; k--; }
      topW[k] = w; topI[k] = b;
    }
    let s = topW[0] + topW[1] + topW[2] + topW[3];
    if (s <= 0) { topW[0] = 1; s = 1; }
    uTop[u] = [topI[0], topI[1], topI[2], topI[3], topW[0] / s, topW[1] / s, topW[2] / s, topW[3] / s];
  }
  for (let i = 0; i < n; i++) {
    const t = uTop[uniq[i]];
    for (let k = 0; k < 4; k++) { skinIndex[i * 4 + k] = t[k]; skinWeight[i * 4 + k] = t[4 + k]; }
  }
  return { skinIndex, skinWeight };
}

// ---------------------------------------------------------------------------
// 5. rig object
// ---------------------------------------------------------------------------
export function createRig(parts, boneDefs, H, opts = {}) {
  const root = new THREE.Group();
  root.name = opts.name || 'RiggedCharacter';
  const bones = {};
  for (const d of boneDefs) {
    const b = new THREE.Bone();
    b.name = d.name;
    bones[d.name] = b;
  }
  for (const d of boneDefs) {
    const b = bones[d.name];
    if (d.parent) {
      const p = boneDefs.find((x) => x.name === d.parent);
      b.position.copy(d.head).sub(p.head);
      bones[d.parent].add(b);
    } else {
      b.position.copy(d.head);
      root.add(b);
    }
  }
  root.updateMatrixWorld(true);
  const boneList = boneDefs.map((d) => bones[d.name]);
  const skeleton = new THREE.Skeleton(boneList);
  const meshes = [];
  for (const p of parts) {
    const g = p.geometry.clone();
    const { skinIndex, skinWeight } = computeSkinWeights(g, boneDefs, H, opts);
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
    const mat = Array.isArray(p.material) ? p.material.map((mm) => mm.clone()) : (p.material ? p.material.clone() : new THREE.MeshPhongMaterial({ color: 0xbbbbbb }));
    const sm = new THREE.SkinnedMesh(g, mat);
    sm.name = p.name;
    sm.castShadow = true; sm.receiveShadow = true;
    sm.frustumCulled = false; // skinned bounds move with the pose
    root.add(sm);
    sm.bind(skeleton, sm.matrixWorld);
    meshes.push(sm);
  }
  root.userData.rig = { type: 'spud-humanoid', height: H };
  return { root, skeleton, bones, meshes };
}

// One-shot convenience: object -> rigged Group
export function autoRig(object, { targetHeight = 1.8, rotateY = 0, markers = null, smoothIterations = 3 } = {}) {
  const { parts, height } = prepareModel(object, { targetHeight, rotateY });
  const mk = markers || detectMarkers(parts, height);
  const boneDefs = buildSkeleton(mk, parts, height);
  const rig = createRig(parts, boneDefs, height, { smoothIterations });
  return { ...rig, markers: mk, boneDefs, parts, height };
}
