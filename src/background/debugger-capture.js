/**
 * Optional full-fidelity capture through the Chrome DevTools Protocol.
 *
 * This is the only way to get response bodies for resources the page did not request
 * through fetch/XHR (documents, scripts, stylesheets) and to see every console message
 * from every world. It requires the "debugger" optional permission and makes Chrome
 * show the "... is debugging this browser" banner, so it stays off by default.
 */

const BODY_TYPES = new Set(['XHR', 'Fetch', 'Script', 'Document', 'Stylesheet', 'Manifest', 'Other']);
const MAX_BODY_BYTES = 8 * 1024 * 1024;

let attachedTabId = null;
let emitFn = null;
let listener = null;
let detachListener = null;
const pending = new Map();

export function isAttached() {
  return attachedTabId != null;
}

export async function startDebuggerCapture(tabId, emit) {
  await stopDebuggerCapture();
  emitFn = emit;
  await chrome.debugger.attach({ tabId }, '1.3');
  attachedTabId = tabId;

  listener = (source, method, params) => {
    if (source.tabId !== attachedTabId) return;
    handleEvent(method, params);
  };
  detachListener = (source, reason) => {
    if (source.tabId !== attachedTabId) return;
    emit('debugger.detached', { reason });
    attachedTabId = null;
  };
  chrome.debugger.onEvent.addListener(listener);
  chrome.debugger.onDetach.addListener(detachListener);

  await send('Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 16 * 1024 * 1024 });
  await send('Page.enable', {});
  await send('Runtime.enable', {});
  await send('Log.enable', {});
  emit('debugger.attached', { tabId });
}

function send(method, params) {
  if (attachedTabId == null) return Promise.resolve(null);
  return chrome.debugger.sendCommand({ tabId: attachedTabId }, method, params).catch((err) => {
    emitFn?.('debugger.error', { method, error: String(err && err.message ? err.message : err) });
    return null;
  });
}

function handleEvent(method, params) {
  const emit = emitFn;
  if (!emit) return;
  switch (method) {
    case 'Network.requestWillBeSent':
      pending.set(params.requestId, { url: params.request.url, type: params.type });
      emit('cdp.net.request', {
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        headers: params.request.headers,
        postData: params.request.postData ? String(params.request.postData).slice(0, 262144) : undefined,
        resourceType: params.type,
        initiator: params.initiator
      });
      break;
    case 'Network.responseReceived': {
      const entry = pending.get(params.requestId);
      if (entry) entry.type = params.type;
      emit('cdp.net.response', {
        requestId: params.requestId,
        url: params.response.url,
        status: params.response.status,
        mimeType: params.response.mimeType,
        headers: params.response.headers,
        resourceType: params.type,
        timing: params.response.timing
      });
      break;
    }
    case 'Network.loadingFinished': {
      const entry = pending.get(params.requestId);
      pending.delete(params.requestId);
      if (!entry) return;
      if (!BODY_TYPES.has(entry.type)) return;
      if (params.encodedDataLength > MAX_BODY_BYTES) return;
      send('Network.getResponseBody', { requestId: params.requestId }).then((res) => {
        if (!res || res.body == null) return;
        emit(
          'cdp.net.body',
          { requestId: params.requestId, url: entry.url, base64Encoded: !!res.base64Encoded, size: res.body.length },
          { body: { kind: 'response-body', contentType: res.base64Encoded ? 'application/octet-stream' : 'text/plain', data: res.body } }
        );
      });
      break;
    }
    case 'Network.webSocketCreated':
      emit('cdp.ws.created', { requestId: params.requestId, url: params.url });
      break;
    case 'Network.webSocketFrameSent':
      emit('cdp.ws.sent', { requestId: params.requestId, payload: truncate(params.response?.payloadData) });
      break;
    case 'Network.webSocketFrameReceived':
      emit('cdp.ws.received', { requestId: params.requestId, payload: truncate(params.response?.payloadData) });
      break;
    case 'Runtime.consoleAPICalled':
      emit('cdp.console', {
        level: params.type,
        args: (params.args || []).map(describeRemoteObject),
        stack: params.stackTrace?.callFrames?.slice(0, 5)
      });
      break;
    case 'Runtime.exceptionThrown':
      emit('cdp.exception', {
        text: params.exceptionDetails?.text,
        description: params.exceptionDetails?.exception?.description,
        url: params.exceptionDetails?.url,
        line: params.exceptionDetails?.lineNumber
      });
      break;
    case 'Log.entryAdded':
      emit('cdp.log', { level: params.entry?.level, text: params.entry?.text, url: params.entry?.url, source: params.entry?.source });
      break;
    case 'Page.frameNavigated':
      emit('cdp.frameNavigated', { url: params.frame?.url, frameId: params.frame?.id, parentId: params.frame?.parentId });
      break;
    default:
      break;
  }
}

function truncate(text, limit = 131072) {
  if (typeof text !== 'string') return text;
  return text.length > limit ? `${text.slice(0, limit)}[...+${text.length - limit}]` : text;
}

function describeRemoteObject(obj) {
  if (!obj) return null;
  if ('value' in obj) return obj.value;
  if (obj.unserializableValue) return obj.unserializableValue;
  if (obj.preview) {
    const out = {};
    for (const p of obj.preview.properties || []) out[p.name] = p.value;
    return { __type: obj.className || obj.subtype || obj.type, ...out };
  }
  return { __type: obj.className || obj.type, description: obj.description };
}

export async function stopDebuggerCapture() {
  if (listener) chrome.debugger.onEvent.removeListener(listener);
  if (detachListener) chrome.debugger.onDetach.removeListener(detachListener);
  listener = null;
  detachListener = null;
  pending.clear();
  const tabId = attachedTabId;
  attachedTabId = null;
  emitFn = null;
  if (tabId != null) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      /* already gone */
    }
  }
}
