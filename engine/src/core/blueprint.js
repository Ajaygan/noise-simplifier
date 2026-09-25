// Blueprint-style visual scripting. A graph is { nodes:[{id,type,x,y,params}],
// links:[{from, fromPin, to}] }. Execution follows white "exec" wires from
// event nodes, like UE Blueprints; values are set inline on each node, and
// global variables (Set/Branch on Variable) cover the data-flow cases.

const T = (key, label, def = '') => ({ key, label, type: 'text', default: def });
const N = (key, label, def = 0, step = 0.1) => ({ key, label, type: 'number', default: def, step });
const V3 = (key, label, def = [0, 0, 0]) => ({ key, label, type: 'vec3', default: def });
const ACT = (key = 'target', label = 'Target') => ({ key, label, type: 'actor', default: 'self' });
const SEL = (key, label, options, def) => ({ key, label, type: 'select', options, default: def ?? options[0] });
const COL = (key, label, def = '#ffffff') => ({ key, label, type: 'color', default: def });
const SND = (key = 'asset', label = 'Sound') => ({ key, label, type: 'sound', default: '__coin' });

export const NODE_TYPES = {
  // ----- events -----
  event_begin: { cat: 'Events', label: 'Event BeginPlay', event: true, params: [], outs: ['out'] },
  event_tick: { cat: 'Events', label: 'Event Tick', event: true, params: [], outs: ['out'] },
  event_key: { cat: 'Events', label: 'On Key Pressed', event: true, params: [T('key', 'Key', 'F')], outs: ['out'] },
  event_overlap: { cat: 'Events', label: 'On Player Overlap Begin', event: true, params: [], outs: ['out'] },
  event_overlap_end: { cat: 'Events', label: 'On Player Overlap End', event: true, params: [], outs: ['out'] },
  event_interact: { cat: 'Events', label: 'On Interact (E)', event: true, params: [N('distance', 'Distance', 2.5)], outs: ['out'] },
  event_timer: { cat: 'Events', label: 'Every N Seconds', event: true, params: [N('interval', 'Seconds', 1)], outs: ['out'] },
  event_custom: { cat: 'Events', label: 'Custom Event', event: true, params: [T('name', 'Name', 'MyEvent')], outs: ['out'] },
  event_var: { cat: 'Events', label: 'On Variable Reaches', event: true, params: [T('name', 'Variable', 'coins'), N('value', 'Value', 5, 1)], outs: ['out'] },

  // ----- flow -----
  branch_var: { cat: 'Flow', label: 'Branch on Variable', params: [T('name', 'Variable', 'coins'), SEL('cmp', 'Compare', ['>=', '>', '==', '!=', '<', '<='], '>='), N('value', 'Value', 1, 1)], outs: ['true', 'false'] },
  random: { cat: 'Flow', label: 'Random Chance', params: [N('chance', 'Chance 0-1', 0.5, 0.05)], outs: ['true', 'false'] },
  delay: { cat: 'Flow', label: 'Delay', params: [N('seconds', 'Seconds', 1)], outs: ['out'] },
  sequence: { cat: 'Flow', label: 'Sequence', params: [], outs: ['then0', 'then1', 'then2'] },
  do_once: { cat: 'Flow', label: 'Do Once', params: [], outs: ['out'] },
  flip_flop: { cat: 'Flow', label: 'Flip Flop', params: [], outs: ['A', 'B'] },
  call_event: { cat: 'Flow', label: 'Call Custom Event', params: [T('name', 'Name', 'MyEvent')], outs: ['out'] },

  // ----- actor -----
  move: { cat: 'Actor', label: 'Move By', params: [ACT(), V3('offset', 'Offset (per sec on Tick)', [0, 1, 0])], outs: ['out'] },
  rotate: { cat: 'Actor', label: 'Rotate By', params: [ACT(), V3('deg', 'Degrees (per sec on Tick)', [0, 90, 0])], outs: ['out'] },
  set_location: { cat: 'Actor', label: 'Set Location', params: [ACT(), V3('pos', 'Position', [0, 0, 0])], outs: ['out'] },
  move_to: { cat: 'Actor', label: 'Tween Move', params: [ACT(), V3('offset', 'Offset', [0, 3, 0]), N('duration', 'Seconds', 2), SEL('loop', 'Loop', ['none', 'pingpong', 'loop'], 'none')], outs: ['out'] },
  set_visible: { cat: 'Actor', label: 'Set Visibility', params: [ACT(), SEL('mode', 'Mode', ['toggle', 'show', 'hide'])], outs: ['out'] },
  set_color: { cat: 'Actor', label: 'Set Color', params: [ACT(), COL('color', 'Color', '#ff4444')], outs: ['out'] },
  destroy: { cat: 'Actor', label: 'Destroy Actor', params: [ACT()], outs: ['out'] },
  spawn: { cat: 'Actor', label: 'Spawn Copy Of Actor', params: [ACT('template', 'Template'), V3('offset', 'Offset', [0, 2, 0])], outs: ['out'] },
  emitter: { cat: 'Actor', label: 'Set Emitter Active', params: [ACT(), SEL('mode', 'Mode', ['toggle', 'on', 'off'])], outs: ['out'] },
  set_physics: { cat: 'Actor', label: 'Add Impulse', params: [ACT(), V3('impulse', 'Impulse', [0, 6, 0])], outs: ['out'] },

  // ----- player -----
  launch_player: { cat: 'Player', label: 'Launch Player', params: [V3('velocity', 'Velocity', [0, 12, 0])], outs: ['out'] },
  teleport_player: { cat: 'Player', label: 'Teleport Player To', params: [ACT('target', 'Actor')], outs: ['out'] },
  damage_player: { cat: 'Player', label: 'Damage Player', params: [N('amount', 'Amount', 25, 1)], outs: ['out'] },
  heal_player: { cat: 'Player', label: 'Heal Player', params: [N('amount', 'Amount', 25, 1)], outs: ['out'] },
  set_speed: { cat: 'Player', label: 'Set Walk Speed Multiplier', params: [N('mult', 'Multiplier', 1.5)], outs: ['out'] },

  // ----- game / ui -----
  print: { cat: 'Game', label: 'Print String', params: [T('text', 'Text', 'Hello'), N('duration', 'Seconds', 2), COL('color', 'Color', '#9be7ff')], outs: ['out'] },
  hud_text: { cat: 'Game', label: 'Set HUD Text', params: [SEL('slot', 'Slot', ['top-left', 'top-right', 'center', 'bottom']), T('text', 'Text ({var})', 'Score: {coins}')], outs: ['out'] },
  set_var: { cat: 'Game', label: 'Set Variable', params: [T('name', 'Variable', 'coins'), SEL('op', 'Op', ['set', 'add', 'subtract', 'multiply']), N('value', 'Value', 1, 1)], outs: ['out'] },
  play_sound: { cat: 'Game', label: 'Play Sound', params: [SND(), N('volume', 'Volume', 0.8)], outs: ['out'] },
  camera_shake: { cat: 'Game', label: 'Camera Shake', params: [N('intensity', 'Intensity', 0.3), N('duration', 'Seconds', 0.4)], outs: ['out'] },
  end_game: { cat: 'Game', label: 'End Game', params: [SEL('result', 'Result', ['win', 'lose']), T('message', 'Message', 'You win!')], outs: [] },
};

export const NODE_CATEGORIES = ['Events', 'Flow', 'Actor', 'Player', 'Game'];

export function nodeDefaults(type) {
  const def = NODE_TYPES[type];
  const params = {};
  for (const p of def.params) params[p.key] = Array.isArray(p.default) ? [...p.default] : p.default;
  return params;
}

export function interpolate(text, vars) {
  return String(text).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? (typeof vars[k] === 'number' ? +vars[k].toFixed(2) : vars[k]) : 0));
}

export function compare(a, cmp, b) {
  switch (cmp) {
    case '>': return a > b; case '>=': return a >= b; case '==': return a == b; // eslint-disable-line eqeqeq
    case '!=': return a != b; case '<': return a < b; case '<=': return a <= b; // eslint-disable-line eqeqeq
    default: return false;
  }
}

// Runtime for one actor's graph. `api` is supplied by the game session and
// performs the actual side effects; this class only walks the graph, so it can
// be unit-tested with a fake api.
export class BlueprintInstance {
  constructor(graph, actorId, api) {
    this.graph = graph || { nodes: [], links: [] };
    this.actorId = actorId;
    this.api = api;
    this.nodes = new Map(this.graph.nodes.map((n) => [n.id, n]));
    this.outLinks = new Map();
    for (const l of this.graph.links || []) {
      const k = `${l.from}:${l.fromPin || 'out'}`;
      if (!this.outLinks.has(k)) this.outLinks.set(k, []);
      this.outLinks.get(k).push(l.to);
    }
    this.state = new Map(); // per-node state (do once, flip flop, timers)
    this.pending = []; // delayed continuations {t, nodeId, pin, ctx}
    this.alive = true;
  }

  eventNodes(type) { return this.graph.nodes.filter((n) => n.type === type); }

  fire(type, ctx = {}, filter = null) {
    if (!this.alive) return 0;
    let n = 0;
    for (const node of this.eventNodes(type)) {
      if (filter && !filter(node)) continue;
      this.follow(node.id, 'out', { dt: 1, ...ctx });
      n++;
    }
    return n;
  }

  follow(nodeId, pin, ctx, depth = 0) {
    if (depth > 200 || !this.alive) return; // guard against infinite loops
    const targets = this.outLinks.get(`${nodeId}:${pin}`) || [];
    for (const t of targets) this.exec(t, ctx, depth + 1);
  }

  exec(nodeId, ctx, depth) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const def = NODE_TYPES[node.type];
    if (!def) return;
    const p = { ...nodeDefaults(node.type), ...(node.params || {}) };
    const api = this.api;
    const self = this.actorId;
    const next = (pin = 'out') => this.follow(nodeId, pin, ctx, depth);
    switch (node.type) {
      case 'branch_var': return next(compare(Number(api.getVar(p.name)) || 0, p.cmp, Number(p.value)) ? 'true' : 'false');
      case 'random': return next(api.random() < Number(p.chance) ? 'true' : 'false');
      case 'delay': this.pending.push({ t: Number(p.seconds) || 0, nodeId, pin: 'out', ctx: { ...ctx, dt: 1 } }); return;
      case 'sequence': next('then0'); next('then1'); next('then2'); return;
      case 'do_once': if (this.state.get(nodeId)) return; this.state.set(nodeId, true); return next();
      case 'flip_flop': { const s = !this.state.get(nodeId); this.state.set(nodeId, s); return next(s ? 'A' : 'B'); }
      case 'call_event': api.callEvent(p.name); return next();
      case 'move': api.moveBy(p.target, self, p.offset.map((v) => v * (ctx.dt ?? 1))); return next();
      case 'rotate': api.rotateBy(p.target, self, p.deg.map((v) => v * (ctx.dt ?? 1))); return next();
      case 'set_location': api.setLocation(p.target, self, p.pos); return next();
      case 'move_to': api.tweenMove(p.target, self, p.offset, Number(p.duration), p.loop); return next();
      case 'set_visible': api.setVisible(p.target, self, p.mode); return next();
      case 'set_color': api.setColor(p.target, self, p.color); return next();
      case 'destroy': {
        const isSelf = !p.target || p.target === 'self';
        api.destroy(p.target, self);
        if (isSelf) { this.alive = false; return; }
        return next();
      }
      case 'spawn': api.spawn(p.template, self, p.offset); return next();
      case 'emitter': api.setEmitter(p.target, self, p.mode); return next();
      case 'set_physics': api.impulse(p.target, self, p.impulse); return next();
      case 'launch_player': api.launchPlayer(p.velocity); return next();
      case 'teleport_player': api.teleportPlayer(p.target, self); return next();
      case 'damage_player': api.damagePlayer(Number(p.amount)); return next();
      case 'heal_player': api.damagePlayer(-Number(p.amount)); return next();
      case 'set_speed': api.setSpeedMult(Number(p.mult)); return next();
      case 'print': api.print(interpolate(p.text, api.vars()), Number(p.duration), p.color); return next();
      case 'hud_text': api.hudText(p.slot, p.text); return next();
      case 'set_var': {
        const cur = Number(api.getVar(p.name)) || 0, v = Number(p.value) || 0;
        const val = p.op === 'add' ? cur + v : p.op === 'subtract' ? cur - v : p.op === 'multiply' ? cur * v : v;
        api.setVar(p.name, val);
        return next();
      }
      case 'play_sound': api.playSound(p.asset, Number(p.volume), self); return next();
      case 'camera_shake': api.shake(Number(p.intensity), Number(p.duration)); return next();
      case 'end_game': api.endGame(p.result, interpolate(p.message, api.vars())); return;
      default:
        if (def.event) return next();
    }
  }

  update(dt) {
    if (!this.alive) return;
    // timers
    for (const node of this.eventNodes('event_timer')) {
      const iv = Math.max(0.05, Number(node.params?.interval) || 1);
      const t = (this.state.get(node.id) || 0) + dt;
      if (t >= iv) { this.state.set(node.id, t - iv); this.follow(node.id, 'out', { dt: 1 }); } else this.state.set(node.id, t);
    }
    if (this.pending.length) {
      const due = [];
      this.pending = this.pending.filter((p) => { p.t -= dt; if (p.t <= 0) { due.push(p); return false; } return true; });
      for (const p of due) this.follow(p.nodeId, p.pin, p.ctx);
    }
    if (this.eventNodes('event_tick').length) this.fire('event_tick', { dt });
  }
}

export function validateGraph(graph) {
  const errors = [];
  if (!graph) return errors;
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const n of graph.nodes) if (!NODE_TYPES[n.type]) errors.push(`Unknown node type ${n.type}`);
  for (const l of graph.links || []) if (!ids.has(l.from) || !ids.has(l.to)) errors.push('Dangling link');
  return errors;
}
