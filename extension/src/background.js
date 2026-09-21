/**
 * Background service worker.
 *
 * Owns the lifecycle of a cleaning session:
 *   1. the popup (or the keyboard shortcut) asks to start on a tab,
 *   2. `chrome.tabCapture.getMediaStreamId` mints a stream id for that tab,
 *   3. an offscreen document grabs the tab audio, keeps it alive and plays the
 *      cleaned audio back to the user,
 *   4. status + meters are mirrored into `chrome.storage.session` so the popup
 *      can show them without any long-lived connection.
 *
 * Only these two APIs are used, so nothing runs inside the meeting page itself
 * (no content script, no page access).
 */

import { DEFAULT_SETTINGS, normalizeSettings } from './settings.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const SESSION_KEY = 'noiseSimplifierSession';
const SETTINGS_KEY = 'noiseSimplifierSettings';

const idleSession = () => ({
  active: false,
  status: 'idle',
  tabId: null,
  tabTitle: '',
  startedAt: null,
  error: null,
  metrics: null,
});

async function readSession() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return { ...idleSession(), ...(stored[SESSION_KEY] || {}) };
}

async function writeSession(patch) {
  const session = { ...(await readSession()), ...patch };
  await chrome.storage.session.set({ [SESSION_KEY]: session });
  updateBadge(session);
  // Let any open popup refresh immediately.
  chrome.runtime.sendMessage({ target: 'popup', type: 'session', session }).catch(() => {});
  return session;
}

function updateBadge(session) {
  const text = !session.active ? '' : session.status === 'running' ? 'ON' : '!';
  const color = session.status === 'running' ? '#1f9d55' : '#c53030';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

async function readSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY] || DEFAULT_SETTINGS);
}

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  }).catch(() => []);
  if (existing && existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Capture the meeting tab audio, remove its background noise and play the cleaned audio back.',
  });
}

async function closeOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  }).catch(() => []);
  if (contexts && contexts.length > 0) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

async function startSession({ tabId, tabTitle, settings }) {
  const targetTabId = tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!targetTabId) throw new Error('No active tab to capture.');
  const resolved = normalizeSettings(settings || (await readSettings()));

  await writeSession({ active: false, status: 'starting', tabId: targetTabId, tabTitle: tabTitle || '', error: null });

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId });
  } catch (err) {
    await writeSession({ active: false, status: 'error', error: `Tab capture refused: ${err.message}` });
    throw err;
  }

  await ensureOffscreenDocument();
  await writeSession({ active: true, status: 'starting', startedAt: Date.now() });

  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    streamId,
    tabId: targetTabId,
    settings: resolved,
  }).catch((err) => ({ ok: false, error: String(err && err.message || err) }));

  if (!response || response.ok === false) {
    const error = (response && response.error) || 'capture failed';
    await writeSession({ active: false, status: 'error', error });
    await closeOffscreenDocument();
    throw new Error(error);
  }
  await writeSession({ status: 'running', error: null });
  return { ok: true };
}

async function stopSession(reason = 'user') {
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop', reason }).catch(() => {});
  await closeOffscreenDocument().catch(() => {});
  await writeSession({ ...idleSession(), status: 'idle' });
  return { ok: true };
}

async function toggleSession(tabId, tabTitle) {
  const session = await readSession();
  if (session.active) return stopSession('user');
  return startSession({ tabId, tabTitle });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;
  const { type } = message;

  if (message.target === 'background') {
    switch (type) {
      case 'start':
        startSession(message)
          .then((r) => sendResponse(r))
          .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
        return true;
      case 'stop':
        stopSession(message.reason || 'user').then((r) => sendResponse(r));
        return true;
      case 'toggle':
        toggleSession(message.tabId, message.tabTitle)
          .then((r) => sendResponse(r))
          .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
        return true;
      case 'getSession':
        readSession().then((session) => sendResponse({ ok: true, session }));
        return true;
      case 'status':
        writeSession({ status: message.status, error: message.error ?? null, metrics: message.metrics ?? null })
          .then(() => sendResponse({ ok: true }));
        return true;
      case 'metrics':
        writeSession({ metrics: message.metrics }).then(() => sendResponse({ ok: true }));
        return true;
      case 'captureEnded':
        writeSession({ ...idleSession(), status: 'idle' })
          .then(() => closeOffscreenDocument())
          .then(() => sendResponse({ ok: true }));
        return true;
      default:
        sendResponse({ ok: false, error: `unknown background message: ${type}` });
        return true;
    }
  }

  if (message.target === 'popup' && type === 'settings') {
    chrome.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(message.settings) });
  }
  return undefined;
});

// Keyboard shortcut: Alt+Shift+N toggles cleaning on the active tab.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-noise-simplifier') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await toggleSession(tab.id, tab.title);
  } catch (err) {
    await writeSession({ status: 'error', error: String(err.message || err) });
  }
});

// If the captured tab goes away, tear the session down.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await readSession();
  if (session.active && session.tabId === tabId) await stopSession('tab-closed');
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  const session = await readSession();
  if (!session.active || session.tabId !== tabId) return;
  // A navigation may or may not keep the stream alive; the offscreen document
  // reports 'captureEnded' when the track really ends, so only log the event.
  if (changeInfo.status === 'loading') {
    await writeSession({ lastNavigation: Date.now() });
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  const settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'settings', settings }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await readSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  await updateBadge(await readSession());
});

chrome.runtime.onStartup.addListener(async () => {
  await writeSession(idleSession());
});
