import * as THREE from 'three';

// Lightweight physics tuned for cheap CPUs:
//  * static colliders are either AABBs ('box') or triangle meshes queried by
//    raycasts ('mesh': ramps, stairs, rotated or imported geometry)
//  * the character is a capsule approximated by an AABB, moved with
//    axis-separated sweeps, step-up and slope-walking via ground raycasts
//  * dynamic bodies are AABBs with gravity, bounce, friction and simple
//    body-body separation; the player can push them.

const BOXY = new Set(['box', 'cylinder', 'crate', 'barrel', 'capsule', 'sphere']);
const _box = new THREE.Box3(), _v = new THREE.Vector3(), _ray = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);

export class Physics {
  constructor(world) {
    this.world = world;
    this.statics = [];    // {box, entry}
    this.meshColliders = []; // Object3D list for raycasts
    this.bodies = [];     // dynamic
    this.gravity = -18;
  }

  collisionMode(e) {
    const p = e.data.props;
    if (e.data.type !== 'mesh' || p.collision === 'none' || p.physics === 'none') return 'none';
    if (p.collision === 'box' || p.collision === 'mesh') return p.collision;
    const r = e.data.transform.r;
    const tilted = Math.abs(r[0] % 360) > 1 || Math.abs(r[2] % 360) > 1;
    if (p.asset) return 'mesh';
    return BOXY.has(p.shape) && !tilted ? 'box' : 'mesh';
  }

  rebuild() {
    this.statics = []; this.meshColliders = []; this.bodies = [];
    for (const e of this.world.actors.values()) this.register(e);
    for (const t of this.world.terrains) if (t.entry.terrainMesh) this.meshColliders.push(t.entry.terrainMesh);
  }

  register(e) {
    if (e.data.type === 'foliage' && e.data.props.collision && e.instances) {
      for (const inst of e.instances) {
        const r = 0.25 * inst.scale;
        this.statics.push({ box: new THREE.Box3(new THREE.Vector3(inst.pos.x - r, inst.pos.y, inst.pos.z - r), new THREE.Vector3(inst.pos.x + r, inst.pos.y + 3 * inst.scale, inst.pos.z + r)), entry: e });
      }
      return;
    }
    const mode = this.collisionMode(e);
    if (mode === 'none') return;
    e.obj.updateMatrixWorld(true);
    if (e.data.props.physics === 'dynamic') {
      const box = new THREE.Box3().setFromObject(e.obj);
      const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      const center = box.getCenter(new THREE.Vector3());
      this.bodies.push({
        entry: e, half, offset: center.clone().sub(e.obj.position), vel: new THREE.Vector3(), angVel: new THREE.Vector3(),
        mass: Math.max(0.1, e.data.props.mass || 1), bounce: e.data.props.bounciness ?? 0.2, grounded: false, sleep: 0,
      });
      return;
    }
    if (mode === 'box') this.statics.push({ box: new THREE.Box3().setFromObject(e.obj), entry: e });
    else e.obj.traverse((o) => { if (o.isMesh && !o.userData.editorOnly) this.meshColliders.push(o); });
  }

  unregister(e) {
    this.statics = this.statics.filter((s) => s.entry !== e);
    this.bodies = this.bodies.filter((b) => b.entry !== e);
    const meshes = new Set(); e.obj.traverse((o) => meshes.add(o));
    this.meshColliders = this.meshColliders.filter((m) => !meshes.has(m));
  }

  // Call when a blueprint moves a static actor.
  refreshStatic(e) {
    for (const s of this.statics) if (s.entry === e) { e.obj.updateMatrixWorld(true); s.box.setFromObject(e.obj); }
  }

  raycast(origin, dir, far, { includeBodies = true } = {}) {
    _ray.set(origin, dir); _ray.far = far;
    let best = null;
    const hits = _ray.intersectObjects(this.meshColliders, false);
    if (hits.length) best = { distance: hits[0].distance, point: hits[0].point.clone(), normal: hits[0].face ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld) : new THREE.Vector3(0, 1, 0), object: hits[0].object };
    const test = (box, entry) => {
      const p = _ray.ray.intersectBox(box, _v);
      if (p) { const d = p.distanceTo(origin); if (d <= far && (!best || d < best.distance)) best = { distance: d, point: p.clone(), normal: new THREE.Vector3(0, 1, 0), entry }; }
    };
    for (const s of this.statics) test(s.box, s.entry);
    if (includeBodies) for (const b of this.bodies) test(this.bodyBox(b, _box).clone(), b.entry);
    return best;
  }

  bodyBox(b, out) {
    const c = _v.copy(b.entry.obj.position).add(b.offset);
    return out.set(c.clone().sub(b.half), c.clone().add(b.half));
  }

  // Highest walkable surface below `pos` within `maxUp` above the feet.
  // `foot` is the footprint half-size: boxes count as ground if any part of the
  // footprint overlaps them, so characters don't fall off when half on a ledge.
  groundHeight(x, y, z, maxUp = 0.45, ignore = null, foot = 0) {
    let g = this.world.terrainHeight(x, z);
    if (g !== null && g > y + maxUp) g = null;
    const top = y + maxUp;
    const under = (b) => x + foot >= b.min.x && x - foot <= b.max.x && z + foot >= b.min.z && z - foot <= b.max.z && b.max.y <= top + 1e-4 && (g === null || b.max.y > g);
    for (const s of this.statics) if (under(s.box)) g = s.box.max.y;
    for (const bd of this.bodies) {
      if (bd === ignore) continue;
      const b = this.bodyBox(bd, _box);
      if (under(b)) g = b.max.y;
    }
    if (this.meshColliders.length) {
      _ray.set(new THREE.Vector3(x, top, z), DOWN); _ray.far = 50;
      const hits = _ray.intersectObjects(this.meshColliders, false);
      for (const h of hits) {
        if (h.object.userData.isTerrain) continue; // terrain handled analytically
        if (g === null || h.point.y > g) g = h.point.y;
        break;
      }
    }
    return g;
  }

  // Resolve horizontal movement against AABBs; returns the corrected delta.
  sweepBoxes(pos, delta, r, h, stepH, list) {
    const out = delta.clone();
    for (const axis of ['x', 'z']) {
      if (!out[axis]) continue;
      const np = pos.clone(); np[axis] += out[axis];
      const min = new THREE.Vector3(np.x - r, np.y + stepH, np.z - r), max = new THREE.Vector3(np.x + r, np.y + h, np.z + r);
      for (const b of list) {
        if (max.x <= b.min.x || min.x >= b.max.x || max.y <= b.min.y || min.y >= b.max.y || max.z <= b.min.z || min.z >= b.max.z) continue;
        // blocked: clamp to the face
        if (out[axis] > 0) out[axis] = Math.max(0, b.min[axis] - r - pos[axis] - 1e-3);
        else out[axis] = Math.min(0, b.max[axis] + r - pos[axis] + 1e-3);
      }
      pos = pos.clone(); pos[axis] += out[axis];
    }
    return out;
  }

  moveCharacter(ch, dt) {
    const { pos, vel } = ch;
    const r = ch.radius, h = ch.height, stepH = 0.4;
    // horizontal
    const delta = new THREE.Vector3(vel.x * dt, 0, vel.z * dt);
    const boxes = this.statics.map((s) => s.box);
    for (const bd of this.bodies) boxes.push(this.bodyBox(bd, new THREE.Box3()));
    let d = this.sweepBoxes(pos, delta, r, h, stepH, boxes);
    // mesh walls: two rays (knee + chest) along the movement
    const len = Math.hypot(d.x, d.z);
    if (len > 1e-5 && this.meshColliders.length) {
      const dir = new THREE.Vector3(d.x / len, 0, d.z / len);
      for (const hgt of [stepH + 0.1, h * 0.8]) {
        const hit = this.raycastMeshes(new THREE.Vector3(pos.x, pos.y + hgt, pos.z), dir, len + r);
        if (hit && hit.normal.y < 0.6) {
          const n = hit.normal.clone().setY(0).normalize();
          const into = d.dot(n);
          if (into < 0) d.addScaledVector(n, -into);
          const allow = Math.max(0, hit.distance - r);
          if (d.length() > allow + 1e-4 && d.dot(dir) > allow) d.setLength(Math.min(d.length(), Math.max(0, allow)));
        }
      }
    }
    // pushing dynamic bodies
    if (len > 1e-5) {
      for (const bd of this.bodies) {
        const b = this.bodyBox(bd, _box);
        const near = pos.x + r + 0.08 > b.min.x && pos.x - r - 0.08 < b.max.x && pos.z + r + 0.08 > b.min.z && pos.z - r - 0.08 < b.max.z && pos.y + h > b.min.y && pos.y + stepH < b.max.y;
        if (near) {
          const push = new THREE.Vector3(vel.x, 0, vel.z).multiplyScalar(1.5 / bd.mass);
          bd.vel.x = push.x; bd.vel.z = push.z; bd.sleep = 0;
        }
      }
    }
    pos.x += d.x; pos.z += d.z;
    // vertical
    vel.y += this.gravity * dt;
    let ny = pos.y + vel.y * dt;
    const ground = this.groundHeight(pos.x, pos.y, pos.z, stepH, null, r * 0.6);
    ch.grounded = false;
    if (ground !== null && ny <= ground + 0.02 && vel.y <= 0) {
      // snap down slopes / steps when grounded
      ny = ground; vel.y = 0; ch.grounded = true;
    } else if (ground !== null && ch.wasGrounded && vel.y <= 0 && pos.y - ground < 0.35) {
      ny = ground; vel.y = 0; ch.grounded = true;
    }
    // ceiling
    if (vel.y > 0) {
      for (const b of boxes) {
        if (pos.x + r > b.min.x && pos.x - r < b.max.x && pos.z + r > b.min.z && pos.z - r < b.max.z && pos.y + h <= b.min.y + 1e-3 && ny + h > b.min.y) { ny = b.min.y - h; vel.y = 0; }
      }
    }
    pos.y = ny;
    ch.wasGrounded = ch.grounded;
    return ch.grounded;
  }

  raycastMeshes(origin, dir, far) {
    _ray.set(origin, dir); _ray.far = far;
    const hits = _ray.intersectObjects(this.meshColliders, false);
    if (!hits.length) return null;
    const h = hits[0];
    return { distance: h.distance, point: h.point, normal: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0) };
  }

  stepBodies(dt) {
    const g = this.gravity;
    for (const bd of this.bodies) {
      if (!bd.entry.obj.parent) continue;
      if (bd.sleep > 60 && bd.vel.lengthSq() < 1e-4) continue;
      const o = bd.entry.obj;
      bd.vel.y += g * dt;
      const c = o.position.clone().add(bd.offset);
      // horizontal against statics
      const others = this.statics.map((s) => s.box);
      for (const ob of this.bodies) if (ob !== bd) others.push(this.bodyBox(ob, new THREE.Box3()));
      const d = this.sweepBoxes(new THREE.Vector3(c.x, c.y - bd.half.y, c.z), new THREE.Vector3(bd.vel.x * dt, 0, bd.vel.z * dt), Math.max(bd.half.x, bd.half.z) * 0.9, bd.half.y * 2, 0.05, others);
      if (Math.abs(d.x) < Math.abs(bd.vel.x * dt) - 1e-5) bd.vel.x *= -bd.bounce;
      if (Math.abs(d.z) < Math.abs(bd.vel.z * dt) - 1e-5) bd.vel.z *= -bd.bounce;
      o.position.x += d.x; o.position.z += d.z;
      // vertical
      const bottom = c.y - bd.half.y;
      let nb = bottom + bd.vel.y * dt;
      const ground = this.groundHeight(o.position.x + bd.offset.x, bottom, o.position.z + bd.offset.z, 0.3, bd);
      bd.grounded = false;
      if (ground !== null && nb <= ground) {
        nb = ground;
        bd.vel.y = Math.abs(bd.vel.y) > 1.5 ? -bd.vel.y * bd.bounce : 0;
        bd.grounded = true;
        bd.vel.x *= Math.pow(0.02, dt); bd.vel.z *= Math.pow(0.02, dt); // friction
      }
      o.position.y += nb - bottom;
      if (bd.vel.lengthSq() < 1e-3 && bd.grounded) bd.sleep++; else bd.sleep = 0;
    }
  }

  bodyFor(e) { return this.bodies.find((b) => b.entry === e) || null; }
}
