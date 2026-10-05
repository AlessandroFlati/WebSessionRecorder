/**
 * Checks the framework state probe in page-hooks.js.
 *
 * Modern pages keep the data they render in framework internals rather than in the DOM, so a
 * recording that captures the markup but not the state behind it is often missing the only
 * copy of what the page knew. The probe runs in the page's own world, where those internals
 * are reachable, and is tested here against stand-ins shaped like the real ones: React hangs
 * a fibre off each node under a `__reactFiber$<id>` key, Vue a `__vue__`, Svelte a
 * `__svelte_meta`.
 *
 * The other half of the test is that it cannot blow up. Framework internals are full of
 * functions, DOM references and cycles, and a probe that throws on any of them is no use.
 *
 * Run: node tools/test_state.js
 */

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../src/content/page-hooks.js'), 'utf8');

const out = console.log.bind(console);
let failures = 0;
function check(name, condition, detail) {
  if (condition) out(`  ok   ${name}`);
  else {
    failures++;
    out(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

/** A page with one element, carrying whichever framework internals the test wants. */
function makePage(build) {
  const posted = [];
  const listeners = [];
  const element = { tagName: 'DIV', getAttribute: () => null };

  const win = {
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    removeEventListener: () => {},
    postMessage: (message) => posted.push(message),
    location: { href: 'https://example.com/app' },
    fetch: () => {},
    WebSocket: class {},
    EventSource: class {},
    navigator: { sendBeacon: () => {} },
    history: { pushState: () => {}, replaceState: () => {} },
    performance: { now: () => 1 }
  };
  win.window = win;

  const doc = {
    querySelectorAll: (selector) => (selector === '[data-testid]' || selector === 'main' ? [element] : []),
    addEventListener: () => {},
    readyState: 'complete',
    documentElement: {},
    title: 'app'
  };

  globalThis.window = win;
  globalThis.document = doc;
  globalThis.performance = win.performance;
  globalThis.location = win.location;
  globalThis.history = win.history;
  globalThis.navigator = win.navigator;
  globalThis.self = win;
  globalThis.XMLHttpRequest = class {};
  globalThis.WebSocket = win.WebSocket;
  globalThis.EventSource = win.EventSource;
  globalThis.Storage = class {};
  globalThis.Node = class {};
  globalThis.console = { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} };

  // The element's internals are built after the globals exist, so a stand-in DOM node is an
  // instance of the same class the probe will test against.
  if (build) build(element);

  eval(source);

  /** Sends a probe request the way the recorder does, and returns the reply payload. */
  const probe = (options) => {
    posted.length = 0;
    for (const fn of listeners) {
      fn({ source: win, data: { __lgCtl: '__WSR_PAGE_MSG__', readState: { id: 'p1', ...options } } });
    }
    const reply = posted.find((m) => m && m.type === 'state.result');
    return reply ? reply.data : null;
  };
  return { probe, element };
}

/* ------------------------------------------------------------------------ react */

{
  out('a React page');
  const page = makePage((el) => {
    const owner = {
      type: { displayName: 'Board' },
      memoizedProps: { puzzle: { size: 6, cells: [1, 2, 3] }, onMove: () => {} },
      memoizedState: null,
      return: null
    };
    const child = { type: 'div', memoizedProps: { className: 'cell' }, return: owner };
    el['__reactFiber$x1y2'] = child;
  });
  const result = page.probe({ selectors: ['[data-testid]'] });
  check('answered', !!result && !result.error, JSON.stringify(result).slice(0, 120));
  check('found one element', (result.found || []).length === 1);
  const frames = result.found[0].react;
  check('walked up to the owning component', frames.some((f) => f.component === 'Board'), JSON.stringify(frames.map((f) => f.component)));
  const board = frames.find((f) => f.component === 'Board');
  check('carried the props', board.props.puzzle.size === 6, JSON.stringify(board.props).slice(0, 120));
  check('kept the nested data', JSON.stringify(board.props.puzzle.cells) === '[1,2,3]');
  check('functions are named, not called', board.props.onMove === '[function onMove]', String(board.props.onMove));
}

{
  out('\nfiltering by prop name');
  const page = makePage((el) => {
    el['__reactFiber$a'] = {
      type: { name: 'Wrapper' },
      memoizedProps: { className: 'x' },
      return: {
        type: { name: 'Game' },
        memoizedProps: { gameState: { score: 7 } },
        return: null
      }
    };
  });
  const all = page.probe({ selectors: ['[data-testid]'] });
  const filtered = page.probe({ selectors: ['[data-testid]'], keyPattern: '^gameState$' });
  check('unfiltered sees both components', all.found[0].react.length === 2, String(all.found[0].react.length));
  check('a key pattern narrows it to one', filtered.found[0].react.length === 1, String(filtered.found[0].react.length));
  check('and it is the right one', filtered.found[0].react[0].component === 'Game');
}

/* -------------------------------------------------------------- hostile internals */

{
  out('\ninternals that would break a naive copy');
  const page = makePage((el) => {
    const circular = { name: 'loop' };
    circular.self = circular;
    const deep = {};
    let node = deep;
    for (let i = 0; i < 40; i++) {
      node.next = {};
      node = node.next;
    }
    el['__reactFiber$b'] = {
      type: { name: 'Nasty' },
      memoizedProps: {
        circular,
        deep,
        element: new globalThis.Node(),
        big: 'x'.repeat(500000),
        many: Array.from({ length: 1000 }, (unused, i) => i),
        when: Symbol('tag')
      },
      return: null
    };
  });
  const result = page.probe({ selectors: ['[data-testid]'] });
  check('still answered', !!result && !result.error, JSON.stringify(result).slice(0, 140));
  const props = result.found[0].react[0].props;
  check('a cycle is marked, not followed', JSON.stringify(props.circular).includes('circular'), JSON.stringify(props.circular));
  check('depth is bounded', JSON.stringify(props.deep).includes('deeper'));
  check('a DOM node is named, not serialised', String(props.element).startsWith('[dom'), String(props.element));
  check('a long string is truncated', String(props.big).includes('truncated'), String(props.big).slice(-20));
  check('a long array is capped', props.many.length < 1000, String(props.many.length));
  check('a symbol survives as text', typeof props.when === 'string');
  const size = JSON.stringify(result).length;
  check('the whole answer stays sendable', size < 400000, `${size} chars`);
}

/* ------------------------------------------------------------- other frameworks */

{
  out('\nVue and Svelte');
  const vue = makePage((el) => { el.__vue__ = { props: { items: [1, 2] } }; });
  const vueResult = vue.probe({ selectors: ['[data-testid]'] });
  check('a Vue component is found', !!vueResult.found && !!vueResult.found[0].vue, JSON.stringify(vueResult).slice(0, 120));
  check('with its props', JSON.stringify(vueResult.found[0].vue.items) === '[1,2]');

  const svelte = makePage((el) => { el.__svelte_meta = { loc: { file: 'App.svelte', line: 12 } }; });
  const svelteResult = svelte.probe({ selectors: ['[data-testid]'] });
  check('a Svelte component is found', !!svelteResult.found[0].svelte);
  check('with where it came from', svelteResult.found[0].svelte.loc.file === 'App.svelte');
}

{
  out('\na page with no framework at all');
  const page = makePage(null);
  const result = page.probe({ selectors: ['[data-testid]'] });
  check('says so rather than guessing', /no framework state/.test(result.error || ''), JSON.stringify(result));
  check('reports what it tried', Array.isArray(result.tried) && result.tried.length > 0);
}

{
  out('\na selector that does not compile');
  const page = makePage((el) => { el['__reactFiber$c'] = { type: { name: 'A' }, memoizedProps: { a: 1 }, return: null }; });
  const result = page.probe({ selectors: ['!!! not a selector', '[data-testid]'] });
  check('skips it and carries on', !!result.found && result.found.length === 1, JSON.stringify(result).slice(0, 140));
}

out(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
