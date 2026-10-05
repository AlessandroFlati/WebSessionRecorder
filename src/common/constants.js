/**
 * Shared names, defaults and small helpers.
 *
 * Everything here is site-agnostic on purpose: the recorder knows nothing about any
 * particular page, and what to watch is configuration rather than code.
 */

export const DB_NAME = 'web-session-recorder';
export const DB_VERSION = 1;

export const PORT_NAME = 'web-session-recorder';
export const PAGE_CHANNEL = '__WSR_PAGE_MSG__';

export const DEFAULT_SETTINGS = {
  // DOM
  dom: true,
  domKeyframeMs: 20000,
  mutations: true,
  mutationsPerSecond: 1500,
  styles: true,
  // Resources
  scripts: true,
  scriptBytesPerFile: 4 * 1024 * 1024,
  scriptBytesPerSession: 96 * 1024 * 1024,
  codeBlocks: true,
  // Input
  input: true,
  pointerMoveMs: 25,
  coalescedMoves: true,
  // Network
  network: true,
  networkBodyLimit: 131072,
  webRequestMeta: true,
  // Page internals
  console: true,
  globals: true,
  globalsMs: 15000,
  storage: true,
  indexedDbDump: true,
  // Media
  screenshotOnClick: false,
  screenshotIntervalMs: 0,
  screenshotQuality: 55,
  // Fidelity / privacy
  useDebugger: false,
  redact: true,

  /**
   * Recording never starts on its own unless both of these are set. A recorder that arms
   * itself on every page is not something anyone should turn on by accident, so the list is
   * empty by default and has to name the URLs it applies to.
   */
  autoRecord: false,
  autoRecordPatterns: [],

  /**
   * What the per-element style and geometry capture should follow. The defaults are generic
   * structural and interactive elements; a page with its own idea of a "cell" can add to the
   * list without touching any code.
   */
  watchSelectors: [],
  focusSelectors: []
};

export const REDACTED = '[redacted]';

export const SENSITIVE_HEADER_RE =
  /^(cookie|set-cookie|authorization|proxy-authorization|csrf-token|x-csrf-token|x-api-key|api-key|jsessionid)$/i;
export const SENSITIVE_KEY_RE = /(token|auth|session|jwt|password|secret|cookie|bearer|credential)/i;

/** The host of a URL, for labelling a session. Never throws on a malformed one. */
export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Whether `url` matches one of `patterns`.
 *
 * The patterns are the familiar match-pattern shape - `https://example.com/*`,
 * `*://*.example.com/app/*` - because that is what anyone configuring a browser extension
 * already expects. A pattern that will not compile is ignored rather than throwing, since it
 * comes from a text box.
 */
export function matchesAny(url, patterns) {
  if (!url || !Array.isArray(patterns)) return false;
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern.trim()) continue;
    const escaped = pattern
      .trim()
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    try {
      if (new RegExp(`^${escaped}$`, 'i').test(url)) return true;
    } catch {
      /* a pattern typed by hand; skip it rather than fail the navigation */
    }
  }
  return false;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
