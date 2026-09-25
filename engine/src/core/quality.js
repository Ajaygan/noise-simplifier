// Scalability presets — the engine's equivalent of UE's "Engine Scalability
// Settings". Everything that costs GPU time on a weak device is controlled here.
//
//  shading   'lambert'  per-vertex lighting (cheapest, PS2/early PS3 look)
//            'phong'    per-pixel Blinn-Phong with specular (classic PS3 look)
//            'standard' PBR (only for the High preset)
export const QUALITY_PRESETS = {
  potato: {
    label: 'Potato',
    renderScale: 0.5, maxHeight: 480, antialias: false,
    shading: 'lambert', shadows: false, shadowMapSize: 256,
    textureMax: 128, bloom: false, post: false,
    drawDistance: 90, lodBias: 2.0, particleScale: 0.3, foliageScale: 0.35,
    maxPointLights: 2, pixelated: false, targetFps: 30,
  },
  low: {
    label: 'Low',
    renderScale: 0.75, maxHeight: 600, antialias: false,
    shading: 'lambert', shadows: true, shadowMapSize: 512,
    textureMax: 256, bloom: false, post: true,
    drawDistance: 160, lodBias: 1.5, particleScale: 0.6, foliageScale: 0.6,
    maxPointLights: 4, pixelated: false, targetFps: 30,
  },
  ps3: {
    label: 'PS3',
    renderScale: 1.0, maxHeight: 720, antialias: false,
    shading: 'phong', shadows: true, shadowMapSize: 1024,
    textureMax: 512, bloom: true, post: true,
    drawDistance: 280, lodBias: 1.0, particleScale: 1.0, foliageScale: 1.0,
    maxPointLights: 8, pixelated: false, targetFps: 30,
  },
  high: {
    label: 'High',
    renderScale: 1.0, maxHeight: 1440, antialias: true,
    shading: 'standard', shadows: true, shadowMapSize: 2048,
    textureMax: 1024, bloom: true, post: true,
    drawDistance: 500, lodBias: 0.7, particleScale: 1.0, foliageScale: 1.0,
    maxPointLights: 16, pixelated: false, targetFps: 60,
  },
};

export const QUALITY_ORDER = ['potato', 'low', 'ps3', 'high'];

export function resolveQuality(name, overrides = {}) {
  const base = QUALITY_PRESETS[name] || QUALITY_PRESETS.ps3;
  return { name: QUALITY_PRESETS[name] ? name : 'ps3', ...base, ...overrides };
}

// Very rough device sniffing used to pick a default preset on first launch.
export function suggestQuality() {
  if (typeof navigator === 'undefined') return 'ps3';
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const mobile = /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);
  if (mem <= 2 || cores <= 2) return 'potato';
  if (mobile || mem <= 4 || cores <= 4) return 'low';
  return 'ps3';
}
