// Minimal DOM toolkit for the editor (no framework = tiny bundle, fast on old machines).

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function modal({ title, body, width = 520, buttons = [], onClose = null, className = '' }) {
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); onClose?.(); };
  const esc = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) close(); };
  const box = h('div', { class: `modal ${className}`, style: { width: typeof width === 'number' ? `${width}px` : width } },
    h('div', { class: 'modal-head' }, h('span', {}, title), h('button', { class: 'icon-btn', title: 'Close', onclick: close }, '✕')),
    h('div', { class: 'modal-body' }, body),
    buttons.length ? h('div', { class: 'modal-foot' }, buttons.map(([label, fn, cls]) => h('button', { class: `btn ${cls || ''}`, onclick: () => { if (fn() !== false) close(); } }, label))) : null,
  );
  const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(); } }, box);
  document.body.appendChild(back);
  document.addEventListener('keydown', esc);
  return { close, el: box };
}

export function toast(msg, kind = 'info', ms = 2600) {
  let wrap = document.getElementById('toasts');
  if (!wrap) { wrap = h('div', { id: 'toasts' }); document.body.appendChild(wrap); }
  const t = h('div', { class: `toast ${kind}` }, msg);
  wrap.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

export function menu(anchor, items) {
  document.querySelectorAll('.dropdown').forEach((d) => d.remove());
  const r = anchor.getBoundingClientRect();
  const dd = h('div', { class: 'dropdown', style: { left: `${r.left}px`, top: `${r.bottom + 2}px` } },
    items.map((it) => it === '-' ? h('div', { class: 'sep' }) : h('div', {
      class: `item ${it.disabled ? 'disabled' : ''}`,
      onclick: () => { if (it.disabled) return; dd.remove(); it.action(); },
    }, h('span', {}, it.label), it.shortcut ? h('span', { class: 'kbd' }, it.shortcut) : null)));
  document.body.appendChild(dd);
  const off = (e) => { if (!dd.contains(e.target) && e.target !== anchor) { dd.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off));
  return dd;
}

// ---------- property fields ----------
export function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', { title: hint || label }, label), h('div', { class: 'field-input' }, input));
}

export function numberInput(value, onChange, { step = 0.1, min, max, width } = {}) {
  const i = h('input', { type: 'number', step, value: +(+value).toFixed(4), min, max, style: width ? { width } : null });
  i.addEventListener('change', () => { const v = parseFloat(i.value); if (!Number.isNaN(v)) onChange(v); });
  // drag-to-scrub on the input like UE
  let sx = null, sv = 0;
  i.addEventListener('mousedown', (e) => { if (e.button === 1 || e.altKey) { sx = e.clientX; sv = parseFloat(i.value) || 0; e.preventDefault(); } });
  window.addEventListener('mousemove', (e) => { if (sx === null) return; const v = sv + (e.clientX - sx) * step; i.value = +v.toFixed(4); onChange(v); });
  window.addEventListener('mouseup', () => { sx = null; });
  return i;
}

export function vec3Input(arr, onChange, { step = 0.1 } = {}) {
  const v = [...arr];
  const colors = ['#e05555', '#5fbf5f', '#5588e0'];
  return h('div', { class: 'vec3' }, [0, 1, 2].map((k) => h('div', { class: 'vec3-c', style: { borderLeftColor: colors[k] } },
    numberInput(v[k], (x) => { v[k] = x; onChange([...v]); }, { step }))));
}

export function textInput(value, onChange, { placeholder, multiline = false } = {}) {
  const i = multiline ? h('textarea', { rows: 3, placeholder }) : h('input', { type: 'text', placeholder });
  i.value = value ?? '';
  i.addEventListener('change', () => onChange(i.value));
  return i;
}

export function colorInput(value, onChange) {
  const hex = String(value || '#ffffff').slice(0, 7);
  const i = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#ffffff' });
  i.addEventListener('input', () => onChange(i.value));
  return i;
}

export function checkbox(value, onChange) {
  const i = h('input', { type: 'checkbox' }); i.checked = !!value;
  i.addEventListener('change', () => onChange(i.checked));
  return i;
}

export function select(value, options, onChange) {
  const s = h('select', {}, options.map((o) => {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    const opt = h('option', { value: v }, l);
    if (String(v) === String(value)) opt.selected = true;
    return opt;
  }));
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

export function slider(value, onChange, { min = 0, max = 1, step = 0.01 } = {}) {
  const out = h('span', { class: 'slider-val' }, (+value).toFixed(2));
  const i = h('input', { type: 'range', min, max, step, value });
  i.addEventListener('input', () => { out.textContent = (+i.value).toFixed(2); onChange(parseFloat(i.value)); });
  return h('div', { class: 'slider' }, i, out);
}

export function section(title, children, { open = true } = {}) {
  const body = h('div', { class: 'section-body' }, children);
  const head = h('div', { class: `section-head ${open ? 'open' : ''}` }, title);
  head.addEventListener('click', () => { head.classList.toggle('open'); body.style.display = head.classList.contains('open') ? '' : 'none'; });
  if (!open) body.style.display = 'none';
  return h('div', { class: 'section' }, head, body);
}

export function download(filename, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const i = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    i.addEventListener('change', () => { resolve([...i.files]); i.remove(); });
    document.body.appendChild(i); i.click();
  });
}

export function readFile(file, as = 'dataurl') {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result); r.onerror = reject;
    if (as === 'text') r.readAsText(file); else if (as === 'buffer') r.readAsArrayBuffer(file); else r.readAsDataURL(file);
  });
}
