import * as THREE from 'three';

// A deliberately tiny post-processing chain that gives the "PS3 era" look
// (bloom, filmic tone curve, colour grade, vignette) for about the cost of four
// full-screen passes, three of which run at quarter resolution.

const VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const BRIGHT = /* glsl */`
uniform sampler2D tDiffuse; uniform float threshold; uniform vec2 texel;
varying vec2 vUv;
void main(){
  // 4-tap box downsample + soft threshold
  vec3 c = texture2D(tDiffuse, vUv + texel*vec2(-1.,-1.)).rgb + texture2D(tDiffuse, vUv + texel*vec2(1.,-1.)).rgb
         + texture2D(tDiffuse, vUv + texel*vec2(-1.,1.)).rgb + texture2D(tDiffuse, vUv + texel*vec2(1.,1.)).rgb;
  c *= 0.25;
  float l = max(max(c.r, c.g), c.b);
  float k = smoothstep(threshold, threshold + 0.35, l);
  gl_FragColor = vec4(c * k, 1.0);
}`;

const BLUR = /* glsl */`
uniform sampler2D tDiffuse; uniform vec2 dir;
varying vec2 vUv;
void main(){
  vec3 s = texture2D(tDiffuse, vUv).rgb * 0.227;
  s += texture2D(tDiffuse, vUv + dir*1.384).rgb * 0.316;
  s += texture2D(tDiffuse, vUv - dir*1.384).rgb * 0.316;
  s += texture2D(tDiffuse, vUv + dir*3.230).rgb * 0.070;
  s += texture2D(tDiffuse, vUv - dir*3.230).rgb * 0.070;
  gl_FragColor = vec4(s, 1.0);
}`;

const COMPOSITE = /* glsl */`
uniform sampler2D tScene; uniform sampler2D tBloom;
uniform float bloomStrength, exposure, contrast, saturation, vignette, useBloom, grain, time;
uniform vec3 tint;
varying vec2 vUv;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + time) * 43758.5453); }
void main(){
  vec3 c = texture2D(tScene, vUv).rgb;
  if (useBloom > 0.5) c += texture2D(tBloom, vUv).rgb * bloomStrength;
  c *= exposure;
  c = aces(c);
  c = pow(c, vec3(1.0/2.2));
  float g = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(g), c, saturation);
  c = (c - 0.5) * contrast + 0.5;
  c *= tint;
  vec2 d = vUv - 0.5;
  c *= 1.0 - dot(d, d) * vignette * 1.6;
  c += (hash(vUv * 512.0) - 0.5) * grain;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export const DEFAULT_POST = {
  bloom: true, bloomStrength: 0.55, bloomThreshold: 0.75,
  exposure: 1.0, contrast: 1.06, saturation: 1.05, tint: '#ffffff',
  vignette: 0.35, grain: 0.02,
};

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    const gl = renderer.getContext();
    const hdr = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
    this.type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const opts = { type: this.type, depthBuffer: true, samples: 0 };
    this.sceneRT = new THREE.WebGLRenderTarget(4, 4, opts);
    this.rtA = new THREE.WebGLRenderTarget(4, 4, { type: this.type, depthBuffer: false });
    this.rtB = new THREE.WebGLRenderTarget(4, 4, { type: this.type, depthBuffer: false });
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    const mk = (frag, uniforms) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    this.brightMat = mk(BRIGHT, { tDiffuse: { value: null }, threshold: { value: 0.8 }, texel: { value: new THREE.Vector2() } });
    this.blurMat = mk(BLUR, { tDiffuse: { value: null }, dir: { value: new THREE.Vector2() } });
    this.compMat = mk(COMPOSITE, {
      tScene: { value: null }, tBloom: { value: null }, bloomStrength: { value: 0.6 }, exposure: { value: 1 },
      contrast: { value: 1 }, saturation: { value: 1 }, vignette: { value: 0.3 }, useBloom: { value: 1 },
      grain: { value: 0 }, time: { value: 0 }, tint: { value: new THREE.Color(1, 1, 1) },
    });
    this.settings = { ...DEFAULT_POST };
    void gl;
  }

  setSize(w, h) {
    this.sceneRT.setSize(w, h);
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.rtA.setSize(qw, qh);
    this.rtB.setSize(qw, qh);
  }

  pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  render(scene, camera, bloomEnabled) {
    const r = this.renderer;
    const s = this.settings;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    if (this.sceneRT.width !== size.x || this.sceneRT.height !== size.y) this.setSize(size.x, size.y);
    const prevTM = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);
    const useBloom = bloomEnabled && s.bloom;
    if (useBloom) {
      this.brightMat.uniforms.tDiffuse.value = this.sceneRT.texture;
      this.brightMat.uniforms.threshold.value = s.bloomThreshold;
      this.brightMat.uniforms.texel.value.set(1 / size.x, 1 / size.y);
      this.pass(this.brightMat, this.rtA);
      this.blurMat.uniforms.tDiffuse.value = this.rtA.texture;
      this.blurMat.uniforms.dir.value.set(1 / this.rtA.width, 0);
      this.pass(this.blurMat, this.rtB);
      this.blurMat.uniforms.tDiffuse.value = this.rtB.texture;
      this.blurMat.uniforms.dir.value.set(0, 1 / this.rtA.height);
      this.pass(this.blurMat, this.rtA);
    }
    const u = this.compMat.uniforms;
    u.tScene.value = this.sceneRT.texture;
    u.tBloom.value = this.rtA.texture;
    u.useBloom.value = useBloom ? 1 : 0;
    u.bloomStrength.value = s.bloomStrength;
    u.exposure.value = s.exposure;
    u.contrast.value = s.contrast;
    u.saturation.value = s.saturation;
    u.vignette.value = s.vignette;
    u.grain.value = s.grain;
    u.time.value = (performance.now() / 1000) % 100;
    u.tint.value.set(s.tint);
    this.pass(this.compMat, null);
    r.toneMapping = prevTM;
  }

  dispose() {
    [this.sceneRT, this.rtA, this.rtB].forEach((t) => t.dispose());
    [this.brightMat, this.blurMat, this.compMat].forEach((m) => m.dispose());
    this.quad.geometry.dispose();
  }
}
