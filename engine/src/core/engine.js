import * as THREE from 'three';
import { PostFX } from './postfx.js';
import { resolveQuality } from './quality.js';
import { clamp } from './util.js';

// Renderer wrapper: owns the WebGL context, the resolution policy (render
// scale, resolution cap, dynamic resolution) and the frame loop / frame cap.
export class Engine {
  constructor(canvas, { quality = 'ps3', overrides = {} } = {}) {
    this.canvas = canvas;
    this.quality = resolveQuality(quality, overrides);
    this.createRenderer();
    this.dynamicResolution = true;
    this.dynScale = 1;
    this.frameCap = 0; // 0 = uncapped (vsync)
    this.stats = { fps: 0, ms: 0, calls: 0, tris: 0, scale: 1, w: 0, h: 0 };
    this._frames = 0; this._acc = 0; this._last = performance.now(); this._lastDraw = 0;
    this._slowFrames = 0; this._fastFrames = 0;
    this.onFrame = null;
    this.running = false;
    this._resizeObs = new ResizeObserver(() => this.resize());
    this._resizeObs.observe(canvas.parentElement || canvas);
    this.resize();
  }

  createRenderer() {
    const q = this.quality;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: q.antialias, powerPreference: 'default',
      stencil: false, preserveDrawingBuffer: false,
    });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.shadowMap.enabled = q.shadows;
    r.shadowMap.type = q.name === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    r.info.autoReset = false; // reset once per frame so post passes don't hide scene stats
    this.post = new PostFX(r);
  }

  setQuality(name, overrides = {}) {
    const prevAA = this.quality.antialias;
    this.quality = resolveQuality(name, overrides);
    const q = this.quality;
    if (prevAA !== q.antialias) {
      // Antialiasing is a context creation flag; we keep the existing context
      // (recreating it would lose every GPU resource). The flag applies on reload.
    }
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = q.name === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.renderer.shadowMap.needsUpdate = true;
    this.canvas.style.imageRendering = q.pixelated ? 'pixelated' : 'auto';
    this.dynScale = 1;
    this.resize();
  }

  pixelRatioFor(w, h) {
    const q = this.quality;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let pr = dpr * q.renderScale * this.dynScale;
    if (h * pr > q.maxHeight) pr = q.maxHeight / h;
    return clamp(pr, 0.25, 2);
  }

  resize() {
    const el = this.canvas.parentElement || this.canvas;
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
    this.width = w; this.height = h;
    this.renderer.setPixelRatio(this.pixelRatioFor(w, h));
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    if (this.onResize) this.onResize(w, h);
  }

  render(scene, camera) {
    const q = this.quality;
    const r = this.renderer;
    r.info.reset();
    if (q.post) this.post.render(scene, camera, q.bloom);
    else { r.setRenderTarget(null); r.render(scene, camera); }
    this.stats.calls = r.info.render.calls;
    this.stats.tris = r.info.render.triangles;
  }

  // Dynamic resolution: if we keep missing the target frame time, render fewer
  // pixels; if we have headroom, creep back up. Hysteresis avoids flicker.
  adaptResolution(dtMs) {
    if (!this.dynamicResolution) return;
    const target = 1000 / (this.frameCap || this.quality.targetFps || 30);
    if (dtMs > target * 1.25) { this._slowFrames++; this._fastFrames = 0; }
    else if (dtMs < target * 0.8) { this._fastFrames++; this._slowFrames = 0; }
    if (this._slowFrames > 20 && this.dynScale > 0.5) {
      this.dynScale = Math.max(0.5, this.dynScale - 0.1); this._slowFrames = 0; this.resize();
    } else if (this._fastFrames > 90 && this.dynScale < 1) {
      this.dynScale = Math.min(1, this.dynScale + 0.05); this._fastFrames = 0; this.resize();
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      if (this.frameCap > 0 && now - this._lastDraw < 1000 / this.frameCap - 1) return;
      const dtMs = now - this._last;
      this._last = now; this._lastDraw = now;
      const dt = Math.min(dtMs / 1000, 0.1);
      this._frames++; this._acc += dtMs;
      if (this._acc >= 500) {
        this.stats.fps = Math.round((this._frames * 1000) / this._acc);
        this.stats.ms = +(this._acc / this._frames).toFixed(1);
        this._frames = 0; this._acc = 0;
        const sz = this.renderer.getDrawingBufferSize(new THREE.Vector2());
        this.stats.w = sz.x; this.stats.h = sz.y; this.stats.scale = +this.dynScale.toFixed(2);
      }
      if (this.onFrame) this.onFrame(dt, now);
      this.adaptResolution(dtMs);
    };
    requestAnimationFrame(loop);
  }

  stop() { this.running = false; }
}
