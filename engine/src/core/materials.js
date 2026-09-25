import * as THREE from 'three';

export const DEFAULT_MATERIAL = {
  color: '#b8b8b8', map: null, uvScale: 1, emissive: '#000000', emissiveIntensity: 1,
  roughness: 0.7, metalness: 0, shading: 'auto', flat: false, opacity: 1,
  texFilter: 'linear', vertexColors: false, doubleSide: false,
};

export const SHADING_MODES = ['auto', 'lambert', 'phong', 'standard', 'toon', 'unlit'];

let toonGradient = null;
function getToonGradient() {
  if (toonGradient) return toonGradient;
  const data = new Uint8Array([90, 90, 90, 255, 180, 180, 180, 255, 255, 255, 255, 255]);
  toonGradient = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  toonGradient.minFilter = toonGradient.magFilter = THREE.NearestFilter;
  toonGradient.needsUpdate = true;
  return toonGradient;
}

export function shadingFor(props, quality) {
  const s = props.shading && props.shading !== 'auto' ? props.shading : quality.shading;
  // Never let a single material push a potato device into PBR.
  if (s === 'standard' && quality.name === 'potato') return 'lambert';
  return s;
}

// Build a material from our serialisable material description.
export function makeMaterial(props, quality, assets) {
  const p = { ...DEFAULT_MATERIAL, ...(props || {}) };
  const shading = shadingFor(p, quality);
  const common = {
    color: new THREE.Color(p.color),
    transparent: p.opacity < 1, opacity: p.opacity,
    side: p.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    vertexColors: !!p.vertexColors,
  };
  let map = null;
  if (p.map && assets) {
    map = assets.getTexture(p.map, quality.textureMax, p.texFilter);
    if (map && p.uvScale !== 1) {
      map = map.clone();
      map.repeat.set(p.uvScale, p.uvScale);
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.needsUpdate = true;
    }
  }
  if (map) common.map = map;
  let m;
  const emissive = new THREE.Color(p.emissive);
  switch (shading) {
    case 'unlit': m = new THREE.MeshBasicMaterial(common); break;
    case 'lambert': m = new THREE.MeshLambertMaterial({ ...common, emissive, emissiveIntensity: p.emissiveIntensity, flatShading: p.flat }); break;
    case 'toon': m = new THREE.MeshToonMaterial({ ...common, emissive, emissiveIntensity: p.emissiveIntensity, gradientMap: getToonGradient() }); break;
    case 'standard': m = new THREE.MeshStandardMaterial({ ...common, emissive, emissiveIntensity: p.emissiveIntensity, roughness: p.roughness, metalness: p.metalness, flatShading: p.flat }); break;
    case 'phong':
    default: {
      const shin = Math.max(2, (1 - p.roughness) * 90);
      const spec = new THREE.Color().setScalar(0.04 + (1 - p.roughness) * 0.35 + p.metalness * 0.3);
      m = new THREE.MeshPhongMaterial({ ...common, emissive, emissiveIntensity: p.emissiveIntensity, shininess: shin, specular: spec, flatShading: p.flat });
    }
  }
  m.userData.spud = true;
  return m;
}

// Imported models come with whatever materials the DCC tool exported (often PBR
// with 4K textures). Convert them to the quality level's cheap equivalent and
// clamp their textures.
export function convertImportedMaterial(src, quality, assets) {
  if (!src || src.userData?.spud) return src;
  const shading = quality.shading;
  const color = src.color ? src.color.clone() : new THREE.Color(1, 1, 1);
  let map = src.map || null;
  if (map && map.image && assets) map = assets.downscaleTexture(map, quality.textureMax);
  const common = {
    color, map, transparent: src.transparent, opacity: src.opacity ?? 1,
    side: src.side, vertexColors: src.vertexColors, alphaTest: src.alphaTest || 0,
  };
  let m;
  if (src.isMeshBasicMaterial) m = new THREE.MeshBasicMaterial(common);
  else if (shading === 'lambert') m = new THREE.MeshLambertMaterial({ ...common, emissive: src.emissive || new THREE.Color(0) });
  else if (shading === 'standard') m = new THREE.MeshStandardMaterial({ ...common, emissive: src.emissive || new THREE.Color(0), roughness: src.roughness ?? 0.7, metalness: src.metalness ?? 0 });
  else m = new THREE.MeshPhongMaterial({ ...common, emissive: src.emissive || new THREE.Color(0), shininess: 30, specular: new THREE.Color(0.12, 0.12, 0.12) });
  if (src.emissiveMap) m.emissiveMap = src.emissiveMap;
  m.name = src.name;
  m.userData.spud = true;
  m.userData.source = src;
  return m;
}
