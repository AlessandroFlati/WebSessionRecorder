import { DEFAULT_SETTINGS, PORT_NAME, matchesAny, hostOf } from '../common/constants.js';
import * as db from '../common/db.js';
import { startNetObserver, stopNetObserver } from './net-observer.js';
import { startDebuggerCapture, stopDebuggerCapture, isAttached } from './debugger-capture.js';
import { createResourceFetcher } from './resource-fetcher.js';

const FLUSH_MS = 300;
const FLUSH_AT = 300;
const SCREENSHOT_MIN_GAP_MS = 550;

let state = emptyState();
let settings = { ...DEFAULT_SETTINGS };
let fetcher = null;
let queue = [];
let flushTimer = null;
let flushing = false;
let lastScreenshot = 0;
let screenshotTimer = null;
let lastStateProbe = null;
const ports = new Set();

function emptyState() {
  return { recording: false, sessionId: null, startedAt: 0, seq: 0, tabId: null, windowId: null, counts: {}, bytes: 0 };
}

/* ------------------------------------------------------------------ bootstrap */

chrome.runtime.onInstalled.addListener(() => {
  void loadSettings();
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  void restore();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((msg) => {
    void onPortMessage(port, msg);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleCommand(msg, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.recording && tabId === state.tabId) void stopRecording('tab-closed');
});

// Recording can start by itself, but only for URLs the user has listed. The default list is
// empty: a recorder that arms itself everywhere is not something to turn on by surprise.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!settings.autoRecord || !settings.autoRecordPatterns.length) return;
  if (changeInfo.status !== 'loading' || !changeInfo.url) return;
  if (state.recording) return;
  if (matchesAny(changeInfo.url, settings.autoRecordPatterns)) {
    void startRecording({ tabId, tab, reason: 'auto' });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'wsr-keepalive') {
    void flush();
    void persistState();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    broadcastState();
  }
});

void restore();

async function restore() {
  await loadSettings();
  const stored = await chrome.storage.session.get('state');
  if (stored.state && stored.state.recording) {
    state = stored.state;
    if (!fetcher) fetcher = createResourceFetcher(emit, settings);
    if (settings.webRequestMeta && state.tabId != null) startNetObserver(state.tabId, emit, settings);
    emit('recorder.serviceWorkerRestarted', {});
  }
  updateBadge();
}

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  return settings;
}

async function persistState() {
  try {
    await chrome.storage.session.set({ state });
  } catch (err) {
    console.error('[web-session-recorder] persistState failed', err);
  }
}

/* ------------------------------------------------------------- session control */

async function startRecording({ tabId, tab, reason } = {}) {
  if (state.recording) await stopRecording('restart');
  await loadSettings();

  let target = tab;
  if (!target) {
    if (tabId != null) target = await chrome.tabs.get(tabId);
    else [target] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!target) throw new Error('no target tab');

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const id = 's_' + stamp + '_' + Math.random().toString(36).slice(2, 8);
  const startedAt = Date.now();
  const session = {
    id,
    startedAt,
    endedAt: null,
    url: target.url,
    title: target.title,
    site: hostOf(target.url),
    userAgent: navigator.userAgent,
    settings: { ...settings },
    counts: {},
    bytes: 0,
    tabId: target.id,
    startReason: reason || 'manual'
  };
  await db.putSession(session);

  state = {
    recording: true,
    sessionId: id,
    startedAt,
    seq: 0,
    tabId: target.id,
    windowId: target.windowId,
    counts: {},
    bytes: 0
  };
  await persistState();

  fetcher = createResourceFetcher(emit, settings);
  if (settings.webRequestMeta) startNetObserver(target.id, emit, settings);
  if (settings.useDebugger) {
    try {
      if (chrome.debugger) await startDebuggerCapture(target.id, emit);
      else emit('debugger.error', { error: 'debugger API unavailable' });
    } catch (err) {
      emit('debugger.error', { error: String(err && err.message ? err.message : err) });
    }
  }
  chrome.alarms.create('wsr-keepalive', { periodInMinutes: 0.4 });

  emit('session.start', {
    url: target.url,
    title: target.title,
    game: session.game,
    settings: session.settings,
    reason: session.startReason
  });
  emit('recorder.injection', await ensureContentScripts(target.id));
  broadcastState();
  updateBadge();
  startScreenshotTimer();
  return { sessionId: id };
}

/**
 * Manifest content scripts only reach documents created after the extension loaded, so a
 * tab that was already open (or open across an extension reload) has no live recorder in
 * its main frame. Injecting explicitly at session start covers every frame; the recorder
 * replaces any stale instance and the page hooks keep working, so this is idempotent.
 */
async function ensureContentScripts(tabId) {
  const result = { frames: 0, mainWorldFrames: 0, errors: [] };
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/content/page-hooks.js'],
      world: 'MAIN',
      injectImmediately: true
    });
    result.mainWorldFrames = injected.length;
  } catch (err) {
    result.errors.push('main: ' + String(err && err.message ? err.message : err));
  }
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/content/recorder.js'],
      world: 'ISOLATED',
      injectImmediately: true
    });
    result.frames = injected.length;
  } catch (err) {
    result.errors.push('isolated: ' + String(err && err.message ? err.message : err));
  }
  return result;
}

async function stopRecording(reason = 'manual') {
  if (!state.recording) return { stopped: false };
  emit('session.stop', { reason });
  const sessionId = state.sessionId;
  const counts = state.counts;
  const bytes = state.bytes;
  stopNetObserver();
  if (isAttached()) await stopDebuggerCapture();
  if (fetcher) fetcher.stop();
  fetcher = null;
  stopScreenshotTimer();
  chrome.alarms.clear('wsr-keepalive');
  await flush();

  const session = await db.getSession(sessionId);
  if (session) {
    session.endedAt = Date.now();
    session.counts = counts;
    session.bytes = bytes;
    await db.putSession(session);
  }
  state = emptyState();
  await persistState();
  broadcastState();
  updateBadge();
  return { stopped: true, sessionId };
}

/* ------------------------------------------------------------------- ingestion */

function emit(type, data, assets = null, wall = null) {
  if (!state.recording) return;
  const at = wall || Date.now();
  push({
    sessionId: state.sessionId,
    seq: state.seq++,
    wall: at,
    t: Math.round(at - state.startedAt),
    frameId: -1,
    frameUrl: null,
    source: 'background',
    type,
    data,
    assets: assets || undefined
  });
}

function push(record) {
  state.counts[record.type] = (state.counts[record.type] || 0) + 1;
  queue.push(record);
  if (queue.length >= FLUSH_AT || record.assets) {
    void flush();
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_MS);
  }
}

async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const batch = queue;
  queue = [];
  try {
    state.bytes += await db.putEvents(batch);
  } catch (err) {
    console.error('[web-session-recorder] flush failed', err);
  } finally {
    flushing = false;
    if (queue.length) setTimeout(() => void flush(), 0);
  }
}

/* -------------------------------------------------------------- port handling */

async function onPortMessage(port, msg) {
  const tabId = port.sender && port.sender.tab ? port.sender.tab.id : undefined;
  switch (msg.type) {
    case 'hello':
      port.postMessage(stateMessage(tabId));
      return;
    case 'heartbeat':
      return;
    case 'events': {
      if (!state.recording || tabId !== state.tabId) return;
      if (msg.sessionId && msg.sessionId !== state.sessionId) return;
      const frameId = port.sender && port.sender.frameId != null ? port.sender.frameId : 0;
      const frameUrl = (port.sender && port.sender.url) || null;
      // A frame id is reused across navigations; documentId identifies the actual document.
      const documentId = (port.sender && port.sender.documentId) || null;
      for (const ev of msg.events) {
        push({
          sessionId: state.sessionId,
          seq: state.seq++,
          wall: ev.wall,
          t: Math.round(ev.wall - state.startedAt),
          pt: ev.pt,
          frameId,
          frameUrl,
          documentId,
          source: ev.source || 'content',
          type: ev.type,
          data: ev.data,
          assets: ev.assets
        });
      }
      return;
    }
    case 'resources':
      if (!state.recording || tabId !== state.tabId) return;
      if (fetcher) fetcher.enqueue(msg.items || []);
      return;
    case 'screenshot':
      if (!state.recording || tabId !== state.tabId) return;
      await captureScreenshot(msg.reason || 'requested');
      return;
    case 'stateResult':
      lastStateProbe = { ...msg.result, href: msg.href, at: Date.now() };
      if (state.recording && tabId === state.tabId) emit('page.state', lastStateProbe);
      chrome.runtime.sendMessage({ type: 'probe:update' }).catch(() => {});
      return;
    default:
      return;
  }
}

function stateMessage(tabId) {
  return {
    type: 'state',
    recording: state.recording && tabId === state.tabId,
    sessionId: state.sessionId,
    startedAt: state.startedAt,
    settings
  };
}

function broadcastState() {
  for (const port of ports) {
    try {
      port.postMessage(stateMessage(port.sender && port.sender.tab ? port.sender.tab.id : undefined));
    } catch {
      ports.delete(port);
    }
  }
  chrome.runtime.sendMessage({ type: 'status-changed' }).catch(() => {});
}

/* ------------------------------------------------------------------ screenshots */

function startScreenshotTimer() {
  stopScreenshotTimer();
  if (!state.recording || !settings.screenshotIntervalMs) return;
  screenshotTimer = setInterval(() => void captureScreenshot('interval'), Math.max(1000, settings.screenshotIntervalMs));
}

function stopScreenshotTimer() {
  if (screenshotTimer) clearInterval(screenshotTimer);
  screenshotTimer = null;
}

async function captureScreenshot(reason) {
  if (!state.recording || state.windowId == null) return;
  const now = Date.now();
  if (now - lastScreenshot < SCREENSHOT_MIN_GAP_MS) return;
  lastScreenshot = now;
  try {
    // captureVisibleTab grabs whatever is in front: skip when the recorded tab is not.
    const tab = await chrome.tabs.get(state.tabId);
    if (!tab || !tab.active) {
      emit('screenshot.skipped', { reason, why: 'recorded tab not active' }, null, now);
      return;
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(state.windowId, {
      format: 'jpeg',
      quality: settings.screenshotQuality
    });
    const blob = await (await fetch(dataUrl)).blob();
    emit(
      'screenshot',
      { reason, size: blob.size, format: 'jpeg' },
      { image: { kind: 'screenshot', contentType: 'image/jpeg', data: blob, size: blob.size } },
      now
    );
  } catch (err) {
    emit('screenshot.error', { reason, error: String(err && err.message ? err.message : err) }, null, now);
  }
}

/* -------------------------------------------------------------- popup commands */

async function handleCommand(msg) {
  switch (msg && msg.type) {
    case 'status': {
      const session = state.sessionId ? await db.getSession(state.sessionId) : null;
      const frames = { total: 0, main: false, urls: [] };
      for (const port of ports) {
        const info = port.__lgFrame;
        if (!info) continue;
        frames.total++;
        if (info.frameId === 0) frames.main = true;
        if (info.url && frames.urls.length < 8) frames.urls.push(info.url);
      }
      let estimate = null;
      try {
        estimate = await navigator.storage.estimate();
      } catch {
        /* not available */
      }
      return {
        recording: state.recording,
        sessionId: state.sessionId,
        startedAt: state.startedAt,
        tabId: state.tabId,
        counts: state.counts,
        events: state.seq,
        bytes: state.bytes,
        session,
        settings,
        frames,
        lastStateProbe,
        storageEstimate: estimate ? { usage: estimate.usage, quota: estimate.quota } : null,
        debuggerAttached: isAttached(),
        resources: fetcher ? fetcher.stats() : null
      };
    }
    case 'start':
      return startRecording({ tabId: msg.tabId, reason: msg.reason });
    case 'stop':
      return stopRecording(msg.reason || 'manual');
    case 'settings:get':
      return loadSettings();
    case 'settings:set': {
      settings = { ...DEFAULT_SETTINGS, ...settings, ...msg.settings };
      await chrome.storage.local.set({ settings });
      broadcastState();
      return settings;
    }
    case 'sessions:list':
      return db.listSessions();
    case 'session:delete':
      if (state.recording && msg.sessionId === state.sessionId) await stopRecording('deleted');
      await db.deleteSession(msg.sessionId);
      return { deleted: msg.sessionId };
    case 'mark':
      emit('user.mark', { label: msg.label || 'mark' });
      await flush();
      return { ok: true };
    case 'openViewer': {
      const query = msg.sessionId ? '?session=' + encodeURIComponent(msg.sessionId) : '';
      await chrome.tabs.create({ url: chrome.runtime.getURL('src/viewer/viewer.html' + query) });
      return { ok: true };
    }
    case 'screenshot':
      await captureScreenshot(msg.reason || 'manual');
      return { ok: true };
    /**
     * Reads what the page's framework is holding for the elements matching a selector. The
     * page world is the only place that data exists, so the request goes out through the
     * recorder and the answer comes back on its port.
     */
    case 'probeState': {
      const tabId = msg.tabId != null ? msg.tabId : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      if (tabId == null) throw new Error('no tab to probe');
      lastStateProbe = null;
      let asked = 0;
      for (const port of ports) {
        if (!port.sender || !port.sender.tab || port.sender.tab.id !== tabId) continue;
        port.postMessage({ type: 'probeState', options: msg.options || {} });
        asked++;
      }
      if (!asked) throw new Error('no recorder is attached to that tab; open or reload the page first');
      for (let waited = 0; waited < 2500 && !lastStateProbe; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return lastStateProbe || { error: 'the page did not answer' };
    }
    case 'probe:get':
      return lastStateProbe;
    /**
     * Anything else may write its own events into the recording: a page script through
     * window.postMessage, another extension through chrome.runtime.sendMessage, or a test
     * harness. Whatever shape the payload has is kept, because a fixed field list is what
     * makes a recording useless to whoever reads it next.
     */
    case 'note': {
      if (!state.recording) return { stored: false, reason: 'not recording' };
      const { type, label, ...rest } = msg;
      emit('note', { label: label || 'note', ...rest });
      return { stored: true };
    }
    case 'status-changed':
    case 'probe:update':
      return null;
    default:
      throw new Error('unknown command: ' + (msg && msg.type));
  }
}

function updateBadge() {
  chrome.action.setBadgeText({ text: state.recording ? 'REC' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
}
