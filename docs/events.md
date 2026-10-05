# Event reference

A session exports as NDJSON: the first line is the session header, every line after it is one
event. Every event carries the same envelope and a `data` payload whose shape depends on
`type`.

```jsonc
{
  "sessionId": "s_20261005161533_ab12cd",
  "seq": 1041,          // order within the session
  "wall": 1791294933123,// Date.now() when it happened
  "t": 8422,            // ms since the session started
  "pt": 8420.31,        // performance.now() in the frame that produced it
  "frameId": 0,         // 0 is the main frame
  "frameUrl": "https://example.com/app",
  "documentId": "…",    // identifies the document, unlike frameId which is reused
  "source": "content",  // content | page | background
  "type": "input.pointerdown",
  "data": { },
  "assets": null        // present when the event carries a blob, e.g. a screenshot
}
```

`frameId` plus `documentId` matter more than they look: a frame id is reused across
navigations, so without `documentId` two different documents in the same frame are
indistinguishable.

## Session

| Type | Payload |
| --- | --- |
| `session.start` | url, title, viewport, user agent, the settings in force |
| `session.stop` | reason, counts per type, total bytes |
| `page.info` | url, title, referrer, readyState, viewport, device pixel ratio |
| `user.mark` | `label` — a marker you inserted |
| `note` | `label` plus whatever a script pushed in (see *Writing your own events*) |
| `recorder.injection` | which frames the content scripts reached, and any errors |

## DOM

| Type | Payload |
| --- | --- |
| `dom.snapshot` | `reason`, url, title, readyState, `length`, `hash`, viewport. **Not the HTML** — see below |
| `dom.snapshot.unchanged` | the hash matched the previous snapshot, so nothing was stored |
| `dom.mutations` | batched records: `kind` (childList / attributes / characterData), node `path`, attribute name and value, added and removed node summaries |
| `dom.mutations.dropped` | how many were discarded when the per-second cap was hit |
| `dom.styles` | per element: node path, bounding rect, the tracked computed properties, pseudo-element content |

A node is identified by a **child-index path** from the document element, not an id: the
recorder does not write to the page.

`dom.snapshot` deliberately stores a hash and a length rather than the serialised HTML, which
keeps sessions small enough to be useful. If you need the markup itself, the DOM can be
reconstructed from the initial document plus `dom.mutations`; if you need it directly, raise
it as an issue rather than assuming the hash is a bug.

## Input

`input.pointerdown`, `input.pointerup`, `input.pointermove`, `input.click`, `input.dblclick`,
`input.auxclick`, `input.contextmenu`, `input.wheel`, `input.keydown`, `input.keyup`,
`input.input`, `input.change`, `input.focusin`, `input.focusout`, `input.submit`.

Payloads carry viewport and page coordinates, buttons, modifiers, the key (redacted for
password fields), a target descriptor (tag, attributes, node path, fractional position within
the element) and **`trusted`** — `event.isTrusted`, which is how a real gesture is told apart
from a synthetic one. `input.pointermove` is sampled at `pointerMoveMs` and can include the
coalesced sequence.

## Network

Observed three ways, because no single one sees everything:

| Source | Types | Sees |
| --- | --- | --- |
| Page hooks | `net.fetch.request/response/error`, `net.xhr.request/response/error`, `net.beacon`, `net.ws.*`, `net.sse.*` | request and response bodies the page itself handled |
| `chrome.webRequest` | `net.request`, `net.completed`, `net.failed` | every request including ones the page cannot see, metadata only |
| Debugger (optional) | `cdp.net.request`, `cdp.net.response`, `cdp.ws.*` | response bodies nothing else exposes |

Sensitive headers are replaced with `[redacted]` when redaction is on. Bodies are truncated at
`networkBodyLimit` with a `[...+N]` marker.

## Resources

| Type | Payload |
| --- | --- |
| `page.resources` | every script, stylesheet and import the document references |
| `resource.source` | url, kind, status, content type, size, sha256, and the text when it could be fetched |
| `resource.skipped` | why: too large, wrong type, or over the session budget |
| `resource.error` | the fetch failed, with the reason |
| `perf.resources` | `PerformanceResourceTiming` entries |

Fetched with `credentials: 'omit'`. With `include`, cross-origin CDN requests fail CORS and
every fetch is lost — which is the kind of thing this tool exists to find out.

## Page internals

| Type | Payload |
| --- | --- |
| `console.log` / `.info` / `.warn` / `.error` / `.debug` / `.trace` | arguments, serialised defensively, with a stack |
| `page.error`, `page.unhandledrejection` | message, stack, source position |
| `page.globals` | globals added to `window` since load whose names look interesting, plus well-known framework hooks |
| `page.state` | the result of a framework state probe: per element, the React fibre chain (component name, props, state), or Vue / Svelte / Angular equivalents |
| `page.history`, `page.popstate` | `pushState` / `replaceState` calls and navigations |
| `page.visibility`, `page.hide`, `page.beforeunload`, `page.resize`, `page.scroll` | lifecycle and viewport |

`page.state` is the one that tends to matter most on a server-driven app, where the data the
page renders exists only as a component prop — not in the DOM, and not in any JSON response.

## Storage

| Type | Payload |
| --- | --- |
| `storage.snapshot` | all of localStorage and sessionStorage, keys that look like credentials redacted |
| `storage.setItem`, `storage.removeItem`, `storage.clear` | live writes as they happen, with the value |
| `storage.idb.list` | the databases present |
| `storage.idb.dump` | object store contents, capped per store |
| `storage.idb.error` | what could not be read |

## Media

`screenshot` carries a JPEG in `assets`; `screenshot.skipped` and `screenshot.error` record
why one did not happen (rate limit, missing permission, protected page).

## Writing your own events

Anything that can reach the extension can add to the recording, which is useful for marking
what your own code was doing:

```js
chrome.runtime.sendMessage(EXTENSION_ID, { type: 'note', label: 'checkout', step: 3, cartId: 'x' });
```

The payload is kept as sent, minus `type`. A fixed field list is what makes a recording
useless to whoever reads it next, so there is no schema beyond `label`.
