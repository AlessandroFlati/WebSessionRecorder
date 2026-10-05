import { SENSITIVE_HEADER_RE, REDACTED } from '../common/constants.js';

/**
 * Metadata-level network capture via chrome.webRequest. It sees every resource
 * (documents, scripts, images, XHR, beacons) but never response bodies; bodies come
 * from the MAIN-world hooks or, when enabled, from the debugger capture.
 */

let handlers = null;

function headersToObject(list, redact) {
  const out = {};
  for (const h of list || []) {
    const name = h.name.toLowerCase();
    out[name] = redact && SENSITIVE_HEADER_RE.test(name) ? REDACTED : (h.value != null ? h.value : `[binary ${h.binaryValue ? h.binaryValue.length : 0}b]`);
  }
  return out;
}

export function startNetObserver(tabId, emit, settings) {
  stopNetObserver();
  const filter = { urls: ['<all_urls>'], tabId };
  const redact = !!settings.redact;

  const onBeforeRequest = (d) => {
    emit('net.request', {
      requestId: d.requestId,
      url: d.url,
      method: d.method,
      resourceType: d.type,
      frameId: d.frameId,
      parentFrameId: d.parentFrameId,
      initiator: d.initiator,
      body: summarizeRequestBody(d.requestBody)
    }, null, d.timeStamp);
  };
  const onSendHeaders = (d) => {
    emit('net.requestHeaders', {
      requestId: d.requestId,
      url: d.url,
      headers: headersToObject(d.requestHeaders, redact)
    }, null, d.timeStamp);
  };
  const onHeadersReceived = (d) => {
    emit('net.responseHeaders', {
      requestId: d.requestId,
      url: d.url,
      statusCode: d.statusCode,
      statusLine: d.statusLine,
      headers: headersToObject(d.responseHeaders, redact)
    }, null, d.timeStamp);
  };
  const onCompleted = (d) => {
    emit('net.completed', {
      requestId: d.requestId,
      url: d.url,
      statusCode: d.statusCode,
      fromCache: d.fromCache,
      resourceType: d.type
    }, null, d.timeStamp);
  };
  const onErrorOccurred = (d) => {
    emit('net.failed', { requestId: d.requestId, url: d.url, error: d.error, resourceType: d.type }, null, d.timeStamp);
  };

  chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, filter, ['requestBody']);
  chrome.webRequest.onSendHeaders.addListener(onSendHeaders, filter, ['requestHeaders']);
  chrome.webRequest.onHeadersReceived.addListener(onHeadersReceived, filter, ['responseHeaders']);
  chrome.webRequest.onCompleted.addListener(onCompleted, filter);
  chrome.webRequest.onErrorOccurred.addListener(onErrorOccurred, filter);

  handlers = { onBeforeRequest, onSendHeaders, onHeadersReceived, onCompleted, onErrorOccurred };
}

function summarizeRequestBody(body) {
  if (!body) return null;
  if (body.error) return { error: body.error };
  if (body.formData) return { formData: body.formData };
  if (body.raw) {
    let text = '';
    let bytes = 0;
    for (const chunk of body.raw) {
      if (chunk.bytes) {
        bytes += chunk.bytes.byteLength;
        if (text.length < 65536) {
          try {
            text += new TextDecoder('utf-8', { fatal: false }).decode(chunk.bytes);
          } catch {
            /* binary chunk */
          }
        }
      } else if (chunk.file) {
        text += `[file ${chunk.file}]`;
      }
    }
    return { bytes, text: text.slice(0, 65536) };
  }
  return null;
}

export function stopNetObserver() {
  if (!handlers) return;
  chrome.webRequest.onBeforeRequest.removeListener(handlers.onBeforeRequest);
  chrome.webRequest.onSendHeaders.removeListener(handlers.onSendHeaders);
  chrome.webRequest.onHeadersReceived.removeListener(handlers.onHeadersReceived);
  chrome.webRequest.onCompleted.removeListener(handlers.onCompleted);
  chrome.webRequest.onErrorOccurred.removeListener(handlers.onErrorOccurred);
  handlers = null;
}
