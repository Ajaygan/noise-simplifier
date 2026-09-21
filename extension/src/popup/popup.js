/**
 * Popup UI.
 *
 * Talks to the background worker for session control, writes settings to
 * `chrome.storage.local` (the offscreen document picks them up live), and
 * renders the meters that the offscreen document mirrors into
 * `chrome.storage.session`.
 */

import {
  DEFAULT_SETTINGS, MODE_INFO, PRESETS, normalizeSettings, strengthToAttenuation,
} from '../settings.js';

const SESSION_KEY = 'noiseSimplifierSession';
const SETTINGS_KEY = 'noiseSimplifierSettings';

const el = (id) => document.getElementById(id);
const ui = {
  primary: el('primary'),
  statusPill: el('statusPill'),
  statusDetail: el('statusDetail'),
  tabTitle: el('tabTitle'),
  mode: el('mode'),
  modeHint: el('modeHint'),
  strength: el('strength'),
  strengthValue: el('strengthValue'),
  voiceFocus: el('voiceFocus'),
  autoGain: el('autoGain'),
  compare: el('compare'),
  meterIn: el('meterIn'),
  meterOut: el('meterOut'),
  meterInValue: el('meterInValue'),
  meterOutValue: el('meterOutValue'),
  suppression: el('suppression'),
};

let settings = { ...DEFAULT_SETTINGS };
let session = { active: false, status: 'idle', tabId: null };
let activeTab = null;
let compareHeld = false;

/* ---------------------------------------------------------------- helpers */

async function readSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settings = normalizeSettings(stored[SETTINGS_KEY] || DEFAULT_SETTINGS);
  return settings;
}

async function writeSettings(patch) {
  settings = normalizeSettings({ ...settings, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  render();
}

async function readSession() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  session = { active: false, status: 'idle', ...(stored[SESSION_KEY] || {}) };
  return session;
}

const send = (message) => chrome.runtime.sendMessage(message);

/* ------------------------------------------------------------- rendering */

function render() {
  const { mode, strength } = settings;
  ui.mode.value = mode;
  ui.modeHint.textContent = MODE_INFO[mode]?.hint || '';
  ui.strength.value = String(Math.round(strength * 100));
  ui.strengthValue.textContent = `${Math.round(strength * 100)}%`;
  ui.voiceFocus.checked = settings.voiceFocus;
  ui.autoGain.checked = settings.autoGain;

  const running = session.active && session.status !== 'error';
  ui.primary.textContent = running ? 'Stop cleaning' : 'Clean this tab';
  ui.primary.classList.toggle('stop', running);
  ui.primary.disabled = session.status === 'starting';
  ui.compare.disabled = !running;

  const status = session.status || 'idle';
  ui.statusPill.textContent = status;
  ui.statusPill.className = `pill ${status === 'running' ? 'running' : status === 'error' ? 'error' : status === 'starting' ? 'starting' : ''}`;

  if (session.status === 'error' && session.error) {
    ui.statusDetail.textContent = session.error;
    ui.statusDetail.classList.add('error');
  } else if (running) {
    ui.statusDetail.textContent = session.detail || 'Cleaning this tab. Keep it open while you meet.';
    ui.statusDetail.classList.remove('error');
  } else {
    ui.statusDetail.textContent = 'Removes fans, keyboards, traffic and room tone while you keep talking.';
    ui.statusDetail.classList.remove('error');
  }

  if (!running) {
    ui.meterIn.style.width = '0%';
    ui.meterOut.style.width = '0%';
    ui.meterInValue.textContent = '—';
    ui.meterOutValue.textContent = '—';
    ui.suppression.textContent = '—';
  }
}

function renderMeters(metrics) {
  if (!metrics) return;
  const scale = (db) => Math.max(0, Math.min(100, ((db + 72) / 72) * 100));
  const inDb = metrics.inputLevel ?? -90;
  const outDb = metrics.outputLevel ?? -90;
  ui.meterIn.style.width = `${scale(inDb)}%`;
  ui.meterOut.style.width = `${scale(outDb)}%`;
  ui.meterInValue.textContent = `${inDb.toFixed(0)} dB`;
  ui.meterOutValue.textContent = `${outDb.toFixed(0)} dB`;
  const drop = inDb - outDb;
  ui.suppression.textContent = Number.isFinite(drop) && inDb > -80 ? `${drop.toFixed(1)} dB` : '—';
}

/* ---------------------------------------------------------------- actions */

async function refresh() {
  await readSession();
  if (session.tabTitle) ui.tabTitle.textContent = session.tabTitle;
  render();
}

async function toggleSession() {
  ui.primary.disabled = true;
  try {
    const response = await send({
      target: 'background',
      type: 'toggle',
      tabId: activeTab?.id,
      tabTitle: activeTab?.title,
    });
    if (response && response.ok === false) {
      ui.statusDetail.textContent = response.error || 'Could not start capture';
      ui.statusDetail.classList.add('error');
    }
  } catch (err) {
    ui.statusDetail.textContent = String(err.message || err);
    ui.statusDetail.classList.add('error');
  }
  await refresh();
  ui.primary.disabled = false;
}

/** While held, the engine passes the original audio through (live A/B). */
async function setBypass(bypass) {
  compareHeld = bypass;
  await writeSettings({ bypass });
}

/* ----------------------------------------------------------------- events */

ui.primary.addEventListener('click', toggleSession);

ui.mode.addEventListener('change', () => writeSettings({ mode: ui.mode.value }));
ui.strength.addEventListener('input', () => {
  ui.strengthValue.textContent = `${ui.strength.value}%`;
});
ui.strength.addEventListener('change', () => {
  const strength = Number(ui.strength.value) / 100;
  writeSettings({ strength, maxAttenuationDb: strengthToAttenuation(strength) });
});
ui.voiceFocus.addEventListener('change', () => writeSettings({ voiceFocus: ui.voiceFocus.checked }));
ui.autoGain.addEventListener('change', () => writeSettings({ autoGain: ui.autoGain.checked }));

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    const preset = PRESETS[chip.dataset.preset];
    if (preset) writeSettings(preset);
  });
}

for (const event of ['pointerdown', 'pointerup', 'pointerleave', 'pointercancel', 'blur']) {
  ui.compare.addEventListener(event, (e) => {
    const held = e.type === 'pointerdown';
    if (held === compareHeld && event !== 'blur') return;
    setBypass(held);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[SESSION_KEY]) {
    session = changes[SESSION_KEY].newValue || session;
    render();
    renderMeters(session.metrics);
  }
  if (area === 'local' && changes[SETTINGS_KEY] && !compareHeld) {
    settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
    render();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target === 'popup' && message.type === 'session') {
    session = message.session || session;
    render();
    renderMeters(session.metrics);
  }
});

/* ------------------------------------------------------------------- boot */

(async function boot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  if (tab) {
    document.getElementById('tabTitle').textContent = (tab.title || 'Current tab').slice(0, 60);
  }
  await readSettings();
  await refresh();
  renderMeters(session.metrics);
  // Poll while the popup is open so meters stay live even if a storage event
  // is missed during a service-worker restart.
  setInterval(async () => {
    if (!session.active) return;
    const before = session.metrics?.inputLevel;
    await readSession();
    if (session.metrics && session.metrics.inputLevel !== before) renderMeters(session.metrics);
  }, 400);
})();
