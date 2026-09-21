/**
 * Offscreen document: the actual audio pipeline.
 *
 *   tab audio ──▶ AudioContext ──▶ AudioWorkletNode("noise-simplifier") ──▶ speakers
 *
 * Chrome mutes the captured tab locally, so the cleaned audio we render here is
 * what the user hears. Everything stays inside this extension page: the meeting
 * page is never touched.
 */

import { normalizeSettings } from '../settings.js';

const WORKLET_URL = chrome.runtime.getURL('dist/denoise.worklet.js');

let context = null;
let stream = null;
let sourceNode = null;
let workletNode = null;
let silentGain = null;
let meterTimer = null;
let latestMetrics = null;
let sessionToken = 0;

function post(message) {
  return chrome.runtime.sendMessage(message).catch(() => {});
}

function reportStatus(status, extra = {}) {
  post({ target: 'background', type: 'status', status, ...extra });
}

/**
 * The popup prints engine failures verbatim, and some of them (Emscripten's
 * "not compiled for this environment", for instance) say nothing about what to
 * do. Keep the original text, add the fix for the one known trap: a stale
 * `dist/denoise.worklet.js` that predates a source change.
 */
function explainEngineError(message) {
  const text = String(message);
  if (/not compiled for this environment/.test(text)) {
    return `${text} — the worklet bundle is stale or was built for a different ` +
      'environment. Run "node tools/build-worklets.mjs", then reload the extension ' +
      'in chrome://extensions and try again.';
  }
  return text;
}

async function startCapture({ streamId, settings, tabId }) {
  // Tear down anything that is already running before taking the token.
  await stopCapture('restart');
  const token = ++sessionToken;
  const resolved = normalizeSettings(settings);

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });
  if (token !== sessionToken) {
    stream.getTracks().forEach((t) => t.stop());
    return { ok: false, error: 'superseded' };
  }

  context = new AudioContext({ latencyHint: 'interactive' });
  await context.audioWorklet.addModule(WORKLET_URL);
  if (token !== sessionToken) return { ok: false, error: 'superseded' };

  sourceNode = context.createMediaStreamSource(stream);
  const channels = Math.min(2, Math.max(1, stream.getAudioTracks()[0]?.getSettings?.().channelCount || 1));
  workletNode = new AudioWorkletNode(context, 'noise-simplifier', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    channelCount: channels,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { settings: resolved, channels },
  });

  workletNode.port.onmessage = (event) => {
    const msg = event.data || {};
    if (msg.type === 'meter') {
      latestMetrics = msg;
    } else if (msg.type === 'error') {
      reportStatus('error', { error: explainEngineError(msg.error) });
    } else if (msg.type === 'ready') {
      reportStatus('running', { detail: `engine ${msg.mode} @ ${msg.sampleRate} Hz` });
    }
  };

  // Keep the graph running even if the tab is muted by the OS.
  silentGain = context.createGain();
  silentGain.gain.value = 1;
  sourceNode.connect(workletNode);
  workletNode.connect(silentGain);
  silentGain.connect(context.destination);
  await context.resume().catch(() => {});

  const track = stream.getAudioTracks()[0];
  if (track) {
    track.onended = async () => {
      if (token !== sessionToken) return;
      await post({ target: 'background', type: 'captureEnded' });
      await stopCapture('ended');
    };
  }

  meterTimer = setInterval(() => {
    if (!latestMetrics) return;
    post({ target: 'background', type: 'metrics', metrics: { ...latestMetrics, tabId } });
  }, 250);

  reportStatus('running', { detail: `capturing ${channels === 2 ? 'stereo' : 'mono'}` });
  return { ok: true };
}

async function stopCapture(reason = 'user') {
  sessionToken++;
  if (meterTimer) {
    clearInterval(meterTimer);
    meterTimer = null;
  }
  latestMetrics = null;
  try { workletNode?.port.postMessage({ type: 'stop' }); } catch { /* ignore */ }
  try { sourceNode?.disconnect(); } catch { /* ignore */ }
  try { workletNode?.disconnect(); } catch { /* ignore */ }
  try { silentGain?.disconnect(); } catch { /* ignore */ }
  stream?.getTracks().forEach((t) => t.stop());
  if (context) {
    await context.close().catch(() => {});
  }
  stream = null;
  sourceNode = null;
  workletNode = null;
  silentGain = null;
  context = null;
  if (reason === 'user') reportStatus('idle', { metrics: null });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;
  if (message.target !== 'offscreen') return undefined;

  switch (message.type) {
    case 'start':
      startCapture(message)
        .then(sendResponse)
        .catch(async (err) => {
          const detail = explainEngineError(err.message || err);
          reportStatus('error', { error: detail });
          sendResponse({ ok: false, error: detail });
        });
      return true;
    case 'stop':
      stopCapture(message.reason === 'user' ? 'user' : 'stopped').then(sendResponse);
      return true;
    case 'settings':
      try {
        workletNode?.port.postMessage({ type: 'settings', settings: normalizeSettings(message.settings) });
      } catch { /* ignore */ }
      sendResponse({ ok: true });
      return true;
    default:
      sendResponse({ ok: false, error: `unknown offscreen message: ${message.type}` });
      return true;
  }
});
