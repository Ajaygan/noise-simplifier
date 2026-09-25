import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BlueprintInstance, interpolate, validateGraph, NODE_TYPES, nodeDefaults } from '../src/core/blueprint.js';
import { Terrain } from '../src/core/terrain.js';
import { World } from '../src/core/world.js';
import { Physics } from '../src/core/physics.js';
import { createActorData } from '../src/core/actors.js';
import { createDefaultProject, createEmptyProject, migrateProject } from '../src/core/project.js';
import { resolveQuality } from '../src/core/quality.js';
import { AssetLibrary } from '../src/core/assets.js';

function fakeApi() {
  const log = [];
  const vars = {};
  return {
    log, vars,
    getVar: (n) => vars[n] ?? 0, setVar: (n, v) => { vars[n] = v; }, vars: () => vars, random: () => 0.3,
    callEvent: (n) => log.push(['call', n]), moveBy: (t, s, o) => log.push(['move', o]), rotateBy: (t, s, d) => log.push(['rot', d]),
    setLocation: () => {}, tweenMove: () => {}, setVisible: () => {}, setColor: () => {}, destroy: (t) => log.push(['destroy', t]),
    spawn: () => {}, setEmitter: () => {}, impulse: () => {}, launchPlayer: (v) => log.push(['launch', v]), teleportPlayer: () => {},
    damagePlayer: (a) => log.push(['dmg', a]), setSpeedMult: () => {}, print: (t) => log.push(['print', t]), hudText: () => {},
    playSound: () => {}, shake: () => {}, endGame: (r, m) => log.push(['end', r, m]),
  };
}

test('blueprint: every node type has defaults and known outputs', () => {
  for (const [type, def] of Object.entries(NODE_TYPES)) {
    const d = nodeDefaults(type);
    for (const p of def.params) assert.ok(p.key in d, `${type}.${p.key}`);
    assert.ok(Array.isArray(def.outs));
  }
});

test('blueprint: overlap -> add var -> branch -> print / destroy', () => {
  const api = fakeApi();
  const g = {
    nodes: [
      { id: 'e', type: 'event_overlap', params: {} },
      { id: 'a', type: 'set_var', params: { name: 'coins', op: 'add', value: 1 } },
      { id: 'b', type: 'branch_var', params: { name: 'coins', cmp: '>=', value: 2 } },
      { id: 'p', type: 'print', params: { text: 'got {coins}' } },
      { id: 'd', type: 'destroy', params: { target: 'self' } },
    ],
    links: [{ from: 'e', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', fromPin: 'true', to: 'd' }, { from: 'b', fromPin: 'false', to: 'p' }],
  };
  const bp = new BlueprintInstance(g, 'self1', api);
  bp.fire('event_overlap');
  assert.deepEqual(api.log.at(-1), ['print', 'got 1']);
  bp.fire('event_overlap');
  assert.deepEqual(api.log.at(-1), ['destroy', 'self']);
  assert.equal(bp.alive, false, 'destroying self stops the graph');
  assert.equal(bp.fire('event_overlap'), 0);
});

test('blueprint: tick scales movement by dt, delay and timers fire later', () => {
  const api = fakeApi();
  const g = {
    nodes: [
      { id: 't', type: 'event_tick', params: {} }, { id: 'r', type: 'rotate', params: { deg: [0, 90, 0] } },
      { id: 'b', type: 'event_begin', params: {} }, { id: 'w', type: 'delay', params: { seconds: 0.5 } }, { id: 'l', type: 'launch_player', params: { velocity: [0, 9, 0] } },
      { id: 'tm', type: 'event_timer', params: { interval: 0.25 } }, { id: 'dm', type: 'damage_player', params: { amount: 5 } },
    ],
    links: [{ from: 't', to: 'r' }, { from: 'b', to: 'w' }, { from: 'w', to: 'l' }, { from: 'tm', to: 'dm' }],
  };
  const bp = new BlueprintInstance(g, 'x', api);
  bp.fire('event_begin');
  assert.equal(api.log.filter((l) => l[0] === 'launch').length, 0);
  for (let i = 0; i < 10; i++) bp.update(0.1);
  assert.deepEqual(api.log.find((l) => l[0] === 'rot'), ['rot', [0, 9, 0]]);
  assert.equal(api.log.filter((l) => l[0] === 'launch').length, 1);
  assert.equal(api.log.filter((l) => l[0] === 'dmg').length, 4);
});

test('blueprint: do once, flip flop, sequence, runaway loops are bounded', () => {
  const api = fakeApi();
  const g = {
    nodes: [
      { id: 'k', type: 'event_key', params: { key: 'F' } }, { id: 'o', type: 'do_once' }, { id: 'p1', type: 'print', params: { text: 'once' } },
      { id: 'c', type: 'event_custom', params: { name: 'loop' } }, { id: 'cc', type: 'call_event', params: { name: 'loop' } },
      { id: 'b', type: 'event_begin' }, { id: 'ff', type: 'flip_flop' }, { id: 'pa', type: 'print', params: { text: 'A' } }, { id: 'pb', type: 'print', params: { text: 'B' } },
    ],
    links: [{ from: 'k', to: 'o' }, { from: 'o', to: 'p1' }, { from: 'c', to: 'cc' }, { from: 'b', to: 'ff' }, { from: 'ff', fromPin: 'A', to: 'pa' }, { from: 'ff', fromPin: 'B', to: 'pb' }],
  };
  const bp = new BlueprintInstance(g, 'x', api);
  bp.fire('event_key'); bp.fire('event_key');
  assert.equal(api.log.filter((l) => l[1] === 'once').length, 1);
  bp.fire('event_begin'); bp.fire('event_begin'); bp.fire('event_begin');
  assert.deepEqual(api.log.filter((l) => l[1] === 'A' || l[1] === 'B').map((l) => l[1]), ['A', 'B', 'A']);
  assert.equal(interpolate('HP {health} / {missing}', { health: 42.456 }), 'HP 42.46 / 0');
  assert.deepEqual(validateGraph({ nodes: [{ id: 'a', type: 'nope' }], links: [{ from: 'a', to: 'zz' }] }).length, 2);
});

test('terrain: bilinear heights, brushes and serialisation round-trip', () => {
  const t = new Terrain({ size: 40, resolution: 16 });
  assert.equal(t.heightAt(0, 0), 0);
  assert.equal(t.heightAt(100, 0), null, 'outside the landscape');
  t.applyBrush(0, 0, { mode: 'raise', radius: 6, strength: 1 }, 1);
  const h = t.heightAt(0, 0);
  assert.ok(h > 0);
  assert.ok(t.heightAt(5, 0) < h && t.heightAt(5, 0) >= 0, 'falloff');
  t.applyBrush(0, 0, { mode: 'smooth', radius: 8, strength: 1 }, 1);
  assert.ok(t.heightAt(0, 0) < h);
  t.applyBrush(0, 0, { mode: 'paint1', radius: 4, strength: 5 }, 1);
  const s = t.serialize();
  const t2 = new Terrain({ size: 40, resolution: 16, ...s });
  assert.equal(t2.heightAt(1.3, -2.2).toFixed(5), t.heightAt(1.3, -2.2).toFixed(5));
  assert.ok(t2.paint[(8 * 17 + 8) * 3 + 1] > 0.9, 'dirt painted at the centre');
  t.generate({ seed: 3, amplitude: 10 });
  t.bakeLighting(new THREE.Vector3(1, 0.3, 0));
  assert.ok(t.baked.every((v) => v > 0 && v < 2));
});

async function physicsWorld(actors) {
  const world = new World({ quality: resolveQuality('potato'), assets: new AssetLibrary({}), mode: 'game' });
  await world.load({ settings: {}, actors });
  const ph = new Physics(world);
  ph.rebuild();
  return { world, ph };
}

test('physics: character falls, lands on a box, is blocked by a wall and climbs a step', async () => {
  const { ph } = await physicsWorld([
    createActorData('mesh', { name: 'Floor', transform: { p: [0, -0.5, 0], s: [40, 1, 40] } }),
    createActorData('mesh', { name: 'Wall', transform: { p: [0, 1.5, -5], s: [10, 3, 1] } }),
    createActorData('mesh', { name: 'Step', transform: { p: [5, 0.15, 0], s: [2, 0.3, 2] } }),
  ]);
  const ch = { pos: new THREE.Vector3(0, 3, 0), vel: new THREE.Vector3(), radius: 0.3, height: 1.8, grounded: false };
  for (let i = 0; i < 120; i++) ph.moveCharacter(ch, 1 / 60);
  assert.ok(ch.grounded && Math.abs(ch.pos.y) < 0.03, `landed at ${ch.pos.y}`);
  ch.vel.set(0, 0, -5);
  for (let i = 0; i < 120; i++) { ch.vel.z = -5; ph.moveCharacter(ch, 1 / 60); }
  assert.ok(ch.pos.z > -4.5 - 0.31 && ch.pos.z < -4, `stopped at wall z=${ch.pos.z}`);
  ch.pos.set(2, 0, 0);
  let top = 0;
  for (let i = 0; i < 45; i++) { ch.vel.set(4, ch.vel.y, 0); ph.moveCharacter(ch, 1 / 60); top = Math.max(top, ch.pos.y); }
  assert.ok(Math.abs(top - 0.3) < 0.02, `stepped up to ${top}`);
  // standing half over the ledge edge still counts as grounded on the step
  ch.pos.set(6.1, 0.3, 0); ch.vel.set(0, 0, 0);
  for (let i = 0; i < 30; i++) ph.moveCharacter(ch, 1 / 60);
  assert.ok(Math.abs(ch.pos.y - 0.3) < 0.02, `ledge ${ch.pos.y}`);
});

test('physics: walking up a ramp uses mesh collision', async () => {
  const { ph } = await physicsWorld([
    createActorData('mesh', { name: 'Floor', transform: { p: [0, -0.5, 0], s: [40, 1, 40] } }),
    createActorData('mesh', { name: 'Ramp', transform: { p: [0, 1, -4], s: [4, 2, 4], r: [0, 90, 0] }, props: { shape: 'ramp' } }),
  ]);
  const ch = { pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(), radius: 0.3, height: 1.8, grounded: true, wasGrounded: true };
  let maxY = 0;
  for (let i = 0; i < 200; i++) { ch.vel.set(0, ch.vel.y, -3); ph.moveCharacter(ch, 1 / 60); maxY = Math.max(maxY, ch.pos.y); }
  assert.ok(maxY > 1.2, `climbed to ${maxY}`);
});

test('physics: dynamic crate falls and settles on the floor', async () => {
  const { ph, world } = await physicsWorld([
    createActorData('mesh', { name: 'Floor', transform: { p: [0, -0.5, 0], s: [40, 1, 40] } }),
    createActorData('mesh', { name: 'Crate', transform: { p: [0, 4, 0] }, props: { shape: 'crate', physics: 'dynamic' } }),
  ]);
  for (let i = 0; i < 240; i++) ph.stepBodies(1 / 60);
  const y = world.byName('Crate').obj.position.y;
  assert.ok(Math.abs(y - 0.5) < 0.05, `crate rests at ${y}`);
});

test('projects: templates build, migrate and survive JSON round-trip', async () => {
  for (const p of [createDefaultProject(createActorData), createEmptyProject(createActorData)]) {
    const q = migrateProject(JSON.parse(JSON.stringify(p)));
    assert.ok(q.actors.length >= 3);
    assert.ok(q.actors.some((a) => a.type === 'player_start'));
    const world = new World({ quality: resolveQuality('ps3'), assets: new AssetLibrary({}), mode: 'game' });
    await world.load({ settings: q.settings, actors: q.actors.filter((a) => a.type !== 'npc' && a.type !== 'text' && a.type !== 'particles') });
    assert.ok(world.actors.size > 0);
  }
  assert.throws(() => migrateProject({ foo: 1 }));
});

test('world: rebuilding / removing a sun does not leak lights into the scene', async () => {
  const world = new World({ quality: resolveQuality('high'), assets: new AssetLibrary({}), mode: 'game' });
  const sun = createActorData('light_dir');
  await world.load({ settings: {}, actors: [sun] });
  const count = () => { let n = 0; world.scene.traverse((o) => { if (o.isDirectionalLight) n++; }); return n; };
  assert.equal(count(), 1);
  for (let i = 0; i < 3; i++) await world.rebuildActor(sun.id);
  assert.equal(count(), 1);
  world.removeActor(sun.id);
  assert.equal(count(), 0);
});
