/**
 * MediaElementSource fallback path.
 *
 * Used when tabCapture is unavailable or the user forces "Element mode".
 * Primary path for DRM sports sites is tabCapture → offscreen (see
 * src/offscreen/offscreen.js). Do not attach here while tabCapture owns the tab
 * — that would fight the capture pipeline.
 *
 *   <video> --createMediaElementSource--> AudioWorkletNode --> destination
 */
(async () => {
  if (globalThis.__honkFilterAllSitesInit) return;
  globalThis.__honkFilterAllSitesInit = true;

  const { DEFAULT_SETTINGS, strengthToParams } = await import(
    chrome.runtime.getURL('src/common/params.js')
  );

  const WORKLET_URL = chrome.runtime.getURL('src/worklet/dehonk-processor.js');

  let settings = { ...DEFAULT_SETTINGS, preferElement: false };
  let ctx = null;
  let workletReady = null;
  const attached = new WeakMap();
  const nodes = new Set();
  let lastReduction = 0;
  let mediaSeen = 0;
  let attachOk = 0;
  let attachFail = 0;
  let drmLikely = false;
  let lastError = '';
  let active = false; // only attach when SW puts us in element mode

  try {
    settings = {
      ...DEFAULT_SETTINGS,
      preferElement: false,
      ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)),
    };
  } catch {
    /* defaults */
  }

  function ensureContext() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      workletReady = ctx.audioWorklet.addModule(WORKLET_URL).catch((err) => {
        console.warn('[HonkFilter] failed to load audio worklet:', err);
        throw err;
      });
    }
    return ctx;
  }

  function resumeContext() {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
  for (const evt of ['click', 'keydown', 'touchstart', 'play']) {
    document.addEventListener(evt, resumeContext, { capture: true, passive: true });
  }

  function currentParams() {
    return strengthToParams(settings.strength, settings.minHz);
  }

  function classifyAttachError(err) {
    const msg = String(err && err.message ? err.message : err);
    lastError = msg;
    const lower = msg.toLowerCase();
    if (
      lower.includes('cors') ||
      lower.includes('cross-origin') ||
      lower.includes('cross origin') ||
      lower.includes('not supported') ||
      lower.includes('securityerror') ||
      err?.name === 'SecurityError' ||
      err?.name === 'NotSupportedError' ||
      err?.name === 'InvalidStateError'
    ) {
      drmLikely = true;
    }
  }

  async function attach(el) {
    if (!active || !settings.enabled) return;
    if (attached.has(el)) return;
    attached.set(el, null);
    mediaSeen++;

    try {
      const context = ensureContext();
      await workletReady;

      const source = context.createMediaElementSource(el);
      const node = new AudioWorkletNode(context, 'dehonk-processor', {
        processorOptions: {
          params: currentParams(),
          bypass: settings.bypass,
        },
        outputChannelCount: [2],
      });
      node.port.onmessage = (e) => {
        if (e.data?.type === 'meter') lastReduction = e.data.reduction;
      };

      source.connect(node);
      node.connect(context.destination);
      attached.set(el, { node, source });
      nodes.add(node);
      attachOk++;
      resumeContext();
    } catch (err) {
      attachFail++;
      classifyAttachError(err);
      console.warn('[HonkFilter] MediaElementSource attach failed:', err);
    }
  }

  function scan() {
    if (!active) return;
    for (const el of document.querySelectorAll('video, audio')) attach(el);
  }

  function pushParams() {
    const params = currentParams();
    for (const node of nodes) {
      node.port.postMessage({ type: 'params', params });
      node.port.postMessage({
        type: 'bypass',
        value: settings.bypass || !settings.enabled,
      });
    }
  }

  const observer = new MutationObserver((records) => {
    if (!active) return;
    for (const rec of records) {
      for (const added of rec.addedNodes) {
        if (!(added instanceof HTMLElement)) continue;
        if (added instanceof HTMLMediaElement) attach(added);
        else if (added.querySelector) {
          for (const el of added.querySelectorAll('video, audio')) attach(el);
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scan, 3000);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'honkfilter') return;

    if (msg.action === 'update') {
      settings = { ...settings, ...msg.settings };
      // Element path only runs when explicitly enabled by the background session.
      if (settings.preferElement && settings.enabled) {
        active = true;
        pushParams();
        scan();
      } else if (settings.enabled === false) {
        active = false;
        pushParams();
      } else if (active) {
        pushParams();
        scan();
      }
      sendResponse({ ok: true, attached: nodes.size, mode: 'element', active });
    } else if (msg.action === 'status') {
      const found = document.querySelectorAll('video, audio').length;
      sendResponse({
        ok: true,
        mode: 'element',
        active,
        attached: nodes.size,
        mediaFound: found,
        mediaSeen,
        attachFail,
        attachOk,
        drmLikely,
        lastError,
        contextState: ctx ? ctx.state : 'none',
        reduction: lastReduction,
      });
    } else if (msg.action === 'ping') {
      sendResponse({ ok: true, mode: 'element' });
    }
    return true;
  });
})();
