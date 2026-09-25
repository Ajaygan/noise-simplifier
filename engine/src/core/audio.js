// Tiny audio layer on WebAudio. Built-in sounds are synthesised (zero bytes of
// assets), imported sounds are decoded from the project's data URLs.

export const BUILTIN_SOUNDS = {
  __coin: 'Coin (built-in)', __jump: 'Jump (built-in)', __hit: 'Hit (built-in)',
  __win: 'Win jingle (built-in)', __lose: 'Lose (built-in)', __click: 'Click (built-in)', __boom: 'Explosion (built-in)',
};

export class AudioManager {
  constructor(assets) {
    this.assets = assets;
    this.ctx = null;
    this.master = null;
    this.loops = [];
  }

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return this.ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  synth(name, volume = 0.8) {
    const ctx = this.ensure(); if (!ctx) return;
    const t = ctx.currentTime;
    const g = ctx.createGain(); g.connect(this.master);
    const tone = (freq, start, dur, type = 'square', vol = 0.25, slide = 0) => {
      const o = ctx.createOscillator(); const og = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t + start);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + start + dur);
      og.gain.setValueAtTime(vol * volume, t + start); og.gain.exponentialRampToValueAtTime(0.001, t + start + dur);
      o.connect(og); og.connect(g); o.start(t + start); o.stop(t + start + dur + 0.02);
    };
    switch (name) {
      case '__coin': tone(988, 0, 0.08); tone(1319, 0.07, 0.25); break;
      case '__jump': tone(300, 0, 0.18, 'square', 0.2, 500); break;
      case '__hit': tone(160, 0, 0.2, 'sawtooth', 0.3, -120); break;
      case '__win': [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.3, 'triangle', 0.3)); break;
      case '__lose': [392, 330, 262].forEach((f, i) => tone(f, i * 0.18, 0.35, 'triangle', 0.3)); break;
      case '__click': tone(1200, 0, 0.03, 'square', 0.15); break;
      case '__boom': {
        const len = ctx.sampleRate * 0.6, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
        const s = ctx.createBufferSource(); s.buffer = buf; const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600;
        const gg = ctx.createGain(); gg.gain.value = volume; s.connect(f); f.connect(gg); gg.connect(g); s.start(); break;
      }
      default: tone(440, 0, 0.1);
    }
  }

  async play(id, volume = 0.8, { loop = false, panner = null } = {}) {
    if (!id) return null;
    if (id.startsWith('__')) { this.synth(id, volume); return null; }
    const ctx = this.ensure(); if (!ctx) return null;
    const buf = await this.assets.getAudioBuffer(ctx, id).catch(() => null);
    if (!buf) return null;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = loop;
    const g = ctx.createGain(); g.gain.value = volume;
    src.connect(g);
    if (panner) { g.connect(panner); panner.connect(this.master); } else g.connect(this.master);
    src.start();
    if (loop) this.loops.push({ src, g, panner });
    return { src, g };
  }

  createPanner(radius) {
    const ctx = this.ensure(); if (!ctx) return null;
    const p = ctx.createPanner();
    p.panningModel = 'equalpower'; p.distanceModel = 'linear'; p.refDistance = 1; p.maxDistance = radius; p.rolloffFactor = 1;
    return p;
  }

  setListener(pos, forward) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
      l.forwardX.value = forward.x; l.forwardY.value = forward.y; l.forwardZ.value = forward.z;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else if (l.setPosition) { l.setPosition(pos.x, pos.y, pos.z); l.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0); }
  }

  stopAll() {
    for (const l of this.loops) { try { l.src.stop(); } catch { /* already stopped */ } }
    this.loops = [];
  }

  dispose() { this.stopAll(); if (this.ctx) this.ctx.close(); this.ctx = null; }
}
