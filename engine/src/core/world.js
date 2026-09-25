import * as THREE from 'three';
import { makeMaterial, convertImportedMaterial } from './materials.js';
import { getShapeGeometry, isPrefab } from './shapes.js';
import { Terrain } from './terrain.js';
import { ParticleEmitter } from './particles.js';
import { CharacterAnimator } from './anim.js';
import { applyAutoLOD } from './lod.js';
import { DEG, rng, deepClone } from './util.js';
import { ACTOR_TYPES } from './actors.js';
import { DEFAULT_SETTINGS } from './project.js';

const SKY_VERT = /* glsl */`varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`;
const SKY_FRAG = /* glsl */`
uniform vec3 top, horizon, bottom, sunColor, sunDir; uniform float sunSize, showSun;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.6)) : mix(horizon, bottom, pow(-h, 0.4));
  float s = max(dot(d, normalize(sunDir)), 0.0);
  c += sunColor * (pow(s, 900.0 / sunSize) * 3.0 + pow(s, 12.0) * 0.25) * showSun;
  gl_FragColor = vec4(c, 1.0);
}`;

// Vector versions of the editor icons (symbol fonts are often missing on low-end systems).
const ICON_PATHS = {
  '☀': (g) => { g.beginPath(); g.arc(32, 32, 9, 0, Math.PI * 2); g.fill(); g.lineWidth = 3; for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; g.beginPath(); g.moveTo(32 + Math.cos(a) * 13, 32 + Math.sin(a) * 13); g.lineTo(32 + Math.cos(a) * 19, 32 + Math.sin(a) * 19); g.stroke(); } },
  '⚑': (g) => { g.lineWidth = 3; g.beginPath(); g.moveTo(24, 48); g.lineTo(24, 16); g.stroke(); g.beginPath(); g.moveTo(25, 16); g.lineTo(44, 22); g.lineTo(25, 30); g.closePath(); g.fill(); },
  '🌲': (g) => { g.beginPath(); g.moveTo(32, 12); g.lineTo(44, 30); g.lineTo(20, 30); g.closePath(); g.moveTo(32, 20); g.lineTo(47, 42); g.lineTo(17, 42); g.closePath(); g.fill(); g.fillRect(29, 42, 6, 8); },
  '✦': (g) => { g.beginPath(); g.moveTo(32, 12); g.lineTo(37, 27); g.lineTo(52, 32); g.lineTo(37, 37); g.lineTo(32, 52); g.lineTo(27, 37); g.lineTo(12, 32); g.lineTo(27, 27); g.closePath(); g.fill(); },
  '♪': (g) => { g.beginPath(); g.ellipse(26, 43, 7, 5, -0.4, 0, Math.PI * 2); g.fill(); g.lineWidth = 3; g.beginPath(); g.moveTo(32, 42); g.lineTo(32, 16); g.lineTo(42, 22); g.stroke(); },
};

function iconSprite(glyph, color = '#ffffff') {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(20,24,32,0.75)'; g.beginPath(); g.arc(32, 32, 28, 0, Math.PI * 2); g.fill();
  g.strokeStyle = color; g.lineWidth = 3; g.stroke();
  g.fillStyle = color; g.strokeStyle = color;
  const draw = ICON_PATHS[glyph];
  if (draw) draw(g);
  else { g.font = 'bold 32px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(glyph, 32, 34); }
  const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: true, transparent: true, fog: false });
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(0.8);
  s.userData.editorOnly = true;
  return s;
}

function textSprite(text, color, bg, size) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const fs = 48;
  g.font = `bold ${fs}px sans-serif`;
  const lines = String(text).split('\n');
  const w = Math.max(...lines.map((l) => g.measureText(l).width)) + 32;
  const h = lines.length * fs * 1.2 + 20;
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height); }
  g.font = `bold ${fs}px sans-serif`; g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  lines.forEach((l, i) => g.fillText(l, c.width / 2, 10 + fs * 0.6 + i * fs * 1.2));
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const s = new THREE.Sprite(mat);
  s.scale.set((c.width / c.height) * size * 0.5 * lines.length ** 0, size * 0.5 * (c.height / (fs * 1.6)), 1);
  s.scale.x = s.scale.y * (c.width / c.height);
  return s;
}

export class World {
  constructor({ quality, assets, mode = 'editor' }) {
    this.quality = quality;
    this.assets = assets;
    this.mode = mode; // 'editor' | 'game'
    this.scene = new THREE.Scene();
    this.actors = new Map();
    this.settings = deepClone(DEFAULT_SETTINGS);
    this.terrains = [];
    this.time = 0;
    this.focus = new THREE.Vector3();

    this.hemi = new THREE.HemisphereLight(0xbcd4ff, 0x5a4a3a, 0.6);
    this.scene.add(this.hemi);
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, bottom: { value: new THREE.Color() },
        sunColor: { value: new THREE.Color(1, 0.95, 0.8) }, sunDir: { value: new THREE.Vector3(0.3, 0.6, 0.2) },
        sunSize: { value: 1 }, showSun: { value: 1 },
      },
    }));
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    this.sky.userData.isSky = true;
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog(0xbcd4e6, 40, 220);
    this.root = new THREE.Group();
    this.root.name = 'Actors';
    this.scene.add(this.root);
  }

  // ---------------- settings / quality ----------------
  applySettings(settings) {
    this.settings = { ...deepClone(DEFAULT_SETTINGS), ...deepClone(settings || {}) };
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof DEFAULT_SETTINGS[k] === 'object' && !Array.isArray(DEFAULT_SETTINGS[k])) this.settings[k] = { ...DEFAULT_SETTINGS[k], ...(settings?.[k] || {}) };
    }
    const s = this.settings;
    const u = this.sky.material.uniforms;
    u.top.value.set(s.sky.top); u.horizon.value.set(s.sky.horizon); u.bottom.value.set(s.sky.bottom);
    u.sunColor.value.set(s.sky.sunColor); u.showSun.value = s.sky.showSun ? 1 : 0; u.sunSize.value = s.sky.sunSize || 1;
    this.hemi.color.set(s.ambient.sky); this.hemi.groundColor.set(s.ambient.ground); this.hemi.intensity = s.ambient.intensity;
    this.applyFog();
  }

  applyFog() {
    const s = this.settings, q = this.quality;
    if (s.fog.enabled) {
      this.scene.fog = this.scene.fog || new THREE.Fog();
      this.scene.fog.color.set(s.fog.color);
      this.scene.fog.near = Math.min(s.fog.near, q.drawDistance * 0.5);
      this.scene.fog.far = Math.min(s.fog.far, q.drawDistance);
    } else {
      // Even with fog "off", fade at the draw distance so culling never pops.
      this.scene.fog = new THREE.Fog(s.fog.color, q.drawDistance * 0.8, q.drawDistance);
    }
    this.scene.background = null;
  }

  async setQuality(q) {
    this.quality = q;
    this.applyFog();
    const ids = [...this.actors.keys()];
    await Promise.all(ids.map((id) => this.rebuildActor(id)));
  }

  // ---------------- load / serialize ----------------
  async load(project) {
    this.clear();
    this.applySettings(project.settings);
    const order = (a) => (a.type === 'terrain' ? 0 : a.type === 'foliage' ? 2 : 1);
    const list = [...(project.actors || [])].sort((a, b) => order(a) - order(b));
    const terrains = list.filter((a) => a.type === 'terrain');
    for (const a of terrains) await this.addActor(a);
    await Promise.all(list.filter((a) => a.type !== 'terrain').map((a) => this.addActor(a)));
  }

  clear() {
    for (const id of [...this.actors.keys()]) this.removeActor(id);
    this.terrains = [];
  }

  serializeActors() {
    return [...this.actors.values()].map((e) => {
      if (e.terrain) Object.assign(e.data.props, e.terrain.serialize());
      return deepClone(e.data);
    });
  }

  // ---------------- actors ----------------
  async addActor(data) {
    const obj = new THREE.Group();
    obj.name = data.name;
    obj.userData.actorId = data.id;
    const entry = { id: data.id, data, obj, parts: [], ready: null };
    this.actors.set(data.id, entry);
    this.root.add(obj);
    this.applyTransform(data.id);
    entry.ready = this.buildVisual(entry);
    await entry.ready;
    return entry;
  }

  removeActor(id) {
    const e = this.actors.get(id);
    if (!e) return;
    this.disposeVisual(e);
    this.root.remove(e.obj);
    this.actors.delete(id);
  }

  async rebuildActor(id) {
    const e = this.actors.get(id);
    if (!e) return;
    if (e.terrain) Object.assign(e.data.props, e.terrain.serialize());
    this.disposeVisual(e);
    e.obj.name = e.data.name;
    this.applyTransform(id);
    e.ready = this.buildVisual(e);
    await e.ready;
    return e;
  }

  disposeVisual(e) {
    for (const c of [...e.obj.children]) {
      e.obj.remove(c);
      c.traverse((o) => {
        if (o.isLight && o.shadow?.map) o.shadow.map.dispose();
        if (o.userData.ownGeometry && o.geometry) o.geometry.dispose();
        if (o.material && o.userData.ownMaterial !== false) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => { if (m.userData?.spud || o.userData.editorOnly) m.dispose(); });
        }
      });
    }
    for (const part of e.parts) {
      part.removeFromParent();
      if (part.isLight && part.shadow?.map) part.shadow.map.dispose();
    }
    if (e.terrain) { this.terrains = this.terrains.filter((t) => t.entry !== e); e.terrain.dispose(); e.terrain = null; }
    e.emitter = null; e.animator = null; e.light = null; e.water = null; e.parts = [];
  }

  applyTransform(id) {
    const e = this.actors.get(id);
    if (!e) return;
    const t = e.data.transform;
    e.obj.position.fromArray(t.p);
    e.obj.rotation.set(t.r[0] * DEG, t.r[1] * DEG, t.r[2] * DEG);
    e.obj.scale.fromArray(t.s);
    e.obj.updateMatrixWorld(true);
  }

  readTransform(id) {
    const e = this.actors.get(id);
    if (!e) return;
    const o = e.obj;
    const r = (v) => Math.round(v * 1000) / 1000;
    e.data.transform = {
      p: o.position.toArray().map(r),
      r: [o.rotation.x / DEG, o.rotation.y / DEG, o.rotation.z / DEG].map((v) => Math.round(v * 100) / 100),
      s: o.scale.toArray().map(r),
    };
  }

  async buildVisual(e) {
    const d = e.data, p = d.props, q = this.quality, obj = e.obj;
    const editor = this.mode === 'editor';
    switch (d.type) {
      case 'mesh': {
        if (p.visible === false && !editor) obj.visible = false;
        if (p.asset) {
          try {
            const { object, animations } = await this.assets.instantiate(p.asset);
            if (!this.actors.has(d.id) || this.actors.get(d.id) !== e) return;
            const asset = this.assets.get(p.asset);
            if (asset?.importScale) object.scale.multiplyScalar(asset.importScale);
            object.traverse((o) => {
              if (o.isMesh) {
                o.castShadow = p.castShadow; o.receiveShadow = p.receiveShadow;
                if (p.materialOverride) o.material = makeMaterial(p.material, q, this.assets);
                else o.material = Array.isArray(o.material) ? o.material.map((m) => convertImportedMaterial(m, q, this.assets)) : convertImportedMaterial(o.material, q, this.assets);
              }
            });
            obj.add(object);
            e.model = object;
            let skinned = false;
            object.traverse((o) => { if (o.isSkinnedMesh) skinned = true; });
            if (skinned) {
              const anim = new CharacterAnimator(object, animations);
              if (anim.ok) e.animator = anim;
            } else if (p.lod) {
              applyAutoLOD(object, { lodBias: q.lodBias });
            }
          } catch (err) {
            console.warn('model failed', err);
            const m = new THREE.Mesh(getShapeGeometry('box', q.name), new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true }));
            obj.add(m);
          }
        } else {
          const geo = getShapeGeometry(p.shape, q.name, 1);
          const matProps = { ...p.material };
          if (isPrefab(p.shape)) matProps.vertexColors = true;
          if (isPrefab(p.shape) && (!p.material.color || p.material.color === '#b8b8b8')) matProps.color = '#ffffff';
          const mesh = new THREE.Mesh(geo, makeMaterial(matProps, q, this.assets));
          mesh.castShadow = p.castShadow; mesh.receiveShadow = p.receiveShadow;
          obj.add(mesh);
        }
        break;
      }
      case 'light_dir': {
        const l = new THREE.DirectionalLight(p.color, p.intensity);
        l.castShadow = p.castShadow && q.shadows;
        if (l.castShadow) {
          l.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
          const a = p.shadowArea || 40;
          Object.assign(l.shadow.camera, { left: -a / 2, right: a / 2, top: a / 2, bottom: -a / 2, near: 0.5, far: 200 });
          l.shadow.bias = -0.0005; l.shadow.normalBias = 0.03;
        }
        // Directional lights live in the scene (not under the actor) so the
        // shadow frustum can follow the camera; the actor only gives rotation.
        l.userData.editorOnly = false;
        this.scene.add(l); this.scene.add(l.target);
        e.light = l;
        e.parts.push(l, l.target);
        if (editor) {
          obj.add(iconSprite('☀', '#ffd166'));
          const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 2, 0xffd166);
          arrow.userData.editorOnly = true; obj.add(arrow);
        }
        break;
      }
      case 'light_point': case 'light_spot': {
        const l = d.type === 'light_point'
          ? new THREE.PointLight(p.color, p.intensity, p.distance, 2)
          : new THREE.SpotLight(p.color, p.intensity, p.distance, p.angle * DEG, p.penumbra, 2);
        const lightCount = [...this.actors.values()].filter((x) => x.light && !x.light.isDirectionalLight).length;
        l.visible = lightCount < q.maxPointLights;
        l.castShadow = p.castShadow && q.shadows && q.name !== 'low';
        if (l.castShadow) l.shadow.mapSize.set(q.shadowMapSize / 2, q.shadowMapSize / 2);
        obj.add(l);
        if (l.isSpotLight) { l.target.position.set(0, 0, -1); obj.add(l.target); }
        e.light = l;
        e.baseIntensity = p.intensity;
        if (editor) obj.add(iconSprite(d.type === 'light_point' ? '✹' : '◭', p.color));
        break;
      }
      case 'player_start': {
        if (editor) {
          obj.add(iconSprite('⚑', '#4cc9f0'));
          const cap = new THREE.Mesh(getShapeGeometry('capsule', 'low'), new THREE.MeshBasicMaterial({ color: 0x4cc9f0, wireframe: true, transparent: true, opacity: 0.5 }));
          cap.position.y = 0.7; cap.userData.editorOnly = true; obj.add(cap);
          const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.1, 0), 1, 0x4cc9f0);
          arrow.userData.editorOnly = true; obj.add(arrow);
        }
        break;
      }
      case 'trigger': case 'kill_volume': {
        const size = d.type === 'trigger' ? p.size : p.size;
        if (editor) {
          const box = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial({ color: d.type === 'trigger' ? p.color : '#ff3355', wireframe: true }));
          box.userData.editorOnly = true; box.userData.ownGeometry = true;
          obj.add(box);
          obj.add(iconSprite(d.type === 'trigger' ? '⬚' : '☠', d.type === 'trigger' ? p.color : '#ff3355'));
        }
        e.volumeSize = new THREE.Vector3(...size);
        break;
      }
      case 'terrain': {
        const t = new Terrain(p);
        const mat = makeMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.95, flat: p.flatShaded }, q, this.assets);
        const mesh = new THREE.Mesh(t.geometry, mat);
        mesh.receiveShadow = true; mesh.castShadow = q.name === 'high';
        mesh.userData.isTerrain = true;
        obj.add(mesh);
        e.terrain = t; e.terrainMesh = mesh;
        this.terrains.push({ entry: e, terrain: t });
        break;
      }
      case 'foliage': {
        const count = Math.max(1, Math.floor(p.count * q.foliageScale));
        const r = rng(p.seed || 1);
        let geo, mat;
        if (p.asset) {
          try {
            const { object } = await this.assets.instantiate(p.asset);
            let found = null; object.traverse((o) => { if (o.isMesh && !found) found = o; });
            if (found) {
              geo = found.geometry.clone(); found.updateWorldMatrix(true, false); geo.applyMatrix4(found.matrixWorld);
              const asset = this.assets.get(p.asset); if (asset?.importScale) geo.scale(asset.importScale, asset.importScale, asset.importScale);
              mat = convertImportedMaterial(Array.isArray(found.material) ? found.material[0] : found.material, q, this.assets);
            }
          } catch { /* fall through */ }
        }
        if (!geo) { geo = getShapeGeometry(p.shape, q.name, p.seed || 1); mat = makeMaterial({ color: '#ffffff', vertexColors: true, doubleSide: p.shape === 'grass' }, q, this.assets); }
        const im = new THREE.InstancedMesh(geo, mat, count);
        im.castShadow = p.castShadow && p.shape !== 'grass'; im.receiveShadow = true;
        obj.updateMatrixWorld(true);
        const inv = obj.matrixWorld.clone().invert();
        const m4 = new THREE.Matrix4(), qn = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
        const up = new THREE.Vector3(0, 1, 0);
        e.instances = [];
        for (let i = 0; i < count; i++) {
          const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * p.radius;
          pos.set(Math.cos(a) * rad, 0, Math.sin(a) * rad);
          const world = pos.clone().applyMatrix4(obj.matrixWorld);
          if (p.alignToTerrain) {
            const h = this.terrainHeight(world.x, world.z);
            if (h !== null) { world.y = h; pos.copy(world).applyMatrix4(inv); }
          }
          const s = p.scaleMin + r() * (p.scaleMax - p.scaleMin);
          qn.setFromAxisAngle(up, r() * Math.PI * 2);
          sc.setScalar(s);
          m4.compose(pos, qn, sc);
          im.setMatrixAt(i, m4);
          e.instances.push({ pos: world.clone(), scale: s });
        }
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        obj.add(im);
        if (editor) { const ic = iconSprite('🌲', '#80ed99'); ic.position.y = 2; obj.add(ic); }
        break;
      }
      case 'water': {
        const segs = q.name === 'potato' ? 1 : 24;
        const geo = new THREE.PlaneGeometry(p.size, p.size, segs, segs); geo.rotateX(-Math.PI / 2);
        const mat = makeMaterial({ color: p.color, opacity: p.opacity, roughness: 0.1, shading: q.name === 'potato' ? 'lambert' : 'phong' }, q, this.assets);
        const mesh = new THREE.Mesh(geo, mat); mesh.userData.ownGeometry = true; mesh.receiveShadow = true;
        obj.add(mesh);
        e.water = mesh; e.waterBase = geo.attributes.position.array.slice();
        break;
      }
      case 'particles': {
        const em = new ParticleEmitter(p, q.particleScale);
        obj.add(em);
        e.emitter = em;
        if (editor) obj.add(iconSprite('✦', '#ff9f1c'));
        break;
      }
      case 'audio': {
        if (editor) {
          obj.add(iconSprite('♪', '#b8f2e6'));
          const ring = new THREE.Mesh(new THREE.SphereGeometry(p.radius, 12, 6), new THREE.MeshBasicMaterial({ color: 0xb8f2e6, wireframe: true, transparent: true, opacity: 0.15 }));
          ring.userData.editorOnly = true; ring.userData.ownGeometry = true; obj.add(ring);
        }
        break;
      }
      case 'text': {
        const s = textSprite(p.text, p.color, p.background, p.size);
        s.userData.ownMaterial = true; s.material.userData.spud = true;
        s.position.y = 0;
        obj.add(s);
        break;
      }
      case 'npc': {
        try {
          const { object, animations } = await this.assets.instantiate(p.asset || '__mannequin');
          if (!this.actors.has(d.id) || this.actors.get(d.id) !== e) return;
          const box = new THREE.Box3().setFromObject(object);
          const h = box.max.y - box.min.y;
          if (h > 0) object.scale.multiplyScalar((p.height || 1.8) / h);
          const tint = new THREE.Color(p.tint || '#ffffff');
          object.traverse((o) => {
            if (o.isMesh) {
              o.castShadow = true;
              const conv = (m) => { const c = convertImportedMaterial(m, q, this.assets); if (c.color) c.color.multiply(tint); return c; };
              o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
            }
          });
          obj.add(object);
          e.model = object;
          const anim = new CharacterAnimator(object, animations);
          if (anim.ok) e.animator = anim;
        } catch (err) { console.warn('npc model failed', err); }
        break;
      }
      default: break;
    }
    // mark editor-only helpers
    obj.traverse((o) => { if (o.userData.editorOnly && !editor) o.visible = false; });
  }

  // ---------------- queries ----------------
  terrainHeight(x, z) {
    let best = null;
    for (const { entry, terrain } of this.terrains) {
      const o = entry.obj.position;
      const h = terrain.heightAt(x - o.x, z - o.z);
      if (h !== null) { const y = h + o.y; if (best === null || y > best) best = y; }
    }
    return best;
  }

  byName(name) {
    for (const e of this.actors.values()) if (e.data.name === name) return e;
    return null;
  }

  sunDirection() {
    for (const e of this.actors.values()) {
      if (e.data.type === 'light_dir') return new THREE.Vector3(0, 0, -1).applyQuaternion(e.obj.quaternion).negate();
    }
    return new THREE.Vector3(0.4, 0.8, 0.3).normalize();
  }

  staticOccluderBoxes() {
    const out = [];
    for (const e of this.actors.values()) {
      if (e.data.type === 'mesh' && e.data.props.castShadow && e.data.props.physics !== 'dynamic') out.push(new THREE.Box3().setFromObject(e.obj));
    }
    return out;
  }

  bakeLighting() {
    const sun = this.sunDirection();
    const occ = this.staticOccluderBoxes();
    for (const { entry, terrain } of this.terrains) {
      const o = entry.obj.position;
      const local = occ.map((b) => b.clone().translate(o.clone().negate()));
      terrain.bakeLighting(sun, local, { ambient: this.settings.ambient.intensity * 0.5 });
      Object.assign(entry.data.props, terrain.serialize());
    }
  }

  // ---------------- per-frame ----------------
  update(dt, camera, { focus = null, viewportHeight = 600, animateCharacters = true } = {}) {
    this.time += dt;
    const q = this.quality;
    camera.far = q.drawDistance * 1.2;
    camera.updateProjectionMatrix();
    this.sky.position.copy(camera.position);
    this.sky.scale.setScalar(q.drawDistance * 1.1);
    const sun = this.sunDirection();
    this.sky.material.uniforms.sunDir.value.copy(sun);
    const f = focus || camera.position;
    const camPos = camera.position;
    const maxD2 = q.drawDistance * q.drawDistance;
    for (const e of this.actors.values()) {
      const d = e.data;
      if (e.light?.isDirectionalLight) {
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(e.obj.quaternion);
        const snap = (v) => Math.round(v);
        e.light.target.position.set(snap(f.x), snap(f.y), snap(f.z));
        e.light.position.copy(e.light.target.position).addScaledVector(dir, -60);
        e.light.target.updateMatrixWorld();
      } else if (e.light && d.props.flicker > 0) {
        e.light.intensity = e.baseIntensity * (1 - d.props.flicker * 0.5 + Math.sin(this.time * 17 + e.id.length) * 0.15 * d.props.flicker + Math.random() * 0.2 * d.props.flicker);
      }
      if (e.emitter) e.emitter.update(dt, camera, viewportHeight);
      if (e.animator && this.mode === 'editor' && d.type === 'npc') e.animator.update(dt, { speed: 0, grounded: true });
      if (e.animator && animateCharacters && d.type === 'mesh') {
        const a = d.props.anim;
        if (a && a !== 'none') e.animator.update(dt, { speed: a === 'walk' ? 1.6 : a === 'run' ? 6 : 0, grounded: true, waving: a === 'wave' });
      }
      if (e.water && q.name !== 'potato') {
        const pos = e.water.geometry.attributes.position, b = e.waterBase, w = d.props.waves;
        for (let i = 0; i < pos.count; i++) pos.array[i * 3 + 1] = Math.sin(b[i * 3] * 0.35 + this.time * 1.3) * w + Math.cos(b[i * 3 + 2] * 0.3 + this.time) * w;
        pos.needsUpdate = true;
      }
      // distance culling (HLOD / world-partition substitute)
      if (d.type === 'mesh' || d.type === 'foliage' || d.type === 'npc') {
        const cull = (d.props.cullScale || 1) * (d.type === 'foliage' ? 1.2 : 1);
        const dist2 = e.obj.position.distanceToSquared(camPos);
        const vis = dist2 < maxD2 * cull * cull + (d.type === 'foliage' ? d.props.radius * d.props.radius : 0);
        if (e.cullVisible !== vis) {
          e.cullVisible = vis;
          for (const c of e.obj.children) if (!c.userData.editorOnly) c.visible = vis;
        }
      }
    }
  }

  dispose() {
    this.clear();
    this.sky.geometry.dispose(); this.sky.material.dispose();
  }
}

export { ACTOR_TYPES };
