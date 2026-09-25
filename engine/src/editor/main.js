import * as THREE from 'three';
import { Engine } from '../core/engine.js';
import { World } from '../core/world.js';
import { AssetLibrary, detectFormat } from '../core/assets.js';
import { createActorData, ACTOR_TYPES } from '../core/actors.js';
import { createDefaultProject, createEmptyProject, migrateProject } from '../core/project.js';
import { Terrain } from '../core/terrain.js';
import { GameSession } from '../core/game.js';
import { AudioManager } from '../core/audio.js';
import { suggestQuality, QUALITY_PRESETS } from '../core/quality.js';
import { deepClone, uid, DEG } from '../core/util.js';
import { Viewport } from './viewport.js';
import { EditorUI } from './panels.js';
import { BlueprintEditor } from './blueprint-editor.js';
import { AutoRigTool } from './autorig-ui.js';
import { openPackager, buildGameHtml } from './packager.js';
import { toast, pickFiles, readFile, download, h } from './ui.js';
import { saveProject, loadProject } from './storage.js';

const STRUCTURAL = new Set(['asset', 'shape', 'physics', 'materialOverride', 'preset', 'material.map', 'type', 'resolution']);

class Editor {
  constructor() {
    this.selection = null;
    this.history = { undo: [], redo: [] };
    this.sculpt = { active: false, mode: 'raise', radius: 6, strength: 0.6 };
    this.playing = false;
    this.dirty = false;
  }

  async boot() {
    const vpEl = document.getElementById('viewport');
    this.vpEl = vpEl;
    const canvas = h('canvas', { tabindex: 0, id: 'vp-canvas' });
    vpEl.prepend(canvas);
    let initial = null;
    try { initial = await loadProject('autosave'); } catch { /* private mode etc. */ }
    const quality = initial?.settings?.quality || suggestQuality();
    this.engine = new Engine(canvas, { quality });
    this.assets = new AssetLibrary({});
    this.world = new World({ quality: this.engine.quality, assets: this.assets, mode: 'editor' });
    this.project = { name: 'Loading…', settings: {}, assets: {} };
    this.ui = new EditorUI(this);
    this.viewport = new Viewport(this, vpEl);
    this.viewport.attachToScene(this.world.scene);
    this.ui.buildToolbar();
    this.buildStats();
    this.bindShortcuts();
    this.engine.onResize = (w, hh) => this.viewport.resize(w, hh);
    this.engine.resize();
    this.engine.onFrame = (dt) => this.frame(dt);
    this.engine.start();

    if (initial) {
      try { await this.loadProjectData(initial); this.log('Restored autosaved project'); } catch (e) { this.log(`Autosave unreadable (${e.message}); starting fresh`, 'warn'); await this.newProject('thirdperson', true); }
    } else await this.newProject('thirdperson', true);
    document.getElementById('loading')?.remove();
    this.log(`Spud Engine ready — WebGL2, quality "${QUALITY_PRESETS[this.engine.quality.name].label}" (${navigator.hardwareConcurrency || '?'} cores${navigator.deviceMemory ? `, ${navigator.deviceMemory} GB` : ''})`);
    window.addEventListener('beforeunload', () => { if (this.dirty) this.autosave(true); });
  }

  // ---------------- project ----------------
  snapshotProject() {
    return {
      version: 1, name: this.project.name, settings: deepClone(this.project.settings),
      assets: this.assets.assets, actors: this.world.serializeActors(), meta: this.project.meta || {},
    };
  }

  async loadProjectData(p) {
    p = migrateProject(p);
    this.project = p;
    this.assets.assets = p.assets;
    this.assets.models.clear(); this.assets.textures.clear();
    if (!this._assetSub) this._assetSub = this.assets.onChange(() => this.ui.renderContent());
    this.selection = null;
    this.viewport.select(null);
    if (this.engine.quality.name !== p.settings.quality) this.engine.setQuality(p.settings.quality);
    this.world.quality = this.engine.quality;
    this.applyEngineSettings();
    await this.world.load(p);
    this.history = { undo: [], redo: [] };
    this.ui.projName.textContent = p.name;
    this.ui.renderOutliner(); this.ui.renderDetails(); this.ui.renderContent(); this.ui.updateToolbar();
  }

  applyEngineSettings() {
    const s = this.project.settings;
    this.engine.post.settings = { ...this.engine.post.settings, ...s.post };
    this.engine.frameCap = s.frameCap || 0;
    this.engine.dynamicResolution = s.dynamicResolution !== false;
  }

  async newProject(template = 'thirdperson', silent = false) {
    if (!silent && this.dirty && !confirm('Start a new project? Unsaved changes in the current project will be lost (download it first with File → Save).')) return;
    const p = template === 'empty' ? createEmptyProject(createActorData) : createDefaultProject(createActorData);
    p.settings.quality = this.engine.quality.name;
    const terr = p.actors.find((a) => a.type === 'terrain');
    if (terr) {
      const t = new Terrain(terr.props);
      t.generate({ seed: 4, amplitude: 9 });
      Object.assign(terr.props, t.serialize());
      t.dispose();
    }
    await this.loadProjectData(p);
    this.dirty = false;
    this.autosave();
    this.log(`New project from ${template === 'empty' ? 'Empty' : 'Third Person'} template`);
  }

  async openProjectFile() {
    const [f] = await pickFiles('.spud,.json', false);
    if (!f) return;
    try {
      const p = JSON.parse(await readFile(f, 'text'));
      await this.loadProjectData(p);
      this.markDirty();
      toast(`Opened ${p.name}`, 'ok');
    } catch (e) { toast(`Could not open project: ${e.message}`, 'error'); }
  }

  saveProjectFile() {
    const p = this.snapshotProject();
    download(`${(p.name || 'project').replace(/[^\w-]+/g, '_')}.spud`, JSON.stringify(p), 'application/json');
    this.dirty = false;
    this.autosave();
    toast('Project saved', 'ok');
  }

  markDirty() {
    this.dirty = true;
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.autosave(), 1500);
    this.ui.status('Unsaved changes…');
  }

  async autosave() {
    try { await saveProject('autosave', this.snapshotProject()); this.ui.status(`Autosaved ${new Date().toLocaleTimeString()}`); } catch (e) { this.ui.status(`Autosave failed: ${e.message}`); }
  }

  // ---------------- history ----------------
  stateString() { return JSON.stringify({ actors: this.world.serializeActors(), settings: this.project.settings }); }

  pushUndo(label = 'Edit', coalesceKey = null) {
    const now = performance.now();
    if (coalesceKey && this._lastKey === coalesceKey && now - this._lastT < 1500) { this._lastT = now; return; }
    this._lastKey = coalesceKey; this._lastT = now;
    this.history.undo.push({ label, state: this.stateString() });
    if (this.history.undo.length > 60) this.history.undo.shift();
    this.history.redo = [];
  }

  async restoreState(str) {
    const s = JSON.parse(str);
    const sel = this.selection;
    this.project.settings = s.settings;
    this.world.applySettings(s.settings);
    await this.world.load({ settings: s.settings, actors: s.actors });
    this.select(this.world.actors.has(sel) ? sel : null);
    this.ui.renderOutliner();
    this.markDirty();
  }

  async undo() {
    const h1 = this.history.undo.pop();
    if (!h1) return;
    this.history.redo.push({ label: h1.label, state: this.stateString() });
    await this.restoreState(h1.state);
    this.ui.status(`Undo: ${h1.label}`);
  }

  async redo() {
    const h1 = this.history.redo.pop();
    if (!h1) return;
    this.history.undo.push({ label: h1.label, state: this.stateString() });
    await this.restoreState(h1.state);
    this.ui.status(`Redo: ${h1.label}`);
  }

  // ---------------- selection & actors ----------------
  selected() { return this.selection ? this.world.actors.get(this.selection) : null; }

  select(id) {
    if (this.selection !== id) this.sculpt.active = false;
    this.selection = id;
    const e = this.selected();
    if (this.viewport.gizmo.enabled === false && e) this.viewport.gizmo.enabled = true;
    this.viewport.select(e);
    this.ui.renderOutliner();
    this.ui.renderDetails();
    this.ui.updateToolbar();
  }

  setGizmo(mode) {
    this.viewport.gizmo.enabled = true;
    this.sculpt.active = false;
    this.viewport.setMode(mode);
    this.viewport.select(this.selected());
  }

  uniqueName(base) {
    const names = new Set([...this.world.actors.values()].map((e) => e.data.name));
    if (!names.has(base)) return base;
    let i = 1;
    const stem = base.replace(/\d+$/, '');
    while (names.has(`${stem}${i}`)) i++;
    return `${stem}${i}`;
  }

  async addActor(type, overrides = {}) {
    this.pushUndo(`Add ${type}`);
    const data = createActorData(type, overrides);
    if (overrides.props?.material) data.props.material = { ...ACTOR_TYPES.mesh.props().material, ...overrides.props.material };
    data.name = this.uniqueName(overrides.name || data.name);
    const e = await this.world.addActor(data);
    this.select(e.id);
    this.markDirty();
    this.log(`Added ${ACTOR_TYPES[type].label} "${data.name}"`);
    return e;
  }

  viewCenterPoint() {
    const r = this.engine.canvas.getBoundingClientRect();
    const p = this.viewport.groundPoint(r.left + r.width / 2, r.top + r.height / 2);
    const cam = this.viewport.camera.position;
    if (p.distanceTo(cam) > 40) return cam.clone().add(new THREE.Vector3(0, 0, -12).applyQuaternion(this.viewport.camera.quaternion)).setY(Math.max(0, p.y));
    return p;
  }

  addActorAtView(item) {
    const p = this.viewCenterPoint();
    return this.addActor(item.type, { props: item.props, name: item.label?.replace(/\W+/g, ''), transform: { p: [+p.x.toFixed(2), +(p.y + (item.lift || 0)).toFixed(2), +p.z.toFixed(2)] } });
  }

  placeAsset(assetId, point = null) {
    const a = assetId === '__mannequin' ? { name: 'Mannequin', rigged: true } : this.assets.get(assetId);
    if (!a) return;
    const p = point || this.viewCenterPoint();
    return this.addActor('mesh', { name: a.name.replace(/\W+/g, ''), props: { asset: assetId, anim: 'idle' }, transform: { p: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)] } });
  }

  rename(id, name) {
    const e = this.world.actors.get(id);
    if (!e || !name.trim()) return;
    this.pushUndo('Rename');
    e.data.name = this.uniqueName(name.trim());
    e.obj.name = e.data.name;
    this.ui.renderOutliner();
    this.markDirty();
  }

  async setProp(id, path, value, { rebuild = true, undo = true } = {}) {
    const e = this.world.actors.get(id);
    if (!e) return;
    if (undo) this.pushUndo(`Set ${path}`, `${id}:${path}`);
    const keys = path.split('.');
    let o = e.data.props;
    for (let i = 0; i < keys.length - 1; i++) { o[keys[i]] = o[keys[i]] || {}; o = o[keys[i]]; }
    o[keys[keys.length - 1]] = value;
    if (rebuild) await this.world.rebuildActor(id);
    if (id === this.selection) {
      this.viewport.select(e);
      if (STRUCTURAL.has(path) || (e.data.type === 'mesh' && path === 'asset')) this.ui.renderDetails();
    }
    this.markDirty();
  }

  setTransform(id, key, v) {
    const e = this.world.actors.get(id);
    if (!e) return;
    this.pushUndo('Transform', `${id}:t:${key}`);
    e.data.transform[key] = v;
    this.world.applyTransform(id);
    this.viewport.select(e);
    this.markDirty();
  }

  onTransformChange() {
    if (!this.selection) return;
    this.world.readTransform(this.selection);
    if (!this._detailsRaf) this._detailsRaf = requestAnimationFrame(() => { this._detailsRaf = null; this.ui.renderDetails(); });
  }

  onTransformEnd() {
    if (this.selection) this.world.readTransform(this.selection);
    const e = this.selected();
    if (e?.data.type === 'foliage') this.world.rebuildActor(e.id);
    this.markDirty();
  }

  onSculptEnd() {
    const e = this.selected();
    if (e?.terrain) Object.assign(e.data.props, e.terrain.serialize());
    this.markDirty();
  }

  async duplicateSelected() {
    const e = this.selected();
    if (!e) return;
    this.world.readTransform(e.id);
    const d = deepClone(e.data);
    d.id = uid('act');
    d.transform.p = [d.transform.p[0] + 1, d.transform.p[1], d.transform.p[2] + 1];
    this.pushUndo('Duplicate');
    d.name = this.uniqueName(d.name);
    const ne = await this.world.addActor(d);
    this.select(ne.id);
    this.markDirty();
  }

  deleteSelected() {
    const e = this.selected();
    if (!e) return;
    this.pushUndo('Delete');
    this.world.removeActor(e.id);
    this.select(null);
    this.markDirty();
    this.log(`Deleted "${e.data.name}"`);
  }

  snapToFloor() {
    const e = this.selected();
    if (!e) return;
    const box = new THREE.Box3().setFromObject(e.obj);
    const origin = new THREE.Vector3(e.obj.position.x, box.min.y + 0.01, e.obj.position.z);
    const rc = new THREE.Raycaster(origin, new THREE.Vector3(0, -1, 0), 0, 500);
    const targets = this.world.root.children.filter((o) => o !== e.obj);
    const hit = rc.intersectObjects(targets, true).find((hh) => hh.object.visible && !hh.object.userData.editorOnly && !hh.object.isSprite);
    let y = hit ? hit.point.y : this.world.terrainHeight(origin.x, origin.z);
    if (y === null || y === undefined) y = 0;
    this.pushUndo('Snap to floor');
    e.obj.position.y += y - box.min.y;
    this.world.readTransform(e.id);
    this.viewport.select(e);
    this.ui.renderDetails();
    this.markDirty();
  }

  // ---------------- assets ----------------
  async importDialog(accept = '.glb,.gltf,.fbx,.obj,.png,.jpg,.jpeg,.webp,.mp3,.wav,.ogg') {
    const files = await pickFiles(accept, true);
    if (!files.length) return [];
    return this.importFiles(files);
  }

  async importFiles(files, dropPoint = null) {
    const added = [];
    for (const f of files) {
      const fmt = detectFormat(f.name);
      if (!fmt) { toast(`Unsupported file: ${f.name}`, 'warn'); continue; }
      if (f.size > 60 * 1024 * 1024) { toast(`${f.name} is over 60 MB — too heavy for a potato-friendly project`, 'warn'); continue; }
      try {
        const data = await readFile(f, 'dataurl');
        const name = f.name.replace(/\.[^.]+$/, '');
        const asset = this.assets.add({ type: fmt.type, format: fmt.format, name, data, size: f.size });
        if (fmt.type === 'model') {
          const tpl = await this.assets.loadModel(asset.id);
          const box = new THREE.Box3().setFromObject(tpl.scene);
          const size = box.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z);
          let tris = 0, skinned = false;
          tpl.scene.traverse((o) => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; if (o.isSkinnedMesh) skinned = true; });
          if (maxDim > 20) asset.importScale = maxDim > 50 && maxDim < 1000 ? 0.01 : 2 / maxDim;
          else if (maxDim > 0 && maxDim < 0.05) asset.importScale = 1 / maxDim;
          asset.tris = Math.round(tris);
          asset.rigged = skinned;
          this.log(`Imported model ${f.name}: ${Math.round(tris).toLocaleString()} tris${skinned ? ', has skeleton' : ''}${asset.importScale ? `, auto-scaled ×${+asset.importScale.toFixed(4)}` : ''}`);
          if (tris > 30000) this.log(`  Warning: ${name} is heavy for low-end devices; Auto LOD will help at distance.`, 'warn');
          if (dropPoint) this.placeAsset(asset.id, dropPoint);
          else toast(h('span', {}, `Imported ${name}. `, h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); this.placeAsset(asset.id); } }, 'Place'), ' · ', h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); this.openAutoRig(asset.id); } }, 'Auto-Rig')), 'ok', 6000);
        } else {
          this.log(`Imported ${fmt.type} ${f.name} (${Math.round(f.size / 1024)} KB)`);
          if (fmt.type === 'texture' && dropPoint) {
            const hit = this.viewport.pick(dropPoint.clientX || 0, dropPoint.clientY || 0);
            void hit;
          }
        }
        added.push(asset);
      } catch (e) {
        console.error(e);
        toast(`Failed to import ${f.name}: ${e.message}`, 'error');
        this.log(`Import failed for ${f.name}: ${e.message}${f.name.endsWith('.gltf') ? ' (use .glb — .gltf files with external buffers cannot be imported)' : ''}`, 'error');
      }
    }
    this.markDirty();
    return added;
  }

  deleteAsset(id) {
    const users = [...this.world.actors.values()].filter((e) => e.data.props.asset === id || e.data.props.material?.map === id);
    if (users.length && !confirm(`${users.length} actor(s) use this asset. Delete anyway?`)) return;
    this.assets.remove(id);
    for (const e of users) { if (e.data.props.asset === id) e.data.props.asset = null; if (e.data.props.material?.map === id) e.data.props.material.map = null; this.world.rebuildActor(e.id); }
    if (this.project.settings.game.character === id) this.project.settings.game.character = '__mannequin';
    this.markDirty();
  }

  previewSound(id) {
    if (!this._audio) this._audio = new AudioManager(this.assets);
    this._audio.play(id, 0.8);
  }

  // ---------------- tools ----------------
  openAutoRig(assetId = null) { return new AutoRigTool(this, assetId); }

  openBlueprint(id = this.selection) {
    if (!id) { toast('Select an actor first', 'warn'); return; }
    return new BlueprintEditor(this, id);
  }

  packageGame() { openPackager(this); }

  bakeLighting() {
    if (!this.world.terrains.length) { toast('Add a Landscape first', 'warn'); return; }
    this.pushUndo('Bake lighting');
    const t = performance.now();
    this.world.bakeLighting();
    this.markDirty();
    this.log(`Lighting baked in ${Math.round(performance.now() - t)} ms`);
    toast('Lighting baked into the landscape', 'ok');
  }

  async setQuality(q) {
    this.project.settings.quality = q;
    this.engine.setQuality(q);
    await this.world.setQuality(this.engine.quality);
    this.viewport.select(this.selected());
    this.ui.updateToolbar();
    this.markDirty();
    const p = this.engine.quality;
    this.log(`Quality → ${p.label}: ${p.maxHeight}p cap, ${p.shading} shading, shadows ${p.shadows ? p.shadowMapSize : 'off'}, textures ≤${p.textureMax}px, post ${p.post ? 'on' : 'off'}`);
  }

  // ---------------- play in editor ----------------
  async togglePlay() {
    if (this.playing) return this.stopPlay();
    this.world.serializeActors();
    this.playing = true;
    document.body.classList.add('playing');
    this.viewport.gizmo.detach();
    this.ui.updateToolbar();
    const session = new GameSession({
      engine: this.engine, project: this.snapshotProject(), assets: this.assets, container: this.vpEl,
      onExit: () => this.stopPlay(), onLog: (m) => this.log(`[Game] ${m}`),
    });
    const onRestart = (s) => { this.session = s; s.onRestart = onRestart; };
    session.onRestart = onRestart;
    this.session = session;
    try { await session.start(); } catch (e) { console.error(e); this.log(`Play failed: ${e.message}`, 'error'); this.stopPlay(); return; }
    this.engine.canvas.focus();
  }

  stopPlay() {
    if (!this.playing) return;
    this.session?.stop();
    this.session = null;
    this.playing = false;
    document.body.classList.remove('playing');
    this.engine.onResize = (w, hh) => this.viewport.resize(w, hh);
    this.engine.resize();
    this.viewport.select(this.selected());
    this.ui.updateToolbar();
    this.log('Stopped play session');
  }

  // ---------------- loop ----------------
  frame(dt) {
    if (this.playing && this.session) {
      this.session.update(dt);
    } else {
      this.viewport.update(dt);
      this.world.update(dt, this.viewport.camera, { focus: this.viewport.pivot, viewportHeight: this.engine.renderer.getDrawingBufferSize(new THREE.Vector2()).y });
      this.engine.render(this.world.scene, this.viewport.camera);
    }
    this.updateStats();
  }

  buildStats() {
    this.statsEl = h('div', { class: 'vp-stats' });
    this.vpEl.appendChild(this.statsEl);
    this.showStats = true;
  }

  toggleStats() { this.showStats = !this.showStats; this.statsEl.style.display = this.showStats ? '' : 'none'; }

  updateStats() {
    if (!this.showStats) return;
    const now = performance.now();
    if (now - (this._statT || 0) < 400) return;
    this._statT = now;
    const s = this.engine.stats, q = this.engine.quality;
    this.statsEl.innerHTML = `<b>${s.fps}</b> FPS · ${s.ms} ms<br>${s.calls} draws · ${(s.tris / 1000).toFixed(1)}k tris<br>${s.w}×${s.h} (${Math.round(s.scale * 100)}%) · ${q.label}${this.playing ? '<br><span class="pie">PLAYING</span>' : ''}`;
    const fpsEl = document.getElementById('status-fps');
    if (fpsEl) fpsEl.textContent = `${s.fps} FPS`;
  }

  log(msg, level = 'info') { this.ui?.log(msg, level); if (level === 'error') console.error(msg); }

  // ---------------- shortcuts ----------------
  bindShortcuts() {
    window.addEventListener('keydown', (e) => {
      const inField = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || document.querySelector('.modal-back');
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.altKey && e.code === 'KeyP') { e.preventDefault(); this.togglePlay(); return; }
      if (this.playing) return;
      if (ctrl && e.code === 'KeyS') { e.preventDefault(); this.saveProjectFile(); return; }
      if (inField) return;
      if (ctrl && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if (ctrl && e.code === 'KeyY') { e.preventDefault(); this.redo(); return; }
      if (ctrl && e.code === 'KeyD') { e.preventDefault(); this.duplicateSelected(); return; }
      if (ctrl && e.code === 'KeyO') { e.preventDefault(); this.openProjectFile(); return; }
      if (ctrl && e.code === 'KeyI') { e.preventDefault(); this.importDialog(); return; }
      if (ctrl) return;
      if (this.viewport.rmb) return; // WASD flying
      switch (e.code) {
        case 'KeyQ': this.ui.tbButtons.select.click(); break;
        case 'KeyW': this.setGizmo('translate'); break;
        case 'KeyE': this.setGizmo('rotate'); break;
        case 'KeyR': this.setGizmo('scale'); break;
        case 'KeyF': this.viewport.focusSelected(); break;
        case 'KeyG': document.getElementById('tb-game')?.click(); break;
        case 'Delete': case 'Backspace': this.deleteSelected(); break;
        case 'End': this.snapToFloor(); break;
        case 'Escape': this.select(null); break;
        default: break;
      }
    });
  }
}

window.addEventListener('error', (e) => { const l = document.getElementById('loading'); if (l) l.textContent = `Failed to start: ${e.message}`; });
const editor = new Editor();
window.spud = editor; // handy for debugging from the console
editor.buildGameHtml = (opts = {}) => buildGameHtml(editor.snapshotProject(), { title: editor.project.name, ...opts });
editor.boot().catch((e) => {
  console.error(e);
  const l = document.getElementById('loading');
  if (l) l.innerHTML = `<div>Spud Engine failed to start</div><pre>${e.message}</pre><div>WebGL2 is required.</div>`;
});

void DEG;
