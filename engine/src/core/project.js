import { DEFAULT_POST } from './postfx.js';

export const PROJECT_VERSION = 1;

export const DEFAULT_SETTINGS = {
  quality: 'ps3',
  frameCap: 0,
  dynamicResolution: true,
  sky: { top: '#2f6db5', horizon: '#c4d9ea', bottom: '#5d6b75', sunColor: '#fff1d6', showSun: true, sunSize: 1 },
  ambient: { sky: '#bcd4ff', ground: '#5a4a3a', intensity: 0.75 },
  fog: { enabled: true, color: '#c4d9ea', near: 50, far: 260 },
  post: { ...DEFAULT_POST },
  game: {
    mode: 'thirdperson', character: '__mannequin', characterHeight: 1.8,
    walkSpeed: 3.2, runSpeed: 7, jumpVelocity: 6.5, gravity: -18,
    cameraDistance: 4.5, health: 100, killZ: -30,
  },
};

// The level every new project starts from — the "Third Person Template".
export function createDefaultProject(createActorData) {
  const A = createActorData;
  const actors = [
    A('light_dir', { name: 'Sun', transform: { p: [0, 12, 0], r: [-55, 35, 0] } }),
    A('terrain', { name: 'Landscape', props: {} }),
    A('player_start', { name: 'PlayerStart', transform: { p: [0, 0.2, 8], r: [0, 180, 0] } }),
    A('mesh', { name: 'Platform', transform: { p: [0, 0.25, 0], s: [8, 0.5, 8] }, props: { shape: 'box', material: { color: '#9aa3ad', roughness: 0.8 } } }),
    A('mesh', { name: 'Ramp', transform: { p: [-6, 1, -1], s: [4, 2, 4], r: [0, -90, 0] }, props: { shape: 'ramp', material: { color: '#c28e5c' } } }),
    A('mesh', { name: 'Block', transform: { p: [-6, 1, -5], s: [4, 2, 4] }, props: { shape: 'box', material: { color: '#6d8fb3' } } }),
    A('mesh', { name: 'Crate1', transform: { p: [3, 1, -2] }, props: { shape: 'crate', physics: 'dynamic', mass: 2 } }),
    A('mesh', { name: 'Crate2', transform: { p: [3.2, 2.1, -2.1], r: [0, 20, 0] }, props: { shape: 'crate', physics: 'dynamic', mass: 2 } }),
    A('mesh', { name: 'Barrel', transform: { p: [2, 1, 2] }, props: { shape: 'barrel', physics: 'dynamic' } }),
    A('mesh', { name: 'Coin', transform: { p: [-6, 3, -5] }, props: { shape: 'coin', collision: 'none', material: { color: '#ffcc33', emissive: '#553300', roughness: 0.2, metalness: 0.8 } },
      blueprint: {
        nodes: [
          { id: 'n1', type: 'event_tick', x: 40, y: 40, params: {} },
          { id: 'n2', type: 'rotate', x: 280, y: 40, params: { deg: [0, 180, 0] } },
          { id: 'n3', type: 'event_overlap', x: 40, y: 200, params: {} },
          { id: 'n4', type: 'set_var', x: 280, y: 200, params: { name: 'coins', op: 'add', value: 1 } },
          { id: 'n5', type: 'play_sound', x: 520, y: 200, params: { asset: '__coin', volume: 0.6 } },
          { id: 'n6', type: 'print', x: 760, y: 200, params: { text: 'Coins: {coins}', duration: 2, color: '#ffd166' } },
          { id: 'n7', type: 'destroy', x: 1000, y: 200, params: { target: 'self' } },
        ],
        links: [
          { from: 'n1', fromPin: 'out', to: 'n2' },
          { from: 'n3', fromPin: 'out', to: 'n4' }, { from: 'n4', fromPin: 'out', to: 'n5' },
          { from: 'n5', fromPin: 'out', to: 'n6' }, { from: 'n6', fromPin: 'out', to: 'n7' },
        ],
      } }),
    A('foliage', { name: 'Forest', transform: { p: [0, 0, 0] }, props: { shape: 'tree', count: 60, radius: 45, seed: 3 } }),
    A('foliage', { name: 'Rocks', transform: { p: [0, 0, 0] }, props: { shape: 'rock', count: 25, radius: 40, seed: 11, scaleMin: 0.6, scaleMax: 2.2 } }),
    A('foliage', { name: 'Grass', transform: { p: [0, 0, 0] }, props: { shape: 'grass', count: 300, radius: 30, seed: 5, castShadow: false, scaleMin: 0.5, scaleMax: 0.9 } }),
    A('particles', { name: 'Campfire', transform: { p: [5, 0.55, 4] }, props: { preset: 'fire' } }),
    A('light_point', { name: 'FireLight', transform: { p: [5, 1.5, 4] }, props: { color: '#ff9a3c', intensity: 10, distance: 10, flicker: 0.6 } }),
    A('npc', { name: 'Wanderer', transform: { p: [8, 0.5, -6] }, props: { behavior: 'wander', tint: '#ffb4a2', talk: 'Nice day for testing!' } }),
    A('text', { name: 'Sign', transform: { p: [0, 2.6, -3.5] }, props: { text: 'Welcome to Spud Engine\nWASD + Space + Shift', size: 1 } }),
  ];
  // flat-ish generated terrain
  return {
    version: PROJECT_VERSION,
    name: 'MyGame',
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    assets: {},
    actors,
    meta: { created: new Date().toISOString(), generateTerrain: true },
  };
}

export function createEmptyProject(createActorData) {
  const A = createActorData;
  return {
    version: PROJECT_VERSION,
    name: 'Untitled',
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    assets: {},
    actors: [
      A('light_dir', { name: 'Sun', transform: { p: [0, 10, 0], r: [-50, 30, 0] } }),
      A('mesh', { name: 'Floor', transform: { p: [0, -0.5, 0], s: [40, 1, 40] }, props: { shape: 'box', material: { color: '#7c8791' } } }),
      A('player_start', { name: 'PlayerStart', transform: { p: [0, 0.1, 6], r: [0, 180, 0] } }),
    ],
    meta: { created: new Date().toISOString() },
  };
}

export function migrateProject(p) {
  if (!p || typeof p !== 'object') throw new Error('Not a project file');
  if (!Array.isArray(p.actors)) throw new Error('Project has no actors');
  p.version = p.version || 1;
  p.assets = p.assets || {};
  p.settings = { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...(p.settings || {}) };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const dv = DEFAULT_SETTINGS[k];
    if (dv && typeof dv === 'object') p.settings[k] = { ...dv, ...(p.settings[k] || {}) };
  }
  return p;
}
