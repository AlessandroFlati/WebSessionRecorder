/**
 * MAIN-world hooks: everything the isolated world cannot see.
 *
 * Installed at document_start so no request is missed, but events are only forwarded
 * while recording is on. Events produced before recording starts are kept in a small
 * ring buffer and replayed on start, so pressing Start after the page loaded still
 * yields the page-load traffic.
 *
 * Communication with the isolated-world recorder goes through window.postMessage; the
 * page could observe those messages, but every payload is data the page itself produced.
 */
(() => {
  'use strict';

  if (window.__WSR_PAGE_HOOKS__) return;
  window.__WSR_PAGE_HOOKS__ = true;

  const CHANNEL = '__WSR_PAGE_MSG__';
  const RING_SIZE = 1200;
  // Which page globals are worth dumping. Deliberately broad: these are the names frameworks
  // and apps use for the data a reader of a recording usually wants.
  const INTERESTING_RE =
    /(apollo|relay|initial|preloaded|hydrat|state|store|redux|vuex|pinia|signal|model|config|settings|session|board|grid|level|data_?layer|__next|__nuxt|__sveltekit|__remix)/i;
  const WELL_KNOWN = [
    '__APOLLO_STATE__', '__APOLLO_CLIENT__', '__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__',
    '__REDUX_DEVTOOLS_EXTENSION__', '__PRELOADED_STATE__', 'dataLayer', 'lix', 'li', 'voyager'
  ];
  const SENSITIVE_HEADER_RE = /^(cookie|set-cookie|authorization|proxy-authorization|csrf-token|x-csrf-token|jsessionid)$/i;

  let on = false;
  let cfg = { network: true, console: true, globals: true, bodyLimit: 131072, redact: true };
  const ring = [];
  let requestSeq = 0;
  const baselineKeys = new Set(Object.getOwnPropertyNames(window));

  function post(type, data, assets) {
    const ev = { __lg: CHANNEL, type, data, wall: Date.now(), pt: Math.round(performance.now() * 100) / 100 };
    if (assets) ev.assets = assets;
    if (!on) {
      ring.push(ev);
      if (ring.length > RING_SIZE) ring.shift();
      return;
    }
    try {
      window.postMessage(ev, '*');
    } catch {
      /* payload not cloneable: drop */
    }
  }

  function drainRing() {
    const pending = ring.splice(0, ring.length);
    for (const ev of pending) {
      ev.data = ev.data || {};
      ev.data.__replayed = true;
      try {
        window.postMessage(ev, '*');
      } catch {
        /* drop */
      }
    }
  }

  window.addEventListener(
    'message',
    (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.__lgCtl !== CHANNEL) return;
      const wasOn = on;
      on = !!d.on;
      if (d.settings) cfg = Object.assign({}, cfg, d.settings);
      // patches live only while recording, so nothing of ours sits in the page's call
      // stacks the rest of the time
      if (on) installPatches();
      else uninstallPatches();
      if (on && !wasOn) drainRing();
      if (on && d.snapshotGlobals) snapshotGlobals();
      if (d.readState) answerStateRequest(d.readState);
    },
    true
  );

  /* ------------------------------------------------- the page's own component state */

  /**
   * Reads the state a framework is holding for an element, and posts a JSON copy back.
   *
   * Modern pages keep the data they render in framework internals rather than in the DOM, and
   * those internals are only reachable from the page's own world - which is where this file
   * runs. A recording that captures the rendered HTML but not the state behind it is often
   * missing the only copy of what the page actually knew.
   *
   * Nothing is patched and nothing is written: this reads properties the framework already
   * hung off the element and sends a copy. React, Vue, Svelte and Angular all attach
   * something recognisable; where they do not, the element is reported as unknown rather than
   * guessed at.
   */
  const REACT_FIBRE_RE = /^__reactFiber\$|^__reactInternalInstance\$/;
  const REACT_PROPS_RE = /^__reactProps\$/;

  const DEFAULT_STATE_SELECTORS = ['[data-testid]', '[role="application"]', '[role="grid"]', 'main', '#app', '#root', 'body'];

  function frameworkHandles(el) {
    const out = { react: null, reactProps: null, vue: null, svelte: null, angular: null };
    for (const key of Object.keys(el)) {
      if (!out.react && REACT_FIBRE_RE.test(key)) out.react = el[key];
      else if (!out.reactProps && REACT_PROPS_RE.test(key)) out.reactProps = el[key];
      else if (key === '__vue__' || key === '__vue_app__' || key === '__vueParentComponent') out.vue = el[key];
      else if (key === '__svelte_meta') out.svelte = el[key];
      else if (key === '__ngContext__') out.angular = el[key];
    }
    return out;
  }

  /**
   * A structured clone that cannot blow up: functions, DOM nodes and anything circular are
   * replaced by a short marker, and the walk is bounded in depth, breadth and total size.
   * Framework internals contain all three, and a probe that throws is no use.
   */
  function safeCopy(value, { maxDepth = 8, maxKeys = 80, maxItems = 200, budget = { left: 240000 } } = {}, seen = new Set(), depth = 0) {
    if (value === null || value === undefined) return value;
    const kind = typeof value;
    if (kind === 'string') {
      budget.left -= value.length;
      return budget.left < 0 ? value.slice(0, 200) + '[truncated]' : value;
    }
    if (kind === 'number' || kind === 'boolean') return value;
    if (kind === 'function') return '[function ' + (value.name || 'anonymous') + ']';
    if (kind === 'symbol' || kind === 'bigint') return String(value);
    if (budget.left < 0 || depth >= maxDepth) return '[deeper]';
    if (typeof Node !== 'undefined' && value instanceof Node) {
      return '[dom ' + (value.nodeName || '').toLowerCase() + ']';
    }
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const out = [];
        for (const item of value.slice(0, maxItems)) out.push(safeCopy(item, { maxDepth, maxKeys, maxItems, budget }, seen, depth + 1));
        if (value.length > maxItems) out.push('[+' + (value.length - maxItems) + ' more]');
        return out;
      }
      if (value instanceof Map) return { '[Map]': safeCopy([...value.entries()], { maxDepth, maxKeys, maxItems, budget }, seen, depth + 1) };
      if (value instanceof Set) return { '[Set]': safeCopy([...value], { maxDepth, maxKeys, maxItems, budget }, seen, depth + 1) };
      const out = {};
      let keys = 0;
      for (const key of Object.keys(value)) {
        if (++keys > maxKeys) {
          out['[more keys]'] = Object.keys(value).length - maxKeys;
          break;
        }
        out[key] = safeCopy(value[key], { maxDepth, maxKeys, maxItems, budget }, seen, depth + 1);
      }
      return out;
    } catch (err) {
      return '[unreadable: ' + String((err && err.message) || err) + ']';
    } finally {
      seen.delete(value);
    }
  }

  /** Walks a React fibre upwards, collecting the props and state of each component. */
  function reactChain(fibre, { maxDepth, keyPattern }) {
    const frames = [];
    for (let depth = 0; fibre && depth < maxDepth; depth++) {
      const name =
        typeof fibre.type === 'string'
          ? fibre.type
          : (fibre.type && (fibre.type.displayName || fibre.type.name)) || null;
      const props = fibre.memoizedProps || fibre.pendingProps || null;
      const hasKey = !keyPattern || (props && Object.keys(props).some((key) => keyPattern.test(key)));
      if (props && hasKey) {
        frames.push({
          depth,
          component: name,
          props: safeCopy(props),
          state: fibre.memoizedState && typeof fibre.memoizedState === 'object' && !fibre.memoizedState.next
            ? safeCopy(fibre.memoizedState)
            : undefined
        });
      }
      fibre = fibre.return;
    }
    return frames;
  }

  function readComponentState(options) {
    const selectors = (options.selectors && options.selectors.length ? options.selectors : DEFAULT_STATE_SELECTORS);
    const maxDepth = options.maxDepth || 40;
    const limit = options.limit || 3;
    const keyPattern = options.keyPattern ? new RegExp(options.keyPattern) : null;
    const found = [];

    for (const selector of selectors) {
      let elements = [];
      try {
        elements = [...document.querySelectorAll(selector)].slice(0, 8);
      } catch {
        continue; // a selector typed by hand
      }
      for (const el of elements) {
        const handles = frameworkHandles(el);
        const entry = { selector, tag: (el.tagName || '').toLowerCase() };
        if (handles.react) {
          const frames = reactChain(handles.react, { maxDepth, keyPattern });
          if (frames.length) entry.react = frames;
        }
        if (!entry.react && handles.reactProps) entry.react = [{ depth: 0, component: null, props: safeCopy(handles.reactProps) }];
        if (handles.vue) entry.vue = safeCopy(handles.vue.props || handles.vue._props || handles.vue);
        if (handles.svelte) entry.svelte = safeCopy(handles.svelte);
        if (handles.angular) entry.angular = '[angular context present]';
        if (entry.react || entry.vue || entry.svelte || entry.angular) {
          found.push(entry);
          if (found.length >= limit) return found;
        }
      }
    }
    return found;
  }

  function answerStateRequest(request) {
    const id = request && request.id;
    let payload;
    try {
      const found = readComponentState(request || {});
      payload = found.length
        ? { id, found }
        : { id, error: 'no framework state found for those selectors', tried: (request && request.selectors) || DEFAULT_STATE_SELECTORS };
    } catch (err) {
      payload = { id, error: String((err && err.message) || err) };
    }
    try {
      window.postMessage({ __lg: CHANNEL, type: 'state.result', data: payload, wall: Date.now() }, '*');
    } catch {
      window.postMessage({ __lg: CHANNEL, type: 'state.result', data: { id, error: 'state could not be serialised' }, wall: Date.now() }, '*');
    }
  }

  /* ------------------------------------------------------------------ utilities */

  function truncate(text, limit) {
    if (typeof text !== 'string') return text;
    const max = limit || cfg.bodyLimit || 131072;
    return text.length > max ? text.slice(0, max) + '[...+' + (text.length - max) + ']' : text;
  }

  function redactHeaders(headers) {
    if (!headers) return headers;
    const out = {};
    for (const key of Object.keys(headers)) {
      out[key] = cfg.redact && SENSITIVE_HEADER_RE.test(key) ? '[redacted]' : headers[key];
    }
    return out;
  }

  function headersToObject(headers) {
    const out = {};
    try {
      if (!headers) return out;
      if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
        headers.forEach((value, key) => {
          out[String(key).toLowerCase()] = value;
        });
        return redactHeaders(out);
      }
      if (Array.isArray(headers)) {
        for (const [key, value] of headers) out[String(key).toLowerCase()] = value;
        return redactHeaders(out);
      }
      for (const key of Object.keys(headers)) out[key.toLowerCase()] = headers[key];
    } catch {
      /* ignore */
    }
    return redactHeaders(out);
  }

  function bodyPreview(body) {
    try {
      if (body == null) return null;
      if (typeof body === 'string') return { type: 'string', text: truncate(body) };
      if (body instanceof URLSearchParams) return { type: 'urlencoded', text: truncate(body.toString()) };
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const entries = [];
        for (const [key, value] of body.entries()) {
          entries.push([key, typeof value === 'string' ? truncate(value, 2048) : '[file]']);
          if (entries.length > 50) break;
        }
        return { type: 'formdata', entries };
      }
      if (body instanceof Blob) return { type: 'blob', size: body.size, contentType: body.type };
      if (body instanceof ArrayBuffer) return { type: 'arraybuffer', byteLength: body.byteLength };
      if (ArrayBuffer.isView(body)) return { type: 'typedarray', byteLength: body.byteLength };
      return { type: typeof body };
    } catch {
      return { type: 'unknown' };
    }
  }

  function isTextual(contentType) {
    if (!contentType) return true;
    return /(json|text|javascript|xml|graphql|x-www-form-urlencoded|plain)/i.test(contentType);
  }

  function nativeToString(fn, name) {
    try {
      Object.defineProperty(fn, 'toString', {
        value: () => 'function ' + name + '() { [native code] }',
        writable: true,
        configurable: true
      });
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
    } catch {
      /* ignore */
    }
    return fn;
  }

  function safeValue(value, maxDepth, budget) {
    const depthLimit = maxDepth == null ? 6 : maxDepth;
    const counter = budget || { n: 4000 };
    const seen = new WeakSet();
    const walk = (v, depth) => {
      if (counter.n-- < 0) return '[budget]';
      const t = typeof v;
      if (v === null || t === 'number' || t === 'boolean' || t === 'undefined') return v;
      if (t === 'string') return v.length > 2048 ? v.slice(0, 2048) + '[...]' : v;
      if (t === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
      if (t === 'bigint') return String(v) + 'n';
      if (t === 'symbol') return String(v);
      if (v instanceof Date) return { __type: 'Date', value: v.toISOString() };
      if (v instanceof Error) return { __type: 'Error', message: v.message, stack: String(v.stack || '').slice(0, 2048) };
      if (typeof Node !== 'undefined' && v instanceof Node) return { __type: 'Node', name: v.nodeName, id: v.id || undefined };
      if (typeof Window !== 'undefined' && v === window) return '[Window]';
      if (v instanceof ArrayBuffer) return { __type: 'ArrayBuffer', byteLength: v.byteLength };
      if (ArrayBuffer.isView(v)) return { __type: v.constructor ? v.constructor.name : 'TypedArray', length: v.length };
      if (depth >= depthLimit) return '[depth]';
      if (seen.has(v)) return '[circular]';
      seen.add(v);
      if (Array.isArray(v)) return v.slice(0, 200).map((item) => walk(item, depth + 1));
      if (typeof Map !== 'undefined' && v instanceof Map) {
        const out = {};
        let i = 0;
        for (const [k, val] of v) {
          if (i++ > 100) break;
          out[String(k)] = walk(val, depth + 1);
        }
        return { __type: 'Map', entries: out };
      }
      if (typeof Set !== 'undefined' && v instanceof Set) {
        return { __type: 'Set', values: Array.from(v).slice(0, 100).map((item) => walk(item, depth + 1)) };
      }
      const out = {};
      let count = 0;
      let keys = [];
      try {
        keys = Object.keys(v);
      } catch {
        return '[opaque]';
      }
      for (const key of keys) {
        if (count++ > 150) {
          out.__truncated = true;
          break;
        }
        try {
          out[key] = walk(v[key], depth + 1);
        } catch {
          out[key] = '[throws]';
        }
      }
      return out;
    };
    try {
      return walk(value, 0);
    } catch {
      return '[unserializable]';
    }
  }

  window.addEventListener('error', (e) => {
    post('page.error', {
      message: e.message,
      filename: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 4096) : undefined
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    post('page.unhandledRejection', { reason: safeValue(e.reason, 3) });
  });

  /* ----------------------------------------------------------- patch lifecycle */

  /**
   * The page-world patches exist only while a recording is running.
   *
   * Leaving them installed permanently put this file into the call stack of every
   * console message and every failed request the page made, so the site's own telemetry
   * warnings and aborted streams were all attributed to the extension in devtools. The
   * cost of installing late is that anything before a recording starts is not captured,
   * which is a fair trade now the games are decoded.
   */
  const natives = {};
  let patched = false;

  function snapshotNatives() {
    natives.fetch = window.fetch;
    natives.WebSocket = window.WebSocket;
    natives.EventSource = window.EventSource;
    natives.sendBeacon = navigator.sendBeacon;
    natives.console = {};
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'table']) natives.console[level] = console[level];
    natives.history = {};
    for (const method of ['pushState', 'replaceState']) natives.history[method] = history[method];
    if (typeof XMLHttpRequest !== 'undefined') {
      natives.xhr = {
        open: XMLHttpRequest.prototype.open,
        send: XMLHttpRequest.prototype.send,
        setRequestHeader: XMLHttpRequest.prototype.setRequestHeader
      };
    }
    if (typeof Storage !== 'undefined') {
      natives.storage = { setItem: Storage.prototype.setItem, removeItem: Storage.prototype.removeItem };
    }
  }

  function restoreNatives() {
    if (natives.fetch) window.fetch = natives.fetch;
    if (natives.WebSocket) window.WebSocket = natives.WebSocket;
    if (natives.EventSource) window.EventSource = natives.EventSource;
    if (natives.sendBeacon) navigator.sendBeacon = natives.sendBeacon;
    for (const level of Object.keys(natives.console || {})) console[level] = natives.console[level];
    for (const method of Object.keys(natives.history || {})) history[method] = natives.history[method];
    if (natives.xhr) {
      XMLHttpRequest.prototype.open = natives.xhr.open;
      XMLHttpRequest.prototype.send = natives.xhr.send;
      XMLHttpRequest.prototype.setRequestHeader = natives.xhr.setRequestHeader;
    }
    if (natives.storage) {
      Storage.prototype.setItem = natives.storage.setItem;
      Storage.prototype.removeItem = natives.storage.removeItem;
    }
  }

  function uninstallPatches() {
    if (!patched) return;
    patched = false;
    restoreNatives();
  }

  function installPatches() {
    if (patched) return;
    patched = true;
    snapshotNatives();

    /* --------------------------------------------------------------------- fetch */

    const nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      const patched = function fetch(input, init) {
        if (!cfg.network) return nativeFetch.apply(this, arguments);
        const id = 'f' + ++requestSeq;
        const started = performance.now();
        let url = '';
        let method = 'GET';
        let headers = {};
        let body = null;
        try {
          if (typeof Request !== 'undefined' && input instanceof Request) {
            url = input.url;
            method = input.method;
            headers = headersToObject(input.headers);
          } else {
            url = String(input && input.url ? input.url : input);
            method = (init && init.method) || 'GET';
            headers = headersToObject(init && init.headers);
          }
          if (init && init.body != null) body = bodyPreview(init.body);
        } catch {
          /* ignore */
        }
        post('net.fetch.request', { id, url, method, headers, body });
        let result;
        try {
          result = nativeFetch.apply(this, arguments);
        } catch (err) {
          post('net.fetch.error', { id, url, error: String(err) });
          throw err;
        }
        return result.then(
          (res) => {
            const meta = {
              id,
              url: res.url || url,
              status: res.status,
              statusText: res.statusText,
              ok: res.ok,
              type: res.type,
              redirected: res.redirected,
              headers: headersToObject(res.headers),
              ms: Math.round(performance.now() - started)
            };
            try {
              const contentType = res.headers.get('content-type') || '';
              if (isTextual(contentType) && res.type !== 'opaque') {
                res
                  .clone()
                  .text()
                  .then((text) => {
                    meta.bodyLength = text.length;
                    post('net.fetch.response', meta, {
                      body: { kind: 'fetch-response', contentType: contentType || 'text/plain', data: truncate(text) }
                    });
                  })
                  .catch(() => post('net.fetch.response', meta));
              } else {
                meta.bodySkipped = contentType || 'opaque';
                post('net.fetch.response', meta);
              }
            } catch {
              post('net.fetch.response', meta);
            }
            return res;
          },
          (err) => {
            post('net.fetch.error', { id, url, error: String(err), ms: Math.round(performance.now() - started) });
            throw err;
          }
        );
      };
      window.fetch = nativeToString(patched, 'fetch');
    }

    /* ----------------------------------------------------------------------- XHR */

    if (typeof XMLHttpRequest !== 'undefined') {
      const proto = XMLHttpRequest.prototype;
      const nativeOpen = proto.open;
      const nativeSend = proto.send;
      const nativeSetHeader = proto.setRequestHeader;
      const META = '__lgMeta';

      proto.open = nativeToString(function open(method, url) {
        try {
          this[META] = { id: 'x' + ++requestSeq, method, url: String(url), headers: {}, started: 0 };
        } catch {
          /* ignore */
        }
        return nativeOpen.apply(this, arguments);
      }, 'open');

      proto.setRequestHeader = nativeToString(function setRequestHeader(name, value) {
        try {
          const meta = this[META];
          if (meta) meta.headers[String(name).toLowerCase()] = value;
        } catch {
          /* ignore */
        }
        return nativeSetHeader.apply(this, arguments);
      }, 'setRequestHeader');

      proto.send = nativeToString(function send(body) {
        const meta = this[META];
        if (cfg.network && meta) {
          meta.started = performance.now();
          post('net.xhr.request', {
            id: meta.id,
            url: meta.url,
            method: meta.method,
            headers: redactHeaders(meta.headers),
            body: bodyPreview(body)
          });
          const xhr = this;
          const finish = () => {
            try {
              const contentType = xhr.getResponseHeader ? xhr.getResponseHeader('content-type') : null;
              const info = {
                id: meta.id,
                url: meta.url,
                status: xhr.status,
                statusText: xhr.statusText,
                responseType: xhr.responseType,
                responseURL: xhr.responseURL,
                headers: parseRawHeaders(xhr.getAllResponseHeaders ? xhr.getAllResponseHeaders() : ''),
                ms: Math.round(performance.now() - meta.started)
              };
              let text = null;
              if (!xhr.responseType || xhr.responseType === 'text') text = xhr.responseText;
              else if (xhr.responseType === 'json') {
                try {
                  text = JSON.stringify(xhr.response);
                } catch {
                  text = null;
                }
              }
              if (typeof text === 'string') {
                info.bodyLength = text.length;
                post('net.xhr.response', info, {
                  body: { kind: 'xhr-response', contentType: contentType || 'text/plain', data: truncate(text) }
                });
              } else {
                info.bodySkipped = xhr.responseType || contentType || 'binary';
                post('net.xhr.response', info);
              }
            } catch (err) {
              post('net.xhr.error', { id: meta.id, url: meta.url, error: String(err) });
            }
          };
          try {
            this.addEventListener('loadend', finish, { once: true });
          } catch {
            /* ignore */
          }
        }
        return nativeSend.apply(this, arguments);
      }, 'send');
    }

    function parseRawHeaders(raw) {
      const out = {};
      if (!raw) return out;
      for (const line of String(raw).trim().split(/[\r\n]+/)) {
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      return redactHeaders(out);
    }

    /* ----------------------------------------------------------------- WebSocket */

    if (typeof WebSocket !== 'undefined' && typeof Proxy !== 'undefined') {
      const NativeWebSocket = WebSocket;
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args) {
          const ws = new target(...args);
          const id = 'w' + ++requestSeq;
          const url = String(args[0]);
          post('net.ws.open', { id, url, protocols: args[1] });
          try {
            ws.addEventListener('message', (e) => {
              post('net.ws.message', { id, url, direction: 'in', data: describeFrame(e.data) });
            });
            ws.addEventListener('close', (e) => post('net.ws.close', { id, url, code: e.code, reason: e.reason }));
            ws.addEventListener('error', () => post('net.ws.error', { id, url }));
            const nativeSend = ws.send.bind(ws);
            ws.send = function send(data) {
              post('net.ws.message', { id, url, direction: 'out', data: describeFrame(data) });
              return nativeSend(data);
            };
          } catch {
            /* ignore */
          }
          return ws;
        }
      });
    }

    function describeFrame(data) {
      if (typeof data === 'string') return truncate(data, 32768);
      if (data instanceof ArrayBuffer) return { __type: 'ArrayBuffer', byteLength: data.byteLength };
      if (typeof Blob !== 'undefined' && data instanceof Blob) return { __type: 'Blob', size: data.size };
      return { __type: typeof data };
    }

    /* ---------------------------------------------------------------- sendBeacon */

    if (navigator.sendBeacon) {
      const nativeBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = nativeToString(function sendBeacon(url, data) {
        post('net.beacon', { url: String(url), body: bodyPreview(data) });
        return nativeBeacon(url, data);
      }, 'sendBeacon');
    }

    /* -------------------------------------------------------------- EventSource */

    if (typeof EventSource !== 'undefined' && typeof Proxy !== 'undefined') {
      const NativeEventSource = EventSource;
      window.EventSource = new Proxy(NativeEventSource, {
        construct(target, args) {
          const es = new target(...args);
          const id = 'e' + ++requestSeq;
          post('net.sse.open', { id, url: String(args[0]) });
          try {
            es.addEventListener('message', (e) => post('net.sse.message', { id, data: truncate(String(e.data), 32768) }));
          } catch {
            /* ignore */
          }
          return es;
        }
      });
    }

    /* -------------------------------------------------------------------- console */

    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'table']) {
      const original = console[level];
      if (typeof original !== 'function') continue;
      console[level] = nativeToString(function () {
        if (cfg.console) {
          try {
            const budget = { n: 600 };
            post('console.' + level, {
              args: Array.prototype.slice.call(arguments, 0, 10).map((a) => safeValue(a, 4, budget))
            });
          } catch {
            /* ignore */
          }
        }
        return original.apply(console, arguments);
      }, level);
    }


    /* -------------------------------------------------------------------- history */

    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      if (typeof original !== 'function') continue;
      history[method] = nativeToString(function () {
        post('page.history', {
          method,
          url: arguments.length > 2 ? String(arguments[2]) : null,
          state: safeValue(arguments[0], 4),
          from: location.href
        });
        return original.apply(history, arguments);
      }, method);
    }

    /* -------------------------------------------------------------- web storage */

    if (typeof Storage !== 'undefined') {
      const nativeSetItem = Storage.prototype.setItem;
      const nativeRemoveItem = Storage.prototype.removeItem;
      Storage.prototype.setItem = nativeToString(function setItem(key, value) {
        try {
          post('storage.setItem', {
            store: this === window.sessionStorage ? 'sessionStorage' : 'localStorage',
            key: String(key),
            value: truncate(String(value), 32768)
          });
        } catch {
          /* ignore */
        }
        return nativeSetItem.apply(this, arguments);
      }, 'setItem');
      Storage.prototype.removeItem = nativeToString(function removeItem(key) {
        try {
          post('storage.removeItem', {
            store: this === window.sessionStorage ? 'sessionStorage' : 'localStorage',
            key: String(key)
          });
        } catch {
          /* ignore */
        }
        return nativeRemoveItem.apply(this, arguments);
      }, 'removeItem');
    }

  }

  /* --------------------------------------------------------------------- globals */

  function snapshotGlobals() {
    if (!cfg.globals) return;
    let names = [];
    try {
      names = Object.getOwnPropertyNames(window);
    } catch {
      return;
    }
    const added = names.filter((n) => !baselineKeys.has(n));
    const budget = { n: 12000 };
    const values = {};
    const candidates = new Set(WELL_KNOWN);
    for (const name of added) {
      if (INTERESTING_RE.test(name) || name.startsWith('__')) candidates.add(name);
    }
    for (const name of candidates) {
      let value;
      try {
        if (!(name in window)) continue;
        value = window[name];
      } catch {
        continue;
      }
      if (value === undefined || typeof value === 'function') continue;
      values[name] = safeValue(value, 5, budget);
      if (budget.n <= 0) break;
    }
    post('page.globals', { newKeyCount: added.length, newKeys: added.slice(0, 300), values });
  }

  post('page.hooksInstalled', { url: location.href, readyState: document.readyState });
})();
