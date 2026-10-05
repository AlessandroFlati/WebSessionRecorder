/**
 * Checks that the page-world hooks only exist while a recording is running.
 *
 * This is what keeps the extension out of the page's call stacks. With the patches installed
 * permanently, every console warning and every failed request the page made showed
 * page-hooks.js in its stack trace, so the site's own noise looked as though it came from
 * here - and a page is entitled not to be altered by something merely watching it.
 *
 * Run: node tools/test_hooks.js
 */

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../src/content/page-hooks.js'), 'utf8');

// the page's console gets stubbed while the hooks run, so hold on to the real one
const out = console.log.bind(console);

let failures = 0;
function check(name, condition, detail) {
  if (condition) out(`  ok   ${name}`);
  else {
    failures++;
    out(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

function makePage() {
  const listeners = {};
  const natives = {};

  class FakeStorage {}
  FakeStorage.prototype.setItem = function setItem() {};
  FakeStorage.prototype.removeItem = function removeItem() {};

  class FakeXHR {}
  FakeXHR.prototype.open = function open() {};
  FakeXHR.prototype.send = function send() {};
  FakeXHR.prototype.setRequestHeader = function setRequestHeader() {};

  const page = {
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener: () => {},
    postMessage: () => {},
    fetch: function fetch() { return Promise.resolve(); },
    WebSocket: class WebSocket {},
    EventSource: class EventSource {},
    XMLHttpRequest: FakeXHR,
    Storage: FakeStorage,
    history: { pushState: function pushState() {}, replaceState: function replaceState() {} },
    navigator: { sendBeacon: function sendBeacon() {} },
    console: {},
    document: { readyState: 'complete' },
    location: { href: 'https://example.com/app' },
    performance: { now: () => 0 },
    Proxy,
    listeners
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'table']) {
    page.console[level] = function () {};
  }
  // remember what "untouched" looks like
  natives.fetch = page.fetch;
  natives.console = { ...page.console };
  natives.xhrSend = FakeXHR.prototype.send;
  natives.setItem = FakeStorage.prototype.setItem;
  natives.pushState = page.history.pushState;
  natives.sendBeacon = page.navigator.sendBeacon;
  natives.WebSocket = page.WebSocket;
  page.natives = natives;
  return page;
}

function load(page) {
  // expose the fake page as the globals the hooks expect, then run them
  const saved = {};
  const keys = ['window', 'console', 'document', 'location', 'performance', 'navigator', 'history',
                'XMLHttpRequest', 'Storage', 'WebSocket', 'EventSource', 'fetch', 'addEventListener'];
  for (const k of keys) saved[k] = globalThis[k];

  globalThis.window = page;
  globalThis.console = page.console;
  globalThis.document = page.document;
  globalThis.location = page.location;
  globalThis.performance = page.performance;
  globalThis.navigator = page.navigator;
  globalThis.history = page.history;
  globalThis.XMLHttpRequest = page.XMLHttpRequest;
  globalThis.Storage = page.Storage;
  globalThis.WebSocket = page.WebSocket;
  globalThis.EventSource = page.EventSource;
  globalThis.addEventListener = page.addEventListener;
  page.window = page;
  page.self = page;

  eval(source);
  return () => {
    for (const k of keys) globalThis[k] = saved[k];
  };
}

const control = (page, on, settings) => {
  for (const fn of page.listeners.message || []) {
    fn({ source: page, data: { __lgCtl: '__WSR_PAGE_MSG__', on, settings } });
  }
};

const isPatched = (page) =>
  page.fetch !== page.natives.fetch ||
  page.console.warn !== page.natives.console.warn ||
  page.XMLHttpRequest.prototype.send !== page.natives.xhrSend ||
  page.Storage.prototype.setItem !== page.natives.setItem ||
  page.history.pushState !== page.natives.pushState ||
  page.navigator.sendBeacon !== page.natives.sendBeacon ||
  page.WebSocket !== page.natives.WebSocket;

{
  console.log('\nwith no recording running');
  const page = makePage();
  const restore = load(page);
  check('nothing is patched on load', !isPatched(page));
  check('console is still the page’s own', page.console.warn === page.natives.console.warn);
  check('fetch is still the page’s own', page.fetch === page.natives.fetch);
  check('it did register a message listener', (page.listeners.message || []).length > 0);
  restore();
}

{
  console.log('\nwhile recording');
  const page = makePage();
  const restore = load(page);
  control(page, true, { network: true, console: true });
  check('patches are installed', isPatched(page));
  check('console is wrapped', page.console.warn !== page.natives.console.warn);
  check('fetch is wrapped', page.fetch !== page.natives.fetch);
  check('xhr send is wrapped', page.XMLHttpRequest.prototype.send !== page.natives.xhrSend);
  check('storage setItem is wrapped', page.Storage.prototype.setItem !== page.natives.setItem);
  restore();
}

{
  console.log('\nafter the recording stops');
  const page = makePage();
  const restore = load(page);
  control(page, true, { network: true, console: true });
  const wasPatched = isPatched(page);
  control(page, false, {});
  check('was patched while running', wasPatched);
  check('everything is restored', !isPatched(page), 'something stayed wrapped');
  check('console is the original again', page.console.warn === page.natives.console.warn);
  check('fetch is the original again', page.fetch === page.natives.fetch);
  check('xhr send is the original again', page.XMLHttpRequest.prototype.send === page.natives.xhrSend);
  check('websocket is the original again', page.WebSocket === page.natives.WebSocket);
  restore();
}

{
  console.log('\nrepeated start and stop');
  const page = makePage();
  const restore = load(page);
  for (let i = 0; i < 3; i++) {
    control(page, true, { network: true, console: true });
    control(page, false, {});
  }
  check('no wrapper is left behind after three cycles', !isPatched(page));
  control(page, true, { network: true, console: true });
  check('and it still installs afterwards', isPatched(page));
  // a second install must not wrap the wrapper
  const onceWrapped = page.console.warn;
  control(page, true, { network: true, console: true });
  check('installing twice does not double-wrap', page.console.warn === onceWrapped);
  control(page, false, {});
  check('and the original is recovered, not a wrapper', page.console.warn === page.natives.console.warn);
  restore();
}

out(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
