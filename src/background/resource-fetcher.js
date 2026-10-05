/**
 * Re-downloads scripts and stylesheets the page loaded, so a recorded session contains
 * the actual game code and not just its URLs. Requests normally hit the HTTP cache,
 * so this does not re-trigger real network traffic in most cases.
 */

const CONCURRENCY = 4;

export function createResourceFetcher(emit, settings) {
  const seen = new Set();
  const queue = [];
  let active = 0;
  let budget = settings.scriptBytesPerSession;
  let stopped = false;

  function enqueue(items) {
    for (const item of items) {
      if (!item || !item.url) continue;
      if (!/^https?:/i.test(item.url)) continue;
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      queue.push(item);
    }
    pump();
  }

  function pump() {
    while (!stopped && active < CONCURRENCY && queue.length && budget > 0) {
      const item = queue.shift();
      active++;
      fetchOne(item).finally(() => {
        active--;
        pump();
      });
    }
  }

  async function fetchOne(item) {
    const started = Date.now();
    try {
      // Credentials must stay off: these are public bundles, and a credentialed request
      // to a host outside host_permissions is rejected by CORS whenever the server
      // answers with "Access-Control-Allow-Origin: *" (gstatic does), which turned
      // fetches that would otherwise succeed into console errors.
      const res = await fetch(item.url, { credentials: 'omit', cache: 'force-cache' });
      const contentType = res.headers.get('content-type') || item.kind || 'text/plain';
      const buf = await res.arrayBuffer();
      if (buf.byteLength > settings.scriptBytesPerFile) {
        emit('resource.skipped', { url: item.url, reason: 'too-large', size: buf.byteLength, kind: item.kind });
        return;
      }
      budget -= buf.byteLength;
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      emit(
        'resource.source',
        {
          url: item.url,
          kind: item.kind,
          status: res.status,
          contentType,
          size: buf.byteLength,
          ms: Date.now() - started,
          sha256: await sha256(buf)
        },
        { source: { kind: item.kind || 'resource', contentType, data: text } }
      );
    } catch (err) {
      emit('resource.error', { url: item.url, kind: item.kind, error: String(err && err.message ? err.message : err) });
    }
  }

  async function sha256(buf) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', buf);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return null;
    }
  }

  return {
    enqueue,
    stop() {
      stopped = true;
      queue.length = 0;
    },
    stats() {
      return { seen: seen.size, queued: queue.length, budgetLeft: budget };
    }
  };
}
