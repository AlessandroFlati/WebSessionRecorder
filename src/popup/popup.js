import { formatBytes, hostOf } from '../common/constants.js';

const el = (id) => document.getElementById(id);
let status = null;
let ticker = null;
let currentTabId = null;

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!response) return reject(new Error('no response'));
      if (!response.ok) return reject(new Error(response.error));
      resolve(response.result);
    });
  });
}

function showError(err) {
  el('error').textContent = err ? String(err.message || err) : '';
}

async function refresh() {
  try {
    status = await send({ type: 'status', tabId: currentTabId });
    showError(null);
  } catch (err) {
    showError(err);
    return;
  }
  renderStatus();
  renderSettings();
  await renderSessions();
}

function renderStatus() {
  const frames = status.frames || { total: 0, main: false };
  const framesEl = el('frames');
  if (!frames.total) {
    framesEl.textContent = 'no frame connected - reload the page';
    framesEl.style.color = 'var(--danger)';
  } else if (!frames.main) {
    framesEl.textContent = `${frames.total} frames, main frame missing - reload the page`;
    framesEl.style.color = 'var(--danger)';
  } else {
    framesEl.textContent = `${frames.total} frame${frames.total > 1 ? 's' : ''} connected`;
    framesEl.style.color = '';
  }

  const toggle = el('toggle');
  toggle.textContent = status.recording ? 'Stop recording' : 'Start recording';
  toggle.classList.toggle('recording', status.recording);
  el('mark').disabled = !status.recording;
  el('shot').disabled = !status.recording;
  el('stats').hidden = !status.recording;

  if (status.recording) {
    el('sessionId').textContent = status.sessionId || '-';
    el('events').textContent = String(status.events);
    el('bytes').textContent = formatBytes(status.bytes);
    el('resources').textContent = status.resources
      ? `${status.resources.seen} fetched, ${status.resources.queued} queued`
      : '-';
    renderTypes(status.counts);
    updateElapsed();
    if (!ticker) ticker = setInterval(updateElapsed, 1000);
  } else if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }

  if (status.storageEstimate) {
    const { usage, quota } = status.storageEstimate;
    el('storage').textContent = `${formatBytes(usage)} used of ${formatBytes(quota)}`;
  }
}

function updateElapsed() {
  if (!status || !status.recording) return;
  const seconds = Math.floor((Date.now() - status.startedAt) / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  el('elapsed').textContent = `${mm}:${ss}`;
}

function renderTypes(counts) {
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  const container = el('types');
  container.textContent = '';
  for (const [type, count] of entries.slice(0, 16)) {
    const name = document.createElement('span');
    name.textContent = type;
    const value = document.createElement('span');
    value.textContent = String(count);
    container.append(name, value);
  }
}

/** Settings are checkboxes, numbers, or newline-separated lists in a textarea. */
function renderSettings() {
  for (const input of document.querySelectorAll('#settings [data-key]')) {
    const key = input.dataset.key;
    const value = status.settings[key];
    if (input.type === 'checkbox') input.checked = !!value;
    else if (input.tagName === 'TEXTAREA') input.value = Array.isArray(value) ? value.join('\n') : value || '';
    else input.value = value;
  }
}

async function onSettingChange(event) {
  const input = event.target;
  const key = input.dataset && input.dataset.key;
  if (!key) return;
  let value;
  if (input.type === 'checkbox') value = input.checked;
  else if (input.tagName === 'TEXTAREA') {
    value = input.value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } else value = Number(input.value);

  // 'debugger' cannot be an optional permission, so it is declared up front; the cost of
  // using it is the visible debugging banner, which is worth one confirmation.
  if (key === 'useDebugger' && value) {
    if (!confirm('Chrome will show a "being debugged" banner on the recorded tab. Enable anyway?')) {
      input.checked = false;
      return;
    }
  }

  // Recording that starts by itself deserves one explicit confirmation, since from then on it
  // happens without anyone pressing anything.
  if (key === 'autoRecord' && value) {
    const patterns = (status.settings.autoRecordPatterns || []).join(', ') || 'nothing yet';
    if (!confirm(`Recording will start by itself on URLs matching: ${patterns}. Continue?`)) {
      input.checked = false;
      return;
    }
  }

  try {
    status.settings = await send({ type: 'settings:set', settings: { [key]: value } });
    showError(null);
  } catch (err) {
    showError(err);
  }
}

async function renderSessions() {
  let sessions = [];
  try {
    sessions = await send({ type: 'sessions:list' });
  } catch (err) {
    showError(err);
    return;
  }
  const list = el('sessionList');
  list.textContent = '';
  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No sessions recorded yet';
    list.append(empty);
    return;
  }
  for (const session of sessions.slice(0, 40)) {
    const row = document.createElement('div');
    row.className = 'session';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${session.site || hostOf(session.url) || 'session'} - ${new Date(session.startedAt).toLocaleString()}`;
    const sub = document.createElement('div');
    sub.className = 'sub';
    const duration = session.endedAt ? Math.round((session.endedAt - session.startedAt) / 1000) : null;
    const eventCount = Object.values(session.counts || {}).reduce((a, b) => a + b, 0);
    sub.textContent = [
      duration != null ? `${duration}s` : 'running',
      `${eventCount} events`,
      formatBytes(session.bytes || 0)
    ].join(' · ');
    meta.append(name, sub);

    const open = document.createElement('button');
    open.textContent = 'Open';
    open.addEventListener('click', async () => {
      await send({ type: 'openViewer', sessionId: session.id });
      window.close();
    });

    const remove = document.createElement('button');
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete session ${session.id}?`)) return;
      await send({ type: 'session:delete', sessionId: session.id });
      await refresh();
    });

    row.append(meta, open, remove);
    list.append(row);
  }
}

el('toggle').addEventListener('click', async () => {
  try {
    if (status && status.recording) await send({ type: 'stop' });
    else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await send({ type: 'start', tabId: tab && tab.id });
    }
    await refresh();
  } catch (err) {
    showError(err);
  }
});

el('mark').addEventListener('click', async () => {
  const label = prompt('Marker label', 'note');
  if (label == null) return;
  try {
    await send({ type: 'mark', label });
    await refresh();
  } catch (err) {
    showError(err);
  }
});

el('shot').addEventListener('click', async () => {
  try {
    await send({ type: 'screenshot', reason: 'manual' });
    await refresh();
  } catch (err) {
    showError(err);
  }
});

el('openViewer').addEventListener('click', async () => {
  await send({ type: 'openViewer' });
  window.close();
});

/**
 * Reads what the page's framework is holding. Useful on its own for working out how a page
 * is built, and recorded as an event when a session is running, because the rendered HTML
 * often is not where the page keeps what it knows.
 */
el('probeRun').addEventListener('click', async () => {
  const out = el('probeResult');
  const selector = el('probeSelector').value.trim();
  out.textContent = 'reading...';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await send({
      type: 'probeState',
      tabId: tab && tab.id,
      options: selector ? { selectors: [selector] } : {}
    });
    if (!result || result.error) {
      out.textContent = (result && result.error) || 'no answer';
      return;
    }
    const lines = [];
    for (const entry of result.found || []) {
      const kinds = ['react', 'vue', 'svelte', 'angular'].filter((k) => entry[k]);
      lines.push(`${entry.selector} (${entry.tag}): ${kinds.join(', ') || 'nothing'}`);
      const frames = entry.react || [];
      for (const frame of frames.slice(0, 3)) {
        lines.push(`  ${frame.component || 'component'}: ${Object.keys(frame.props || {}).slice(0, 8).join(', ')}`);
      }
    }
    out.textContent = lines.join('\n') || 'nothing found';
    if (status && status.recording) out.textContent += '\n(recorded in this session)';
  } catch (err) {
    out.textContent = String(err.message || err);
  }
});

document.getElementById('settings').addEventListener('change', onSettingChange);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && ['status-changed', 'probe:update'].includes(msg.type)) void refresh();
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab && tab.id;
  el('tabInfo').textContent = tab ? hostOf(tab.url) || tab.url || '' : 'no tab';
  await refresh();
})();
