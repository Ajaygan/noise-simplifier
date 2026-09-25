/* global __PLAYER_BUNDLE__ */
import { h, modal, field, select, textInput, checkbox, download, toast } from './ui.js';
import { QUALITY_ORDER, QUALITY_PRESETS } from '../core/quality.js';

// "Package Project": produces ONE self-contained .html file (runtime + level +
// every asset as data URLs). Runs by double-clicking, from a USB stick, on
// itch.io, or on any static host. No install, no server.

const PLAYER = typeof __PLAYER_BUNDLE__ !== 'undefined' ? __PLAYER_BUNDLE__ : '';

export function buildGameHtml(project, { title, quality = 'auto', showFps = false } = {}) {
  if (!PLAYER) throw new Error('Player runtime not bundled — run `npm run build`.');
  const safeJson = JSON.stringify({ ...project, packaged: { title, quality, showFps, date: new Date().toISOString() } }).replace(/</g, '\\u003c');
  const js = PLAYER.replace(/<\/script/gi, '<\\/script');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="generator" content="Spud Engine">
<title>${esc(title)}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden;touch-action:none}#game{position:fixed;inset:0}canvas{display:block;width:100%;height:100%;outline:none}</style>
</head><body><div id="game"></div>
<script type="application/json" id="spud-project">${safeJson}</script>
<script>${js}</script>
</body></html>`;
}

export function openPackager(editor) {
  const opts = { title: editor.project.name || 'My Game', quality: 'auto', showFps: false };
  const est = () => {
    const bytes = JSON.stringify(editor.snapshotProject()).length + PLAYER.length;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };
  const sizeEl = h('b', {}, est());
  const body = h('div', {},
    h('p', { class: 'muted' }, 'Exports the whole game (engine runtime, level, models, textures, sounds) as a single HTML file. It runs on any device with a browser, even offline.'),
    field('Game Title', textInput(opts.title, (v) => { opts.title = v; })),
    field('Default Quality', select(opts.quality, [['auto', 'Auto-detect device'], ...QUALITY_ORDER.map((k) => [k, QUALITY_PRESETS[k].label])], (v) => { opts.quality = v; })),
    field('Show FPS', checkbox(opts.showFps, (v) => { opts.showFps = v; })),
    h('div', { class: 'pad' }, 'Estimated size: ', sizeEl),
    h('div', { class: 'muted' }, 'Tip: players can still switch quality from the title screen.'),
  );
  const build = () => buildGameHtml(editor.snapshotProject(), opts);
  modal({
    title: 'Package Game', body, width: 480,
    buttons: [
      ['Test in new tab', () => {
        try { const url = URL.createObjectURL(new Blob([build()], { type: 'text/html' })); window.open(url, '_blank'); } catch (e) { toast(e.message, 'error'); }
        return false;
      }],
      ['Build & Download', () => {
        try {
          const html = build();
          download(`${opts.title.replace(/[^\w-]+/g, '_') || 'game'}.html`, html, 'text/html');
          editor.log(`Packaged game: ${(html.length / 1024 / 1024).toFixed(2)} MB`);
          toast('Game packaged!', 'ok');
        } catch (e) { toast(e.message, 'error'); return false; }
        return true;
      }, 'primary'],
    ],
  });
}
