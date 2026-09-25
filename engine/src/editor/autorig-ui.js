import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { h, clear, modal, toast, field, select, slider, checkbox, download } from './ui.js';
import { prepareModel, detectMarkers, buildSkeleton, createRig, MARKER_NAMES, BONE_NAMES } from '../core/autorig.js';
import { ProceduralAnimator } from '../core/anim.js';
import { MANNEQUIN_ID } from '../core/assets.js';
import { buildMannequinGeometry } from '../core/mannequin.js';
import { arrayBufferToDataUrl } from '../core/util.js';

const MARKER_STYLE = {
  chin: ['#ffd60a', 'Chin'], groin: ['#ff8c42', 'Groin'],
  wrist_L: ['#4cc9f0', 'Wrist L'], wrist_R: ['#4cc9f0', 'Wrist R'],
  elbow_L: ['#80ed99', 'Elbow L'], elbow_R: ['#80ed99', 'Elbow R'],
  knee_L: ['#f72585', 'Knee L'], knee_R: ['#f72585', 'Knee R'],
};

function heat(t) {
  // blue -> cyan -> green -> yellow -> red (classic weight-paint ramp)
  const c = new THREE.Color();
  c.setHSL((1 - t) * 0.66, 1, 0.5);
  return c;
}

export class AutoRigTool {
  constructor(editor, assetId = null) {
    this.editor = editor;
    this.assetId = assetId;
    this.rotateY = 0;
    this.targetHeight = 1.8;
    this.symmetry = true;
    this.smooth = 3;
    this.falloff = 0.022;
    this.stage = 'pick';
    this.anim = 'idle';
    this.open();
  }

  open() {
    this.view = h('div', { class: 'rig-view' });
    this.side = h('div', { class: 'rig-side' });
    this.overlay = h('div', { class: 'rig-overlay' });
    this.view.appendChild(this.overlay);
    this.m = modal({ title: 'Auto-Rig Character', body: h('div', { class: 'rig-layout' }, this.view, this.side), width: '92vw', className: 'rig-modal', onClose: () => this.dispose() });
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.view.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#1b2129');
    this.scene.add(new THREE.HemisphereLight(0xdde8ff, 0x3a3228, 1.4));
    const d = new THREE.DirectionalLight(0xffffff, 1.6); d.position.set(2, 4, 5); this.scene.add(d);
    const grid = new THREE.GridHelper(4, 16, 0x3d4b5c, 0x2a3440); this.scene.add(grid);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
    this.persp = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
    this.orbit = { yaw: 0.5, pitch: 0.15, dist: 4.2 };
    this.modelGroup = new THREE.Group(); this.scene.add(this.modelGroup);
    this.markerGroup = new THREE.Group(); this.scene.add(this.markerGroup);
    this.raycaster = new THREE.Raycaster();
    this.clock = new THREE.Clock();
    this.running = true;
    this.bindView();
    const loop = () => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      this.frame(Math.min(0.05, this.clock.getDelta()));
    };
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.view);
    loop();
    if (this.assetId) this.loadSource(this.assetId); else this.renderSide();
  }

  dispose() {
    this.running = false;
    this.ro?.disconnect();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
  }

  resize() {
    const w = this.view.clientWidth, hh = this.view.clientHeight;
    if (!w || !hh) return;
    this.renderer.setSize(w, hh);
    this.persp.aspect = w / hh; this.persp.updateProjectionMatrix();
    this.fitOrtho();
  }

  fitOrtho() {
    const H = this.targetHeight * 1.15;
    const w = this.view.clientWidth || 1, hh = this.view.clientHeight || 1;
    const aspect = w / hh;
    Object.assign(this.ortho, { left: (-H * aspect) / 2, right: (H * aspect) / 2, top: H / 2, bottom: -H / 2 });
    this.ortho.position.set(0, this.targetHeight / 2, 10);
    this.ortho.lookAt(0, this.targetHeight / 2, 0);
    this.ortho.updateProjectionMatrix();
  }

  // ---------------- flow ----------------
  async loadSource(id) {
    this.assetId = id;
    try {
      if (id === MANNEQUIN_ID) {
        this.source = new THREE.Mesh(buildMannequinGeometry(), new THREE.MeshPhongMaterial({ vertexColors: true }));
        this.sourceName = 'Mannequin';
      } else {
        const { object } = await this.editor.assets.instantiate(id);
        this.source = object;
        this.sourceName = this.editor.assets.get(id)?.name || 'Character';
      }
      let tris = 0;
      this.source.traverse((o) => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
      this.tris = Math.round(tris);
      this.prepare(true);
    } catch (e) {
      toast(`Could not load model: ${e.message}`, 'error');
    }
  }

  prepare(detect = true) {
    this.stage = 'markers';
    this.rig = null; this.animator = null;
    this.prepared = prepareModel(this.source, { targetHeight: this.targetHeight, rotateY: (this.rotateY * Math.PI) / 180 });
    if (detect || !this.markers) {
      const t = performance.now();
      this.markers = detectMarkers(this.prepared.parts, this.prepared.height);
      this.detectMs = Math.round(performance.now() - t);
    }
    clear3(this.modelGroup);
    for (const p of this.prepared.parts) {
      const mats = Array.isArray(p.material) ? p.material : [p.material];
      const mm = mats.map((m) => { const c = m ? m.clone() : new THREE.MeshPhongMaterial({ color: 0xbbbbbb }); c.transparent = true; c.opacity = 0.85; c.depthWrite = true; return c; });
      this.modelGroup.add(new THREE.Mesh(p.geometry, Array.isArray(p.material) ? mm : mm[0]));
    }
    this.buildMarkers();
    this.fitOrtho();
    this.renderSide();
  }

  buildMarkers() {
    clear3(this.markerGroup);
    this.markerMeshes = {};
    const r = this.targetHeight * 0.018;
    for (const name of MARKER_NAMES) {
      const [color] = MARKER_STYLE[name];
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
      m.renderOrder = 10;
      const ring = new THREE.Mesh(new THREE.RingGeometry(r * 1.4, r * 1.9, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.8 }));
      ring.renderOrder = 11; m.add(ring);
      m.userData.marker = name;
      m.position.set(this.markers[name].x, this.markers[name].y, 1);
      this.markerGroup.add(m);
      this.markerMeshes[name] = m;
    }
    // bone preview lines
    this.previewLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.7 }));
    this.previewLines.renderOrder = 9;
    this.markerGroup.add(this.previewLines);
    this.updatePreviewSkeleton();
  }

  updatePreviewSkeleton() {
    if (!this.prepared) return;
    try {
      const bones = buildSkeleton(this.markers, this.prepared.parts, this.prepared.height);
      const pts = [];
      for (const b of bones) pts.push(b.head.x, b.head.y, 1, b.tail.x, b.tail.y, 1);
      this.previewLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.previewBones = bones;
    } catch { /* partial markers */ }
  }

  doRig() {
    const t = performance.now();
    const H = this.prepared.height;
    const bones = buildSkeleton(this.markers, this.prepared.parts, H);
    this.rig = createRig(this.prepared.parts, bones, H, { smoothIterations: this.smooth, falloff: this.falloff, name: this.sourceName });
    this.rigMs = Math.round(performance.now() - t);
    clear3(this.modelGroup);
    clear3(this.markerGroup);
    this.modelGroup.add(this.rig.root);
    this.skelHelper = new THREE.SkeletonHelper(this.rig.root);
    this.skelHelper.material.depthTest = false; this.skelHelper.material.transparent = true;
    this.skelHelper.renderOrder = 5;
    this.modelGroup.add(this.skelHelper);
    this.animator = new ProceduralAnimator(this.rig.root);
    this.stage = 'preview';
    this.weightBone = '';
    this.renderSide();
    this.editor.log(`Auto-rig: ${this.sourceName} rigged with ${bones.length} bones in ${this.rigMs} ms`);
  }

  showWeights(boneName) {
    this.weightBone = boneName;
    if (!this.rig) return;
    const bi = BONE_NAMES.indexOf(boneName);
    for (const sm of this.rig.meshes) {
      const g = sm.geometry;
      if (!sm.userData.saved) sm.userData.saved = { mat: sm.material, color: g.attributes.color || null };
      if (!boneName) {
        sm.material = sm.userData.saved.mat;
        if (sm.userData.saved.color) g.setAttribute('color', sm.userData.saved.color); else g.deleteAttribute('color');
        continue;
      }
      const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      const col = new Float32Array(si.count * 3);
      for (let i = 0; i < si.count; i++) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === bi) w += sw.getComponent(i, k);
        const c = heat(w);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      if (!sm.userData.weightMat) sm.userData.weightMat = new THREE.MeshBasicMaterial({ vertexColors: true });
      sm.material = sm.userData.weightMat;
    }
  }

  async exportGlb() {
    this.showWeights('');
    this.animator?.reset();
    this.rig.root.updateMatrixWorld(true);
    const exporter = new GLTFExporter();
    const buf = await exporter.parseAsync(this.rig.root, { binary: true, onlyVisible: true });
    return buf;
  }

  async save({ asPlayer = false, place = false } = {}) {
    try {
      const buf = await this.exportGlb();
      const name = `${this.sourceName} (Rigged)`;
      const a = this.editor.assets.add({ type: 'model', format: 'glb', name, data: arrayBufferToDataUrl(buf, 'model/gltf-binary'), rigged: true, importScale: 1 });
      this.editor.markDirty();
      this.editor.ui.renderContent();
      if (asPlayer) { this.editor.project.settings.game.character = a.id; this.editor.log(`Player character set to ${name}`); }
      if (place) this.editor.placeAsset(a.id);
      toast(`Saved ${name} to the Content Browser (${Math.round(buf.byteLength / 1024)} KB)`, 'ok');
      this.m.close();
    } catch (e) {
      console.error(e);
      toast(`Export failed: ${e.message}`, 'error');
    }
  }

  // ---------------- view interaction ----------------
  bindView() {
    const c = this.renderer.domElement;
    let drag = null, orbitDrag = null;
    const pickMarker = (e) => {
      const r = c.getBoundingClientRect();
      const m = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(m, this.ortho);
      const hits = this.raycaster.intersectObjects(Object.values(this.markerMeshes || {}), false);
      return { hit: hits[0]?.object, ray: this.raycaster.ray };
    };
    c.addEventListener('pointerdown', (e) => {
      if (this.stage === 'markers') {
        const { hit } = pickMarker(e);
        if (hit) { drag = hit.userData.marker; c.setPointerCapture(e.pointerId); }
      } else if (this.stage === 'preview') { orbitDrag = { x: e.clientX, y: e.clientY }; c.setPointerCapture(e.pointerId); }
    });
    c.addEventListener('pointermove', (e) => {
      if (drag) {
        const { ray } = pickMarker(e);
        const p = new THREE.Vector3();
        ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -1), p);
        this.setMarker(drag, p.x, p.y);
      } else if (orbitDrag) {
        this.orbit.yaw -= (e.clientX - orbitDrag.x) * 0.01;
        this.orbit.pitch = Math.max(-0.5, Math.min(1.2, this.orbit.pitch + (e.clientY - orbitDrag.y) * 0.01));
        orbitDrag = { x: e.clientX, y: e.clientY };
      } else if (this.stage === 'markers') {
        const { hit } = pickMarker(e);
        c.style.cursor = hit ? 'grab' : 'default';
        this.overlay.textContent = hit ? MARKER_STYLE[hit.userData.marker][1] : '';
      }
    });
    c.addEventListener('pointerup', () => { drag = null; orbitDrag = null; });
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.orbit.dist = Math.max(1.5, Math.min(10, this.orbit.dist * (e.deltaY > 0 ? 1.1 : 0.9))); }, { passive: false });
  }

  setMarker(name, x, y) {
    const H = this.targetHeight;
    y = Math.max(0, Math.min(H, y));
    if (name === 'chin' || name === 'groin') x = 0;
    if (name.endsWith('_L')) x = Math.max(0.005, x);
    if (name.endsWith('_R')) x = Math.min(-0.005, x);
    this.markers[name] = { x, y };
    this.markerMeshes[name].position.set(x, y, 1);
    if (this.symmetry && /_[LR]$/.test(name)) {
      const other = name.endsWith('_L') ? name.replace('_L', '_R') : name.replace('_R', '_L');
      this.markers[other] = { x: -x, y };
      this.markerMeshes[other].position.set(-x, y, 1);
    }
    this.updatePreviewSkeleton();
  }

  frame(dt) {
    let cam = this.ortho;
    if (this.stage === 'preview') {
      cam = this.persp;
      const H = this.targetHeight, o = this.orbit;
      cam.position.set(Math.sin(o.yaw) * Math.cos(o.pitch) * o.dist, H * 0.55 + Math.sin(o.pitch) * o.dist, Math.cos(o.yaw) * Math.cos(o.pitch) * o.dist);
      cam.lookAt(0, H * 0.5, 0);
      if (this.animator?.ok) {
        const a = this.anim;
        if (a === 'tpose') this.animator.reset();
        else this.animator.update(dt, { speed: a === 'walk' ? 1.6 : a === 'run' ? 6 : 0, grounded: a !== 'jump', waving: a === 'wave' });
      }
    }
    this.renderer.render(this.scene, cam);
  }

  // ---------------- side panel ----------------
  renderSide() {
    const s = this.side;
    clear(s);
    const models = [[MANNEQUIN_ID, 'Mannequin (built-in test)'], ...this.editor.assets.list('model').map((a) => [a.id, a.name])];
    const steps = [['pick', '1. Model'], ['markers', '2. Markers'], ['preview', '3. Test & Save']];
    s.appendChild(h('div', { class: 'rig-steps' }, steps.map(([k, l]) => h('div', { class: `rig-step ${this.stage === k ? 'on' : ''}` }, l))));

    s.appendChild(h('div', { class: 'rig-sec' },
      h('div', { class: 'rig-title' }, 'Character model'),
      field('Model', select(this.assetId || '', [['', '— choose —'], ...models], (v) => v && this.loadSource(v))),
      h('button', { class: 'btn small', onclick: async () => { const added = await this.editor.importDialog('.glb,.gltf,.fbx,.obj'); const m = added?.find((a) => a.type === 'model'); if (m) { this.renderSide(); this.loadSource(m.id); } } }, 'Import FBX / OBJ / GLB…'),
      this.tris ? h('div', { class: 'muted' }, `${this.tris.toLocaleString()} triangles`) : null,
      this.tris > 30000 ? h('div', { class: 'warn-box' }, 'Heavy for potato devices. Consider decimating to under 10k triangles for PS3-style games.') : null,
    ));

    if (this.stage === 'pick') {
      s.appendChild(h('div', { class: 'muted pad' }, 'Import a humanoid character (T-pose or A-pose works best), or try the built-in mannequin. The rigger finds the joints, builds a 19-bone skeleton and paints skin weights automatically.'));
      return;
    }

    if (this.stage === 'markers') {
      s.appendChild(h('div', { class: 'rig-sec' },
        h('div', { class: 'rig-title' }, 'Orientation'),
        h('div', { class: 'muted' }, 'The character should face you (towards +Z), standing on the grid.'),
        h('div', { class: 'row' }, [0, 90, 180, 270].map((d) => h('button', { class: `btn small ${this.rotateY === d ? 'primary' : ''}`, onclick: () => { this.rotateY = d; this.prepare(true); } }, `${d}°`))),
        field('Height (m)', select(this.targetHeight, [1.0, 1.5, 1.7, 1.8, 2.0, 2.5, 3.0], (v) => { this.targetHeight = +v; this.prepare(true); })),
      ));
      s.appendChild(h('div', { class: 'rig-sec' },
        h('div', { class: 'rig-title' }, 'Markers', h('span', { class: 'muted' }, ` auto-detected in ${this.detectMs} ms`)),
        h('div', { class: 'muted' }, 'Drag the coloured dots onto the joints if they are off. The white lines preview the skeleton.'),
        h('div', { class: 'legend' }, Object.entries(MARKER_STYLE).filter(([k]) => !k.endsWith('_R')).map(([, [c, l]]) => h('span', {}, h('i', { style: { background: c } }), l.replace(' L', '')))),
        field('Symmetry', checkbox(this.symmetry, (v) => { this.symmetry = v; })),
        h('button', { class: 'btn small', onclick: () => this.prepare(true) }, 'Re-detect'),
      ));
      s.appendChild(h('div', { class: 'rig-sec' },
        h('div', { class: 'rig-title' }, 'Skinning'),
        field('Smoothness', slider(this.smooth, (v) => { this.smooth = Math.round(v); }, { min: 0, max: 8, step: 1 })),
        field('Joint Blend', slider(this.falloff, (v) => { this.falloff = v; }, { min: 0.008, max: 0.06, step: 0.002 })),
      ));
      s.appendChild(h('button', { class: 'btn primary big', onclick: () => this.doRig() }, 'Rig Character'));
      return;
    }

    // preview
    s.appendChild(h('div', { class: 'rig-sec' },
      h('div', { class: 'rig-title' }, 'Rigged', h('span', { class: 'muted' }, ` ${BONE_NAMES.length} bones · ${this.rigMs} ms`)),
      h('div', { class: 'muted' }, 'Test the deformation with the procedural animations. Drag in the view to orbit.'),
      h('div', { class: 'tool-grid' }, [['idle', 'Idle'], ['walk', 'Walk'], ['run', 'Run'], ['jump', 'Jump'], ['wave', 'Wave'], ['tpose', 'T-Pose']].map(([k, l]) =>
        h('button', { class: `btn small ${this.anim === k ? 'primary' : ''}`, onclick: () => { this.anim = k; this.renderSide(); } }, l))),
      field('Show Skeleton', checkbox(this.skelHelper?.visible !== false, (v) => { if (this.skelHelper) this.skelHelper.visible = v; })),
      field('Weight Paint', select(this.weightBone || '', [['', '— off —'], ...BONE_NAMES.map((b) => [b, b])], (v) => this.showWeights(v))),
    ));
    s.appendChild(h('div', { class: 'rig-sec' },
      h('div', { class: 'rig-title' }, 'Save'),
      h('button', { class: 'btn primary big', onclick: () => this.save({ asPlayer: true }) }, '★ Save & use as Player Character'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => this.save({ place: true }) }, 'Save & place in level'),
        h('button', { class: 'btn', onclick: () => this.save() }, 'Save to Content')),
      h('button', { class: 'btn small', onclick: async () => { const b = await this.exportGlb(); download(`${this.sourceName.replace(/\W+/g, '_')}_rigged.glb`, b, 'model/gltf-binary'); } }, 'Download .glb (Blender, Unity, Godot…)'),
      h('button', { class: 'btn small', onclick: () => { this.prepare(false); } }, '← Adjust markers'),
    ));
  }
}

function clear3(g) { while (g.children.length) g.remove(g.children[0]); }
