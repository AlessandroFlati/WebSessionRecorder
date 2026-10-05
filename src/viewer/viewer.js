import { formatBytes } from '../common/constants.js';
import * as db from '../common/db.js';

const el = (id) => document.getElementById(id);

/** The host of a session's URL, for labelling it in the list and the title. */
const hostLabel = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'session';
  }
};

const CATEGORY_COLORS = {
  input: '#0a66c2',
  dom: '#2e7d32',
  net: '#ef6c00',
  cdp: '#ff8f00',
  console: '#8e24aa',
  page: '#00838f',
  storage: '#6d4c41',
  resource: '#546e7a',
  perf: '#90a4ae',
  screenshot: '#d81b60',
  session: '#000000',
  user: '#c62828',
  recorder: '#9e9e9e',
  debugger: '#795548'
};

const state = {
  sessions: [],
  session: null,
  events: [],
  filtered: [],
  assets: new Map(),
  selected: null,
  rowHeight: 22,
  filter: { text: '', type: '', prefixes: null, onlyAssets: false }
};

/* ------------------------------------------------------------------- loading */

async function init() {
  state.sessions = await db.listSessions();
  const select = el('sessionSelect');
  select.textContent = '';
  for (const session of state.sessions) {
    const option = document.createElement('option');
    option.value = session.id;
    const when = new Date(session.startedAt).toLocaleString();
    option.textContent = `${session.site || hostLabel(session.url)} · ${when}`;
    select.append(option);
  }
  const requested = new URLSearchParams(location.search).get('session');
  const initial = requested && state.sessions.some((s) => s.id === requested) ? requested : state.sessions[0] && state.sessions[0].id;
  if (!initial) {
    el('sessionMeta').textContent = 'no sessions recorded';
    return;
  }
  select.value = initial;
  await loadSession(initial);
}

async function loadSession(id) {
  state.session = state.sessions.find((s) => s.id === id) || (await db.getSession(id));
  state.events = [];
  state.selected = null;
  el('detail').innerHTML = '<div class="empty">Select an event</div>';

  let after = -1;
  for (;;) {
    const page = await db.readEvents(id, after, 5000);
    if (!page.length) break;
    for (const ev of page) {
      ev.blob = searchBlob(ev);
      state.events.push(ev);
    }
    after = page[page.length - 1].seq;
    if (state.events.length >= 500000) break;
  }

  const assets = await db.listAssets(id);
  state.assets = new Map(assets.map((a) => [a.id, a]));

  renderSessionMeta();
  renderTypeFilter();
  applyFilter();
  drawTimeline();
}

function searchBlob(ev) {
  let json = '';
  try {
    json = JSON.stringify(ev.data);
  } catch {
    json = '';
  }
  return (ev.type + ' ' + (json || '')).slice(0, 4000).toLowerCase();
}

function renderSessionMeta() {
  const s = state.session;
  if (!s) return;
  const duration = s.endedAt ? Math.round((s.endedAt - s.startedAt) / 1000) : null;
  el('sessionMeta').textContent = [
    s.id,
    s.site || hostLabel(s.url),
    duration != null ? `${duration}s` : 'unfinished',
    `${state.events.length} events`,
    `${state.assets.size} assets`,
    formatBytes(s.bytes || 0)
  ].join(' · ');
  document.title = `${s.site || hostLabel(s.url) || 'session'} · ${new Date(s.startedAt).toLocaleString()}`;
}

function renderTypeFilter() {
  const counts = new Map();
  for (const ev of state.events) counts.set(ev.type, (counts.get(ev.type) || 0) + 1);
  const select = el('typeFilter');
  select.size = 1;
  select.multiple = false;
  select.textContent = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = `all types (${state.events.length})`;
  select.append(all);
  for (const [type, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = `${type} (${count})`;
    select.append(option);
  }
  select.value = state.filter.type;
}

/* ------------------------------------------------------------------ filtering */

function applyFilter() {
  const { text, type, prefixes, onlyAssets } = state.filter;
  state.filtered = state.events.filter((ev) => {
    if (type && ev.type !== type) return false;
    if (prefixes && !prefixes.some((p) => ev.type.startsWith(p))) return false;
    if (onlyAssets && !ev.assetRefs) return false;
    if (text && !ev.blob.includes(text)) return false;
    return true;
  });
  el('counter').textContent = `${state.filtered.length} / ${state.events.length} events`;
  renderRows(true);
}

/* -------------------------------------------------------------- virtual list */

function renderRows(resetScroll) {
  const scroller = el('listScroller');
  const spacer = el('spacer');
  spacer.style.height = `${state.filtered.length * state.rowHeight}px`;
  if (resetScroll) scroller.scrollTop = 0;
  paintWindow();
}

function paintWindow() {
  const scroller = el('listScroller');
  const rows = el('rows');
  const start = Math.max(0, Math.floor(scroller.scrollTop / state.rowHeight) - 10);
  const visible = Math.ceil(scroller.clientHeight / state.rowHeight) + 20;
  const slice = state.filtered.slice(start, start + visible);
  rows.style.transform = `translateY(${start * state.rowHeight}px)`;
  rows.textContent = '';
  for (const ev of slice) rows.append(rowElement(ev));
}

function rowElement(ev) {
  const row = document.createElement('div');
  row.className = 'event';
  if (state.selected && state.selected.seq === ev.seq) row.classList.add('selected');
  row.style.borderLeft = `3px solid ${categoryColor(ev.type)}`;

  const t = document.createElement('span');
  t.className = 't';
  t.textContent = formatTime(ev.t);

  const seq = document.createElement('span');
  seq.className = 'seq';
  seq.textContent = `#${ev.seq}`;

  const type = document.createElement('span');
  type.className = 'type';
  type.textContent = ev.type;

  const summary = document.createElement('span');
  summary.className = 'summary';
  summary.textContent = summarize(ev);

  row.append(t, seq, type, summary);
  if (ev.assetRefs) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '@';
    row.append(badge);
  }
  row.addEventListener('click', () => select(ev));
  return row;
}

function formatTime(ms) {
  const total = Math.max(0, ms || 0);
  const s = Math.floor(total / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}.${String(total % 1000).padStart(3, '0')}`;
}

function categoryColor(type) {
  return CATEGORY_COLORS[String(type).split('.')[0]] || '#9e9e9e';
}

function summarize(ev) {
  const d = ev.data || {};
  const type = ev.type;
  if (type.startsWith('input.')) {
    const target = d.target || {};
    const where = d.x != null ? `(${d.x},${d.y})` : '';
    const inTarget = d.inTarget ? ` f=${d.inTarget.fx},${d.inTarget.fy}` : '';
    return [where, d.key ? `key=${d.key}` : '', target.css || d.targetPath || '', inTarget].filter(Boolean).join(' ');
  }
  if (type === 'dom.mutations') return `${d.count} records`;
  if (type === 'dom.mutations.dropped') return `${d.count} dropped`;
  if (type === 'dom.snapshot') return `${d.reason} ${formatBytes(d.length)} ${d.url || ''}`;
  if (type === 'dom.styles') return `${d.count} cells under ${d.rootSelector}`;
  if (type === 'dom.styleChange') return `${(d.cells || []).length} cells`;
  if (type.startsWith('net.')) {
    const status = d.status != null ? ` -> ${d.status}` : '';
    return `${d.method || d.direction || ''} ${d.url || ''}${status}`.trim();
  }
  if (type.startsWith('cdp.net.')) return `${d.method || ''} ${d.url || ''} ${d.status || ''}`.trim();
  if (type.startsWith('console.')) {
    try {
      return (d.args || []).map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 300);
    } catch {
      return '';
    }
  }
  if (type === 'resource.source') return `${formatBytes(d.size)} ${d.url}`;
  if (type === 'page.codeBlock') return `${d.looksJson ? 'json' : 'text'} ${formatBytes(d.length)} ${d.id || ''}`;
  if (type === 'page.inlineScript') return `${formatBytes(d.length)} ${d.id || d.path || ''}`;
  if (type === 'page.globals') return `${d.newKeyCount} new keys`;
  if (type === 'storage.snapshot') return `${d.store} ${d.keys} keys`;
  if (type === 'storage.idb.dump') return `${d.database}/${d.store} ${d.count} records`;
  if (type === 'user.mark') return d.label;
  if (type === 'screenshot') return `${d.reason} ${formatBytes(d.size)}`;
  try {
    return JSON.stringify(d).slice(0, 300);
  } catch {
    return '';
  }
}

/* ----------------------------------------------------------------- detail pane */

function select(ev) {
  state.selected = ev;
  paintWindow();
  renderDetail(ev);
}

function renderDetail(ev) {
  const detail = el('detail');
  detail.textContent = '';

  const title = document.createElement('h3');
  title.textContent = `#${ev.seq} ${ev.type} @ ${formatTime(ev.t)}`;
  detail.append(title);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = [
    new Date(ev.wall).toLocaleTimeString(),
    `source=${ev.source}`,
    `frame=${ev.frameId}`,
    ev.frameUrl || ''
  ].join(' · ');
  detail.append(meta);

  if (ev.assetRefs) {
    const wrap = document.createElement('div');
    wrap.className = 'assets';
    for (const [name, id] of Object.entries(ev.assetRefs)) wrap.append(assetElement(name, id));
    detail.append(wrap);
  }

  if (ev.type === 'dom.styles' || ev.type === 'dom.styleChange') detail.append(styleTable(ev));

  const pre = document.createElement('pre');
  try {
    pre.textContent = JSON.stringify(ev.data, null, 2);
  } catch {
    pre.textContent = String(ev.data);
  }
  detail.append(pre);
}

function styleTable(ev) {
  const cells = (ev.data && ev.data.cells) || [];
  const wrap = document.createElement('div');
  const pre = document.createElement('pre');
  const lines = cells.slice(0, 400).map((cell) => {
    const style = cell.style || {};
    return `${(cell.path || '').padEnd(18)} bg=${style['background-color'] || '-'} text="${(cell.text || '').slice(0, 12)}" ${cell.css || ''}`;
  });
  pre.textContent = lines.join('\n');
  const head = document.createElement('div');
  head.className = 'meta';
  head.textContent = `${cells.length} cells (background-color first)`;
  wrap.append(head, colorStrip(cells), pre);
  return wrap;
}

function colorStrip(cells) {
  const strip = document.createElement('div');
  for (const cell of cells.slice(0, 400)) {
    const dot = document.createElement('span');
    dot.className = 'swatch';
    dot.style.background = (cell.style && cell.style['background-color']) || 'transparent';
    dot.title = `${cell.path} ${(cell.style && cell.style['background-color']) || ''}`;
    strip.append(dot);
  }
  return strip;
}

function assetElement(name, id) {
  const info = state.assets.get(id) || { id, kind: name, contentType: '?', size: 0 };
  const box = document.createElement('div');
  box.className = 'asset';

  const head = document.createElement('div');
  head.className = 'head';
  const label = document.createElement('strong');
  label.textContent = `${name} · ${info.kind}`;
  const size = document.createElement('span');
  size.className = 'meta';
  size.textContent = `${info.contentType} · ${formatBytes(info.size)}`;

  const view = document.createElement('button');
  view.textContent = 'View';
  const download = document.createElement('button');
  download.textContent = 'Download';

  head.append(label, size, view, download);
  box.append(head);

  const body = document.createElement('div');
  box.append(body);

  view.addEventListener('click', async () => {
    const asset = await db.getAsset(id);
    if (!asset) return;
    body.textContent = '';
    if (typeof asset.data !== 'string') {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(asset.data);
      body.append(img);
      return;
    }
    const pre = document.createElement('pre');
    let text = asset.data;
    if (/json/.test(asset.contentType)) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* keep raw */
      }
    }
    pre.textContent = text.length > 400000 ? text.slice(0, 400000) + '\n[...truncated for display]' : text;
    body.append(pre);
  });

  download.addEventListener('click', async () => {
    const asset = await db.getAsset(id);
    if (!asset) return;
    const blob = typeof asset.data === 'string' ? new Blob([asset.data], { type: asset.contentType }) : asset.data;
    saveBlob(blob, `${state.session.id}_${id}_${asset.kind}${extensionFor(asset.contentType)}`);
  });

  return box;
}

function extensionFor(contentType) {
  if (/html/.test(contentType)) return '.html';
  if (/json/.test(contentType)) return '.json';
  if (/javascript/.test(contentType)) return '.js';
  if (/css/.test(contentType)) return '.css';
  if (/jpeg/.test(contentType)) return '.jpg';
  if (/png/.test(contentType)) return '.png';
  return '.txt';
}

/* -------------------------------------------------------------------- timeline */

function drawTimeline() {
  const canvas = el('timeline');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(300, Math.floor(rect.width * dpr));
  canvas.height = Math.floor(54 * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const width = canvas.width / dpr;
  const height = 54;
  ctx.clearRect(0, 0, width, height);

  if (!state.events.length) return;
  const last = state.events[state.events.length - 1].t || 1;
  const categories = [...new Set(state.events.map((ev) => String(ev.type).split('.')[0]))];
  const laneHeight = Math.max(3, Math.floor(height / Math.max(1, categories.length)));

  for (const ev of state.events) {
    const category = String(ev.type).split('.')[0];
    const lane = categories.indexOf(category);
    const x = ((ev.t || 0) / last) * (width - 2);
    ctx.fillStyle = categoryColor(ev.type);
    ctx.fillRect(x, lane * laneHeight, 1.5, Math.max(2, laneHeight - 1));
  }

  const legend = el('legend');
  legend.textContent = '';
  for (const category of categories) {
    const item = document.createElement('span');
    const dot = document.createElement('i');
    dot.style.background = CATEGORY_COLORS[category] || '#9e9e9e';
    item.append(dot, document.createTextNode(category));
    legend.append(item);
  }

  canvas.onclick = (event) => {
    const bounds = canvas.getBoundingClientRect();
    const ratio = (event.clientX - bounds.left) / bounds.width;
    const targetTime = ratio * last;
    let best = null;
    let bestDelta = Infinity;
    for (let i = 0; i < state.filtered.length; i++) {
      const delta = Math.abs((state.filtered[i].t || 0) - targetTime);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    }
    if (best == null) return;
    el('listScroller').scrollTop = Math.max(0, best * state.rowHeight - 100);
    paintWindow();
    select(state.filtered[best]);
  };
}

/* ---------------------------------------------------------------------- export */

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function exportEvents() {
  const parts = [];
  parts.push(JSON.stringify({ __meta: 'web-session-recorder', session: state.session }) + '\n');
  for (const ev of state.events) {
    const copy = { ...ev };
    delete copy.blob;
    parts.push(JSON.stringify(copy) + '\n');
  }
  saveBlob(new Blob(parts, { type: 'application/x-ndjson' }), `${state.session.id}.ndjson`);
}

async function exportBundle() {
  const assetBytes = [...state.assets.values()].reduce((sum, a) => sum + (a.size || 0), 0);
  if (assetBytes > 50 * 1024 * 1024) {
    if (!confirm(`This bundle embeds ${formatBytes(assetBytes)} of assets. Continue?`)) return;
  }
  const button = el('exportBundle');
  const original = button.textContent;
  button.disabled = true;

  const parts = ['{\n"session":', JSON.stringify(state.session), ',\n"events":[\n'];
  state.events.forEach((ev, index) => {
    const copy = { ...ev };
    delete copy.blob;
    parts.push((index ? ',\n' : '') + JSON.stringify(copy));
  });
  parts.push('\n],\n"assets":[\n');

  let index = 0;
  let firstAsset = true;
  for (const id of state.assets.keys()) {
    button.textContent = `Exporting ${++index}/${state.assets.size}`;
    const asset = await db.getAsset(id);
    if (!asset) continue;
    const record = {
      id: asset.id,
      seq: asset.seq,
      kind: asset.kind,
      contentType: asset.contentType,
      size: asset.size
    };
    if (typeof asset.data === 'string') {
      record.encoding = 'utf8';
      record.data = asset.data;
    } else {
      record.encoding = 'base64';
      record.data = await blobToBase64(asset.data);
    }
    parts.push((firstAsset ? '' : ',\n') + JSON.stringify(record));
    firstAsset = false;
  }
  parts.push('\n]\n}\n');

  saveBlob(new Blob(parts, { type: 'application/json' }), `${state.session.id}.bundle.json`);
  button.textContent = original;
  button.disabled = false;
}

async function blobToBase64(blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ------------------------------------------------------------------- listeners */

el('listScroller').addEventListener('scroll', paintWindow, { passive: true });
window.addEventListener('resize', () => {
  paintWindow();
  drawTimeline();
});

el('sessionSelect').addEventListener('change', (e) => void loadSession(e.target.value));
el('reload').addEventListener('click', () => void init());

el('search').addEventListener('input', (e) => {
  state.filter.text = e.target.value.trim().toLowerCase();
  applyFilter();
});

el('typeFilter').addEventListener('change', (e) => {
  state.filter.type = e.target.value;
  state.filter.prefixes = null;
  setActivePreset(null);
  applyFilter();
});

el('onlyAssets').addEventListener('change', (e) => {
  state.filter.onlyAssets = e.target.checked;
  applyFilter();
});

function preset(id, prefixes) {
  el(id).addEventListener('click', () => {
    state.filter.prefixes = prefixes;
    state.filter.type = '';
    el('typeFilter').value = '';
    setActivePreset(prefixes ? id : null);
    applyFilter();
  });
}

function setActivePreset(id) {
  for (const button of ['presetMoves', 'presetNet', 'presetDom', 'presetAll']) {
    el(button).classList.toggle('active', button === id);
  }
}

preset('presetMoves', ['input.pointerdown', 'input.click', 'input.keydown', 'dom.styleChange', 'user.mark', 'screenshot']);
preset('presetNet', ['net.', 'cdp.net', 'perf.', 'resource.']);
preset('presetDom', ['dom.', 'page.']);
preset('presetAll', null);

el('exportEvents').addEventListener('click', exportEvents);
el('exportBundle').addEventListener('click', () => void exportBundle());
el('deleteSession').addEventListener('click', async () => {
  if (!state.session) return;
  if (!confirm(`Delete session ${state.session.id}?`)) return;
  await db.deleteSession(state.session.id);
  await init();
});

void init();
