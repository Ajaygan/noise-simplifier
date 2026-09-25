import * as THREE from 'three';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// "Nanite for potatoes": automatic discrete LODs. Heavy static meshes get two
// simplified versions generated on load (cached per geometry), swapped by
// distance. The distances scale with the quality preset's lodBias.

const cache = new WeakMap(); // geometry -> [lod1, lod2]
const modifier = new SimplifyModifier();

function triCount(g) { return (g.index ? g.index.count : g.attributes.position.count) / 3; }

function simplify(geo, ratio) {
  try {
    let g = geo.clone();
    // SimplifyModifier needs position+normal(+uv) and merged vertices
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
    g = mergeVertices(g, 1e-4);
    const remove = Math.floor(g.attributes.position.count * (1 - ratio));
    const s = modifier.modify(g, remove);
    s.computeVertexNormals();
    return s;
  } catch (e) {
    return null;
  }
}

export function applyAutoLOD(root, { lodBias = 1, minTris = 1500, maxVerts = 40000 } = {}) {
  const targets = [];
  root.traverse((o) => {
    if (o.isMesh && !o.isSkinnedMesh && !o.isInstancedMesh && o.geometry && triCount(o.geometry) >= minTris && o.geometry.attributes.position.count <= maxVerts) targets.push(o);
  });
  let converted = 0;
  for (const mesh of targets) {
    let lods = cache.get(mesh.geometry);
    if (!lods) {
      lods = [simplify(mesh.geometry, 0.4), simplify(mesh.geometry, 0.12)];
      cache.set(mesh.geometry, lods);
    }
    if (!lods[0]) continue;
    const lod = new THREE.LOD();
    lod.name = `${mesh.name || 'mesh'}_LOD`;
    lod.position.copy(mesh.position); lod.quaternion.copy(mesh.quaternion); lod.scale.copy(mesh.scale);
    const radius = (mesh.geometry.boundingSphere || (mesh.geometry.computeBoundingSphere(), mesh.geometry.boundingSphere)).radius * mesh.scale.x;
    const base = Math.max(8, radius * 6) / lodBias; // bigger bias = earlier switch
    const mk = (g) => { const m = new THREE.Mesh(g, mesh.material); m.castShadow = mesh.castShadow; m.receiveShadow = mesh.receiveShadow; return m; };
    const m0 = mk(mesh.geometry);
    lod.addLevel(m0, 0);
    lod.addLevel(mk(lods[0]), base);
    if (lods[1]) lod.addLevel(mk(lods[1]), base * 2.5);
    mesh.parent.add(lod);
    mesh.parent.remove(mesh);
    converted++;
  }
  return converted;
}
