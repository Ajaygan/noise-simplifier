import { Engine } from '../core/engine.js';
import { AssetLibrary } from '../core/assets.js';
import { GameSession } from '../core/game.js';
import { QUALITY_ORDER, QUALITY_PRESETS, suggestQuality } from '../core/quality.js';
import { migrateProject } from '../core/project.js';

// Entry point of packaged games: title screen -> game.

function el(tag, style, text) { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text) e.textContent = text; return e; }

async function boot() {
  const root = document.getElementById('game') || document.body;
  const src = document.getElementById('spud-project');
  let project;
  try { project = migrateProject(JSON.parse(src.textContent)); } catch (e) { root.textContent = `Corrupt game data: ${e.message}`; return; }
  const meta = project.packaged || {};
  const saved = localStorage.getItem(`spud-quality:${meta.title}`);
  let quality = saved || (meta.quality && meta.quality !== 'auto' ? meta.quality : suggestQuality());

  const canvas = el('canvas'); canvas.tabIndex = 0;
  root.appendChild(canvas);
  root.style.position = root.style.position || 'fixed';
  const engine = new Engine(canvas, { quality });
  engine.frameCap = project.settings.frameCap || 0;
  engine.dynamicResolution = project.settings.dynamicResolution !== false;
  engine.post.settings = { ...engine.post.settings, ...project.settings.post };
  const assets = new AssetLibrary(project.assets);

  const fps = el('div', 'position:absolute;right:8px;top:6px;font:12px monospace;color:#0f0;text-shadow:0 1px 2px #000;z-index:4;pointer-events:none');
  if (meta.showFps) root.appendChild(fps);

  const title = el('div', 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:radial-gradient(#1c2a3a,#05080c);color:#fff;font-family:system-ui,sans-serif;z-index:10');
  title.appendChild(el('div', 'font-size:44px;font-weight:800;letter-spacing:1px;text-shadow:0 4px 18px #000;text-align:center;padding:0 20px', meta.title || project.name));
  const play = el('button', 'font:700 20px system-ui;padding:14px 48px;border-radius:8px;border:0;background:#f0a020;color:#111;cursor:pointer', 'PLAY');
  const qsel = el('select', 'font:14px system-ui;padding:6px 10px;border-radius:6px;background:#1d2733;color:#fff;border:1px solid #fff3');
  for (const k of QUALITY_ORDER) { const o = el('option', null, `Graphics: ${QUALITY_PRESETS[k].label}`); o.value = k; if (k === quality) o.selected = true; qsel.appendChild(o); }
  qsel.onchange = () => { quality = qsel.value; localStorage.setItem(`spud-quality:${meta.title}`, quality); engine.setQuality(quality); };
  title.append(play, qsel, el('div', 'opacity:.55;font-size:13px', 'WASD move · Shift run · Space jump · E interact · Esc pause'), el('div', 'position:absolute;bottom:10px;opacity:.35;font-size:11px', 'Made with Spud Engine'));
  root.appendChild(title);

  let session = null;
  const start = async () => {
    play.disabled = true; play.textContent = 'Loading…';
    session = new GameSession({ engine, project, assets, container: root });
    const onRestart = (s) => { session = s; s.onRestart = onRestart; };
    session.onRestart = onRestart;
    await session.start();
    title.remove();
    canvas.focus();
    engine.onFrame = (dt) => {
      session?.update(dt);
      if (meta.showFps) fps.textContent = `${engine.stats.fps} fps · ${engine.stats.w}×${engine.stats.h}`;
    };
    engine.start();
  };
  play.onclick = start;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
