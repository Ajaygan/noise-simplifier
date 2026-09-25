import { h, clear, modal, toast } from './ui.js';
import { NODE_TYPES, NODE_CATEGORIES, nodeDefaults, validateGraph } from '../core/blueprint.js';
import { BUILTIN_SOUNDS } from '../core/audio.js';
import { deepClone, uid } from '../core/util.js';

const CAT_COLORS = { Events: '#b3261e', Flow: '#5a5a5a', Actor: '#1f6feb', Player: '#2da44e', Game: '#8250df' };

// One-click gameplay recipes. Positions are laid out left-to-right.
const TEMPLATES = {
  'Pickup (coin)': [
    ['event_overlap', {}], ['set_var', { name: 'coins', op: 'add', value: 1 }], ['play_sound', { asset: '__coin', volume: 0.6 }],
    ['print', { text: 'Coins: {coins}', duration: 1.5, color: '#ffd166' }], ['destroy', { target: 'self' }],
  ],
  'Spin forever': [['event_tick', {}], ['rotate', { deg: [0, 90, 0] }]],
  'Jump pad': [['event_overlap', {}], ['launch_player', { velocity: [0, 14, 0] }], ['play_sound', { asset: '__jump', volume: 0.6 }]],
  'Door (press E)': [['event_interact', { distance: 3 }], ['flip_flop', {}], ['move_to', { offset: [0, 3, 0], duration: 1, loop: 'none' }]],
  'Moving platform': [['event_begin', {}], ['move_to', { offset: [0, 0, 6], duration: 3, loop: 'pingpong' }]],
  'Damage zone': [['event_timer', { interval: 0.5 }], ['branch_var', { name: '__inside', cmp: '==', value: 1 }], ['damage_player', { amount: 10 }]],
  'Win zone': [['event_overlap', {}], ['end_game', { result: 'win', message: 'Level complete!' }]],
  'Collect 5 to win': [['event_var', { name: 'coins', value: 5 }], ['end_game', { result: 'win', message: 'You collected them all!' }]],
  'HUD score': [['event_begin', {}], ['hud_text', { slot: 'top-right', text: 'Coins: {coins}' }]],
  'Explode on key': [['event_key', { key: 'F' }], ['play_sound', { asset: '__boom', volume: 0.8 }], ['camera_shake', { intensity: 0.4, duration: 0.5 }], ['destroy', { target: 'self' }]],
};

export class BlueprintEditor {
  constructor(editor, actorId) {
    this.editor = editor;
    this.entry = editor.world.actors.get(actorId);
    this.graph = deepClone(this.entry.data.blueprint) || { nodes: [], links: [] };
    this.graph.links = this.graph.links || [];
    this.view = { x: 60, y: 60, z: 1 };
    this.selected = null;
    this.open();
  }

  open() {
    this.palette = h('div', { class: 'bp-palette' });
    this.canvas = h('div', { class: 'bp-canvas', tabindex: 0 });
    this.world = h('div', { class: 'bp-world' });
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'bp-wires');
    this.world.appendChild(this.svg);
    this.canvas.appendChild(this.world);
    this.canvas.appendChild(h('div', { class: 'bp-hint' }, 'Drag from an output pin to another node to wire · drag background to pan · wheel to zoom · Del removes node · right-click a wire to delete it'));
    const body = h('div', { class: 'bp-layout' }, this.palette, this.canvas);
    this.m = modal({
      title: `Blueprint — ${this.entry.data.name}`, body, width: '94vw', className: 'bp-modal',
      buttons: [['Clear graph', () => { if (confirm('Remove all nodes?')) { this.graph = { nodes: [], links: [] }; this.render(); } return false; }], ['Cancel', () => true], ['Compile & Save', () => this.save(), 'primary']],
    });
    this.buildPalette();
    this.bindCanvas();
    this.render();
  }

  save() {
    const errs = validateGraph(this.graph);
    if (errs.length) { toast(errs[0], 'error'); return false; }
    this.editor.pushUndo('Edit blueprint');
    this.entry.data.blueprint = this.graph.nodes.length ? deepClone(this.graph) : null;
    this.editor.markDirty();
    this.editor.ui.renderDetails(); this.editor.ui.renderOutliner();
    this.editor.log(`Blueprint compiled for ${this.entry.data.name}: ${this.graph.nodes.length} nodes`);
    toast('Blueprint compiled', 'ok');
    return true;
  }

  buildPalette() {
    const p = this.palette;
    clear(p);
    const search = h('input', { type: 'search', class: 'search', placeholder: 'Search nodes…' });
    const list = h('div', { class: 'bp-pal-list' });
    const render = () => {
      clear(list);
      const q = search.value.toLowerCase();
      list.appendChild(h('div', { class: 'place-cat' }, 'Templates'));
      for (const name of Object.keys(TEMPLATES)) {
        if (q && !name.toLowerCase().includes(q)) continue;
        list.appendChild(h('div', { class: 'place-item tpl', onclick: () => this.addTemplate(name) }, '★ ', name));
      }
      for (const cat of NODE_CATEGORIES) {
        const items = Object.entries(NODE_TYPES).filter(([, d]) => d.cat === cat && d.label.toLowerCase().includes(q));
        if (!items.length) continue;
        list.appendChild(h('div', { class: 'place-cat', style: { color: CAT_COLORS[cat] } }, cat));
        for (const [type, d] of items) {
          const el = h('div', { class: 'place-item', draggable: 'true' }, h('span', { class: 'bp-dot', style: { background: CAT_COLORS[cat] } }), d.label);
          el.addEventListener('click', () => this.addNode(type));
          el.addEventListener('dragstart', (e) => e.dataTransfer.setData('spud/node', type));
          list.appendChild(el);
        }
      }
    };
    search.addEventListener('input', render);
    p.append(search, list);
    render();
  }

  toGraph(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left - this.view.x) / this.view.z, y: (clientY - r.top - this.view.y) / this.view.z };
  }

  addNode(type, pos) {
    const r = this.canvas.getBoundingClientRect();
    const p = pos || this.toGraph(r.left + r.width / 2 - 100, r.top + r.height / 3 + Math.random() * 60);
    const n = { id: uid('n'), type, x: Math.round(p.x), y: Math.round(p.y), params: nodeDefaults(type) };
    this.graph.nodes.push(n);
    this.selected = n.id;
    this.render();
    return n;
  }

  addTemplate(name) {
    const steps = TEMPLATES[name];
    const maxY = this.graph.nodes.reduce((m, n) => Math.max(m, n.y + 170), 20);
    let prev = null;
    steps.forEach(([type, params], i) => {
      const n = { id: uid('n'), type, x: 30 + i * 250, y: maxY, params: { ...nodeDefaults(type), ...deepClone(params) } };
      this.graph.nodes.push(n);
      if (prev) this.graph.links.push({ from: prev.id, fromPin: NODE_TYPES[prev.type].outs[0], to: n.id });
      prev = n;
    });
    if (name === 'Damage zone') {
      // needs overlap events maintaining the __inside flag
      const y = maxY + 170;
      const a = { id: uid('n'), type: 'event_overlap', x: 30, y, params: {} };
      const b = { id: uid('n'), type: 'set_var', x: 280, y, params: { name: '__inside', op: 'set', value: 1 } };
      const c = { id: uid('n'), type: 'event_overlap_end', x: 530, y, params: {} };
      const d = { id: uid('n'), type: 'set_var', x: 780, y, params: { name: '__inside', op: 'set', value: 0 } };
      this.graph.nodes.push(a, b, c, d);
      this.graph.links.push({ from: a.id, fromPin: 'out', to: b.id }, { from: c.id, fromPin: 'out', to: d.id });
    }
    this.render();
    toast(`Added template: ${name}`, 'ok');
  }

  deleteNode(id) {
    this.graph.nodes = this.graph.nodes.filter((n) => n.id !== id);
    this.graph.links = this.graph.links.filter((l) => l.from !== id && l.to !== id);
    if (this.selected === id) this.selected = null;
    this.render();
  }

  applyView() {
    this.world.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.z})`;
    this.canvas.style.backgroundPosition = `${this.view.x}px ${this.view.y}px`;
    this.canvas.style.backgroundSize = `${24 * this.view.z}px ${24 * this.view.z}px`;
  }

  bindCanvas() {
    const c = this.canvas;
    let pan = null;
    c.addEventListener('pointerdown', (e) => {
      if (e.target !== c && e.target !== this.world && e.target !== this.svg) return;
      pan = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
      this.selected = null; this.render();
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (pan) { this.view.x = pan.vx + e.clientX - pan.x; this.view.y = pan.vy + e.clientY - pan.y; this.applyView(); }
      if (this.linkDrag) this.updateLinkDrag(e);
    });
    c.addEventListener('pointerup', (e) => { pan = null; if (this.linkDrag) this.finishLinkDrag(e); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const before = this.toGraph(e.clientX, e.clientY);
      this.view.z = Math.min(1.6, Math.max(0.35, this.view.z * (e.deltaY < 0 ? 1.1 : 0.9)));
      const r = c.getBoundingClientRect();
      this.view.x = e.clientX - r.left - before.x * this.view.z;
      this.view.y = e.clientY - r.top - before.y * this.view.z;
      this.applyView();
    }, { passive: false });
    c.addEventListener('keydown', (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { e.preventDefault(); this.deleteNode(this.selected); }
    });
    c.addEventListener('dragover', (e) => e.preventDefault());
    c.addEventListener('drop', (e) => { const t = e.dataTransfer.getData('spud/node'); if (t) { e.preventDefault(); this.addNode(t, this.toGraph(e.clientX, e.clientY)); } });
  }

  paramInput(node, p) {
    const val = node.params[p.key] ?? p.default;
    const set = (v) => { node.params[p.key] = v; };
    const stop = (el) => { el.addEventListener('pointerdown', (e) => e.stopPropagation()); el.addEventListener('keydown', (e) => e.stopPropagation()); return el; };
    switch (p.type) {
      case 'number': { const i = stop(h('input', { type: 'number', step: p.step || 0.1, value: val })); i.addEventListener('change', () => set(parseFloat(i.value) || 0)); return i; }
      case 'vec3': return h('div', { class: 'bp-vec' }, [0, 1, 2].map((k) => { const i = stop(h('input', { type: 'number', step: 0.1, value: val[k] })); i.addEventListener('change', () => { const v = [...(node.params[p.key] || val)]; v[k] = parseFloat(i.value) || 0; set(v); }); return i; }));
      case 'select': { const s = stop(h('select', {}, p.options.map((o) => h('option', { value: o, selected: o === val }, o)))); s.addEventListener('change', () => set(s.value)); return s; }
      case 'color': { const i = stop(h('input', { type: 'color', value: val })); i.addEventListener('input', () => set(i.value)); return i; }
      case 'actor': {
        const names = ['self', ...[...this.editor.world.actors.values()].map((e) => e.data.name).sort()];
        const s = stop(h('select', {}, names.map((n) => h('option', { value: n, selected: n === val }, n === 'self' ? 'Self' : n))));
        s.addEventListener('change', () => set(s.value)); return s;
      }
      case 'sound': {
        const opts = [...Object.entries(BUILTIN_SOUNDS), ...this.editor.assets.list('sound').map((a) => [a.id, a.name])];
        const s = stop(h('select', {}, opts.map(([k, l]) => h('option', { value: k, selected: k === val }, l))));
        s.addEventListener('change', () => set(s.value)); return s;
      }
      default: { const i = stop(h('input', { type: 'text', value: val })); i.addEventListener('change', () => set(i.value)); return i; }
    }
  }

  render() {
    for (const el of [...this.world.querySelectorAll('.bp-node')]) el.remove();
    this.nodeEls = new Map();
    for (const n of this.graph.nodes) {
      const def = NODE_TYPES[n.type];
      if (!def) continue;
      const color = CAT_COLORS[def.cat];
      const inPin = def.event ? null : h('div', { class: 'pin in', 'data-node': n.id, title: 'exec in' }, h('i', { class: 'tri' }));
      const outs = def.outs.map((o) => {
        const pin = h('div', { class: 'pin out', 'data-node': n.id, 'data-pin': o, title: `exec out: ${o}` }, o === 'out' ? '' : o, h('i', { class: 'tri' }));
        pin.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.startLinkDrag(n, o, pin, e); });
        return pin;
      });
      const head = h('div', { class: 'bp-head', style: { background: `linear-gradient(90deg, ${color}, ${color}99)` } }, inPin, h('span', { class: 'bp-title' }, def.event ? '◆ ' : 'ƒ ', def.label));
      const body = h('div', { class: 'bp-body' },
        h('div', { class: 'bp-params' }, def.params.map((p) => h('label', { class: 'bp-param' }, h('span', {}, p.label), this.paramInput(n, p)))),
        h('div', { class: 'bp-outs' }, outs));
      const el = h('div', { class: `bp-node ${this.selected === n.id ? 'sel' : ''}`, style: { left: `${n.x}px`, top: `${n.y}px`, borderColor: this.selected === n.id ? '#ffb000' : color + '88' } }, head, body);
      head.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        this.selected = n.id;
        this.world.querySelectorAll('.bp-node').forEach((x) => x.classList.remove('sel'));
        el.classList.add('sel');
        const sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y;
        const move = (ev) => { n.x = Math.round(ox + (ev.clientX - sx) / this.view.z); n.y = Math.round(oy + (ev.clientY - sy) / this.view.z); el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; this.drawWires(); };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      });
      head.addEventListener('dblclick', () => this.deleteNode(n.id));
      head.title = 'Drag to move · double-click to delete';
      this.world.appendChild(el);
      this.nodeEls.set(n.id, el);
    }
    this.applyView();
    requestAnimationFrame(() => this.drawWires());
  }

  pinPos(el, side) {
    const wr = this.world.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: ((side === 'out' ? r.right : r.left) - wr.left) / this.view.z, y: (r.top + r.height / 2 - wr.top) / this.view.z };
  }

  wirePath(a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  }

  drawWires() {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    for (const l of this.graph.links) {
      const fromEl = this.nodeEls.get(l.from), toEl = this.nodeEls.get(l.to);
      if (!fromEl || !toEl) continue;
      const pin = fromEl.querySelector(`.pin.out[data-pin="${l.fromPin || 'out'}"]`);
      const inp = toEl.querySelector('.pin.in') || toEl.querySelector('.bp-head');
      if (!pin || !inp) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', this.wirePath(this.pinPos(pin, 'out'), this.pinPos(inp, 'in')));
      path.setAttribute('class', 'wire');
      path.addEventListener('contextmenu', (e) => { e.preventDefault(); this.graph.links = this.graph.links.filter((x) => x !== l); this.drawWires(); });
      path.addEventListener('dblclick', () => { this.graph.links = this.graph.links.filter((x) => x !== l); this.drawWires(); });
      this.svg.appendChild(path);
    }
    if (this.linkDrag?.path) this.svg.appendChild(this.linkDrag.path);
  }

  startLinkDrag(node, pin, pinEl, e) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'wire dragging');
    this.linkDrag = { node, pin, from: this.pinPos(pinEl, 'out'), path };
    this.svg.appendChild(path);
    this.canvas.setPointerCapture(e.pointerId);
    this.updateLinkDrag(e);
  }

  updateLinkDrag(e) {
    const p = this.toGraph(e.clientX, e.clientY);
    this.linkDrag.path.setAttribute('d', this.wirePath(this.linkDrag.from, p));
  }

  finishLinkDrag(e) {
    const ld = this.linkDrag; this.linkDrag = null;
    ld.path.remove();
    const target = document.elementsFromPoint(e.clientX, e.clientY).map((el) => el.closest?.('.bp-node')).find(Boolean);
    if (target) {
      const id = [...this.nodeEls.entries()].find(([, el]) => el === target)?.[0];
      const tn = this.graph.nodes.find((n) => n.id === id);
      if (tn && tn.id !== ld.node.id && !NODE_TYPES[tn.type].event) {
        // one wire per output pin (like UE exec pins)
        this.graph.links = this.graph.links.filter((l) => !(l.from === ld.node.id && (l.fromPin || 'out') === ld.pin));
        this.graph.links.push({ from: ld.node.id, fromPin: ld.pin, to: tn.id });
      } else if (tn && NODE_TYPES[tn.type].event) toast('Event nodes have no input — wire into an action', 'warn');
    }
    this.drawWires();
  }
}
