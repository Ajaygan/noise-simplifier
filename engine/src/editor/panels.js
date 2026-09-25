import { h, clear, field, numberInput, vec3Input, textInput, colorInput, checkbox, select, slider, section, menu, modal } from './ui.js';
import { ACTOR_TYPES, ACTOR_CATEGORIES } from '../core/actors.js';
import { SHAPES } from '../core/shapes.js';
import { SHADING_MODES } from '../core/materials.js';
import { PARTICLE_PRESETS } from '../core/particles.js';
import { QUALITY_PRESETS, QUALITY_ORDER } from '../core/quality.js';
import { BUILTIN_SOUNDS } from '../core/audio.js';
import { MANNEQUIN_ID } from '../core/assets.js';

const PLACE_ITEMS = [
  { cat: 'Basic', label: 'Cube', type: 'mesh', props: { shape: 'box' }, lift: 0.5 },
  { cat: 'Basic', label: 'Sphere', type: 'mesh', props: { shape: 'sphere' }, lift: 0.5 },
  { cat: 'Basic', label: 'Cylinder', type: 'mesh', props: { shape: 'cylinder' }, lift: 0.5 },
  { cat: 'Basic', label: 'Cone', type: 'mesh', props: { shape: 'cone' }, lift: 0.5 },
  { cat: 'Basic', label: 'Capsule', type: 'mesh', props: { shape: 'capsule' }, lift: 0.7 },
  { cat: 'Basic', label: 'Torus', type: 'mesh', props: { shape: 'torus' }, lift: 0.6 },
  { cat: 'Basic', label: 'Plane', type: 'mesh', props: { shape: 'plane' } },
  { cat: 'Basic', label: 'Ramp', type: 'mesh', props: { shape: 'ramp' }, lift: 0.5 },
  { cat: 'Basic', label: 'Stairs', type: 'mesh', props: { shape: 'stairs' }, lift: 0.5 },
  { cat: 'Basic', label: 'Player Start', type: 'player_start' },
  { cat: 'Basic', label: 'Text Render', type: 'text', lift: 1.5 },
  { cat: 'Props', label: 'Crate (physics)', type: 'mesh', props: { shape: 'crate', physics: 'dynamic' }, lift: 0.5 },
  { cat: 'Props', label: 'Barrel (physics)', type: 'mesh', props: { shape: 'barrel', physics: 'dynamic' }, lift: 0.5 },
  { cat: 'Props', label: 'Coin', type: 'mesh', props: { shape: 'coin', collision: 'none', material: { color: '#ffcc33', emissive: '#553300', roughness: 0.2 } }, lift: 1 },
  { cat: 'Props', label: 'Tree', type: 'mesh', props: { shape: 'tree' } },
  { cat: 'Props', label: 'Pine Tree', type: 'mesh', props: { shape: 'pine' } },
  { cat: 'Props', label: 'Rock', type: 'mesh', props: { shape: 'rock' }, lift: 0.2 },
  { cat: 'Props', label: 'Bush', type: 'mesh', props: { shape: 'bush' } },
  { cat: 'Lights', label: 'Directional Light', type: 'light_dir', lift: 8 },
  { cat: 'Lights', label: 'Point Light', type: 'light_point', lift: 2 },
  { cat: 'Lights', label: 'Spot Light', type: 'light_spot', lift: 4 },
  { cat: 'Characters', label: 'AI Character', type: 'npc' },
  { cat: 'Environment', label: 'Landscape', type: 'terrain' },
  { cat: 'Environment', label: 'Foliage Scatter', type: 'foliage' },
  { cat: 'Environment', label: 'Water Plane', type: 'water', lift: 0.2 },
  { cat: 'Volumes', label: 'Trigger Volume', type: 'trigger', lift: 1 },
  { cat: 'Volumes', label: 'Kill Z Volume', type: 'kill_volume' },
  { cat: 'Effects', label: 'Fire', type: 'particles', props: { preset: 'fire' } },
  { cat: 'Effects', label: 'Smoke', type: 'particles', props: { preset: 'smoke' } },
  { cat: 'Effects', label: 'Sparks', type: 'particles', props: { preset: 'sparks' }, lift: 1 },
  { cat: 'Effects', label: 'Magic', type: 'particles', props: { preset: 'magic' }, lift: 1 },
  { cat: 'Effects', label: 'Rain', type: 'particles', props: { preset: 'rain' } },
  { cat: 'Effects', label: 'Snow', type: 'particles', props: { preset: 'snow' } },
  { cat: 'Effects', label: 'Ambient Sound', type: 'audio', lift: 1 },
];


// Inline SVG icons: glyph fonts are missing on many old / minimal systems.
const SVG = {
  select: '<path d="M5 3l12 8-5 1 3 6-2 1-3-6-4 4z"/>',
  move: '<path d="M12 2l3 3h-2v6h6V9l3 3-3 3v-2h-6v6h2l-3 3-3-3h2v-6H5v2l-3-3 3-3v2h6V5H9z"/>',
  rotate: '<path d="M12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-6-6v3l4-4-4-4z"/>',
  scale: '<path d="M3 3h7v2H6.4l4.3 4.3-1.4 1.4L5 6.4V10H3zm18 18h-7v-2h3.6l-4.3-4.3 1.4-1.4 4.3 4.3V14h2z"/>',
  world: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 9h-3a15 15 0 0 0-1.3-6 8 8 0 0 1 4.3 6zM12 4c.9 1.3 1.8 3.8 2 7h-4c.2-3.2 1.1-5.7 2-7zM4.1 13h3a15 15 0 0 0 1.3 6 8 8 0 0 1-4.3-6zm3-2h-3a8 8 0 0 1 4.3-6 15 15 0 0 0-1.3 6zM12 20c-.9-1.3-1.8-3.8-2-7h4c-.2 3.2-1.1 5.7-2 7zm3.6-1a15 15 0 0 0 1.3-6h3a8 8 0 0 1-4.3 6z"/>',
  local: '<path d="M11 2h2v5h-2zm0 15h2v5h-2zM2 11h5v2H2zm15 0h5v2h-5zM12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z"/>',
  snap: '<path d="M3 3h18v18H3zm2 2v4h4V5zm6 0v4h4V5zm6 0v4h2V5zM5 11v4h4v-4zm6 0v4h4v-4zm6 0v4h2v-4zM5 17v2h4v-2zm6 0v2h4v-2zm6 0v2h2v-2z"/>',
  person: '<path d="M12 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM7 9h10l-1 7h-2l-.5 6h-3L10 16H8z"/>',
  cube: '<path d="M12 2l9 5v10l-9 5-9-5V7zm0 2.3L5.3 8 12 11.7 18.7 8zM5 9.7v6.1l6 3.4v-6.2zm14 0l-6 3.3v6.2l6-3.4z"/>',
  sound: '<path d="M3 9h4l5-4v14l-5-4H3zm13-1a5 5 0 0 1 0 8l-1.3-1.5a3 3 0 0 0 0-5zm2.5-3a9 9 0 0 1 0 14l-1.3-1.5a7 7 0 0 0 0-11z"/>',
  eye: '<path d="M12 5c5 0 9 4.5 10 7-1 2.5-5 7-10 7S3 14.5 2 12c1-2.5 5-7 10-7zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/>',
};
export const icon = (name) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ico'); s.innerHTML = SVG[name]; return s; };

export class EditorUI {
  constructor(editor) {
    this.editor = editor;
    this.$ = (id) => document.getElementById(id);
    this.buildMenubar();
    this.buildToolbar();
    this.buildPlacePanel();
    this.buildBottom();
    this.placeFilter = '';
  }

  // ---------------- menubar ----------------
  buildMenubar() {
    const E = this.editor;
    const m = this.$('menubar');
    const menus = {
      File: () => [
        { label: 'New Project (Third Person template)', action: () => E.newProject('thirdperson') },
        { label: 'New Empty Project', action: () => E.newProject('empty') },
        '-',
        { label: 'Open Project…', shortcut: 'Ctrl+O', action: () => E.openProjectFile() },
        { label: 'Save Project (download)', shortcut: 'Ctrl+S', action: () => E.saveProjectFile() },
        '-',
        { label: 'Import Asset… (GLB, FBX, OBJ, PNG, JPG, MP3, WAV)', shortcut: 'Ctrl+I', action: () => E.importDialog() },
        '-',
        { label: 'Package Game (single HTML file)…', action: () => E.packageGame() },
      ],
      Edit: () => [
        { label: 'Undo', shortcut: 'Ctrl+Z', action: () => E.undo(), disabled: !E.history.undo.length },
        { label: 'Redo', shortcut: 'Ctrl+Y', action: () => E.redo(), disabled: !E.history.redo.length },
        '-',
        { label: 'Duplicate', shortcut: 'Ctrl+D', action: () => E.duplicateSelected(), disabled: !E.selected() },
        { label: 'Delete', shortcut: 'Del', action: () => E.deleteSelected(), disabled: !E.selected() },
        { label: 'Focus Selected', shortcut: 'F', action: () => E.viewport.focusSelected(), disabled: !E.selected() },
      ],
      Tools: () => [
        { label: 'Auto-Rig Character…', action: () => E.openAutoRig() },
        { label: 'Blueprint Editor (selected actor)…', action: () => E.openBlueprint(), disabled: !E.selected() },
        { label: 'World Settings…', action: () => this.openWorldSettings() },
        '-',
        { label: 'Bake Lighting (terrain)', action: () => E.bakeLighting() },
        { label: 'Performance Stats overlay', action: () => E.toggleStats() },
      ],
      Help: () => [
        { label: 'Controls & Shortcuts', action: () => this.showHelp() },
        { label: 'About Spud Engine', action: () => this.showAbout() },
      ],
    };
    clear(m);
    m.appendChild(h('div', { class: 'logo' }, h('span', { class: 'logo-mark' }, '◆'), 'SPUD', h('span', { class: 'logo-sub' }, 'ENGINE')));
    for (const [name, items] of Object.entries(menus)) {
      const b = h('div', { class: 'menu' }, name);
      b.addEventListener('click', () => menu(b, items()));
      m.appendChild(b);
    }
    m.appendChild(h('div', { class: 'spacer' }));
    this.projName = h('div', { class: 'proj-name', title: 'Click to rename project', onclick: () => { const n = prompt('Project name', E.project.name); if (n) { E.project.name = n; this.projName.textContent = n; E.markDirty(); } } }, E.project?.name || '');
    m.appendChild(this.projName);
  }

  // ---------------- toolbar ----------------
  buildToolbar() {
    const E = this.editor;
    const t = this.$('toolbar');
    clear(t);
    const tb = (id, label, title, fn) => h('button', { class: 'tb', id, title, onclick: fn }, label);
    this.tbButtons = {
      select: tb('tb-select', icon('select'), 'Select (Q)', () => { E.sculpt.active = false; E.viewport.gizmo.detach(); E.viewport.gizmo.enabled = false; this.updateToolbar(); }),
      translate: tb('tb-move', icon('move'), 'Move (W)', () => E.setGizmo('translate')),
      rotate: tb('tb-rot', icon('rotate'), 'Rotate (E)', () => E.setGizmo('rotate')),
      scale: tb('tb-scale', icon('scale'), 'Scale (R)', () => E.setGizmo('scale')),
    };
    const space = tb('tb-space', icon('world'), 'World / Local space', () => { const g = E.viewport.gizmo; g.setSpace(g.space === 'world' ? 'local' : 'world'); space.replaceChildren(icon(g.space === 'world' ? 'world' : 'local')); space.title = `Transform space: ${g.space}`; });
    const snap = tb('tb-snap', icon('snap'), 'Grid snapping', () => { E.viewport.setSnap(!E.viewport.snap); snap.classList.toggle('on', E.viewport.snap); });
    snap.classList.add('on');
    const addBtn = h('button', { class: 'tb wide', title: 'Quickly add an actor' }, '+ Add');
    addBtn.addEventListener('click', () => menu(addBtn, PLACE_ITEMS.map((it) => ({ label: `${it.cat} · ${it.label}`, action: () => E.addActorAtView(it) }))));
    this.qualitySel = select(E.project?.settings?.quality || 'ps3', QUALITY_ORDER.map((k) => [k, `Quality: ${QUALITY_PRESETS[k].label}`]), (v) => E.setQuality(v));
    this.qualitySel.title = 'Engine scalability preset — what the game will run at on the target device';
    const view = select('lit', [['lit', 'Lit'], ['wireframe', 'Wireframe']], (v) => E.viewport.setViewMode(v));
    const gameView = tb('tb-game', icon('eye'), 'Game View (G) — hide editor helpers', () => { E.viewport.setGameView(!E.viewport.gameView); gameView.classList.toggle('on', E.viewport.gameView); });
    this.playBtn = h('button', { class: 'tb play', title: 'Play in editor (Alt+P)', onclick: () => E.togglePlay() }, h('i', { class: 'tri' }), ' Play');
    const pkg = h('button', { class: 'tb wide', title: 'Package the game as a single HTML file', onclick: () => E.packageGame() }, 'Package');
    const rig = h('button', { class: 'tb wide', title: 'Auto-rig a custom character', onclick: () => E.openAutoRig() }, 'Auto-Rig');
    const settings = h('button', { class: 'tb wide', title: 'World Settings', onclick: () => this.openWorldSettings() }, 'World Settings');
    t.append(
      h('div', { class: 'tb-group' }, Object.values(this.tbButtons)),
      h('div', { class: 'tb-group' }, space, snap),
      h('div', { class: 'tb-group' }, addBtn),
      h('div', { class: 'tb-group' }, this.qualitySel, view, gameView),
      h('div', { class: 'spacer' }),
      h('div', { class: 'tb-group' }, rig, settings, pkg),
      h('div', { class: 'tb-group' }, this.playBtn),
    );
    this.updateToolbar();
  }

  updateToolbar() {
    const E = this.editor;
    if (!E.viewport) return;
    const g = E.viewport.gizmo;
    for (const [k, b] of Object.entries(this.tbButtons)) b.classList.toggle('on', k === 'select' ? !g.enabled : g.enabled && g.mode === k);
    this.playBtn.replaceChildren(h('i', { class: E.playing ? 'sq' : 'tri' }), E.playing ? ' Stop' : ' Play');
    this.playBtn.classList.toggle('stop', E.playing);
    if (this.qualitySel) this.qualitySel.value = E.project.settings.quality;
  }

  // ---------------- place actors ----------------
  buildPlacePanel() {
    const E = this.editor;
    const p = this.$('place');
    clear(p);
    const search = h('input', { type: 'search', placeholder: 'Search actors…', class: 'search' });
    const list = h('div', { class: 'place-list' });
    const render = () => {
      clear(list);
      const q = search.value.toLowerCase();
      const cats = [...new Set(PLACE_ITEMS.map((i) => i.cat))];
      for (const cat of cats) {
        const items = PLACE_ITEMS.filter((i) => i.cat === cat && i.label.toLowerCase().includes(q));
        if (!items.length) continue;
        list.appendChild(h('div', { class: 'place-cat' }, cat));
        for (const it of items) {
          const icon = ACTOR_TYPES[it.type]?.icon || '•';
          const el = h('div', { class: 'place-item', draggable: 'true', title: 'Drag into the viewport or double-click' }, h('span', { class: 'pi-icon' }, it.type === 'mesh' ? '▣' : icon), it.label);
          el.addEventListener('dragstart', (e) => e.dataTransfer.setData('spud/actor', JSON.stringify({ type: it.type, props: it.props, lift: it.lift || 0, name: it.label.replace(/\W+/g, '') })));
          el.addEventListener('dblclick', () => E.addActorAtView(it));
          list.appendChild(el);
        }
      }
    };
    search.addEventListener('input', render);
    p.append(h('div', { class: 'panel-title' }, 'Place Actors'), search, list);
    render();
  }

  // ---------------- outliner ----------------
  renderOutliner() {
    const E = this.editor;
    const o = this.$('outliner');
    clear(o);
    const search = h('input', { type: 'search', placeholder: 'Search outliner…', class: 'search', value: this.outlinerFilter || '' });
    search.addEventListener('input', () => { this.outlinerFilter = search.value; this.renderOutlinerList(list); });
    const list = h('div', { class: 'outliner-list' });
    const count = h('span', { class: 'muted' }, ` ${E.world.actors.size} actors`);
    o.append(h('div', { class: 'panel-title' }, 'Outliner', count), search, list);
    this.renderOutlinerList(list);
  }

  renderOutlinerList(list) {
    const E = this.editor;
    clear(list);
    const q = (this.outlinerFilter || '').toLowerCase();
    const entries = [...E.world.actors.values()].filter((e) => e.data.name.toLowerCase().includes(q)).sort((a, b) => a.data.name.localeCompare(b.data.name));
    for (const e of entries) {
      const t = ACTOR_TYPES[e.data.type];
      const row = h('div', { class: `ol-row ${E.selection === e.id ? 'sel' : ''}` },
        h('span', { class: 'ol-icon' }, t?.icon || '•'),
        h('span', { class: 'ol-name' }, e.data.name),
        e.data.blueprint?.nodes?.length ? h('span', { class: 'ol-bp', title: 'Has Blueprint' }, 'BP') : null,
        h('span', { class: 'ol-type' }, t?.label || e.data.type),
      );
      row.addEventListener('click', () => E.select(e.id));
      row.addEventListener('dblclick', () => { E.select(e.id); E.viewport.focusSelected(); });
      list.appendChild(row);
    }
  }

  // ---------------- details ----------------
  renderDetails() {
    const E = this.editor;
    const d = this.$('details');
    clear(d);
    const e = E.selected();
    d.appendChild(h('div', { class: 'panel-title' }, 'Details'));
    if (!e) { d.appendChild(h('div', { class: 'empty' }, 'Select an actor to edit its properties.', h('br'), h('br'), h('span', { class: 'muted' }, 'Tip: hold right mouse + WASD to fly, Alt+drag to orbit, F to focus.'))); return; }
    const data = e.data, p = data.props, id = e.id;
    const set = (key, v, opts) => E.setProp(id, key, v, opts);
    const setMat = (key, v) => E.setProp(id, `material.${key}`, v);
    const typeDef = ACTOR_TYPES[data.type];
    d.appendChild(h('div', { class: 'det-head' }, h('span', { class: 'ol-icon big' }, typeDef?.icon), h('div', {}, textInput(data.name, (v) => E.rename(id, v)), h('div', { class: 'muted' }, typeDef?.label))));

    // transform
    const tr = data.transform;
    d.appendChild(section('Transform', [
      field('Location', vec3Input(tr.p, (v) => E.setTransform(id, 'p', v))),
      field('Rotation', vec3Input(tr.r, (v) => E.setTransform(id, 'r', v), { step: 1 })),
      field('Scale', vec3Input(tr.s, (v) => E.setTransform(id, 's', v), { step: 0.05 })),
    ]));

    const models = [['', '— built-in shape —'], ...E.assets.list('model').map((a) => [a.id, a.name])];
    const textures = [['', '— none —'], ...E.assets.list('texture').map((a) => [a.id, a.name])];
    const sounds = [['', '— none —'], ...Object.entries(BUILTIN_SOUNDS), ...E.assets.list('sound').map((a) => [a.id, a.name])];

    switch (data.type) {
      case 'mesh': {
        const m = { ...p.material };
        d.appendChild(section('Static Mesh', [
          field('Mesh Asset', select(p.asset || '', models, (v) => set('asset', v || null))),
          !p.asset ? field('Shape', select(p.shape, Object.entries(SHAPES).map(([k, s]) => [k, s.label]), (v) => set('shape', v))) : null,
          p.asset ? field('Override Materials', checkbox(p.materialOverride, (v) => set('materialOverride', v))) : null,
          e.animator ? field('Preview Animation', select(p.anim || 'idle', ['none', 'idle', 'walk', 'run', 'wave'], (v) => set('anim', v, { rebuild: false }))) : null,
        ]));
        if (!p.asset || p.materialOverride) {
          d.appendChild(section('Material', [
            field('Base Color', colorInput(m.color, (v) => setMat('color', v))),
            field('Texture', select(m.map || '', textures, (v) => setMat('map', v || null))),
            m.map ? field('UV Tiling', numberInput(m.uvScale ?? 1, (v) => setMat('uvScale', v), { step: 0.5 })) : null,
            m.map ? field('Filtering', select(m.texFilter || 'linear', [['linear', 'Smooth'], ['nearest', 'Pixelated (retro)']], (v) => setMat('texFilter', v))) : null,
            field('Shading', select(m.shading || 'auto', SHADING_MODES.map((s) => [s, s === 'auto' ? 'Auto (from quality)' : s[0].toUpperCase() + s.slice(1)]), (v) => setMat('shading', v)), 'Lambert = per-vertex (cheapest), Phong = PS3 specular, Standard = PBR'),
            field('Roughness', slider(m.roughness ?? 0.7, (v) => setMat('roughness', v))),
            field('Metallic', slider(m.metalness ?? 0, (v) => setMat('metalness', v))),
            field('Emissive', colorInput(m.emissive || '#000000', (v) => setMat('emissive', v))),
            field('Emissive Power', numberInput(m.emissiveIntensity ?? 1, (v) => setMat('emissiveIntensity', v))),
            field('Opacity', slider(m.opacity ?? 1, (v) => setMat('opacity', v))),
            field('Flat Shading', checkbox(m.flat, (v) => setMat('flat', v))),
            field('Double Sided', checkbox(m.doubleSide, (v) => setMat('doubleSide', v))),
          ]));
        }
        d.appendChild(section('Physics & Collision', [
          field('Collision', select(p.collision || 'auto', [['auto', 'Auto'], ['box', 'Box (fastest)'], ['mesh', 'Mesh (ramps, models)'], ['none', 'No collision']], (v) => set('collision', v, { rebuild: false }))),
          field('Simulate', select(p.physics || 'static', [['static', 'Static'], ['dynamic', 'Simulate Physics'], ['none', 'None']], (v) => set('physics', v, { rebuild: false }))),
          p.physics === 'dynamic' ? field('Mass', numberInput(p.mass ?? 1, (v) => set('mass', v, { rebuild: false }))) : null,
          p.physics === 'dynamic' ? field('Bounciness', slider(p.bounciness ?? 0.2, (v) => set('bounciness', v, { rebuild: false }))) : null,
        ], { open: false }));
        d.appendChild(section('Rendering', [
          field('Visible in Game', checkbox(p.visible !== false, (v) => set('visible', v, { rebuild: false }))),
          field('Cast Shadow', checkbox(p.castShadow, (v) => set('castShadow', v))),
          field('Receive Shadow', checkbox(p.receiveShadow, (v) => set('receiveShadow', v))),
          field('Auto LOD', checkbox(p.lod, (v) => set('lod', v)), 'Generate simplified meshes for distance (heavy models only)'),
          field('Cull Distance ×', numberInput(p.cullScale ?? 1, (v) => set('cullScale', v, { rebuild: false }), { step: 0.1 })),
        ], { open: false }));
        break;
      }
      case 'light_dir': case 'light_point': case 'light_spot':
        d.appendChild(section('Light', [
          field('Color', colorInput(p.color, (v) => set('color', v))),
          field('Intensity', numberInput(p.intensity, (v) => set('intensity', v), { step: 0.1 })),
          data.type !== 'light_dir' ? field('Attenuation Radius', numberInput(p.distance, (v) => set('distance', v), { step: 0.5 })) : null,
          data.type === 'light_spot' ? field('Cone Angle', numberInput(p.angle, (v) => set('angle', v), { step: 1 })) : null,
          data.type === 'light_spot' ? field('Penumbra', slider(p.penumbra, (v) => set('penumbra', v))) : null,
          field('Cast Shadows', checkbox(p.castShadow, (v) => set('castShadow', v))),
          data.type === 'light_dir' ? field('Shadow Area (m)', numberInput(p.shadowArea, (v) => set('shadowArea', v), { step: 5 })) : null,
          data.type === 'light_point' ? field('Flicker', slider(p.flicker || 0, (v) => set('flicker', v, { rebuild: false }))) : null,
        ]));
        break;
      case 'trigger': case 'kill_volume':
        d.appendChild(section('Volume', [
          field('Box Extent', vec3Input(p.size, (v) => set('size', v))),
          data.type === 'trigger' ? field('Editor Color', colorInput(p.color, (v) => set('color', v))) : null,
          h('div', { class: 'muted pad' }, data.type === 'trigger' ? 'Use "On Player Overlap Begin" in this actor\'s Blueprint.' : 'Respawns the player on touch.'),
        ]));
        break;
      case 'terrain': d.appendChild(this.terrainSection(e)); break;
      case 'foliage':
        d.appendChild(section('Foliage', [
          field('Mesh Asset', select(p.asset || '', models, (v) => set('asset', v || null))),
          !p.asset ? field('Type', select(p.shape, ['tree', 'pine', 'rock', 'bush', 'grass', 'crate', 'barrel'], (v) => set('shape', v))) : null,
          field('Count', numberInput(p.count, (v) => set('count', Math.max(1, Math.round(v))), { step: 5 })),
          field('Radius', numberInput(p.radius, (v) => set('radius', v), { step: 1 })),
          field('Seed', numberInput(p.seed, (v) => set('seed', Math.round(v)), { step: 1 })),
          field('Scale Min', numberInput(p.scaleMin, (v) => set('scaleMin', v))),
          field('Scale Max', numberInput(p.scaleMax, (v) => set('scaleMax', v))),
          field('Snap to Landscape', checkbox(p.alignToTerrain, (v) => set('alignToTerrain', v))),
          field('Cast Shadow', checkbox(p.castShadow, (v) => set('castShadow', v))),
          field('Collision', checkbox(p.collision, (v) => set('collision', v, { rebuild: false }))),
          h('button', { class: 'btn small', onclick: () => E.world.rebuildActor(id) }, 'Re-scatter on landscape'),
        ]));
        break;
      case 'water':
        d.appendChild(section('Water', [
          field('Size', numberInput(p.size, (v) => set('size', v), { step: 5 })),
          field('Color', colorInput(p.color, (v) => set('color', v))),
          field('Opacity', slider(p.opacity, (v) => set('opacity', v))),
          field('Wave Height', numberInput(p.waves, (v) => set('waves', v, { rebuild: false }), { step: 0.05 })),
        ]));
        break;
      case 'particles':
        d.appendChild(section('Particle System', [
          field('Preset', select(p.preset, Object.keys(PARTICLE_PRESETS), (v) => set('preset', v))),
          field('Spawn Rate', numberInput(p.rate ?? PARTICLE_PRESETS[p.preset].rate, (v) => set('rate', v), { step: 5 })),
          field('Start Color', colorInput(p.color || PARTICLE_PRESETS[p.preset].color, (v) => set('color', v))),
          field('End Color', colorInput(p.colorEnd || PARTICLE_PRESETS[p.preset].colorEnd, (v) => set('colorEnd', v))),
          field('Size', numberInput(p.size ?? PARTICLE_PRESETS[p.preset].size, (v) => set('size', v), { step: 0.05 })),
          field('Auto Start', checkbox(p.autoStart !== false, (v) => set('autoStart', v))),
        ]));
        break;
      case 'audio':
        d.appendChild(section('Sound', [
          field('Sound Asset', select(p.asset || '', sounds.filter(([k]) => !k.startsWith('__')), (v) => set('asset', v || null))),
          field('Volume', slider(p.volume, (v) => set('volume', v, { rebuild: false }))),
          field('Loop', checkbox(p.loop, (v) => set('loop', v, { rebuild: false }))),
          field('Auto Play', checkbox(p.autoplay, (v) => set('autoplay', v, { rebuild: false }))),
          field('3D (spatial)', checkbox(p.spatial, (v) => set('spatial', v, { rebuild: false }))),
          field('Radius', numberInput(p.radius, (v) => set('radius', v), { step: 1 })),
        ]));
        break;
      case 'text':
        d.appendChild(section('Text', [
          field('Text', textInput(p.text, (v) => set('text', v), { multiline: true })),
          field('Color', colorInput(p.color, (v) => set('color', v))),
          field('Background', select(p.background || '', [['', 'None'], ['#00000088', 'Dark'], ['#ffffffcc', 'Light']], (v) => set('background', v))),
          field('Size', numberInput(p.size, (v) => set('size', v), { step: 0.1 })),
        ]));
        break;
      case 'npc':
        d.appendChild(section('AI Character', [
          field('Character', select(p.asset || MANNEQUIN_ID, [[MANNEQUIN_ID, 'Mannequin (built-in)'], ...E.assets.list('model').map((a) => [a.id, `${a.name}${a.rigged ? ' (rigged)' : ''}`])], (v) => set('asset', v))),
          field('Behavior', select(p.behavior, [['idle', 'Idle'], ['wander', 'Wander'], ['follow', 'Follow player'], ['flee', 'Flee from player']], (v) => set('behavior', v, { rebuild: false }))),
          field('Move Speed', numberInput(p.speed, (v) => set('speed', v, { rebuild: false }))),
          field('Radius', numberInput(p.radius, (v) => set('radius', v, { rebuild: false }), { step: 1 })),
          field('Height (m)', numberInput(p.height || 1.8, (v) => set('height', v))),
          field('Tint', colorInput(p.tint, (v) => set('tint', v))),
          field('Dialogue (E)', textInput(p.talk, (v) => set('talk', v, { rebuild: false }))),
        ]));
        break;
      default: break;
    }

    // blueprint section (every actor can have one)
    const bp = data.blueprint;
    d.appendChild(section('Blueprint', [
      h('div', { class: 'muted pad' }, bp?.nodes?.length ? `${bp.nodes.length} nodes, ${bp.links.length} wires` : 'No script. Blueprints add gameplay: pickups, doors, jump pads, enemies…'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary small', onclick: () => E.openBlueprint(id) }, bp?.nodes?.length ? 'Edit Blueprint' : '＋ Add Blueprint'),
        bp?.nodes?.length ? h('button', { class: 'btn small', onclick: () => { E.pushUndo('Remove blueprint'); data.blueprint = null; E.markDirty(); this.renderDetails(); this.renderOutliner(); } }, 'Remove') : null),
    ]));
  }

  terrainSection(e) {
    const E = this.editor, p = e.data.props, s = E.sculpt;
    const modes = [['raise', 'Raise'], ['lower', 'Lower'], ['smooth', 'Smooth'], ['flatten', 'Flatten'], ['noise', 'Noise'], ['paint0', '■ Grass'], ['paint1', '■ Dirt'], ['paint2', '■ Rock']];
    const toolRow = h('div', { class: 'tool-grid' }, modes.map(([m, l]) => {
      const b = h('button', { class: `btn small ${s.active && s.mode === m ? 'primary' : ''}` }, l);
      b.addEventListener('click', () => { s.active = !(s.active && s.mode === m); s.mode = m; if (s.active) { E.viewport.gizmo.detach(); } this.renderDetails(); E.ui.status(s.active ? `Sculpt: ${l.slice(2)} — left-drag on the landscape` : 'Sculpt off'); });
      return b;
    }));
    const set = (k, v) => E.setProp(e.id, k, v);
    const gen = { seed: Math.floor(Math.random() * 1000), amplitude: 8 };
    return h('div', {},
      section('Landscape Sculpt & Paint', [
        toolRow,
        field('Brush Radius', slider(s.radius, (v) => { s.radius = v; }, { min: 1, max: 30, step: 0.5 })),
        field('Strength', slider(s.strength, (v) => { s.strength = v; }, { min: 0.05, max: 2, step: 0.05 })),
        h('div', { class: 'muted pad' }, s.active ? 'Left-drag in the viewport to sculpt. Click the tool again to stop.' : 'Pick a tool, then left-drag on the landscape.'),
      ]),
      section('Generate', [
        field('Seed', numberInput(gen.seed, (v) => { gen.seed = v; }, { step: 1 })),
        field('Height', numberInput(gen.amplitude, (v) => { gen.amplitude = v; }, { step: 1 })),
        h('button', { class: 'btn small', onclick: () => { E.pushUndo('Generate terrain'); e.terrain.generate({ seed: gen.seed, amplitude: gen.amplitude }); Object.assign(p, e.terrain.serialize()); E.markDirty(); } }, 'Generate hills'),
        h('button', { class: 'btn small', onclick: () => { E.pushUndo('Flatten terrain'); e.terrain.heights.fill(0); e.terrain.updateGeometry(); Object.assign(p, e.terrain.serialize()); E.markDirty(); } }, 'Flatten all'),
      ], { open: false }),
      section('Lighting', [
        h('div', { class: 'muted pad' }, 'Bake sun shadows + ambient occlusion into the landscape (like a lightmap). Lets you turn off realtime shadows on potato devices.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn small primary', onclick: () => E.bakeLighting() }, 'Bake Lighting'),
          h('button', { class: 'btn small', onclick: () => { e.terrain.clearBake(); Object.assign(p, e.terrain.serialize()); E.markDirty(); } }, 'Clear')),
      ], { open: false }),
      section('Landscape Settings', [
        field('Size (m)', numberInput(p.size, (v) => set('size', v), { step: 10 })),
        field('Resolution', select(p.resolution, [32, 48, 64, 96, 128], (v) => { if (confirm('Changing resolution resets the heightmap. Continue?')) { E.pushUndo('Terrain resolution'); p.heights = null; p.paint = null; p.baked = null; E.setProp(e.id, 'resolution', +v, { undo: false }); } else this.renderDetails(); })),
        field('Grass Color', colorInput(p.layers[0], (v) => set('layers', [v, p.layers[1], p.layers[2]]))),
        field('Dirt Color', colorInput(p.layers[1], (v) => set('layers', [p.layers[0], v, p.layers[2]]))),
        field('Rock Color', colorInput(p.layers[2], (v) => set('layers', [p.layers[0], p.layers[1], v]))),
        field('Auto Rock on Slopes', checkbox(p.autoRock, (v) => set('autoRock', v))),
        field('Flat Shaded (retro)', checkbox(p.flatShaded, (v) => set('flatShaded', v))),
      ], { open: false }),
    );
  }

  // ---------------- bottom: content browser + log ----------------
  buildBottom() {
    const b = this.$('bottom');
    clear(b);
    this.cbTab = h('div', { class: 'tab on', onclick: () => this.showTab('cb') }, 'Content Browser');
    this.logTab = h('div', { class: 'tab', onclick: () => this.showTab('log') }, 'Output Log');
    this.cbEl = h('div', { class: 'tab-body cb' });
    this.logEl = h('div', { class: 'tab-body log', style: { display: 'none' } });
    b.append(h('div', { class: 'tabs' }, this.cbTab, this.logTab, h('div', { class: 'spacer' }),
      h('button', { class: 'btn small primary', onclick: () => this.editor.importDialog() }, 'Import…'),
      h('button', { class: 'btn small', onclick: () => this.editor.openAutoRig() }, 'Auto-Rig…')), this.cbEl, this.logEl);
  }

  showTab(t) {
    this.cbTab.classList.toggle('on', t === 'cb'); this.logTab.classList.toggle('on', t === 'log');
    this.cbEl.style.display = t === 'cb' ? '' : 'none'; this.logEl.style.display = t === 'log' ? '' : 'none';
    if (t === 'log') this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  renderContent() {
    const E = this.editor;
    const el = this.cbEl;
    clear(el);
    const tiles = [];
    const mk = (a, builtin = false) => {
      const thumb = a.type === 'texture' ? h('img', { src: a.data, class: 'thumb-img' }) : h('div', { class: 'thumb-icon' }, icon(builtin || a.rigged ? 'person' : a.type === 'sound' ? 'sound' : 'cube'));
      const size = a.data ? `${Math.round((a.data.length * 0.75) / 1024)} KB` : '';
      const tile = h('div', { class: 'tile', draggable: 'true', title: `${a.name}\n${a.type}${a.rigged ? ' · rigged' : ''} ${size}` },
        h('div', { class: 'thumb' }, thumb, a.rigged ? h('span', { class: 'badge' }, 'RIG') : null),
        h('div', { class: 'tile-name' }, a.name), h('div', { class: 'tile-type' }, builtin ? 'Character' : a.type));
      tile.addEventListener('dragstart', (e) => e.dataTransfer.setData('spud/asset', a.id));
      tile.addEventListener('dblclick', () => { if (a.type === 'model') E.placeAsset(a.id); });
      tile.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const items = [];
        if (a.type === 'model') {
          items.push({ label: 'Place in level', action: () => E.placeAsset(a.id) });
          items.push({ label: 'Place as AI Character', action: () => E.addActorAtView({ type: 'npc', props: { asset: a.id } }) });
          if (!builtin) items.push({ label: 'Auto-Rig this model…', action: () => E.openAutoRig(a.id) });
          items.push({ label: '★ Use as Player Character', action: () => { E.pushUndo('Player character'); E.project.settings.game.character = a.id; E.markDirty(); E.log(`Player character set to ${a.name}`); } });
        }
        if (a.type === 'texture') items.push({ label: 'Apply to selected mesh', disabled: E.selected()?.data.type !== 'mesh', action: () => E.setProp(E.selection, 'material.map', a.id) });
        if (a.type === 'sound') items.push({ label: '▶ Preview', action: () => E.previewSound(a.id) });
        if (!builtin) {
          items.push('-');
          items.push({ label: 'Rename…', action: () => { const n = prompt('Asset name', a.name); if (n) { E.assets.rename(a.id, n); E.markDirty(); } } });
          items.push({ label: 'Delete', action: () => E.deleteAsset(a.id) });
        }
        const anchor = h('div', { style: { position: 'fixed', left: `${e.clientX}px`, top: `${e.clientY}px` } });
        document.body.appendChild(anchor); menu(anchor, items); setTimeout(() => anchor.remove(), 50);
      });
      tiles.push(tile);
    };
    mk({ id: MANNEQUIN_ID, name: 'Mannequin', type: 'model', rigged: true }, true);
    for (const a of E.assets.list()) mk(a);
    el.append(...tiles, h('div', { class: 'tile drop', onclick: () => E.importDialog() }, h('div', { class: 'thumb' }, h('div', { class: 'thumb-icon' }, '＋')), h('div', { class: 'tile-name' }, 'Import…'), h('div', { class: 'tile-type' }, 'or drop files')));
  }

  log(msg, level = 'info') {
    const t = new Date().toLocaleTimeString();
    this.logEl.appendChild(h('div', { class: `log-line ${level}` }, h('span', { class: 'muted' }, `[${t}] `), msg));
    while (this.logEl.children.length > 400) this.logEl.firstChild.remove();
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  status(msg) { const s = this.$('status-msg'); if (s) s.textContent = msg; }

  // ---------------- world settings ----------------
  openWorldSettings() {
    const E = this.editor;
    const s = E.project.settings;
    const apply = () => { E.world.applySettings(s); E.engine.post.settings = { ...E.engine.post.settings, ...s.post }; E.engine.frameCap = s.frameCap; E.engine.dynamicResolution = s.dynamicResolution; E.markDirty(); };
    const S = (obj, key, input) => input;
    const models = [['__mannequin', 'Mannequin (built-in)'], ...E.assets.list('model').map((a) => [a.id, `${a.name}${a.rigged ? ' (rigged)' : ''}`])];
    const body = h('div', { class: 'ws' },
      section('Game Mode', [
        field('Template', select(s.game.mode, [['thirdperson', 'Third Person'], ['firstperson', 'First Person'], ['topdown', 'Top Down'], ['sidescroller', 'Side Scroller (2.5D)']], (v) => { s.game.mode = v; apply(); })),
        field('Player Character', select(s.game.character, models, (v) => { s.game.character = v; apply(); })),
        field('Character Height', numberInput(s.game.characterHeight, (v) => { s.game.characterHeight = v; apply(); })),
        field('Walk Speed', numberInput(s.game.walkSpeed, (v) => { s.game.walkSpeed = v; apply(); })),
        field('Run Speed', numberInput(s.game.runSpeed, (v) => { s.game.runSpeed = v; apply(); })),
        field('Jump Velocity', numberInput(s.game.jumpVelocity, (v) => { s.game.jumpVelocity = v; apply(); })),
        field('Gravity', numberInput(s.game.gravity, (v) => { s.game.gravity = v; apply(); }, { step: 1 })),
        field('Camera Distance', numberInput(s.game.cameraDistance, (v) => { s.game.cameraDistance = v; apply(); })),
        field('Max Health', numberInput(s.game.health, (v) => { s.game.health = v; apply(); }, { step: 5 })),
        field('Kill Z', numberInput(s.game.killZ, (v) => { s.game.killZ = v; apply(); }, { step: 1 })),
      ]),
      section('Performance (potato mode)', [
        field('Scalability', select(s.quality, QUALITY_ORDER.map((k) => [k, QUALITY_PRESETS[k].label]), (v) => E.setQuality(v))),
        field('Frame Cap', select(s.frameCap, [[0, 'Unlimited (vsync)'], [30, '30 FPS (saves battery)'], [60, '60 FPS']], (v) => { s.frameCap = +v; apply(); })),
        field('Dynamic Resolution', checkbox(s.dynamicResolution, (v) => { s.dynamicResolution = v; apply(); }), 'Lower the internal resolution automatically when FPS drops'),
      ]),
      section('Sky & Sun', [
        field('Zenith', colorInput(s.sky.top, (v) => { s.sky.top = v; apply(); })),
        field('Horizon', colorInput(s.sky.horizon, (v) => { s.sky.horizon = v; apply(); })),
        field('Ground', colorInput(s.sky.bottom, (v) => { s.sky.bottom = v; apply(); })),
        field('Sun Color', colorInput(s.sky.sunColor, (v) => { s.sky.sunColor = v; apply(); })),
        field('Show Sun Disc', checkbox(s.sky.showSun, (v) => { s.sky.showSun = v; apply(); })),
        field('Sky Light', colorInput(s.ambient.sky, (v) => { s.ambient.sky = v; apply(); })),
        field('Bounce Light', colorInput(s.ambient.ground, (v) => { s.ambient.ground = v; apply(); })),
        field('Ambient Intensity', slider(s.ambient.intensity, (v) => { s.ambient.intensity = v; apply(); }, { min: 0, max: 2 })),
      ], { open: false }),
      section('Fog', [
        field('Enabled', checkbox(s.fog.enabled, (v) => { s.fog.enabled = v; apply(); })),
        field('Color', colorInput(s.fog.color, (v) => { s.fog.color = v; apply(); })),
        field('Start', numberInput(s.fog.near, (v) => { s.fog.near = v; apply(); }, { step: 5 })),
        field('End', numberInput(s.fog.far, (v) => { s.fog.far = v; apply(); }, { step: 5 })),
      ], { open: false }),
      section('Post Process (PS3 look)', [
        field('Bloom', checkbox(s.post.bloom, (v) => { s.post.bloom = v; apply(); })),
        field('Bloom Strength', slider(s.post.bloomStrength, (v) => { s.post.bloomStrength = v; apply(); }, { min: 0, max: 2 })),
        field('Bloom Threshold', slider(s.post.bloomThreshold, (v) => { s.post.bloomThreshold = v; apply(); }, { min: 0, max: 1.5 })),
        field('Exposure', slider(s.post.exposure, (v) => { s.post.exposure = v; apply(); }, { min: 0.3, max: 2.5 })),
        field('Contrast', slider(s.post.contrast, (v) => { s.post.contrast = v; apply(); }, { min: 0.5, max: 1.6 })),
        field('Saturation', slider(s.post.saturation, (v) => { s.post.saturation = v; apply(); }, { min: 0, max: 2 })),
        field('Tint', colorInput(s.post.tint, (v) => { s.post.tint = v; apply(); })),
        field('Vignette', slider(s.post.vignette, (v) => { s.post.vignette = v; apply(); }, { min: 0, max: 1.5 })),
        field('Film Grain', slider(s.post.grain, (v) => { s.post.grain = v; apply(); }, { min: 0, max: 0.15, step: 0.005 })),
        h('div', { class: 'muted pad' }, 'Post-processing is skipped entirely on the Potato preset.'),
      ], { open: false }),
    );
    void S;
    modal({ title: 'World Settings', body, width: 460, className: 'side-modal', onClose: () => this.renderDetails() });
  }

  showHelp() {
    const rows = [
      ['Right mouse + WASD / QE', 'Fly camera (wheel while held = speed)'], ['Alt + left drag', 'Orbit around focus'], ['Middle drag', 'Pan'], ['Wheel', 'Dolly'],
      ['F', 'Focus selected'], ['Q / W / E / R', 'Select / Move / Rotate / Scale'], ['G', 'Game view (hide helpers)'], ['Ctrl+D', 'Duplicate'], ['Del', 'Delete'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'], ['Ctrl+S', 'Save project file'], ['Alt+P', 'Play / Stop'], ['End', 'Snap selected to floor'],
      ['In game: WASD, Shift, Space, E', 'Move, run, jump, interact'], ['In game: Esc / P', 'Pause'],
    ];
    modal({ title: 'Controls & Shortcuts', width: 520, body: h('table', { class: 'help' }, rows.map(([k, v]) => h('tr', {}, h('td', { class: 'kbd' }, k), h('td', {}, v)))) });
  }

  showAbout() {
    modal({ title: 'About Spud Engine', width: 480, body: h('div', { class: 'about' },
      h('p', {}, h('b', {}, 'Spud Engine'), ' is a game engine + editor for low-end hardware. Integrated GPUs, old laptops, Chromebooks and phones all work: if it has a browser with WebGL2, it runs.'),
      h('p', {}, 'Rendering targets the PS3 era: per-vertex or Blinn-Phong lighting, low-res textures, shadow maps, bloom, fog and colour grading. Scalability presets go from Potato (480p, no post, no shadows) up to High.'),
      h('p', { class: 'muted' }, 'Built on three.js (MIT). Projects are single JSON files; packaged games are single HTML files.')) });
  }
}
