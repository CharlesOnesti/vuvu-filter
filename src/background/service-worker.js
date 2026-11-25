/**
 * Orchestrates tabCapture → offscreen DSP (primary) and MediaElementSource
 * injection (fallback for simple HTML5 when capture is unavailable).
 *
 * tabCapture.getMediaStreamId must run in the service worker after a user
 * gesture (opening the popup / clicking Enable). The stream ID is redeemed in
 * the offscreen document via getUserMedia.
 */

import { DEFAULT_SETTINGS } from '../common/params.js';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const CONTENT_FILE = 'src/content/content.js';

/** @type {{ tabId: number, mode: 'tabCapture' | 'element' | null } | null} */
let session = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.some((c) => c.documentUrl?.endsWith(OFFSCREEN_URL) || c.contextType === 'OFFSCREEN_DOCUMENT');
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification:
      'Capture tab audio for real-time air-horn suppression and play filtered audio back to the user.',
  });
  // Give the offscreen module a beat to register its message listener.
  await new Promise((r) => setTimeout(r, 50));
}

async function sendOffscreen(payload, attempt = 0) {
  await ensureOffscreen();
  try {
    return await chrome.runtime.sendMessage({ target: 'offscreen', ...payload });
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 80));
      return sendOffscreen(payload, attempt + 1);
    }
    throw err;
  }
}

async function setBadge(tabId, mode) {
  try {
    if (!mode) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: mode === 'tabCapture' ? '#2f6df6' : '#5a7a3a',
    });
    await chrome.action.setBadgeText({
      tabId,
      text: mode === 'tabCapture' ? 'ON' : 'EL',
    });
  } catch {
    /* tab may be gone */
  }
}

async function stopSession() {
  const prev = session;
  session = null;
  if (prev?.mode === 'tabCapture' && (await hasOffscreen())) {
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' });
    } catch {
      /* offscreen may have gone away */
    }
  }
  if (prev?.tabId != null) {
    if (prev.mode === 'element') {
      try {
        await chrome.tabs.sendMessage(prev.tabId, {
          type: 'honkfilter',
          action: 'update',
          settings: { enabled: false, preferElement: false },
        });
      } catch {
        /* no content script */
      }
    }
    await setBadge(prev.tabId, null);
  }
  return { ok: true };
}

async function injectContent(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [CONTENT_FILE],
    });
    return true;
  } catch {
    return false;
  }
}

async function startElementFallback(tabId, settings) {
  const injected = await injectContent(tabId);
  if (!injected) {
    return { ok: false, mode: null, error: 'Could not inject content script.' };
  }
  // Wait briefly for the async content IIFE.
  for (let i = 0; i < 10; i++) {
    try {
      const ping = await chrome.tabs.sendMessage(tabId, {
        type: 'honkfilter',
        action: 'ping',
      });
      if (ping?.ok) break;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'honkfilter',
      action: 'update',
      settings: { ...settings, enabled: true, preferElement: true },
    });
  } catch (err) {
    return {
      ok: false,
      mode: null,
      error: String(err && err.message ? err.message : err),
    };
  }
  session = { tabId, mode: 'element' };
  await setBadge(tabId, 'element');
  return { ok: true, mode: 'element' };
}

async function startTabCapture(tabId, settings) {
  // Stop any prior capture so we don't leave a muted tab dangling.
  if (session) await stopSession();

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    return {
      ok: false,
      mode: null,
      error: String(err && err.message ? err.message : err),
      hint: 'tabCapture requires a user gesture (open the popup on the playing tab).',
    };
  }

  await ensureOffscreen();
  const result = await sendOffscreen({
    action: 'start',
    streamId,
    tabId,
    settings,
  });

  if (!result?.ok) {
    return {
      ok: false,
      mode: null,
      error: result?.error || 'Offscreen capture failed.',
    };
  }

  session = { tabId, mode: 'tabCapture' };
  await setBadge(tabId, 'tabCapture');
  return { ok: true, mode: 'tabCapture', sampleRate: result.sampleRate };
}

async function startBest(tabId, settings, preferMode) {
  const s = { ...DEFAULT_SETTINGS, ...settings, enabled: true };

  if (preferMode === 'element') {
    return startElementFallback(tabId, s);
  }

  // Primary: tabCapture (works on many DRM sports players where createMediaElementSource fails).
  const capture = await startTabCapture(tabId, s);
  if (capture.ok) return capture;

  // Fallback: MediaElementSource for simple HTML5 / YouTube when capture is denied.
  const fallback = await startElementFallback(tabId, s);
  if (fallback.ok) {
    return {
      ...fallback,
      warning: `tabCapture failed (${capture.error}); using MediaElementSource fallback.`,
    };
  }
  return {
    ok: false,
    mode: null,
    error: capture.error || fallback.error || 'Could not start filter.',
  };
}

async function sessionStatus() {
  if (!session) {
    return { ok: true, active: false, mode: null };
  }

  if (session.mode === 'tabCapture') {
    try {
      const off = await sendOffscreen({ action: 'status' });
      return {
        ok: true,
        active: !!off?.capturing,
        mode: 'tabCapture',
        tabId: session.tabId,
        ...off,
      };
    } catch {
      return { ok: true, active: false, mode: null, error: 'offscreen gone' };
    }
  }

  // Element mode — ask content script.
  try {
    const st = await chrome.tabs.sendMessage(session.tabId, {
      type: 'honkfilter',
      action: 'status',
    });
    return {
      ok: true,
      ...st,
      // Prefer the content script's active flag; session exists even before attach.
      active: st?.active !== false,
      mode: 'element',
      tabId: session.tabId,
    };
  } catch {
    return { ok: true, active: true, mode: 'element', tabId: session.tabId };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'honkfilter-bg') return;

  (async () => {
    if (msg.action === 'start') {
      sendResponse(await startBest(msg.tabId, msg.settings, msg.preferMode));
    } else if (msg.action === 'stop') {
      sendResponse(await stopSession());
    } else if (msg.action === 'update') {
      if (!session) {
        sendResponse({ ok: true, active: false });
        return;
      }
      if (session.mode === 'tabCapture') {
        sendResponse(
          await sendOffscreen({ action: 'update', settings: msg.settings })
        );
      } else {
        try {
          sendResponse(
            await chrome.tabs.sendMessage(session.tabId, {
              type: 'honkfilter',
              action: 'update',
              settings: msg.settings,
            })
          );
        } catch (err) {
          sendResponse({ ok: false, error: String(err) });
        }
      }
    } else if (msg.action === 'status') {
      sendResponse(await sessionStatus());
    } else if (msg.action === 'inject') {
      sendResponse({ ok: await injectContent(msg.tabId) });
    } else if (msg.action === 'hasAllSites') {
      const granted = await chrome.permissions.contains({
        origins: ['*://*/*'],
      });
      sendResponse({ granted });
    } else if (msg.action === 'requestAllSites') {
      const granted = await chrome.permissions.request({
        origins: ['*://*/*', 'file:///*'],
      });
      sendResponse({ granted });
    } else {
      sendResponse({ ok: false, error: 'unknown' });
    }
  })();

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId === tabId) stopSession();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // Full navigations end element-mode sessions; tabCapture usually survives
  // same-tab navigations, but a hard reload can drop the stream.
  if (session?.tabId === tabId && info.status === 'loading' && session.mode === 'element') {
    setBadge(tabId, null);
    session = null;
  }
});
