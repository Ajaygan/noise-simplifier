import * as THREE from 'three';
import { DEG, clamp, lerp } from './util.js';

// Procedural humanoid animation. Works on skeletons made by the auto-rigger
// *and* on common third-party naming (Mixamo, UE mannequin, Blender rigify-ish)
// because every rotation is expressed in model space and converted into each
// bone's own rest frame. If the model ships with real animation clips named
// idle/walk/run/jump, those are used instead (see CharacterAnimator).

const ALIASES = {
  hips: ['hips', 'pelvis', 'mixamorighips', 'hip', 'root_pelvis'],
  spine: ['spine', 'spine01', 'mixamorigspine', 'spine_01'],
  chest: ['chest', 'spine2', 'spine02', 'spine03', 'mixamorigspine2', 'mixamorigspine1', 'spine_02', 'upperchest'],
  neck: ['neck', 'mixamorigneck', 'neck01', 'neck_01'],
  head: ['head', 'mixamorighead'],
  shoulder_L: ['shoulder_l', 'leftshoulder', 'mixamorigleftshoulder', 'clavicle_l', 'l_clavicle', 'shoulderl', 'claviclel'],
  upperarm_L: ['upperarm_l', 'leftarm', 'mixamorigleftarm', 'upper_arm_l', 'l_upperarm', 'upperarml', 'arml'],
  forearm_L: ['forearm_l', 'leftforearm', 'mixamorigleftforearm', 'lowerarm_l', 'l_forearm', 'forearml', 'lowerarml'],
  hand_L: ['hand_l', 'lefthand', 'mixamoriglefthand', 'l_hand', 'handl'],
  shoulder_R: ['shoulder_r', 'rightshoulder', 'mixamorigrightshoulder', 'clavicle_r', 'r_clavicle', 'shoulderr', 'clavicler'],
  upperarm_R: ['upperarm_r', 'rightarm', 'mixamorigrightarm', 'upper_arm_r', 'r_upperarm', 'upperarmr', 'armr'],
  forearm_R: ['forearm_r', 'rightforearm', 'mixamorigrightforearm', 'lowerarm_r', 'r_forearm', 'forearmr', 'lowerarmr'],
  hand_R: ['hand_r', 'righthand', 'mixamorigrighthand', 'r_hand', 'handr'],
  thigh_L: ['thigh_l', 'leftupleg', 'mixamorigleftupleg', 'l_thigh', 'upperleg_l', 'thighl', 'upperlegl'],
  shin_L: ['shin_l', 'leftleg', 'mixamorigleftleg', 'calf_l', 'l_calf', 'lowerleg_l', 'shinl', 'calfl', 'lowerlegl'],
  foot_L: ['foot_l', 'leftfoot', 'mixamorigleftfoot', 'l_foot', 'footl'],
  thigh_R: ['thigh_r', 'rightupleg', 'mixamorigrightupleg', 'r_thigh', 'upperleg_r', 'thighr', 'upperlegr'],
  shin_R: ['shin_r', 'rightleg', 'mixamorigrightleg', 'calf_r', 'r_calf', 'lowerleg_r', 'shinr', 'calfr', 'lowerlegr'],
  foot_R: ['foot_r', 'rightfoot', 'mixamorigrightfoot', 'r_foot', 'footr'],
};

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/^armature_?/, '');

export function findHumanoidBones(root) {
  const bones = [];
  root.traverse((o) => { if (o.isBone) bones.push(o); });
  if (!bones.length) return null;
  const out = {};
  for (const [std, names] of Object.entries(ALIASES)) {
    const found = bones.find((b) => names.includes(norm(b.name))) ||
      bones.find((b) => names.some((n) => norm(b.name).replace(/_/g, '') === n.replace(/_/g, '')));
    if (found) out[std] = found;
  }
  const required = ['hips', 'upperarm_L', 'upperarm_R', 'thigh_L', 'thigh_R', 'shin_L', 'shin_R'];
  return required.every((k) => out[k]) ? out : null;
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

export class ProceduralAnimator {
  constructor(root) {
    this.root = root;
    this.bones = findHumanoidBones(root);
    this.ok = !!this.bones;
    this.time = 0; this.phase = 0; this.speed = 0; this.air = 0; this.wave = 0;
    this.state = 'idle';
    if (!this.ok) return;
    root.updateMatrixWorld(true);
    const rootInv = new THREE.Quaternion();
    root.getWorldQuaternion(rootInv).invert();
    this.rest = {};
    for (const [k, b] of Object.entries(this.bones)) {
      const w = new THREE.Quaternion();
      b.getWorldQuaternion(w);
      w.premultiply(rootInv); // rest world rotation in model space
      const parentW = new THREE.Quaternion();
      if (b.parent) { b.parent.getWorldQuaternion(parentW); parentW.premultiply(rootInv); }
      this.rest[k] = { local: b.quaternion.clone(), world: w, parentWorld: parentW, pos: b.position.clone() };
    }
    // Arm rest direction: how far do we have to rotate to bring arms down?
    this.armDrop = {};
    for (const s of ['L', 'R']) {
      const ua = this.bones[`upperarm_${s}`], fa = this.bones[`forearm_${s}`];
      if (!fa) { this.armDrop[s] = 0; continue; }
      ua.getWorldPosition(_v); fa.getWorldPosition(_v2);
      root.worldToLocal(_v); root.worldToLocal(_v2);
      const d = _v2.sub(_v);
      const ang = Math.atan2(d.y, Math.abs(d.x)); // 0 = T-pose, negative = arms down
      this.armDrop[s] = (-72 * DEG) - ang;
    }
    const hipsW = new THREE.Vector3();
    this.bones.hips.getWorldPosition(hipsW); root.worldToLocal(hipsW);
    this.hipHeight = Math.max(0.2, hipsW.y);
  }

  // Apply a model-space rotation (euler, radians) to a bone relative to rest.
  setRot(name, x, y, z) {
    const b = this.bones[name];
    if (!b) return;
    const r = this.rest[name];
    _e.set(x, y, z, 'XYZ');
    _q.setFromEuler(_e);
    // delta expressed in the bone's rest frame: W^-1 * D * W
    _q2.copy(r.world).invert().multiply(_q).multiply(r.world);
    b.quaternion.copy(r.local).multiply(_q2);
  }

  update(dt, { speed = 0, grounded = true, runSpeed = 6, waving = false } = {}) {
    if (!this.ok) return;
    this.time += dt;
    this.speed = lerp(this.speed, speed, 1 - Math.exp(-dt * 10));
    this.air = lerp(this.air, grounded ? 0 : 1, 1 - Math.exp(-dt * 12));
    this.wave = lerp(this.wave, waving ? 1 : 0, 1 - Math.exp(-dt * 6));
    const sp = this.speed;
    const moveT = clamp(sp / 1.2, 0, 1);
    const runT = clamp((sp - 2.5) / (runSpeed - 2.5), 0, 1);
    const stride = lerp(1.9, 2.4, runT);
    this.phase += dt * (sp > 0.05 ? (sp / stride) * Math.PI * 2 * 0.5 : 0);
    const p = this.phase, t = this.time;
    const s = Math.sin(p), c = Math.cos(p);
    const breathe = Math.sin(t * 1.8) * 0.02 * (1 - moveT);

    const legAmp = lerp(0.45, 0.8, runT) * moveT;
    const kneeAmp = lerp(0.7, 1.35, runT) * moveT;
    const armAmp = lerp(0.35, 0.9, runT) * moveT;
    const lean = lerp(0.04, 0.22, runT) * moveT;

    // legs
    const legL = -s * legAmp, legR = s * legAmp;
    const kneeL = Math.max(0, Math.sin(p + 1.4)) * kneeAmp + 0.05;
    const kneeR = Math.max(0, Math.sin(p + Math.PI + 1.4)) * kneeAmp + 0.05;
    const airTuck = this.air;
    this.setRot('thigh_L', lerp(legL, -0.9, airTuck * 0.6), 0, 0);
    this.setRot('thigh_R', lerp(legR, -0.2, airTuck * 0.6), 0, 0);
    this.setRot('shin_L', lerp(kneeL, 1.3, airTuck * 0.6), 0, 0);
    this.setRot('shin_R', lerp(kneeR, 0.5, airTuck * 0.6), 0, 0);
    this.setRot('foot_L', -Math.max(0, -legL) * 0.3, 0, 0);
    this.setRot('foot_R', -Math.max(0, -legR) * 0.3, 0, 0);

    // torso
    this.setRot('spine', lean + breathe, s * 0.08 * moveT, 0);
    this.setRot('chest', breathe * 0.5, -s * 0.12 * moveT, 0);
    this.setRot('neck', -lean * 0.5, s * 0.04 * moveT, 0);
    this.setRot('head', Math.sin(t * 0.7) * 0.03 * (1 - moveT), Math.sin(t * 0.5) * 0.08 * (1 - moveT), 0);

    // arms: drop from T-pose, swing opposite to legs
    const armIdle = Math.sin(t * 1.8) * 0.03 * (1 - moveT);
    const airRaise = airTuck * 0.9;
    for (const [side, sg, swing] of [['L', 1, s], ['R', -1, -s]]) {
      let drop = (this.armDrop[side] || 0) + airRaise;
      let fwd = swing * armAmp;
      let elbowBend = lerp(0.15, 1.2, runT * moveT) + armIdle;
      if (side === 'R' && this.wave > 0.01) {
        const w = this.wave;
        drop = lerp(drop, 1.25, w);
        fwd = lerp(fwd, 0, w);
        elbowBend = lerp(elbowBend, 0.3 + Math.sin(t * 9) * 0.35, w);
      }
      this.setRot(`upperarm_${side}`, fwd, 0, sg * drop);
      // elbow bends forward: rotate around the arm's local-ish up axis
      this.setRot(`forearm_${side}`, 0, -sg * elbowBend, 0);
      this.setRot(`shoulder_${side}`, 0, 0, sg * (0.03 * moveT * swing));
    }

    // root bob
    const hips = this.bones.hips, rp = this.rest.hips.pos;
    const bob = (Math.abs(c) * 0.05 * moveT + breathe * 0.3) * (this.hipHeight / 0.95);
    hips.position.set(rp.x, rp.y + bob * (1 - airTuck) - moveT * 0.02 * (this.hipHeight / 0.95), rp.z);
  }

  reset() {
    if (!this.ok) return;
    for (const [k, b] of Object.entries(this.bones)) { b.quaternion.copy(this.rest[k].local); b.position.copy(this.rest[k].pos); }
  }
}

// Uses real clips if the model has them, otherwise the procedural animator.
export class CharacterAnimator {
  constructor(root, clips = []) {
    this.root = root;
    const byName = (re) => clips.find((c) => re.test(c.name));
    this.clips = { idle: byName(/idle/i), walk: byName(/walk/i), run: byName(/run|sprint|jog/i), jump: byName(/jump|fall/i) };
    this.useClips = !!(this.clips.idle && (this.clips.walk || this.clips.run));
    if (this.useClips) {
      this.mixer = new THREE.AnimationMixer(root);
      this.actions = {};
      for (const [k, c] of Object.entries(this.clips)) if (c) { const a = this.mixer.clipAction(c); a.play(); a.weight = 0; this.actions[k] = a; }
      this.actions.idle.weight = 1;
    } else {
      this.proc = new ProceduralAnimator(root);
    }
  }

  get ok() { return this.useClips || this.proc?.ok; }

  update(dt, st) {
    if (this.useClips) {
      const sp = st.speed || 0;
      const target = !st.grounded && this.actions.jump ? 'jump' : sp > 3.5 && this.actions.run ? 'run' : sp > 0.3 ? (this.actions.walk ? 'walk' : 'run') : 'idle';
      for (const [k, a] of Object.entries(this.actions)) a.weight = lerp(a.weight, k === target ? 1 : 0, 1 - Math.exp(-dt * 8));
      this.mixer.update(dt);
    } else if (this.proc?.ok) this.proc.update(dt, st);
  }
}
