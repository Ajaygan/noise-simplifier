import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { dataUrlToArrayBuffer, uid } from './util.js';
import { buildMannequinRigged } from './mannequin.js';

export const MANNEQUIN_ID = '__mannequin';

function nextPow2Below(n, max) {
  let p = 1;
  while (p * 2 <= n && p * 2 <= max) p *= 2;
  return p;
}

// Holds every asset of a project (as data URLs so a project is one portable
// file) and caches parsed GPU-side versions.
export class AssetLibrary {
  constructor(assets = {}) {
    this.assets = assets;
    this.models = new Map();   // id -> Promise<{scene, animations}>
    this.textures = new Map(); // id|max|filter -> Texture
    this.downscaled = new WeakMap();
    this.audioBuffers = new Map();
    this.listeners = new Set();
  }

  list(type) { return Object.values(this.assets).filter((a) => !type || a.type === type); }
  get(id) { return this.assets[id]; }

  add(asset) {
    const a = { id: asset.id || uid('asset'), ...asset };
    this.assets[a.id] = a;
    this.emit();
    return a;
  }

  remove(id) {
    delete this.assets[id];
    this.models.delete(id);
    for (const k of [...this.textures.keys()]) if (k.startsWith(id + '|')) this.textures.delete(k);
    this.emit();
  }

  rename(id, name) { if (this.assets[id]) { this.assets[id].name = name; this.emit(); } }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach((fn) => fn()); }

  // ---------- textures ----------
  getTexture(id, max = 512, filter = 'linear') {
    const key = `${id}|${max}|${filter}`;
    if (this.textures.has(key)) return this.textures.get(key);
    const a = this.assets[id];
    if (!a || a.type !== 'texture') return null;
    const tex = new THREE.Texture();
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    if (filter === 'nearest') { tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestMipmapNearestFilter; }
    const img = new Image();
    img.onload = () => {
      tex.image = this.shrinkImage(img, max);
      tex.needsUpdate = true;
    };
    img.src = a.data;
    this.textures.set(key, tex);
    return tex;
  }

  shrinkImage(img, max) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) return img;
    const tw = nextPow2Below(w, max), th = nextPow2Below(h, max);
    if (tw === w && th === h) return img;
    const c = document.createElement('canvas');
    c.width = tw; c.height = th;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, tw, th);
    return c;
  }

  downscaleTexture(tex, max) {
    const img = tex.image;
    if (!img || typeof document === 'undefined') return tex;
    const w = img.width || img.videoWidth, h = img.height || img.videoHeight;
    if (!w || (w <= max && h <= max)) return tex;
    let perImg = this.downscaled.get(img);
    if (!perImg) { perImg = new Map(); this.downscaled.set(img, perImg); }
    if (perImg.has(max)) return perImg.get(max);
    let out = tex;
    try {
      const t = tex.clone();
      t.image = this.shrinkImage(img, max);
      t.needsUpdate = true;
      out = t;
    } catch { /* ImageBitmap without canvas support etc. */ }
    perImg.set(max, out);
    return out;
  }

  // ---------- models ----------
  loadModel(id) {
    if (this.models.has(id)) return this.models.get(id);
    let p;
    if (id === MANNEQUIN_ID) {
      p = Promise.resolve().then(() => {
        const { root } = buildMannequinRigged();
        return { scene: root, animations: [] };
      });
    } else {
      const a = this.assets[id];
      if (!a) return Promise.reject(new Error(`missing asset ${id}`));
      p = parseModel(a.format, a.data);
    }
    p = p.then((res) => {
      res.scene.traverse((o) => {
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      });
      return res;
    });
    this.models.set(id, p);
    return p;
  }

  async instantiate(id) {
    const tpl = await this.loadModel(id);
    const clone = SkeletonUtils.clone(tpl.scene);
    return { object: clone, animations: tpl.animations || [] };
  }

  // ---------- audio ----------
  async getAudioBuffer(ctx, id) {
    if (this.audioBuffers.has(id)) return this.audioBuffers.get(id);
    const a = this.assets[id];
    if (!a) return null;
    const p = ctx.decodeAudioData(dataUrlToArrayBuffer(a.data));
    this.audioBuffers.set(id, p);
    return p;
  }
}

export function parseModel(format, dataUrl) {
  const buf = () => dataUrlToArrayBuffer(dataUrl);
  const text = () => new TextDecoder().decode(buf());
  return new Promise((resolve, reject) => {
    try {
      if (format === 'glb' || format === 'gltf') {
        const data = format === 'glb' ? buf() : text();
        new GLTFLoader().parse(data, '', (g) => resolve({ scene: g.scene, animations: g.animations || [] }), reject);
      } else if (format === 'obj') {
        const g = new OBJLoader().parse(text());
        resolve({ scene: g, animations: [] });
      } else if (format === 'fbx') {
        const g = new FBXLoader().parse(buf(), '');
        resolve({ scene: g, animations: g.animations || [] });
      } else reject(new Error(`unsupported model format ${format}`));
    } catch (e) { reject(e); }
  });
}

export function detectFormat(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  if (['glb', 'gltf', 'obj', 'fbx'].includes(ext)) return { type: 'model', format: ext };
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) return { type: 'texture', format: ext };
  if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) return { type: 'sound', format: ext };
  return null;
}
