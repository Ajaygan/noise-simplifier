// Small helpers shared by the editor and the packaged player.

let _uidCounter = 0;
export function uid(prefix = 'a') {
  _uidCounter = (_uidCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}${_uidCounter.toString(36)}`;
}

export const DEG = Math.PI / 180;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const deepClone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

export function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  if (typeof Buffer !== 'undefined' && typeof window === 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

export function base64ToArrayBuffer(b64) {
  if (typeof Buffer !== 'undefined' && typeof window === 'undefined') {
    const b = Buffer.from(b64, 'base64');
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

export function dataUrlToArrayBuffer(url) {
  const i = url.indexOf(',');
  return base64ToArrayBuffer(url.slice(i + 1));
}

export function arrayBufferToDataUrl(buf, mime = 'application/octet-stream') {
  return `data:${mime};base64,${arrayBufferToBase64(buf)}`;
}

export function float32ToBase64(f32) {
  return arrayBufferToBase64(f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength));
}
export function base64ToFloat32(b64) {
  return new Float32Array(base64ToArrayBuffer(b64));
}

// Deterministic RNG (mulberry32) so foliage / particles look the same every load.
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexToNum(h) {
  if (typeof h === 'number') return h;
  return parseInt(String(h).replace('#', ''), 16) || 0;
}
