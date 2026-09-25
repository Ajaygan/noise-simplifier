import * as THREE from 'three';
import { World } from './world.js';
import { Physics } from './physics.js';
import { BlueprintInstance, interpolate } from './blueprint.js';
import { CharacterAnimator } from './anim.js';
import { AudioManager } from './audio.js';
import { convertImportedMaterial } from './materials.js';
import { DEG, clamp, deepClone, uid } from './util.js';

const HUD_CSS = `
.spud-hud{position:absolute;inset:0;pointer-events:none;font-family:system-ui,Segoe UI,Roboto,sans-serif;color:#fff;text-shadow:0 1px 2px #000,0 0 6px #0008;user-select:none;overflow:hidden}
.spud-hud .slot{position:absolute;font-size:18px;font-weight:700;white-space:pre}
.spud-hud .tl{left:14px;top:12px}.spud-hud .tr{right:14px;top:12px;text-align:right}
.spud-hud .center{left:50%;top:40%;transform:translate(-50%,-50%);font-size:28px;text-align:center}
.spud-hud .bottom{left:50%;bottom:70px;transform:translateX(-50%);text-align:center}
.spud-hud .msgs{position:absolute;left:14px;top:44px;display:flex;flex-direction:column;gap:3px;font-size:15px}
.spud-hud .hp{position:absolute;left:14px;bottom:14px;width:200px;height:12px;background:#0008;border:1px solid #fff5;border-radius:3px}
.spud-hud .hp>div{height:100%;background:linear-gradient(90deg,#e63946,#ff8c42);border-radius:2px;transition:width .2s}
.spud-hud .cross{position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px;border-radius:50%;background:#fff;box-shadow:0 0 3px #000}
.spud-hud .prompt{position:absolute;left:50%;bottom:110px;transform:translateX(-50%);background:#000a;padding:6px 12px;border-radius:6px;font-size:15px;display:none}
.spud-hud .hint{position:absolute;right:12px;bottom:10px;font-size:12px;opacity:.7}
.spud-overlay{position:absolute;inset:0;background:#0009;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;pointer-events:auto;font-family:system-ui,sans-serif;color:#fff;z-index:5}
.spud-overlay h1{margin:0;font-size:38px;text-shadow:0 2px 8px #000}
.spud-overlay button{font:600 16px system-ui;padding:10px 26px;border-radius:6px;border:1px solid #fff4;background:#1d2733;color:#fff;cursor:pointer;min-width:180px}
.spud-overlay button:hover{background:#2c3e50}
.spud-touch{position:absolute;inset:0;pointer-events:none}
.spud-touch .stick{position:absolute;left:24px;bottom:24px;width:120px;height:120px;border-radius:50%;background:#fff2;border:2px solid #fff4;pointer-events:auto;touch-action:none}
.spud-touch .knob{position:absolute;left:35px;top:35px;width:50px;height:50px;border-radius:50%;background:#fff6}
.spud-touch .btn{position:absolute;width:70px;height:70px;border-radius:50%;background:#fff2;border:2px solid #fff5;pointer-events:auto;touch-action:none;color:#fff;font:700 14px system-ui;display:flex;align-items:center;justify-content:center}
.spud-touch .look{position:absolute;right:0;top:0;width:55%;height:100%;pointer-events:auto;touch-action:none}
`;

function injectCss() {
  if (document.getElementById('spud-hud-css')) return;
  const s = document.createElement('style'); s.id = 'spud-hud-css'; s.textContent = HUD_CSS; document.head.appendChild(s);
}

export class GameSession {
  constructor({ engine, project, assets, container, onExit = null, onLog = null }) {
    this.engine = engine;
    this.project = deepClone({ ...project, assets: undefined });
    this.assets = assets;
    this.container = container;
    this.onExit = onExit;
    this.onLog = onLog || ((m) => console.log('[game]', m));
    this.settings = this.project.settings;
    this.g = this.settings.game;
    this.camera = new THREE.PerspectiveCamera(this.g.mode === 'firstperson' ? 75 : 60, 1, 0.1, 1000);
    this.keys = new Set();
    this.vars = { health: this.g.health, score: 0, coins: 0 };
    this.tweens = [];
    this.overlaps = new Map(); // actorId -> bool
    this.blueprints = new Map();
    this.shakeT = 0; this.shakeI = 0;
    this.paused = false; this.ended = false;
    this.speedMult = 1;
    this.yaw = 0; this.pitch = -0.2;
    this.camDist = this.g.cameraDistance || 4.5;
    this.touch = { x: 0, y: 0, jump: false, run: false };
    this.audio = new AudioManager(assets);
    this._listeners = [];
  }

  // ---------------- lifecycle ----------------
  async start() {
    injectCss();
    this.world = new World({ quality: this.engine.quality, assets: this.assets, mode: 'game' });
    await this.world.load(this.project);
    this.physics = new Physics(this.world);
    this.physics.gravity = this.g.gravity;
    this.physics.rebuild();
    await this.spawnPlayer();
    this.buildHud();
    this.bindInput();
    this.initNpcs();
    for (const e of this.world.actors.values()) this.attachBlueprint(e);
    this.startAmbientSounds();
    for (const bp of this.blueprints.values()) bp.fire('event_begin');
    this.engine.onResize = (w, h) => { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); };
    this.engine.onResize(this.engine.width, this.engine.height);
    this.log('Game started — click the viewport to capture the mouse, Esc to release.');
    return this;
  }

  log(m) { this.onLog(m); }

  stop() {
    for (const [el, ev, fn, opt] of this._listeners) el.removeEventListener(ev, fn, opt);
    this._listeners = [];
    if (document.pointerLockElement) document.exitPointerLock();
    this.audio.dispose();
    this.hud?.remove(); this.touchEl?.remove(); this.overlay?.remove();
    this.world?.dispose();
    this.world = null;
  }

  async restart() {
    const { engine, assets, container, onExit, onLog } = this;
    this.stop();
    const s = new GameSession({ engine, project: { ...this.project }, assets, container, onExit, onLog });
    if (this.onRestart) this.onRestart(s);
    await s.start();
    return s;
  }

  // ---------------- player ----------------
  async spawnPlayer() {
    const start = [...this.world.actors.values()].find((e) => e.data.type === 'player_start');
    this.spawn = start ? start.obj.position.clone() : new THREE.Vector3(0, 2, 0);
    this.spawnYaw = start ? start.obj.rotation.y : 0;
    const h = this.world.terrainHeight(this.spawn.x, this.spawn.z);
    if (h !== null && h > this.spawn.y) this.spawn.y = h;
    this.player = {
      pos: this.spawn.clone(), vel: new THREE.Vector3(), radius: 0.32, height: this.g.characterHeight || 1.8,
      grounded: false, wasGrounded: false, facing: this.spawnYaw, obj: new THREE.Group(), jumpBuffered: 0, coyote: 0,
    };
    this.yaw = this.spawnYaw + Math.PI;
    this.world.scene.add(this.player.obj);
    try {
      const { object, animations } = await this.assets.instantiate(this.g.character || '__mannequin');
      const box = new THREE.Box3().setFromObject(object);
      const hh = box.max.y - box.min.y;
      if (hh > 0) object.scale.multiplyScalar(this.player.height / hh);
      object.position.y -= box.min.y * (this.player.height / (hh || 1));
      object.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.material = Array.isArray(o.material) ? o.material.map((m) => convertImportedMaterial(m, this.engine.quality, this.assets)) : convertImportedMaterial(o.material, this.engine.quality, this.assets);
        }
      });
      this.player.obj.add(object);
      this.player.model = object;
      this.player.anim = new CharacterAnimator(object, animations);
      if (!this.player.anim.ok) this.log('Player character has no humanoid rig — run it through the Auto-Rig tool to animate it.');
    } catch (e) { this.log(`Could not load player character: ${e.message}`); }
    if (this.g.mode === 'firstperson' && this.player.model) this.player.model.visible = false;
  }

  respawn(msg) {
    this.player.pos.copy(this.spawn); this.player.vel.set(0, 0, 0);
    if (msg) this.print(msg, 2, '#ff8080');
  }

  // ---------------- HUD ----------------
  buildHud() {
    const hud = document.createElement('div');
    hud.className = 'spud-hud';
    hud.innerHTML = `<div class="slot tl"></div><div class="slot tr"></div><div class="slot center"></div><div class="slot bottom"></div>
      <div class="msgs"></div><div class="hp"><div></div></div><div class="prompt"></div>
      ${this.g.mode === 'firstperson' ? '<div class="cross"></div>' : ''}
      <div class="hint">WASD move · Shift run · Space jump · E interact · Esc/P pause</div>`;
    this.container.appendChild(hud);
    this.hud = hud;
    this.slots = { 'top-left': hud.querySelector('.tl'), 'top-right': hud.querySelector('.tr'), center: hud.querySelector('.center'), bottom: hud.querySelector('.bottom') };
    this.slotText = {};
    this.msgs = hud.querySelector('.msgs');
    this.hpBar = hud.querySelector('.hp>div');
    this.prompt = hud.querySelector('.prompt');
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) this.buildTouch();
  }

  buildTouch() {
    const t = document.createElement('div'); t.className = 'spud-touch';
    t.innerHTML = `<div class="look"></div><div class="stick"><div class="knob"></div></div>
      <div class="btn" data-b="jump" style="right:24px;bottom:30px">JUMP</div>
      <div class="btn" data-b="run" style="right:110px;bottom:20px;width:56px;height:56px">RUN</div>
      <div class="btn" data-b="use" style="right:40px;bottom:120px;width:56px;height:56px">E</div>`;
    this.container.appendChild(t); this.touchEl = t;
    const stick = t.querySelector('.stick'), knob = t.querySelector('.knob');
    let sid = null, cx = 0, cy = 0;
    this.on(stick, 'pointerdown', (e) => { sid = e.pointerId; const r = stick.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; stick.setPointerCapture(sid); });
    this.on(stick, 'pointermove', (e) => {
      if (e.pointerId !== sid) return;
      let dx = e.clientX - cx, dy = e.clientY - cy; const l = Math.hypot(dx, dy), m = 45;
      if (l > m) { dx *= m / l; dy *= m / l; }
      knob.style.transform = `translate(${dx}px,${dy}px)`; this.touch.x = dx / m; this.touch.y = dy / m;
    });
    const end = () => { sid = null; knob.style.transform = ''; this.touch.x = this.touch.y = 0; };
    this.on(stick, 'pointerup', end); this.on(stick, 'pointercancel', end);
    const look = t.querySelector('.look'); let lid = null, lx = 0, ly = 0;
    this.on(look, 'pointerdown', (e) => { lid = e.pointerId; lx = e.clientX; ly = e.clientY; });
    this.on(look, 'pointermove', (e) => { if (e.pointerId !== lid) return; this.look(e.clientX - lx, e.clientY - ly, 0.006); lx = e.clientX; ly = e.clientY; });
    this.on(look, 'pointerup', () => { lid = null; });
    for (const b of t.querySelectorAll('.btn')) {
      this.on(b, 'pointerdown', () => { if (b.dataset.b === 'jump') this.player.jumpBuffered = 0.15; if (b.dataset.b === 'run') this.touch.run = !this.touch.run; if (b.dataset.b === 'use') this.interact(); });
    }
  }

  print(text, dur = 2, color = '#9be7ff') {
    const d = document.createElement('div'); d.textContent = text; d.style.color = color;
    this.msgs.appendChild(d);
    while (this.msgs.children.length > 8) this.msgs.firstChild.remove();
    setTimeout(() => d.remove(), dur * 1000);
    this.log(`Print: ${text}`);
  }

  showOverlay(title, buttons) {
    this.overlay?.remove();
    const o = document.createElement('div'); o.className = 'spud-overlay';
    const h = document.createElement('h1'); h.textContent = title; o.appendChild(h);
    for (const [label, fn] of buttons) { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; o.appendChild(b); }
    this.container.appendChild(o); this.overlay = o;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  setPaused(p) {
    if (this.ended) return;
    this.paused = p;
    if (p) this.showOverlay('Paused', [['Resume', () => this.setPaused(false)], ['Restart', () => this.restart()], ...(this.onExit ? [['Quit', () => this.onExit()]] : [])]);
    else { this.overlay?.remove(); this.overlay = null; }
  }

  endGame(result, message) {
    if (this.ended) return;
    this.ended = true;
    this.audio.synth(result === 'win' ? '__win' : '__lose');
    this.showOverlay(message || (result === 'win' ? 'You win!' : 'Game over'), [['Play again', () => this.restart()], ...(this.onExit ? [['Quit', () => this.onExit()]] : [])]);
  }

  // ---------------- input ----------------
  on(el, ev, fn, opt) { el.addEventListener(ev, fn, opt); this._listeners.push([el, ev, fn, opt]); }

  bindInput() {
    const canvas = this.engine.canvas;
    this.on(window, 'keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
      if (this.keys.has(e.code)) return;
      this.keys.add(e.code);
      this.audio.ensure();
      if (e.code === 'Escape' || e.code === 'KeyP') { this.setPaused(!this.paused); return; }
      if (this.paused || this.ended) return;
      if (e.code === 'Space') this.player.jumpBuffered = 0.15;
      if (e.code === 'KeyE') this.interact();
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.code;
      for (const bp of this.blueprints.values()) {
        bp.fire('event_key', {}, (n) => {
          const k = String(n.params?.key || '').trim();
          return k.toUpperCase() === key || k === e.code || `Key${k.toUpperCase()}` === e.code || (k.toLowerCase() === 'space' && e.code === 'Space');
        });
      }
    });
    this.on(window, 'keyup', (e) => this.keys.delete(e.code));
    this.on(window, 'blur', () => this.keys.clear());
    this.on(canvas, 'click', () => {
      this.audio.ensure();
      if (!this.paused && !this.ended && !('ontouchstart' in window) && canvas.requestPointerLock) {
        try { const r = canvas.requestPointerLock(); if (r?.catch) r.catch(() => {}); } catch { /* not allowed */ }
      }
    });
    let dragging = false, lx = 0, ly = 0;
    this.on(canvas, 'mousedown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
    this.on(window, 'mouseup', () => { dragging = false; });
    this.on(window, 'mousemove', (e) => {
      if (this.paused || this.ended) return;
      if (document.pointerLockElement === canvas) this.look(e.movementX, e.movementY, 0.0025);
      else if (dragging) { this.look(e.clientX - lx, e.clientY - ly, 0.005); lx = e.clientX; ly = e.clientY; }
    });
    this.on(canvas, 'wheel', (e) => { e.preventDefault(); this.camDist = clamp(this.camDist + Math.sign(e.deltaY) * 0.5, 1.5, 14); }, { passive: false });
  }

  look(dx, dy, s) {
    this.yaw -= dx * s;
    this.pitch = clamp(this.pitch - dy * s, -1.35, 1.2);
  }

  interact() {
    let best = null, bestD = Infinity;
    for (const [id, bp] of this.blueprints) {
      const e = this.world.actors.get(id); if (!e) continue;
      const nodes = bp.eventNodes('event_interact'); if (!nodes.length) continue;
      const d = e.obj.position.distanceTo(this.player.pos);
      const maxD = Math.max(...nodes.map((n) => Number(n.params?.distance) || 2.5));
      if (d <= maxD && d < bestD) { best = bp; bestD = d; }
    }
    if (best) { best.fire('event_interact'); return; }
    // talkative NPCs
    for (const n of this.npcs || []) {
      if (n.entry.data.props.talk && n.entry.obj.position.distanceTo(this.player.pos) < 3) { this.print(`${n.entry.data.name}: ${n.entry.data.props.talk}`, 3, '#ffe8a3'); return; }
    }
  }

  // ---------------- blueprints ----------------
  attachBlueprint(e) {
    const g = e.data.blueprint;
    if (!g || !g.nodes?.length) return;
    this.blueprints.set(e.id, new BlueprintInstance(g, e.id, this.api()));
  }

  api() {
    if (this._api) return this._api;
    const S = this;
    const T = (target, self) => (!target || target === 'self' ? S.world.actors.get(self) : S.world.byName(target));
    const refresh = (e) => { if (e) { S.physics.refreshStatic(e); e.obj.updateMatrixWorld(true); } };
    this._api = {
      getVar: (n) => S.vars[n] ?? 0,
      setVar: (n, v) => {
        S.vars[n] = v;
        for (const bp of S.blueprints.values()) bp.fire('event_var', {}, (node) => node.params?.name === n && Number(node.params?.value) === Number(v));
      },
      vars: () => S.vars,
      random: Math.random,
      callEvent: (name) => { for (const bp of S.blueprints.values()) bp.fire('event_custom', {}, (n) => n.params?.name === name); },
      moveBy: (t, self, o) => { const e = T(t, self); if (e) { e.obj.position.x += o[0]; e.obj.position.y += o[1]; e.obj.position.z += o[2]; refresh(e); } },
      rotateBy: (t, self, d) => { const e = T(t, self); if (e) { e.obj.rotation.x += d[0] * DEG; e.obj.rotation.y += d[1] * DEG; e.obj.rotation.z += d[2] * DEG; } },
      setLocation: (t, self, p) => { const e = T(t, self); if (e) { e.obj.position.fromArray(p); refresh(e); } },
      tweenMove: (t, self, off, dur, loop) => {
        const e = T(t, self); if (!e) return;
        S.tweens = S.tweens.filter((tw) => tw.e !== e);
        S.tweens.push({ e, from: e.obj.position.clone(), to: e.obj.position.clone().add(new THREE.Vector3(...off)), dur: Math.max(0.01, dur), t: 0, loop, dir: 1 });
      },
      setVisible: (t, self, mode) => { const e = T(t, self); if (e) e.obj.visible = mode === 'toggle' ? !e.obj.visible : mode === 'show'; },
      setColor: (t, self, color) => {
        const e = T(t, self); if (!e) return;
        e.obj.traverse((o) => { if (o.isMesh && o.material?.color) { o.material = o.material.clone(); o.material.color.set(color); } });
      },
      destroy: (t, self) => { const e = T(t, self); if (e) S.destroyActor(e); },
      spawn: (t, self, off) => S.spawnCopy(T(t, self), T('self', self), off),
      setEmitter: (t, self, mode) => { const e = T(t, self); if (e?.emitter) e.emitter.active = mode === 'toggle' ? !e.emitter.active : mode === 'on'; },
      impulse: (t, self, imp) => { const e = T(t, self); const b = e && S.physics.bodyFor(e); if (b) { b.vel.add(new THREE.Vector3(...imp).divideScalar(b.mass)); b.sleep = 0; } },
      launchPlayer: (v) => { S.player.vel.set(v[0], v[1], v[2]); S.player.grounded = false; S.player.wasGrounded = false; S.player.launched = 0.25; },
      teleportPlayer: (t, self) => { const e = T(t, self); if (e) { S.player.pos.copy(e.obj.position); S.player.vel.set(0, 0, 0); } },
      damagePlayer: (a) => {
        S.vars.health = clamp((S.vars.health ?? 100) - a, 0, S.g.health || 100);
        if (a > 0) { S.audio.synth('__hit', 0.6); S.shakeT = 0.25; S.shakeI = 0.15; }
        if (S.vars.health <= 0) S.endGame('lose', 'You died');
      },
      setSpeedMult: (m) => { S.speedMult = m; },
      print: (text, dur, color) => S.print(text, dur, color),
      hudText: (slot, text) => { S.slotText[slot] = text; },
      playSound: (id, vol) => S.audio.play(id, vol),
      shake: (i, d) => { S.shakeI = i; S.shakeT = d; },
      endGame: (r, m) => S.endGame(r, m),
    };
    return this._api;
  }

  destroyActor(e) {
    this.physics.unregister(e);
    const bp = this.blueprints.get(e.id); if (bp) bp.alive = false;
    this.blueprints.delete(e.id);
    this.npcs = (this.npcs || []).filter((n) => n.entry !== e);
    this.tweens = this.tweens.filter((t) => t.e !== e);
    this.world.removeActor(e.id);
  }

  async spawnCopy(template, self, off) {
    if (!template) return;
    const d = deepClone(template.data);
    d.id = uid('spawn'); d.name = `${d.name}_${d.id.slice(-4)}`;
    const base = (self || template).obj.position;
    d.transform.p = [base.x + off[0], base.y + off[1], base.z + off[2]];
    const e = await this.world.addActor(d);
    if (!this.world) return;
    this.physics.register(e);
    if (e.data.type === 'npc') this.initNpc(e);
    this.attachBlueprint(e);
    this.blueprints.get(e.id)?.fire('event_begin');
  }

  // ---------------- NPCs ----------------
  initNpcs() {
    this.npcs = [];
    for (const e of this.world.actors.values()) if (e.data.type === 'npc') this.initNpc(e);
  }

  initNpc(e) {
    this.npcs.push({ entry: e, home: e.obj.position.clone(), target: null, wait: Math.random() * 2, vel: new THREE.Vector3(), grounded: true, speed: 0 });
  }

  updateNpcs(dt) {
    for (const n of this.npcs) {
      const e = n.entry, p = e.data.props, pos = e.obj.position;
      let want = null;
      const toPlayer = this.player.pos.clone().sub(pos); toPlayer.y = 0;
      const dP = toPlayer.length();
      if (p.behavior === 'follow' && dP < p.radius * 2 && dP > 2) want = this.player.pos.clone();
      else if (p.behavior === 'flee' && dP < p.radius) want = pos.clone().sub(toPlayer.normalize().multiplyScalar(3));
      else if (p.behavior === 'wander') {
        if (!n.target || pos.distanceTo(n.target) < 0.5) {
          n.wait -= dt;
          if (n.wait <= 0) { const a = Math.random() * Math.PI * 2, r = Math.random() * p.radius; n.target = n.home.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); n.wait = 1 + Math.random() * 3; }
        } else want = n.target;
      }
      let speed = 0;
      if (want) {
        const dir = want.clone().sub(pos); dir.y = 0;
        if (dir.length() > 0.3) {
          dir.normalize();
          speed = p.speed * (p.behavior === 'flee' ? 1.8 : 1);
          const ch = { pos: pos.clone(), vel: new THREE.Vector3(dir.x * speed, n.vel.y, dir.z * speed), radius: 0.3, height: 1.7, grounded: n.grounded, wasGrounded: n.grounded };
          this.physics.moveCharacter(ch, dt);
          const moved = Math.hypot(ch.pos.x - pos.x, ch.pos.z - pos.z);
          if (moved < speed * dt * 0.2) n.target = null; // stuck -> pick another
          pos.copy(ch.pos); n.vel.y = ch.vel.y; n.grounded = ch.grounded;
          const targetYaw = Math.atan2(dir.x, dir.z);
          let dy = targetYaw - e.obj.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          e.obj.rotation.y += dy * Math.min(1, dt * 8);
        }
      } else {
        const ch = { pos: pos.clone(), vel: new THREE.Vector3(0, n.vel.y, 0), radius: 0.3, height: 1.7, grounded: n.grounded, wasGrounded: n.grounded };
        this.physics.moveCharacter(ch, dt); pos.copy(ch.pos); n.vel.y = ch.vel.y; n.grounded = ch.grounded;
      }
      if (p.behavior === 'idle' || (!want && dP < 4)) {
        // face the player when close
        if (dP < 4) { const ty = Math.atan2(toPlayer.x, toPlayer.z); let dy = ty - e.obj.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); e.obj.rotation.y += dy * Math.min(1, dt * 4); }
      }
      e.animator?.update(dt, { speed, grounded: n.grounded, waving: !!p.talk && dP < 3.5 && speed === 0 });
    }
  }

  // ---------------- sounds ----------------
  startAmbientSounds() {
    this.ambient = [];
    for (const e of this.world.actors.values()) {
      if (e.data.type !== 'audio' || !e.data.props.asset || !e.data.props.autoplay) continue;
      const p = e.data.props;
      const start = async () => {
        const panner = p.spatial ? this.audio.createPanner(p.radius) : null;
        if (panner) { panner.positionX.value = e.obj.position.x; panner.positionY.value = e.obj.position.y; panner.positionZ.value = e.obj.position.z; }
        await this.audio.play(p.asset, p.volume, { loop: p.loop, panner });
      };
      this.ambient.push(start);
    }
    // browsers need a user gesture before audio: start on first input
    const kick = () => { this.audio.ensure(); this.ambient.forEach((f) => f()); this.ambient = []; window.removeEventListener('pointerdown', kick); window.removeEventListener('keydown', kick); };
    if (this.ambient.length) { this.on(window, 'pointerdown', kick); this.on(window, 'keydown', kick); }
  }

  // ---------------- per frame ----------------
  update(dt) {
    if (!this.world) return;
    if (!this.paused && !this.ended) this.simulate(dt);
    this.updateCamera(dt);
    this.world.update(dt, this.camera, { focus: this.player.pos, viewportHeight: this.engine.renderer.getDrawingBufferSize(new THREE.Vector2()).y, animateCharacters: true });
    this.updateHud();
    this.engine.render(this.world.scene, this.camera);
  }

  simulate(dt) {
    const pl = this.player, g = this.g, k = this.keys;
    // input -> desired velocity
    let ix = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let iz = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    ix += this.touch.x; iz -= this.touch.y;
    const il = Math.hypot(ix, iz); if (il > 1) { ix /= il; iz /= il; }
    const run = k.has('ShiftLeft') || k.has('ShiftRight') || this.touch.run;
    const speed = (run ? g.runSpeed : g.walkSpeed) * this.speedMult;
    let fwd, right;
    if (g.mode === 'topdown') { fwd = new THREE.Vector3(0, 0, -1); right = new THREE.Vector3(1, 0, 0); }
    else if (g.mode === 'sidescroller') { fwd = new THREE.Vector3(0, 0, 0); right = new THREE.Vector3(1, 0, 0); iz = 0; }
    else { fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); right = new THREE.Vector3(-fwd.z, 0, fwd.x); }
    const wish = fwd.multiplyScalar(iz).add(right.multiplyScalar(ix));
    const accel = pl.grounded ? 14 : 4;
    if (pl.launched > 0) pl.launched -= dt;
    else {
      pl.vel.x += (wish.x * speed - pl.vel.x) * Math.min(1, accel * dt);
      pl.vel.z += (wish.z * speed - pl.vel.z) * Math.min(1, accel * dt);
    }
    // jump with coyote time + buffering
    pl.coyote = pl.grounded ? 0.12 : pl.coyote - dt;
    pl.jumpBuffered -= dt;
    if (pl.jumpBuffered > 0 && pl.coyote > 0) {
      pl.vel.y = g.jumpVelocity; pl.grounded = false; pl.wasGrounded = false; pl.coyote = 0; pl.jumpBuffered = 0;
      this.audio.synth('__jump', 0.25);
    }
    this.physics.moveCharacter(pl, dt);
    this.physics.stepBodies(dt);
    // facing
    const hs = Math.hypot(pl.vel.x, pl.vel.z);
    if (g.mode === 'firstperson') pl.facing = this.yaw + Math.PI;
    else if (hs > 0.3) {
      const target = Math.atan2(pl.vel.x, pl.vel.z);
      let d = target - pl.facing; d = Math.atan2(Math.sin(d), Math.cos(d));
      pl.facing += d * Math.min(1, dt * 12);
    }
    pl.obj.position.copy(pl.pos);
    pl.obj.rotation.y = pl.facing;
    pl.anim?.update(dt, { speed: hs, grounded: pl.grounded, runSpeed: g.runSpeed });
    // kill z / volumes / overlaps
    if (pl.pos.y < (g.killZ ?? -30)) this.respawn('Fell out of the world');
    this.checkOverlaps();
    this.updateNpcs(dt);
    // tweens
    for (const tw of this.tweens) {
      tw.t += (dt / tw.dur) * tw.dir;
      if (tw.t >= 1) { if (tw.loop === 'pingpong') { tw.t = 1; tw.dir = -1; } else if (tw.loop === 'loop') tw.t = 0; else tw.t = 1; }
      if (tw.t <= 0 && tw.dir < 0) { tw.t = 0; tw.dir = 1; }
      const s = tw.t * tw.t * (3 - 2 * tw.t);
      const prev = tw.e.obj.position.clone();
      tw.e.obj.position.lerpVectors(tw.from, tw.to, s);
      this.physics.refreshStatic(tw.e);
      // carry the player on moving platforms
      if (pl.grounded) {
        const b = new THREE.Box3().setFromObject(tw.e.obj);
        if (pl.pos.x > b.min.x && pl.pos.x < b.max.x && pl.pos.z > b.min.z && pl.pos.z < b.max.z && Math.abs(pl.pos.y - b.max.y) < 0.3) pl.pos.add(tw.e.obj.position.clone().sub(prev));
      }
    }
    this.tweens = this.tweens.filter((tw) => tw.loop !== 'none' || tw.t < 1);
    for (const bp of [...this.blueprints.values()]) bp.update(dt);
    // interact prompt
    let prompt = '';
    for (const [id, bp] of this.blueprints) {
      const e = this.world.actors.get(id); if (!e) continue;
      const n = bp.eventNodes('event_interact')[0];
      if (n && e.obj.position.distanceTo(pl.pos) <= (Number(n.params?.distance) || 2.5)) { prompt = `Press E — ${e.data.name}`; break; }
    }
    if (!prompt) for (const n of this.npcs) if (n.entry.data.props.talk && n.entry.obj.position.distanceTo(pl.pos) < 3) { prompt = `Press E — talk to ${n.entry.data.name}`; break; }
    this.prompt.textContent = prompt; this.prompt.style.display = prompt ? 'block' : 'none';
    this.audio.setListener(this.camera.position, this.camera.getWorldDirection(new THREE.Vector3()));
  }

  checkOverlaps() {
    const pl = this.player;
    const pbox = new THREE.Box3(new THREE.Vector3(pl.pos.x - pl.radius, pl.pos.y, pl.pos.z - pl.radius), new THREE.Vector3(pl.pos.x + pl.radius, pl.pos.y + pl.height, pl.pos.z + pl.radius));
    for (const e of [...this.world.actors.values()]) {
      const t = e.data.type;
      const bp = this.blueprints.get(e.id);
      const hasOverlap = bp && (bp.eventNodes('event_overlap').length || bp.eventNodes('event_overlap_end').length);
      if (t !== 'kill_volume' && !hasOverlap) continue;
      let box;
      if (e.volumeSize) {
        const half = e.volumeSize.clone().multiply(e.obj.scale).multiplyScalar(0.5);
        box = new THREE.Box3(e.obj.position.clone().sub(half), e.obj.position.clone().add(half));
      } else box = new THREE.Box3().setFromObject(e.obj).expandByScalar(0.05);
      const inside = box.intersectsBox(pbox);
      const was = this.overlaps.get(e.id) || false;
      if (inside && !was) {
        if (t === 'kill_volume') { this.respawn('Killed by volume'); this.api().damagePlayer(0); continue; }
        bp?.fire('event_overlap');
      } else if (!inside && was) bp?.fire('event_overlap_end');
      this.overlaps.set(e.id, inside);
    }
  }

  updateCamera(dt) {
    const pl = this.player, g = this.g, cam = this.camera;
    const head = pl.pos.clone().add(new THREE.Vector3(0, pl.height * 0.9, 0));
    if (g.mode === 'firstperson') {
      cam.position.copy(head);
      cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    } else if (g.mode === 'topdown') {
      const target = pl.pos.clone().add(new THREE.Vector3(0, 1, 0));
      const want = target.clone().add(new THREE.Vector3(0, this.camDist * 2.6, this.camDist * 1.6));
      cam.position.lerp(want, 1 - Math.exp(-dt * 8)); cam.lookAt(target);
    } else if (g.mode === 'sidescroller') {
      const target = pl.pos.clone().add(new THREE.Vector3(0, 1.2, 0));
      const want = target.clone().add(new THREE.Vector3(0, 1.5, this.camDist * 2.2));
      cam.position.lerp(want, 1 - Math.exp(-dt * 6)); cam.lookAt(target);
    } else {
      const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), -Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
      const pivot = pl.pos.clone().add(new THREE.Vector3(0, pl.height * 0.85, 0));
      let dist = this.camDist;
      const hit = this.physics.raycast(pivot, dir, dist + 0.3, { includeBodies: false });
      if (hit) dist = Math.max(0.6, hit.distance - 0.3);
      const th = this.world.terrainHeight(pivot.x + dir.x * dist, pivot.z + dir.z * dist);
      cam.position.copy(pivot).addScaledVector(dir, dist);
      if (th !== null && cam.position.y < th + 0.3) cam.position.y = th + 0.3;
      cam.lookAt(pivot);
    }
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      cam.position.add(new THREE.Vector3((Math.random() - 0.5) * this.shakeI, (Math.random() - 0.5) * this.shakeI, (Math.random() - 0.5) * this.shakeI));
    }
    cam.updateMatrixWorld();
  }

  updateHud() {
    if (!this.hud) return;
    for (const [slot, el] of Object.entries(this.slots)) {
      const t = this.slotText[slot] ? interpolate(this.slotText[slot], this.vars) : '';
      if (el.textContent !== t) el.textContent = t;
    }
    const max = this.g.health || 100;
    this.hpBar.style.width = `${clamp((this.vars.health / max) * 100, 0, 100)}%`;
  }
}
