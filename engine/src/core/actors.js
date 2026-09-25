import { DEFAULT_MATERIAL } from './materials.js';
import { TERRAIN_DEFAULTS } from './terrain.js';
import { MANNEQUIN_ID } from './assets.js';
import { uid, deepClone } from './util.js';

// Actor type registry: what appears in "Place Actors", default properties and
// how the Details panel should edit them.

export const ACTOR_TYPES = {
  mesh: {
    label: 'Static Mesh', icon: '▣', category: 'Basic',
    props: () => ({
      shape: 'box', asset: null, material: { ...DEFAULT_MATERIAL },
      castShadow: true, receiveShadow: true, collision: 'auto', physics: 'static',
      mass: 1, bounciness: 0.2, lod: true, cullScale: 1, anim: 'idle', visible: true,
    }),
  },
  light_dir: { label: 'Directional Light', icon: '☀', category: 'Lights', props: () => ({ color: '#fff4e0', intensity: 2.2, castShadow: true, shadowArea: 40 }) },
  light_point: { label: 'Point Light', icon: '✹', category: 'Lights', props: () => ({ color: '#ffd9a0', intensity: 8, distance: 12, castShadow: false, flicker: 0 }) },
  light_spot: { label: 'Spot Light', icon: '◭', category: 'Lights', props: () => ({ color: '#ffffff', intensity: 20, distance: 20, angle: 35, penumbra: 0.3, castShadow: false }) },
  player_start: { label: 'Player Start', icon: '⚑', category: 'Basic', props: () => ({}) },
  trigger: { label: 'Trigger Volume', icon: '⬚', category: 'Volumes', props: () => ({ size: [2, 2, 2], color: '#ff9f1c' }) },
  kill_volume: { label: 'Kill Z Volume', icon: '☠', category: 'Volumes', props: () => ({ size: [200, 2, 200] }) },
  terrain: { label: 'Landscape', icon: '⛰', category: 'Environment', props: () => ({ ...deepClone(TERRAIN_DEFAULTS) }) },
  foliage: {
    label: 'Foliage Scatter', icon: '🌲', category: 'Environment',
    props: () => ({ shape: 'tree', asset: null, count: 40, radius: 25, seed: 7, scaleMin: 0.8, scaleMax: 1.4, alignToTerrain: true, castShadow: true, collision: false }),
  },
  water: { label: 'Water Plane', icon: '≈', category: 'Environment', props: () => ({ size: 60, color: '#2a6f97', opacity: 0.75, waves: 0.15 }) },
  particles: { label: 'Particle Emitter', icon: '✦', category: 'Effects', props: () => ({ preset: 'fire', rate: null, color: '', colorEnd: '', size: null, autoStart: true }) },
  audio: { label: 'Ambient Sound', icon: '♪', category: 'Effects', props: () => ({ asset: null, volume: 0.8, loop: true, autoplay: true, spatial: true, radius: 15 }) },
  text: { label: 'Text Render', icon: 'T', category: 'Basic', props: () => ({ text: 'Hello!', color: '#ffffff', background: '#00000088', size: 1, billboard: true }) },
  npc: {
    label: 'AI Character', icon: '☺', category: 'Characters',
    props: () => ({ asset: MANNEQUIN_ID, behavior: 'wander', speed: 1.6, radius: 8, tint: '#ffffff', height: 1.8, talk: '' }),
  },
};

export const ACTOR_CATEGORIES = ['Basic', 'Lights', 'Characters', 'Environment', 'Volumes', 'Effects'];

export function createActorData(type, overrides = {}) {
  const t = ACTOR_TYPES[type];
  if (!t) throw new Error(`Unknown actor type ${type}`);
  const props = { ...t.props(), ...(overrides.props || {}) };
  return {
    id: overrides.id || uid('act'),
    name: overrides.name || t.label.replace(/\s+/g, ''),
    type,
    transform: {
      p: overrides.transform?.p || [0, 0, 0],
      r: overrides.transform?.r || [0, 0, 0],
      s: overrides.transform?.s || [1, 1, 1],
    },
    props,
    blueprint: overrides.blueprint || null,
    tags: overrides.tags || [],
  };
}
