import { DEFAULT_SETTINGS, saveSettings, loadSettings } from '../common/params.js';

const $ = (id) => document.getElementById(id);
const els = {
  enabled: $('enabled'),
  strength: $('strength'),
  strengthVal: $('strengthVal'),
  minHz: $('minHz'),
  minHzVal: $('minHzVal'),
  bypass: $('bypass'),
  reset: $('reset'),
  status: $('status'),
  meter: $('meter'),
  meterVal: $('meterVal'),
  start: $('start'),
  stop: $('stop'),
  modeLine: $('modeLine'),
  forceElement: $('forceElement'),
};

let settings = { ...DEFAULT_SETTINGS };
let tabId = null;
let tabUrl = '';
let sessionActive = false;
let sessionMode = null;
let bypassHeld = false;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('devtools://') ||
    url.startsWith('https://chrome.google.com/webstore') ||
    url.startsWith('https://chromewebstore.google.com')
  );
}

function bg(action, payload = {}) {
  return chrome.runtime.sendMessage({ type: 'honkfilter-bg', action, ...payload });
}

function render() {
  els.enabled.checked = settings.enabled && sessionActive;
  els.strength.value = settings.strength;
  els.strengthVal.textContent = settings.strength;
  els.minHz.value = settings.minHz;
  els.minHzVal.textContent = `${settings.minHz} Hz`;
  els.strength.disabled = !sessionActive;
  els.minHz.disabled = !sessionActive;
  els.start.classList.toggle('hidden', sessionActive);
  els.stop.classList.toggle('hidden', !sessionActive);
}

function setStatus(text, warn = false) {
  els.status.textContent = text;
  els.status.classList.toggle('warn', warn);
}

function setModeLine(mode, extra = '') {
  const labels = {
    tabCapture: 'Tab audio capture (DRM-friendly)',
    element: 'MediaElementSource (HTML5 fallback)',
  };
  const label = mode ? labels[mode] || mode : '—';
  els.modeLine.textContent = `Mode: ${label}${extra ? ` · ${extra}` : ''}`;
}

async function applyLive(patch) {
  settings = { ...settings, ...patch };
  render();
  await saveSettings(patch);
  if (sessionActive) {
    await bg('update', {
      settings: { ...settings, bypass: bypassHeld ? true : settings.bypass },
    });
  }
}

async function startFilter() {
  if (tabId == null || isRestrictedUrl(tabUrl)) {
    setStatus('Open a normal web video tab first.', true);
    return;
  }
  setStatus('Starting capture…');
  const preferMode = els.forceElement.checked ? 'element' : undefined;
  const res = await bg('start', {
    tabId,
    settings: { ...settings, enabled: true },
    preferMode,
  });
  if (!res?.ok) {
    sessionActive = false;
    sessionMode = null;
    setStatus(res?.error || 'Could not start filter on this tab.', true);
    setModeLine(null);
    render();
    return;
  }
  sessionActive = true;
  sessionMode = res.mode;
  settings = { ...settings, enabled: true };
  await saveSettings({ enabled: true });
  setModeLine(res.mode, res.warning ? 'fallback used' : '');
  setStatus(
    res.mode === 'tabCapture'
      ? 'Filtering this tab via tab audio capture.'
      : 'Filtering via MediaElementSource fallback.'
  );
  if (res.warning) setStatus(res.warning, true);
  render();
}

async function stopFilter() {
  await bg('stop');
  sessionActive = false;
  sessionMode = null;
  bypassHeld = false;
  setModeLine(null);
  setStatus('Stopped. Click Start on this tab to filter again.');
  els.meter.style.width = '0%';
  els.meterVal.textContent = '—';
  render();
}

async function refreshStatus() {
  if (isRestrictedUrl(tabUrl)) {
    setStatus('Open a normal web video tab (YouTube, Fubo, Fox Sports…).', true);
    setModeLine(null);
    els.meter.style.width = '0%';
    els.meterVal.textContent = '—';
    return;
  }

  const res = await bg('status');
  const onThisTab = res?.tabId === tabId && !!res?.mode;

  if (onThisTab && res.mode === 'tabCapture') {
    sessionMode = 'tabCapture';
    sessionActive = !!res.capturing;
  } else if (onThisTab && res.mode === 'element') {
    sessionMode = 'element';
    sessionActive = !!res.active;
  } else {
    sessionMode = null;
    sessionActive = false;
  }

  render();

  if (!sessionActive) {
    setModeLine(null);
    setStatus('Idle. Click Start on this tab while a stream is playing.', true);
    els.meter.style.width = '0%';
    els.meterVal.textContent = '—';
    return;
  }

  setModeLine(sessionMode);

  if (sessionMode === 'tabCapture' && res?.silentLikely) {
    setStatus(
      'Capture is running but audio looks silent — this player may block tab audio (some Widevine apps).',
      true
    );
  } else if (sessionMode === 'element' && res?.drmLikely && (res?.attached || 0) === 0) {
    setStatus(
      'MediaElementSource blocked (DRM). Turn off “Force element mode” and use Start (tab capture).',
      true
    );
  } else if (sessionMode === 'element' && (res?.mediaFound || 0) === 0) {
    setStatus('No video/audio elements found yet.', true);
  } else if (sessionMode === 'element' && (res?.attached || 0) === 0) {
    setStatus('Waiting for a playable media element…', true);
  } else if (res?.contextState === 'suspended') {
    setStatus('Audio context suspended — click the page once.', true);
  } else {
    setStatus(
      sessionMode === 'tabCapture'
        ? 'Filtering tab audio. Horns should drop; voice should stay.'
        : `Filtering ${res.attached} media element${res.attached > 1 ? 's' : ''}.`
    );
  }

  const reduction = res?.reduction || 0;
  const pct = Math.max(0, Math.min(100, (reduction / 30) * 100));
  els.meter.style.width = `${pct}%`;
  els.meterVal.textContent = reduction > 0.2 ? `-${reduction.toFixed(1)} dB` : '—';
}

els.strength.addEventListener('input', () => {
  els.strengthVal.textContent = els.strength.value;
  applyLive({ strength: Number(els.strength.value) });
});

els.minHz.addEventListener('input', () => {
  els.minHzVal.textContent = `${els.minHz.value} Hz`;
  applyLive({ minHz: Number(els.minHz.value) });
});

els.enabled.addEventListener('change', async () => {
  if (els.enabled.checked) {
    await startFilter();
  } else {
    await stopFilter();
  }
});

els.start.addEventListener('click', () => startFilter());
els.stop.addEventListener('click', () => stopFilter());

const holdOn = (e) => {
  e.preventDefault();
  bypassHeld = true;
  if (sessionActive) bg('update', { settings: { ...settings, bypass: true } });
};
const holdOff = () => {
  bypassHeld = false;
  if (sessionActive) bg('update', { settings: { ...settings, bypass: false } });
};
els.bypass.addEventListener('mousedown', holdOn);
els.bypass.addEventListener('touchstart', holdOn, { passive: false });
for (const evt of ['mouseup', 'mouseleave', 'touchend', 'touchcancel']) {
  els.bypass.addEventListener(evt, holdOff);
}

els.reset.addEventListener('click', async () => {
  settings = { ...DEFAULT_SETTINGS };
  render();
  await saveSettings(DEFAULT_SETTINGS);
  if (sessionActive) await bg('update', { settings });
});

$('bench').addEventListener('click', () =>
  chrome.tabs.create({ url: chrome.runtime.getURL('test/bench.html') })
);

(async () => {
  const tab = await activeTab();
  tabId = tab ? tab.id : null;
  tabUrl = tab?.url || '';
  settings = await loadSettings();
  render();
  await refreshStatus();
  // If the user already had a session on this tab, keep controls live.
  setInterval(refreshStatus, 500);
})();
