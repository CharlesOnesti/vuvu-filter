/**
 * Offscreen audio pipeline (primary path for DRM / sports streamers).
 *
 *   tabCapture streamId
 *     → getUserMedia({ chromeMediaSource: 'tab' })
 *     → MediaStreamSource
 *     → AudioWorkletNode (dehonk-processor)
 *     → AudioContext.destination  (restore playback; capture mutes the tab)
 *
 * Same DSP core as the MediaElementSource fallback.
 */

import { strengthToParams, DEFAULT_SETTINGS } from '../common/params.js';

const WORKLET_URL = chrome.runtime.getURL('src/worklet/dehonk-processor.js');

/** @type {MediaStream | null} */
let stream = null;
/** @type {AudioContext | null} */
let ctx = null;
/** @type {AudioWorkletNode | null} */
let node = null;
/** @type {MediaStreamAudioSourceNode | null} */
let source = null;
/** @type {number | null} */
let activeTabId = null;
let settings = { ...DEFAULT_SETTINGS };
let lastReduction = 0;
let startedAt = 0;
let peakLevel = 0;
let levelSamples = 0;

function currentParams() {
  return strengthToParams(settings.strength, settings.minHz);
}

function pushParams() {
  if (!node) return;
  node.port.postMessage({ type: 'params', params: currentParams() });
  node.port.postMessage({
    type: 'bypass',
    value: settings.bypass || !settings.enabled,
  });
}

function teardown() {
  try {
    node?.port.postMessage({ type: 'bypass', value: true });
  } catch {
    /* ignore */
  }
  try {
    source?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    node?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    stream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  try {
    ctx?.close();
  } catch {
    /* ignore */
  }
  stream = null;
  ctx = null;
  node = null;
  source = null;
  activeTabId = null;
  lastReduction = 0;
  peakLevel = 0;
  levelSamples = 0;
  startedAt = 0;
}

async function startCapture(streamId, tabId, nextSettings) {
  teardown();
  if (nextSettings) settings = { ...DEFAULT_SETTINGS, ...nextSettings };

  // Prefer audio-only; some Chrome builds still want a video constraint present.
  let media;
  try {
    media = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  } catch {
    media = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });
    // Drop video tracks — we only filter audio.
    for (const t of media.getVideoTracks()) t.stop();
  }

  stream = media;
  activeTabId = tabId;
  startedAt = Date.now();
  peakLevel = 0;
  levelSamples = 0;

  ctx = new AudioContext();
  await ctx.audioWorklet.addModule(WORKLET_URL);

  source = ctx.createMediaStreamSource(media);
  node = new AudioWorkletNode(ctx, 'dehonk-processor', {
    processorOptions: {
      params: currentParams(),
      bypass: settings.bypass || !settings.enabled,
    },
    outputChannelCount: [2],
  });

  node.port.onmessage = (e) => {
    if (e.data?.type === 'meter') lastReduction = e.data.reduction || 0;
  };

  // Side-chain analyser for silence / DRM detection (does not affect output).
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const levelBuf = new Float32Array(analyser.fftSize);
  source.connect(analyser);
  const levelTimer = setInterval(() => {
    if (!ctx || ctx.state === 'closed') {
      clearInterval(levelTimer);
      return;
    }
    analyser.getFloatTimeDomainData(levelBuf);
    let peak = 0;
    for (let i = 0; i < levelBuf.length; i++) {
      const v = Math.abs(levelBuf[i]);
      if (v > peak) peak = v;
    }
    peakLevel = Math.max(peakLevel, peak);
    levelSamples++;
  }, 250);

  source.connect(node);
  node.connect(ctx.destination);
  if (ctx.state === 'suspended') await ctx.resume();
  pushParams();

  return { ok: true, tabId, sampleRate: ctx.sampleRate };
}

function status() {
  const silentLikely =
    !!stream && levelSamples >= 8 && peakLevel < 0.0005 && Date.now() - startedAt > 2500;

  return {
    ok: true,
    mode: stream ? 'tabCapture' : 'idle',
    tabId: activeTabId,
    capturing: !!stream,
    contextState: ctx ? ctx.state : 'none',
    reduction: lastReduction,
    peakLevel,
    silentLikely,
    settings,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  (async () => {
    try {
      if (msg.action === 'start') {
        const result = await startCapture(msg.streamId, msg.tabId, msg.settings);
        sendResponse(result);
      } else if (msg.action === 'stop') {
        teardown();
        sendResponse({ ok: true });
      } else if (msg.action === 'update') {
        settings = { ...settings, ...msg.settings };
        pushParams();
        if (!settings.enabled && stream) {
          // Keep capture alive but bypass so audio still plays unfiltered.
          pushParams();
        }
        sendResponse({ ok: true, capturing: !!stream });
      } else if (msg.action === 'status') {
        sendResponse(status());
      } else {
        sendResponse({ ok: false, error: 'unknown action' });
      }
    } catch (err) {
      teardown();
      sendResponse({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  })();

  return true;
});
