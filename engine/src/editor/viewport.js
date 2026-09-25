import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { clamp } from '../core/util.js';

export class Viewport {
  constructor(editor, container) {
    this.editor = editor;
    this.container = container;
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    this.camera.position.set(14, 9, 16);
    this.yaw = Math.atan2(14, 16); this.pitch = -0.4;
    this.applyCamRot();
    this.flySpeed = 10;
    this.keys = new Set();
    this.rmb = false; this.mmb = false; this.orbiting = false;
    this.pivot = new THREE.Vector3();
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.viewMode = 'lit';
    this.gameView = false;
    this.snap = true;

    this.helpers = new THREE.Group();
    this.helpers.name = '__editor_helpers';
    this.grid = new THREE.GridHelper(200, 200, 0x445566, 0x2a3440);
    this.grid.material.transparent = true; this.grid.material.opacity = 0.5;
    this.grid.position.y = 0.001;
    this.helpers.add(this.grid);
    this.selBox = new THREE.BoxHelper(undefined, 0xffaa00);
    this.selBox.visible = false;
    this.helpers.add(this.selBox);
    this.brush = new THREE.Mesh(new THREE.RingGeometry(0.95, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }));
    this.brush.visible = false; this.brush.renderOrder = 999;
    this.helpers.add(this.brush);

    const canvas = editor.engine.canvas;
    this.canvas = canvas;
    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSize(0.9);
    this.gizmoHelper = this.gizmo.getHelper();
    this.gizmo.addEventListener('dragging-changed', (e) => {
      if (e.value) { this.editor.pushUndo('Transform'); this.dragging = true; }
      else { this.dragging = false; this.editor.onTransformEnd(); }
    });
    this.gizmo.addEventListener('objectChange', () => this.editor.onTransformChange());
    this.setSnap(true);
    this.bind();
  }

  attachToScene(scene) {
    scene.add(this.helpers);
    scene.add(this.gizmoHelper);
  }

  applyCamRot() { this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ'); }

  setSnap(on) {
    this.snap = on;
    this.gizmo.setTranslationSnap(on ? 0.25 : null);
    this.gizmo.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null);
    this.gizmo.setScaleSnap(on ? 0.1 : null);
  }

  setMode(m) { this.gizmo.setMode(m); this.editor.ui.updateToolbar(); }

  select(entry) {
    if (entry && !['terrain'].includes(entry.data.type)) this.gizmo.attach(entry.obj); else this.gizmo.detach();
    if (entry) { this.selBox.setFromObject(entry.obj); this.selBox.visible = !this.gameView; } else this.selBox.visible = false;
    this.brush.visible = false;
  }

  setGameView(on) {
    this.gameView = on;
    this.helpers.visible = !on;
    this.gizmoHelper.visible = !on;
    this.editor.world.root.traverse((o) => { if (o.userData.editorOnly) o.visible = !on; });
  }

  setViewMode(m) {
    this.viewMode = m;
    const scene = this.editor.world.scene;
    scene.overrideMaterial = m === 'wireframe' ? new THREE.MeshBasicMaterial({ color: 0x9fd3ff, wireframe: true }) : null;
  }

  focusSelected() {
    const e = this.editor.selected();
    if (!e) return;
    const box = new THREE.Box3().setFromObject(e.obj);
    const c = box.isEmpty() ? e.obj.position.clone() : box.getCenter(new THREE.Vector3());
    const r = box.isEmpty() ? 2 : Math.max(1, box.getSize(new THREE.Vector3()).length() * 0.6);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.camera.position.copy(c).addScaledVector(dir, -r * 2.2);
    this.pivot.copy(c);
  }

  pick(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    this.mouse.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    this.raycaster.params.Points = { threshold: 0.3 };
    const hits = this.raycaster.intersectObjects(this.editor.world.root.children, true);
    for (const h of hits) {
      if (!h.object.visible) continue;
      let o = h.object;
      while (o && o.userData.actorId === undefined) o = o.parent;
      if (o) return { entry: this.editor.world.actors.get(o.userData.actorId), point: h.point, object: h.object };
    }
    return null;
  }

  groundPoint(clientX, clientY) {
    const hit = this.pick(clientX, clientY);
    if (hit) return hit.point;
    const p = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) return p;
    return this.camera.position.clone().add(new THREE.Vector3(0, 0, -10).applyQuaternion(this.camera.quaternion));
  }

  terrainPoint(clientX, clientY, entry) {
    const r = this.canvas.getBoundingClientRect();
    this.mouse.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hit = this.raycaster.intersectObject(entry.terrainMesh, false)[0];
    return hit ? hit.point : null;
  }

  bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    let downX = 0, downY = 0, lastX = 0, lastY = 0, moved = false;
    c.addEventListener('pointerdown', (e) => {
      if (this.editor.playing) return;
      c.focus();
      downX = lastX = e.clientX; downY = lastY = e.clientY; moved = false;
      if (e.button === 2) { this.rmb = true; c.setPointerCapture(e.pointerId); }
      if (e.button === 1) { this.mmb = true; e.preventDefault(); c.setPointerCapture(e.pointerId); }
      if (e.button === 0 && e.altKey) { this.orbiting = true; c.setPointerCapture(e.pointerId); }
      if (e.button === 0 && !e.altKey && this.editor.sculpt.active) {
        const sel = this.editor.selected();
        if (sel?.terrain) { this.sculpting = true; this.editor.pushUndo('Sculpt'); this.sculptAt(e.clientX, e.clientY, 1 / 30); c.setPointerCapture(e.pointerId); }
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (this.editor.playing) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) moved = true;
      if (this.rmb) { this.yaw -= dx * 0.004; this.pitch = clamp(this.pitch - dy * 0.004, -1.55, 1.55); this.applyCamRot(); }
      else if (this.mmb) {
        const s = Math.max(0.01, this.camera.position.distanceTo(this.pivot)) * 0.0018;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
        const d = right.multiplyScalar(-dx * s).add(up.multiplyScalar(dy * s));
        this.camera.position.add(d); this.pivot.add(d);
      } else if (this.orbiting) {
        const off = this.camera.position.clone().sub(this.pivot);
        const sph = new THREE.Spherical().setFromVector3(off);
        sph.theta -= dx * 0.005; sph.phi = clamp(sph.phi - dy * 0.005, 0.05, Math.PI - 0.05);
        off.setFromSpherical(sph);
        this.camera.position.copy(this.pivot).add(off);
        this.camera.lookAt(this.pivot);
        const eul = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
        this.yaw = eul.y; this.pitch = eul.x;
      } else if (this.sculpting) {
        this.sculptAt(e.clientX, e.clientY, 1 / 60);
      }
      if (this.editor.sculpt.active && !this.rmb) this.updateBrush(e.clientX, e.clientY);
    });
    c.addEventListener('pointerup', (e) => {
      if (this.editor.playing) return;
      if (e.button === 0 && !moved && !this.orbiting && !this.sculpting && !this.dragging && !this.gizmo.dragging && !this.gizmoHover) {
        const hit = this.pick(e.clientX, e.clientY);
        this.editor.select(hit ? hit.entry.id : null);
      }
      if (this.sculpting) { this.sculpting = false; this.editor.onSculptEnd(); }
      this.rmb = this.mmb = this.orbiting = false;
      try { c.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    });
    this.gizmo.addEventListener('hoveron', () => { this.gizmoHover = true; });
    this.gizmo.addEventListener('hoveroff', () => { this.gizmoHover = false; });
    c.addEventListener('wheel', (e) => {
      if (this.editor.playing) return;
      e.preventDefault();
      if (this.rmb) { this.flySpeed = clamp(this.flySpeed * (e.deltaY < 0 ? 1.2 : 0.83), 0.5, 200); this.editor.ui.status(`Camera speed ${this.flySpeed.toFixed(1)}`); return; }
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const dist = Math.max(0.5, this.camera.position.distanceTo(this.pivot));
      this.camera.position.addScaledVector(dir, -Math.sign(e.deltaY) * Math.max(0.5, dist * 0.12));
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (this.editor.playing || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.rmb = false; });
    // drag & drop from Place Actors / Content Browser / desktop
    c.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    c.addEventListener('drop', (e) => {
      e.preventDefault();
      const p = this.groundPoint(e.clientX, e.clientY);
      const actor = e.dataTransfer.getData('spud/actor');
      const asset = e.dataTransfer.getData('spud/asset');
      if (actor) { const d = JSON.parse(actor); this.editor.addActor(d.type, { props: d.props, name: d.name, transform: { p: [p.x, p.y + (d.lift || 0), p.z] } }); }
      else if (asset) this.editor.placeAsset(asset, p);
      else if (e.dataTransfer.files?.length) this.editor.importFiles([...e.dataTransfer.files], p);
    });
  }

  updateBrush(x, y) {
    const sel = this.editor.selected();
    if (!sel?.terrain) { this.brush.visible = false; return; }
    const p = this.terrainPoint(x, y, sel);
    if (!p) { this.brush.visible = false; return; }
    this.brush.visible = true;
    this.brush.position.copy(p).add(new THREE.Vector3(0, 0.05, 0));
    this.brush.scale.setScalar(this.editor.sculpt.radius);
  }

  sculptAt(x, y, dt) {
    const sel = this.editor.selected();
    if (!sel?.terrain) return;
    const p = this.terrainPoint(x, y, sel);
    if (!p) return;
    const local = p.clone().sub(sel.obj.position);
    const s = this.editor.sculpt;
    if (s.mode === 'flatten' && this.sculptFlatten === undefined) this.sculptFlatten = local.y;
    sel.terrain.applyBrush(local.x, local.z, { mode: s.mode, radius: s.radius, strength: s.strength, flattenHeight: this.sculptFlatten ?? local.y }, dt);
  }

  update(dt) {
    if (this.sculpting === false) this.sculptFlatten = undefined;
    if (this.rmb) {
      const k = this.keys;
      const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
      const r = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
      const u = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
      const boost = k.has('ShiftLeft') ? 3 : 1;
      if (f || r || u) {
        const v = new THREE.Vector3(r, 0, -f).applyQuaternion(this.camera.quaternion);
        v.y += u;
        this.camera.position.addScaledVector(v, this.flySpeed * boost * dt);
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
        this.pivot.copy(this.camera.position).addScaledVector(dir, 10);
      }
    }
    const sel = this.editor.selected();
    if (sel && this.selBox.visible) this.selBox.setFromObject(sel.obj);
  }

  resize(w, h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
}
