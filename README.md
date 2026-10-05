# Web Session Recorder

A Chrome extension that records what a web page actually did, in enough detail to work out
afterwards how it was built — DOM and mutations, computed styles, every input event, network
traffic, scripts and inline JSON, web storage and IndexedDB, console output, page globals, and
the state a framework is holding behind the rendered HTML.

It is a reverse-engineering and debugging instrument rather than a session-replay product.
Where tools like rrweb reconstruct a visual replay, this keeps the underlying evidence: the
exact event sequence, the bytes that arrived, and the values the page held at the time.

Everything is stored locally in IndexedDB and exported as one NDJSON file per session. Nothing
is uploaded anywhere.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Pin the extension; the popup is the whole interface

Chrome 116 or newer (it uses `world: "MAIN"` content scripts).

## Record

Open the page, press **Start recording**, use the page, press **Stop**. Then **Open** the
session to browse it, or export it as NDJSON.

A few things are worth knowing:

- **Reload after starting** if you want the page's own startup. The content scripts load at
  `document_start` and sit inert, so a recording that begins mid-session misses what happened
  before it — including the first network calls and the initial DOM.
- **Mark** drops a labelled marker into the timeline. Much easier than finding "the moment I
  clicked the thing" afterwards.
- **Framework state** reads what React, Vue, Svelte or Angular is holding for the elements
  matching a selector. That is often the only copy of what the page knew: server-driven apps
  render their data into component props and never put it in the DOM or in a JSON response.

## What gets recorded

| Group | Events | Notes |
| --- | --- | --- |
| DOM | `dom.snapshot`, `dom.mutations`, `dom.styles` | snapshots at keyframes, mutations batched, computed styles for the elements being followed |
| Input | `input.pointerdown`, `input.keydown`, … | with `trusted`, so synthetic events are distinguishable from real ones |
| Network | `net.request`, `net.response`, `net.fetch.*`, `net.xhr.*`, `net.ws.*`, `net.sse.*` | metadata always; bodies when enabled |
| Resources | `resource.source`, `resource.error` | script and stylesheet metadata, with contents when fetchable |
| Page internals | `console.*`, `page.globals`, `page.state` | console, interesting globals, framework state |
| Storage | `storage.snapshot`, `storage.setItem`, `idb.dump` | localStorage, sessionStorage, IndexedDB |
| Session | `session.start`, `mark`, `note`, `screenshot` | markers and anything another script pushed in |

`docs/events.md` describes the payloads.

## Settings

The popup's **Capture settings** covers what to record and how much. Three are worth
explaining:

- **Debugger (full bodies)** attaches the Chrome debugger to get response bodies the page
  never exposes. It works, and Chrome shows a "being debugged" banner on the tab for as long
  as it is on.
- **Auto-record matching URLs** starts recording by itself. It is off by default and does
  nothing until you list URL patterns (`https://example.com/*`, `*://*.example.org/app/*`),
  because a recorder that arms itself everywhere is not something to enable by accident.
- **Extra elements to follow** adds CSS selectors to the per-element style and geometry
  capture, for pages whose structure the defaults miss.

## Privacy

This records a great deal, so it is worth being plain about it.

- Recording is **manual** unless you explicitly configure auto-record with URL patterns.
- Data stays in the browser profile's IndexedDB until you export or delete it.
- With **Redact credentials** on (the default), password field values, `Cookie`,
  `Authorization` and similar headers, and storage keys that look like tokens are replaced
  with `[redacted]`. It is a filter on obvious cases, not a guarantee: a recording of a
  logged-in session can still contain personal data and identifiers, so treat an exported
  session as sensitive.
- Record pages you are entitled to record.

## Hacking on it

```
node tools/check_syntax.js    # parses every file as both module and script
node tools/test_hooks.js      # the page-world hooks install, capture and uninstall cleanly
node tools/test_state.js      # the framework state probe, against stand-in internals
```

`node --check <file>` is not enough on its own: given a path it parses as CommonJS and
reports success for a broken ES module. `tools/check_syntax.js` parses from stdin with an
explicit `--input-type`, which does report the error.

Layout:

```
src/background/   service worker (session lifecycle, ingestion), webRequest observer,
                  debugger capture, resource fetcher
src/content/      recorder.js (isolated world), page-hooks.js (page world)
src/common/       settings, IndexedDB access
src/popup/        the interface
src/viewer/       session browser and NDJSON export
```

Two deliberate constraints, both load-bearing:

- **The recorder never mutates the page.** Node identity is a child-index path, not an
  injected id or attribute. A page watched this way behaves exactly as it would unwatched.
- **The page-world hooks patch `fetch`, `XMLHttpRequest`, `console` and friends only while
  recording**, and restore the originals when it stops, so nothing of the extension sits in
  the page's call stacks the rest of the time.

## Licence

MIT — see [LICENSE](LICENSE).
