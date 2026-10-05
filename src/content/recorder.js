/**
 * Isolated-world recorder: DOM, computed styles, input, page resources and storage.
 *
 * Runs in every frame at document_start and stays inert until the background tells it to
 * record, so a page that is not being recorded pays for nothing but the file being parsed.
 *
 * It never mutates the page. Node identity is a child-index path rather than an injected
 * attribute or id, and nothing is added to the DOM, so a page behaves exactly as it would
 * without the extension - which matters both for fidelity and because a page is entitled not
 * to be altered by something watching it.
 */
(() => {
  'use strict';

  // A previous instance may still be here after an extension reload, where its chrome.*
  // APIs are dead but its listeners keep running. Always replace it rather than bailing
  // out on a boolean guard, otherwise an orphaned instance blocks the live one forever.
  const previous = window.__WSR_RECORDER__;
  if (previous && typeof previous.dispose === 'function') {
    try {
      previous.dispose('replaced');
    } catch {
      /* orphaned instance may throw on teardown */
    }
  }

  let disposed = false;

  const PORT_NAME = 'web-session-recorder';
  const PAGE_CHANNEL = '__WSR_PAGE_MSG__';
  const FLUSH_MS = 250;
  const FLUSH_AT = 120;
  const MAX_BUFFERED_EVENTS = 20000;
  const MAX_HTML_BYTES = 12 * 1024 * 1024;
  const MAX_NODE_HTML = 32 * 1024;
  const MAX_MUTATIONS_PER_BATCH = 300;
  const MAX_CELLS = 600;
  const MAX_TEXT = 120;
  const HEARTBEAT_MS = 15000;

  const STYLE_KEYS = [
    'display', 'visibility', 'opacity', 'position',
    'background-color', 'background-image', 'color',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'border-top-width', 'border-top-style', 'border-radius',
    'box-shadow', 'outline-color', 'font-size', 'font-weight', 'text-align',
    'width', 'height', 'transform', 'clip-path', 'fill', 'stroke', 'cursor', 'pointer-events'
  ];

  const PSEUDO_KEYS = ['content', 'background-color', 'background-image', 'color', 'transform', 'display'];

  /**
   * The region the per-element capture concentrates on. Recording computed styles for every
   * node on a page is far too much data, so the capture is anchored to the largest plausible
   * application region and the elements inside it.
   *
   * Both lists are only defaults: `settings.focusSelectors` and `settings.watchSelectors` are
   * prepended, so a page whose structure these miss can be followed without changing code.
   */
  const DEFAULT_FOCUS_SELECTORS = [
    '[role="application"]', '[role="grid"]', '[role="main"]', 'main',
    '[class*="board" i]', '[class*="grid" i]', '[class*="canvas" i]', '[class*="editor" i]',
    '[class*="app" i]', '#app', '#root'
  ];

  const DEFAULT_WATCH_SELECTORS = [
    '[role="gridcell"]', '[role="cell"]', '[role="button"]', '[role="checkbox"]',
    '[role="radio"]', '[role="option"]', '[role="tab"]', '[role="menuitem"]',
    '[data-cell-idx]', '[data-cell]', '[data-index]', '[data-id]', '[data-testid]',
    '[class*="cell" i]', '[class*="tile" i]', '[class*="square" i]', '[class*="node" i]',
    'td', 'th', 'li', 'button', 'a[href]', 'input', 'select', 'textarea', 'summary',
    'svg rect', 'svg circle', 'svg path'
  ];

  const focusSelectors = () => [...(settings && settings.focusSelectors ? settings.focusSelectors : []), ...DEFAULT_FOCUS_SELECTORS];
  const watchSelector = () =>
    [...(settings && settings.watchSelectors ? settings.watchSelectors : []), ...DEFAULT_WATCH_SELECTORS].join(', ');

  const SENSITIVE_KEY_RE = /(token|auth|session|jwt|password|secret|cookie|bearer|credential|li_at)/i;

  let port = null;
  let reconnectTimer = null;
  let recording = false;
  let sessionId = null;
  let settings = null;

  let buffer = [];
  let flushTimer = null;
  let droppedEvents = 0;

  let observer = null;
  let intervals = [];
  let listeners = [];
  let heartbeatTimer = null;
  let bridgeHandler = null;

  let lastHref = location.href;
  let lastPointerEmit = 0;
  let lastPointerTargetPath = null;
  let lastScrollEmit = 0;
  let mutationWindowStart = 0;
  let mutationWindowCount = 0;
  let mutationsDropped = 0;
  let styleRecaptureBudget = 0;
  let styleWindowStart = 0;
  let perfIndex = 0;
  let lastSnapshotHash = null;
  let afterClickTimer = null;
  const seenInlineHashes = new Set();
  const seenCodeHashes = new Set();
  const sentResourceUrls = new Set();

  /* ------------------------------------------------------------------ transport */

  function contextAlive() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function connect() {
    if (port || disposed) return;
    if (!contextAlive()) {
      teardown('context-invalidated');
      return;
    }
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      scheduleReconnect();
      return;
    }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      if (recording) stopCapture('port-disconnected');
      scheduleReconnect();
    });
    try {
      port.postMessage({ type: 'hello', href: location.href, top: window.top === window });
    } catch {
      port = null;
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer || disposed) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (contextAlive()) connect();
      else teardown('context-invalidated');
    }, 1500);
  }

  function onPortMessage(msg) {
    if (!msg) return;
    // A state probe can be asked for at any time, recording or not: it reads what the page's
    // framework is holding and is the one thing the isolated world cannot do for itself.
    if (msg.type === 'probeState') {
      requestPageState(msg.options || {});
      return;
    }
    if (msg.type !== 'state') return;
    settings = msg.settings;
    sessionId = msg.sessionId;
    if (msg.recording && !recording) startCapture();
    else if (!msg.recording && recording) stopCapture('stopped');
    else if (recording) configurePageHooks();
  }

  function emit(type, data, assets) {
    if (!recording) return;
    if (buffer.length >= MAX_BUFFERED_EVENTS) {
      droppedEvents++;
      return;
    }
    const ev = { wall: Date.now(), pt: Math.round(performance.now() * 100) / 100, type, data };
    if (assets) ev.assets = assets;
    buffer.push(ev);
    if (assets || buffer.length >= FLUSH_AT) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!buffer.length || !port) return;
    if (droppedEvents) {
      buffer.unshift({ wall: Date.now(), pt: 0, type: 'recorder.dropped', data: { events: droppedEvents } });
      droppedEvents = 0;
    }
    const pending = buffer;
    buffer = [];
    let batch = [];
    const send = () => {
      if (!batch.length) return;
      try {
        port.postMessage({ type: 'events', sessionId, events: batch });
      } catch {
        port = null;
        scheduleReconnect();
      }
      batch = [];
    };
    for (const ev of pending) {
      if (ev.assets) {
        send();
        batch = [ev];
        send();
      } else {
        batch.push(ev);
        if (batch.length >= 60) send();
      }
    }
    send();
  }

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push([target, type, handler, options]);
  }

  function every(ms, fn) {
    if (!ms) return;
    intervals.push(setInterval(fn, ms));
  }

  /* --------------------------------------------------------------- descriptors */

  function nodePath(node) {
    if (!node) return null;
    const root = document.documentElement;
    if (node === root) return '';
    const parts = [];
    let n = node;
    let guard = 0;
    while (n && n !== root && guard++ < 200) {
      const parent = n.parentNode;
      if (!parent) return null;
      parts.unshift(Array.prototype.indexOf.call(parent.childNodes, n));
      n = parent;
    }
    return n === root ? parts.join('/') : null;
  }

  function cssPath(el, depth = 4) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < depth) {
      let part = n.tagName.toLowerCase();
      if (n.id) part += '#' + n.id;
      const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).slice(0, 3) : [];
      if (cls.length && cls[0]) part += '.' + cls.join('.');
      parts.unshift(part);
      n = n.parentElement;
    }
    return parts.join(' > ');
  }

  function ownAttributes(el) {
    const out = {};
    if (!el.attributes) return out;
    for (const attr of el.attributes) {
      if (attr.name === 'style' && attr.value.length > 512) {
        out[attr.name] = attr.value.slice(0, 512);
        continue;
      }
      out[attr.name] = attr.value.length > 512 ? attr.value.slice(0, 512) : attr.value;
    }
    return out;
  }

  function describeElement(el, withRect) {
    if (!el || el.nodeType !== 1) {
      if (el && el.nodeType === 3) {
        return { path: nodePath(el), tag: '#text', text: (el.nodeValue || '').slice(0, MAX_TEXT) };
      }
      return null;
    }
    const out = {
      path: nodePath(el),
      css: cssPath(el),
      tag: el.tagName.toLowerCase(),
      attrs: ownAttributes(el),
      text: (el.textContent || '').trim().slice(0, MAX_TEXT)
    };
    if (withRect) {
      const r = el.getBoundingClientRect();
      out.rect = { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
    }
    return out;
  }

  function round(n) {
    return Math.round(n * 10) / 10;
  }

  function styleOf(el) {
    const cs = getComputedStyle(el);
    const out = {};
    for (const key of STYLE_KEYS) {
      const value = cs.getPropertyValue(key);
      if (value) out[key] = value;
    }
    return out;
  }

  function pseudoStyleOf(el, pseudo) {
    try {
      const cs = getComputedStyle(el, pseudo);
      const content = cs.getPropertyValue('content');
      if (!content || content === 'none') return null;
      const out = {};
      for (const key of PSEUDO_KEYS) {
        const value = cs.getPropertyValue(key);
        if (value) out[key] = value;
      }
      return out;
    } catch {
      return null;
    }
  }

  /** The biggest plausible application region, which the element capture is anchored to. */
  function findFocusRoot() {
    for (const selector of focusSelectors()) {
      try {
        const el = document.querySelector(selector);
        if (el && el.getBoundingClientRect().width > 100) return { el, selector };
      } catch {
        /* invalid selector on this engine */
      }
    }
    return { el: document.body, selector: 'body' };
  }

  /* ------------------------------------------------------------------ snapshots */

  function captureDomSnapshot(reason) {
    if (!settings.dom || !document.documentElement) return;
    let html = '';
    try {
      html = document.documentElement.outerHTML;
    } catch {
      return;
    }
    const hash = hashString(html);
    if (hash === lastSnapshotHash) {
      emit('dom.snapshot.unchanged', { reason, hash });
      return;
    }
    lastSnapshotHash = hash;
    emit(
      'dom.snapshot',
      {
        reason,
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        length: html.length,
        hash,
        truncated: html.length > MAX_HTML_BYTES,
        viewport: {
          w: window.innerWidth,
          h: window.innerHeight,
          dpr: window.devicePixelRatio,
          scrollX: window.scrollX,
          scrollY: window.scrollY
        }
      },
      { html: { kind: 'dom-snapshot', contentType: 'text/html', data: html.slice(0, MAX_HTML_BYTES) } }
    );
  }

  function captureStyles(reason) {
    if (!settings.styles || !document.body) return;
    const { el: root, selector } = findFocusRoot();
    if (!root) return;
    let cells = [];
    try {
      cells = Array.prototype.slice.call(root.querySelectorAll(watchSelector()), 0, MAX_CELLS);
    } catch {
      return;
    }
    const items = cells.map((el) => {
      const r = el.getBoundingClientRect();
      const item = {
        path: nodePath(el),
        css: cssPath(el, 2),
        attrs: ownAttributes(el),
        text: (el.textContent || '').trim().slice(0, 40),
        rect: { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) },
        style: styleOf(el)
      };
      const before = pseudoStyleOf(el, '::before');
      const after = pseudoStyleOf(el, '::after');
      if (before) item.before = before;
      if (after) item.after = after;
      return item;
    });
    emit('dom.styles', {
      reason,
      rootSelector: selector,
      root: describeElement(root, true),
      rootStyle: styleOf(root),
      count: items.length,
      truncated: items.length >= MAX_CELLS,
      cells: items
    });
  }

  function captureResources() {
    if (!settings.scripts) return;
    const external = [];
    const scripts = [];
    for (const s of document.querySelectorAll('script')) {
      const entry = {
        path: nodePath(s),
        src: s.src || null,
        type: s.getAttribute('type') || null,
        async: s.async,
        defer: s.defer,
        id: s.id || null
      };
      if (s.src) {
        entry.kind = 'script';
        if (!sentResourceUrls.has(s.src)) {
          sentResourceUrls.add(s.src);
          external.push({ url: s.src, kind: 'script' });
        }
      } else {
        const text = s.textContent || '';
        entry.inlineLength = text.length;
        const hash = hashString(text);
        entry.hash = hash;
        if (text.length && !seenInlineHashes.has(hash)) {
          seenInlineHashes.add(hash);
          emit(
            'page.inlineScript',
            { path: entry.path, id: entry.id, type: entry.type, length: text.length, hash },
            { source: { kind: 'inline-script', contentType: 'application/javascript', data: text.slice(0, 4 * 1024 * 1024) } }
          );
        }
      }
      scripts.push(entry);
    }

    const styles = [];
    for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) {
      styles.push({ href: link.href, media: link.media || null });
      if (link.href && !sentResourceUrls.has(link.href)) {
        sentResourceUrls.add(link.href);
        external.push({ url: link.href, kind: 'stylesheet' });
      }
    }

    emit('page.resources', { scripts, styles, externalQueued: external.length });

    if (external.length && port) {
      try {
        port.postMessage({ type: 'resources', items: external });
      } catch {
        /* dropped */
      }
    }

    captureInlineStyleSheets();
  }

  function captureInlineStyleSheets() {
    for (const styleEl of document.querySelectorAll('style')) {
      const text = styleEl.textContent || '';
      if (!text) continue;
      const hash = hashString(text);
      if (seenInlineHashes.has(hash)) continue;
      seenInlineHashes.add(hash);
      emit(
        'page.inlineStyle',
        { path: nodePath(styleEl), length: text.length, hash },
        { source: { kind: 'inline-style', contentType: 'text/css', data: text.slice(0, 2 * 1024 * 1024) } }
      );
    }
  }

  function captureCodeBlocks() {
    if (!settings.codeBlocks) return;
    for (const code of document.querySelectorAll('code')) {
      const text = code.textContent || '';
      if (text.length < 2) continue;
      const hash = hashString(text);
      if (seenCodeHashes.has(hash)) continue;
      seenCodeHashes.add(hash);
      let looksJson = false;
      const trimmed = text.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) looksJson = true;
      emit(
        'page.codeBlock',
        { path: nodePath(code), id: code.id || null, attrs: ownAttributes(code), length: text.length, looksJson, hash },
        { source: { kind: 'code-block', contentType: looksJson ? 'application/json' : 'text/plain', data: text.slice(0, 4 * 1024 * 1024) } }
      );
    }
  }

  function capturePerformanceEntries() {
    let entries;
    try {
      entries = performance.getEntriesByType('resource');
    } catch {
      return;
    }
    if (entries.length <= perfIndex) return;
    const slice = entries.slice(perfIndex, perfIndex + 400);
    perfIndex += slice.length;
    emit('perf.resources', {
      entries: slice.map((e) => ({
        name: e.name,
        initiatorType: e.initiatorType,
        startTime: round(e.startTime),
        duration: round(e.duration),
        transferSize: e.transferSize,
        encodedBodySize: e.encodedBodySize,
        decodedBodySize: e.decodedBodySize
      }))
    });
  }

  function captureWebStorage() {
    if (!settings.storage) return;
    for (const [name, store] of [['localStorage', safeStorage('localStorage')], ['sessionStorage', safeStorage('sessionStorage')]]) {
      if (!store) continue;
      const items = {};
      try {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (key == null) continue;
          let value = store.getItem(key) || '';
          if (settings.redact && SENSITIVE_KEY_RE.test(key)) value = '[redacted:' + value.length + ']';
          items[key] = value.length > 65536 ? value.slice(0, 65536) + '[...+' + (value.length - 65536) + ']' : value;
        }
      } catch {
        /* storage blocked */
      }
      emit('storage.snapshot', { store: name, keys: Object.keys(items).length, items });
    }
  }

  function safeStorage(name) {
    try {
      return window[name];
    } catch {
      return null;
    }
  }

  async function captureIndexedDb() {
    if (!settings.indexedDbDump || !indexedDB.databases) return;
    let dbs = [];
    try {
      dbs = await indexedDB.databases();
    } catch {
      return;
    }
    emit('storage.idb.list', { databases: dbs.map((d) => ({ name: d.name, version: d.version })) });
    for (const info of dbs) {
      if (!info.name) continue;
      try {
        const db = await openIdb(info.name);
        const stores = Array.prototype.slice.call(db.objectStoreNames);
        for (const storeName of stores) {
          try {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const values = await idbRequest(store.getAll(undefined, 200));
            const keys = await idbRequest(store.getAllKeys(undefined, 200));
            emit('storage.idb.dump', {
              database: info.name,
              store: storeName,
              keyPath: store.keyPath,
              autoIncrement: store.autoIncrement,
              indexes: Array.prototype.slice.call(store.indexNames),
              count: values.length,
              keys: safeJson(keys),
              values: safeJson(values)
            });
          } catch (err) {
            emit('storage.idb.error', { database: info.name, store: storeName, error: String(err) });
          }
        }
        db.close();
      } catch (err) {
        emit('storage.idb.error', { database: info.name, error: String(err) });
      }
    }
  }

  function openIdb(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    });
  }

  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function keyframe(reason) {
    captureDomSnapshot(reason);
    captureStyles(reason);
    captureResources();
    captureCodeBlocks();
    capturePerformanceEntries();
    captureWebStorage();
    void captureIndexedDb();
    requestGlobals();
  }

  /* ------------------------------------------------------------------ mutations */

  function installMutationObserver() {
    if (!settings.mutations || !document.documentElement) return;
    observer = new MutationObserver((records) => {
      checkNavigation();
      const now = Date.now();
      if (now - mutationWindowStart > 1000) {
        if (mutationsDropped) {
          emit('dom.mutations.dropped', { count: mutationsDropped, windowMs: now - mutationWindowStart });
          mutationsDropped = 0;
        }
        mutationWindowStart = now;
        mutationWindowCount = 0;
      }
      const allowance = Math.max(0, (settings.mutationsPerSecond || 1500) - mutationWindowCount);
      if (allowance <= 0) {
        mutationsDropped += records.length;
        return;
      }
      const take = Math.min(records.length, allowance, MAX_MUTATIONS_PER_BATCH);
      if (records.length > take) mutationsDropped += records.length - take;
      mutationWindowCount += take;

      const out = [];
      const styleTargets = [];
      for (let i = 0; i < take; i++) {
        const rec = records[i];
        const entry = serializeMutation(rec);
        if (entry) out.push(entry);
        if (
          rec.type === 'attributes' &&
          (rec.attributeName === 'class' || rec.attributeName === 'style' || (rec.attributeName || '').startsWith('aria-')) &&
          rec.target.nodeType === 1
        ) {
          styleTargets.push(rec.target);
        }
      }
      if (out.length) emit('dom.mutations', { count: out.length, records: out });
      if (styleTargets.length) captureChangedStyles(styleTargets);
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true
    });
  }

  function serializeMutation(rec) {
    const target = rec.target;
    const base = {
      kind: rec.type,
      path: nodePath(target),
      tag: target.nodeType === 1 ? target.tagName.toLowerCase() : target.nodeName,
      css: target.nodeType === 1 ? cssPath(target, 3) : undefined
    };
    if (rec.type === 'attributes') {
      base.attr = rec.attributeName;
      base.old = rec.oldValue;
      base.value = target.nodeType === 1 ? target.getAttribute(rec.attributeName) : null;
      if (base.old === base.value) return null;
      return base;
    }
    if (rec.type === 'characterData') {
      base.old = (rec.oldValue || '').slice(0, MAX_TEXT);
      base.value = (target.nodeValue || '').slice(0, MAX_TEXT);
      if (base.old === base.value) return null;
      return base;
    }
    base.added = Array.prototype.slice.call(rec.addedNodes, 0, 20).map(serializeAddedNode);
    base.removed = Array.prototype.slice.call(rec.removedNodes, 0, 20).map(serializeRemovedNode);
    base.prev = rec.previousSibling ? nodePath(rec.previousSibling) : null;
    base.next = rec.nextSibling ? nodePath(rec.nextSibling) : null;
    if (!base.added.length && !base.removed.length) return null;
    return base;
  }

  function serializeAddedNode(node) {
    if (node.nodeType === 1) {
      let html = '';
      try {
        html = node.outerHTML || '';
      } catch {
        html = '';
      }
      return {
        type: 'element',
        path: nodePath(node),
        tag: node.tagName.toLowerCase(),
        html: html.length > MAX_NODE_HTML ? html.slice(0, MAX_NODE_HTML) + '<!--truncated-->' : html
      };
    }
    return { type: node.nodeType === 3 ? 'text' : 'node', path: nodePath(node), text: (node.nodeValue || '').slice(0, MAX_TEXT) };
  }

  function serializeRemovedNode(node) {
    if (node.nodeType === 1) {
      let html = '';
      try {
        html = node.outerHTML || '';
      } catch {
        html = '';
      }
      return {
        type: 'element',
        tag: node.tagName.toLowerCase(),
        html: html.length > MAX_NODE_HTML ? html.slice(0, MAX_NODE_HTML) + '<!--truncated-->' : html
      };
    }
    return { type: node.nodeType === 3 ? 'text' : 'node', text: (node.nodeValue || '').slice(0, MAX_TEXT) };
  }

  function captureChangedStyles(targets) {
    if (!settings.styles) return;
    const now = Date.now();
    if (now - styleWindowStart > 1000) {
      styleWindowStart = now;
      styleRecaptureBudget = 200;
    }
    if (styleRecaptureBudget <= 0) return;
    const unique = [];
    const seen = new Set();
    for (const el of targets) {
      if (!el.isConnected) continue;
      const path = nodePath(el);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      unique.push({ el, path });
      if (unique.length >= styleRecaptureBudget) break;
    }
    if (!unique.length) return;
    styleRecaptureBudget -= unique.length;
    emit('dom.styleChange', {
      cells: unique.map(({ el, path }) => {
        const r = el.getBoundingClientRect();
        const item = {
          path,
          css: cssPath(el, 2),
          attrs: ownAttributes(el),
          text: (el.textContent || '').trim().slice(0, 40),
          rect: { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) },
          style: styleOf(el)
        };
        const before = pseudoStyleOf(el, '::before');
        if (before) item.before = before;
        const after = pseudoStyleOf(el, '::after');
        if (after) item.after = after;
        return item;
      })
    });
  }

  function checkNavigation() {
    if (location.href === lastHref) return;
    const from = lastHref;
    lastHref = location.href;
    emit('page.urlChanged', { from, to: lastHref });
    resetPerPageState();
    // This SPA swaps screens well after the URL changes, so one early keyframe catches
    // the outgoing screen. Take a second one once the new screen has had time to render.
    setTimeout(() => keyframe('navigation'), 800);
    setTimeout(() => keyframe('navigation-settled'), 3500);
  }

  function resetPerPageState() {
    perfIndex = 0;
    lastSnapshotHash = null;
  }

  /* ---------------------------------------------------------------------- input */

  function pointerData(e, withTarget) {
    const data = {
      x: round(e.clientX),
      y: round(e.clientY),
      pageX: round(e.pageX),
      pageY: round(e.pageY),
      screenX: e.screenX,
      screenY: e.screenY,
      button: e.button,
      buttons: e.buttons,
      pointerType: e.pointerType,
      pressure: e.pressure != null ? round(e.pressure) : undefined,
      mods: modifiers(e),
      trusted: e.isTrusted
    };
    if (withTarget) {
      const target = describeElement(e.target, true);
      data.target = target;
      if (target && target.rect && target.rect.w > 0 && target.rect.h > 0) {
        data.inTarget = {
          fx: round(((e.clientX - target.rect.x) / target.rect.w) * 1000) / 1000,
          fy: round(((e.clientY - target.rect.y) / target.rect.h) * 1000) / 1000
        };
      }
      const stack = elementStack(e.clientX, e.clientY);
      if (stack) data.stack = stack;
    } else {
      data.targetPath = nodePath(e.target);
    }
    return data;
  }

  function elementStack(x, y) {
    try {
      return Array.prototype.slice.call(document.elementsFromPoint(x, y), 0, 4).map((el) => ({
        path: nodePath(el),
        css: cssPath(el, 2)
      }));
    } catch {
      return null;
    }
  }

  function modifiers(e) {
    const m = [];
    if (e.ctrlKey) m.push('ctrl');
    if (e.altKey) m.push('alt');
    if (e.shiftKey) m.push('shift');
    if (e.metaKey) m.push('meta');
    return m.length ? m.join('+') : undefined;
  }

  function installInput() {
    if (!settings.input) return;
    const opts = { capture: true, passive: true };

    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click', 'dblclick', 'auxclick']) {
      on(document, type, (e) => {
        emit('input.' + type, pointerData(e, true));
        if (settings.screenshotOnClick && (type === 'pointerdown' || type === 'click')) requestScreenshot(type);
        // A full board state shortly after every click is what makes a move reconstructable.
        if (type === 'click' || type === 'pointerdown') scheduleAfterClickStyles();
      }, opts);
    }

    on(document, 'contextmenu', (e) => emit('input.contextmenu', pointerData(e, true)), { capture: true });

    on(document, 'pointermove', (e) => {
      const now = performance.now();
      const minGap = settings.pointerMoveMs || 25;
      const targetPath = nodePath(e.target);
      const targetChanged = targetPath !== lastPointerTargetPath;
      if (!targetChanged && now - lastPointerEmit < minGap) return;
      lastPointerEmit = now;
      const data = pointerData(e, targetChanged);
      if (targetChanged) {
        lastPointerTargetPath = targetPath;
        data.targetChanged = true;
      }
      if (settings.coalescedMoves && e.getCoalescedEvents) {
        try {
          const points = e.getCoalescedEvents();
          if (points.length > 1) {
            data.trail = points.slice(-20).map((p) => ({ x: round(p.clientX), y: round(p.clientY), t: round(p.timeStamp) }));
          }
        } catch {
          /* not available */
        }
      }
      emit('input.pointermove', data);
    }, opts);

    on(document, 'wheel', (e) => {
      emit('input.wheel', {
        x: round(e.clientX),
        y: round(e.clientY),
        deltaX: round(e.deltaX),
        deltaY: round(e.deltaY),
        deltaMode: e.deltaMode,
        targetPath: nodePath(e.target)
      });
    }, opts);

    // Bound on window as well as document. A page may bind its own keyboard handling on
    // window, and anything dispatching there synthetically never passes through document -
    // which is how a whole run of keystrokes can go unrecorded.
    for (const type of ['keydown', 'keyup']) {
      const seen = new WeakSet();
      const record = (e) => {
        if (seen.has(e)) return; // the same event arriving on both targets
        seen.add(e);
        const target = e.target;
        const isPassword = target && target.type === 'password';
        emit('input.' + type, {
          key: isPassword ? '[redacted]' : e.key,
          code: e.code,
          repeat: e.repeat,
          mods: modifiers(e),
          trusted: e.isTrusted,
          onWindow: target === window,
          target: describeElement(target, false)
        });
      };
      on(document, type, record, opts);
      on(window, type, record, opts);
    }

    for (const type of ['input', 'change']) {
      on(document, type, (e) => {
        const target = e.target;
        if (!target || target.nodeType !== 1) return;
        const isPassword = target.type === 'password';
        const sensitive = isPassword || (settings.redact && SENSITIVE_KEY_RE.test(target.name || target.id || ''));
        emit('input.' + type, {
          value: sensitive ? '[redacted]' : String(target.value != null ? target.value : '').slice(0, 256),
          checked: target.checked,
          target: describeElement(target, false)
        });
      }, opts);
    }

    for (const type of ['focusin', 'focusout']) {
      on(document, type, (e) => emit('input.' + type, { target: describeElement(e.target, false) }), opts);
    }

    for (const type of ['dragstart', 'dragend', 'drop']) {
      on(document, type, (e) => emit('input.' + type, pointerData(e, true)), { capture: true, passive: true });
    }

    for (const type of ['touchstart', 'touchend']) {
      on(document, type, (e) => {
        emit('input.' + type, {
          touches: Array.prototype.slice.call(e.changedTouches, 0, 5).map((t) => ({ x: round(t.clientX), y: round(t.clientY), id: t.identifier })),
          target: describeElement(e.target, true)
        });
      }, opts);
    }

    on(window, 'scroll', () => {
      const now = performance.now();
      if (now - lastScrollEmit < 120) return;
      lastScrollEmit = now;
      emit('page.scroll', { x: round(window.scrollX), y: round(window.scrollY) });
    }, opts);

    on(window, 'resize', () => emit('page.resize', { w: window.innerWidth, h: window.innerHeight }), opts);
    on(document, 'visibilitychange', () => emit('page.visibility', { state: document.visibilityState }), opts);
    on(window, 'hashchange', () => checkNavigation(), opts);
    on(window, 'popstate', () => {
      emit('page.popstate', { url: location.href });
      checkNavigation();
    }, opts);
    on(window, 'pagehide', () => {
      emit('page.hide', { url: location.href });
      flush();
    }, opts);
    on(window, 'beforeunload', () => {
      emit('page.beforeunload', { url: location.href });
      flush();
    }, opts);
  }

  function scheduleAfterClickStyles() {
    if (!settings.styles || afterClickTimer) return;
    afterClickTimer = setTimeout(() => {
      afterClickTimer = null;
      if (recording) captureStyles('after-click');
    }, 180);
  }

  function requestScreenshot(reason) {
    if (!port) return;
    try {
      port.postMessage({ type: 'screenshot', reason });
    } catch {
      /* dropped */
    }
  }

  /* ----------------------------------------------------------------- page bridge */

  function configurePageHooks() {
    if (!settings) return;
    window.postMessage(
      {
        __lgCtl: PAGE_CHANNEL,
        on: recording,
        settings: {
          network: !!settings.network,
          console: !!settings.console,
          globals: !!settings.globals,
          bodyLimit: settings.networkBodyLimit,
          redact: !!settings.redact
        }
      },
      '*'
    );
  }

  function requestGlobals() {
    if (!settings || !settings.globals) return;
    window.postMessage({ __lgCtl: PAGE_CHANNEL, on: recording, snapshotGlobals: true }, '*');
  }

  /**
   * Asks the page world for the state its framework is holding. The reply arrives on the
   * same bridge as everything else, so it lands in the recording like any other event and is
   * forwarded to the background for whoever asked.
   */
  function requestPageState(options) {
    const id = 'state-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    window.postMessage({ __lgCtl: PAGE_CHANNEL, readState: { id, ...options } }, '*');
  }

  function installBridge() {
    bridgeHandler = (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.__lg !== PAGE_CHANNEL || !d.type) return;
      // A probe result is wanted even when nothing is being recorded, since asking for one is
      // a deliberate act rather than part of a capture.
      if (d.type === 'state.result' && port) {
        try {
          port.postMessage({ type: 'stateResult', result: d.data, href: location.href });
        } catch {
          /* port closed under us */
        }
      }
      if (!recording) return;
      const ev = { wall: d.wall || Date.now(), pt: d.pt || 0, type: d.type, data: d.data, source: 'page' };
      if (d.assets) ev.assets = d.assets;
      if (buffer.length >= MAX_BUFFERED_EVENTS) {
        droppedEvents++;
        return;
      }
      buffer.push(ev);
      if (ev.assets || buffer.length >= FLUSH_AT) flush();
      else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    };
    window.addEventListener('message', bridgeHandler, true);
  }

  /* ------------------------------------------------------------------ lifecycle */

  function startCapture() {
    recording = true;
    resetPerPageState();
    emit('page.info', {
      url: location.href,
      referrer: document.referrer,
      title: document.title,
      readyState: document.readyState,
      isTop: window.top === window,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      screen: { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight },
      language: navigator.language,
      languages: navigator.languages,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffset: new Date().getTimezoneOffset(),
      hardwareConcurrency: navigator.hardwareConcurrency,
      userAgent: navigator.userAgent
    });

    configurePageHooks();
    installInput();
    installMutationObserver();

    const runKeyframe = () => keyframe('initial');
    if (document.readyState === 'loading') {
      on(document, 'DOMContentLoaded', () => {
        keyframe('domcontentloaded');
        setTimeout(() => keyframe('settled'), 2500);
      }, { once: true });
    } else {
      runKeyframe();
      setTimeout(() => keyframe('settled'), 2500);
    }

    every(settings.domKeyframeMs, () => keyframe('interval'));
    every(5000, capturePerformanceEntries);
    heartbeatTimer = setInterval(() => {
      if (!contextAlive()) {
        teardown('context-invalidated');
        return;
      }
      flush();
      if (port) {
        try {
          port.postMessage({ type: 'heartbeat' });
        } catch {
          /* dropped */
        }
      }
    }, HEARTBEAT_MS);
  }

  function stopCapture(reason) {
    if (recording) emit('page.captureStopped', { reason });
    flush();
    recording = false;
    configurePageHooks();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    for (const id of intervals) clearInterval(id);
    intervals = [];
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (afterClickTimer) clearTimeout(afterClickTimer);
    afterClickTimer = null;
    for (const [target, type, handler, options] of listeners) {
      target.removeEventListener(type, handler, options);
    }
    listeners = [];
    seenInlineHashes.clear();
    seenCodeHashes.clear();
    sentResourceUrls.clear();
  }

  /* --------------------------------------------------------------------- helpers */

  function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36) + ':' + str.length;
  }

  function safeJson(value, maxDepth = 6, budget = { n: 4000 }) {
    const seen = new WeakSet();
    const walk = (v, depth) => {
      if (budget.n-- < 0) return '[budget]';
      if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
      if (typeof v === 'string') return v.length > 4096 ? v.slice(0, 4096) + '[...]' : v;
      if (v === undefined) return undefined;
      if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
      if (typeof v === 'bigint') return String(v) + 'n';
      if (typeof v === 'symbol') return String(v);
      if (v instanceof Date) return { __type: 'Date', value: v.toISOString() };
      if (v instanceof ArrayBuffer) return { __type: 'ArrayBuffer', byteLength: v.byteLength };
      if (ArrayBuffer.isView(v)) return { __type: v.constructor.name, length: v.length };
      if (v instanceof Blob) return { __type: 'Blob', size: v.size, type: v.type };
      if (typeof Node !== 'undefined' && v instanceof Node) return { __type: 'Node', name: v.nodeName, path: nodePath(v) };
      if (depth >= maxDepth) return '[depth]';
      if (seen.has(v)) return '[circular]';
      seen.add(v);
      if (Array.isArray(v)) return v.slice(0, 200).map((item) => walk(item, depth + 1));
      if (v instanceof Map) {
        const out = {};
        let i = 0;
        for (const [k, val] of v) {
          if (i++ > 100) break;
          out[String(k)] = walk(val, depth + 1);
        }
        return { __type: 'Map', entries: out };
      }
      if (v instanceof Set) return { __type: 'Set', values: Array.from(v).slice(0, 100).map((item) => walk(item, depth + 1)) };
      const out = {};
      let count = 0;
      for (const key of Object.keys(v)) {
        if (count++ > 200) {
          out.__truncated = true;
          break;
        }
        try {
          out[key] = walk(v[key], depth + 1);
        } catch (err) {
          out[key] = '[throws]';
        }
      }
      return out;
    };
    try {
      return walk(value, 0);
    } catch (err) {
      return '[unserializable]';
    }
  }

  /** Removes every trace of this instance so a freshly injected one can take over. */
  function teardown(reason) {
    if (disposed) return;
    disposed = true;
    try {
      stopCapture(reason || 'disposed');
    } catch {
      /* best effort */
    }
    if (bridgeHandler) {
      window.removeEventListener('message', bridgeHandler, true);
      bridgeHandler = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    buffer = [];
    if (port) {
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
      port = null;
    }
    if (window.__WSR_RECORDER__ && window.__WSR_RECORDER__.dispose === teardown) delete window.__WSR_RECORDER__;
  }

  window.__WSR_RECORDER__ = { dispose: teardown, installedAt: Date.now() };

  installBridge();
  connect();
})();
