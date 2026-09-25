import * as THREE from 'three';
import { rng } from './util.js';

// CPU particle emitter drawn as one THREE.Points call (a single draw call per
// emitter, no textures needed). Particle budgets scale with the quality preset.

export const PARTICLE_PRESETS = {
  fire:   { rate: 60, life: 1.0, speed: 1.6, spread: 0.35, gravity: 1.5, size: 0.5, sizeEnd: 0.05, color: '#ffb347', colorEnd: '#ff2000', additive: true, radius: 0.25, max: 200 },
  smoke:  { rate: 18, life: 3.5, speed: 0.8, spread: 0.3, gravity: 0.4, size: 0.6, sizeEnd: 2.0, color: '#777777', colorEnd: '#2a2a2a', additive: false, radius: 0.3, max: 120, opacity: 0.45 },
  sparks: { rate: 40, life: 0.8, speed: 5, spread: 1.0, gravity: -9, size: 0.12, sizeEnd: 0.02, color: '#fff2a0', colorEnd: '#ff6a00', additive: true, radius: 0.05, max: 150 },
  magic:  { rate: 35, life: 1.6, speed: 0.7, spread: 1.0, gravity: 0.5, size: 0.25, sizeEnd: 0.0, color: '#8fd3ff', colorEnd: '#b25bff', additive: true, radius: 0.8, max: 150 },
  rain:   { rate: 400, life: 1.2, speed: 16, spread: 0.02, gravity: -4, size: 0.08, sizeEnd: 0.08, color: '#9fb8d0', colorEnd: '#9fb8d0', additive: false, radius: 25, max: 900, down: true, opacity: 0.6 },
  snow:   { rate: 120, life: 6, speed: 1.2, spread: 0.2, gravity: 0, size: 0.14, sizeEnd: 0.14, color: '#ffffff', colorEnd: '#ffffff', additive: false, radius: 25, max: 900, down: true },
  dust:   { rate: 10, life: 5, speed: 0.15, spread: 1.0, gravity: 0, size: 0.07, sizeEnd: 0.07, color: '#fff0c8', colorEnd: '#fff0c8', additive: true, radius: 4, max: 80, opacity: 0.6 },
};

let _dot = null;
function dotTexture() {
  if (_dot || typeof document === 'undefined') return _dot;
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.4, 'rgba(255,255,255,0.6)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
  _dot = new THREE.CanvasTexture(c);
  return _dot;
}

export class ParticleEmitter extends THREE.Points {
  constructor(props = {}, qualityScale = 1) {
    const preset = PARTICLE_PRESETS[props.preset] || PARTICLE_PRESETS.fire;
    const cfg = { ...preset, ...Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined && v !== null && v !== '')) };
    const max = Math.max(8, Math.floor(cfg.max * qualityScale));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    geo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(max), 1));
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: dotTexture() }, opacity: { value: cfg.opacity ?? 1 }, scale: { value: 300 } },
      vertexShader: `attribute float size; varying vec3 vColor; uniform float scale;
        void main(){ vColor = color; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = size * scale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; uniform float opacity; varying vec3 vColor;
        void main(){ vec4 t = texture2D(map, gl_PointCoord); if (t.a < 0.02) discard; gl_FragColor = vec4(vColor, t.a * opacity); }`,
      vertexColors: true, transparent: true, depthWrite: false,
      blending: cfg.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    super(geo, mat);
    this.cfg = cfg;
    this.max = max;
    this.rateScale = qualityScale;
    this.frustumCulled = false;
    this.p = { pos: new Float32Array(max * 3), vel: new Float32Array(max * 3), age: new Float32Array(max).fill(1e9), life: new Float32Array(max) };
    this.acc = 0;
    this.rand = rng(12345);
    this.c0 = new THREE.Color(cfg.color); this.c1 = new THREE.Color(cfg.colorEnd);
    this.active = props.autoStart !== false;
    this.cursor = 0;
    this.userData.isEmitter = true;
  }

  update(dt, camera, viewportHeight = 600) {
    const cfg = this.cfg, P = this.p, R = this.rand;
    if (this.active) {
      this.acc += dt * cfg.rate * this.rateScale;
      while (this.acc >= 1) {
        this.acc -= 1;
        const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
        const a = R() * Math.PI * 2, rr = Math.sqrt(R()) * cfg.radius;
        const ox = Math.cos(a) * rr, oz = Math.sin(a) * rr;
        if (cfg.down) {
          P.pos[i * 3] = ox; P.pos[i * 3 + 1] = cfg.speed * cfg.life * 0.6; P.pos[i * 3 + 2] = oz;
          P.vel[i * 3] = (R() - 0.5) * cfg.spread; P.vel[i * 3 + 1] = -cfg.speed; P.vel[i * 3 + 2] = (R() - 0.5) * cfg.spread;
        } else {
          P.pos[i * 3] = ox; P.pos[i * 3 + 1] = 0; P.pos[i * 3 + 2] = oz;
          P.vel[i * 3] = (R() - 0.5) * cfg.spread * cfg.speed; P.vel[i * 3 + 1] = cfg.speed * (0.6 + R() * 0.4); P.vel[i * 3 + 2] = (R() - 0.5) * cfg.spread * cfg.speed;
        }
        P.age[i] = 0; P.life[i] = cfg.life * (0.7 + R() * 0.6);
      }
    }
    const pos = this.geometry.attributes.position.array, col = this.geometry.attributes.color.array, size = this.geometry.attributes.size.array;
    let n = 0;
    const g = cfg.gravity;
    for (let i = 0; i < this.max; i++) {
      if (P.age[i] >= P.life[i]) continue;
      P.age[i] += dt;
      const t = P.age[i] / P.life[i];
      if (t >= 1) continue;
      P.vel[i * 3 + 1] += g * dt;
      P.pos[i * 3] += P.vel[i * 3] * dt; P.pos[i * 3 + 1] += P.vel[i * 3 + 1] * dt; P.pos[i * 3 + 2] += P.vel[i * 3 + 2] * dt;
      pos[n * 3] = P.pos[i * 3]; pos[n * 3 + 1] = P.pos[i * 3 + 1]; pos[n * 3 + 2] = P.pos[i * 3 + 2];
      const fade = t < 0.1 ? t / 0.1 : 1 - Math.max(0, (t - 0.6) / 0.4);
      col[n * 3] = (this.c0.r + (this.c1.r - this.c0.r) * t) * fade;
      col[n * 3 + 1] = (this.c0.g + (this.c1.g - this.c0.g) * t) * fade;
      col[n * 3 + 2] = (this.c0.b + (this.c1.b - this.c0.b) * t) * fade;
      size[n] = cfg.size + (cfg.sizeEnd - cfg.size) * t;
      n++;
    }
    this.geometry.setDrawRange(0, n);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.attributes.size.needsUpdate = true;
    if (camera?.isPerspectiveCamera) this.material.uniforms.scale.value = viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
  }

  burst(count = 30) { const r = this.cfg.rate; this.acc += count / Math.max(0.001, this.rateScale); void r; }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
