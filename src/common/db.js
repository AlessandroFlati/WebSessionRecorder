import { DB_NAME, DB_VERSION } from './constants.js';

/**
 * IndexedDB access shared by the service worker and the viewer page: both run on the
 * extension origin, so they open the very same database.
 *
 * sessions: { id, startedAt, endedAt, url, title, game, userAgent, settings, counts, bytes, tabId }
 * events:   { sessionId, seq, t, wall, pt, frameId, frameUrl, type, data, assets? }
 * assets:   { id, sessionId, seq, kind, contentType, size, data }
 */

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('byStart', 'startedAt');
      }
      if (!db.objectStoreNames.contains('events')) {
        db.createObjectStore('events', { keyPath: ['sessionId', 'seq'] });
      }
      if (!db.objectStoreNames.contains('assets')) {
        const a = db.createObjectStore('assets', { keyPath: 'id', autoIncrement: true });
        a.createIndex('bySession', 'sessionId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, stores, mode) {
  return db.transaction(stores, mode);
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
  });
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Upper bound for a compound [sessionId, seq] key range: arrays sort after numbers. */
export function sessionRange(sessionId) {
  return IDBKeyRange.bound([sessionId], [sessionId, []]);
}

export async function putSession(session) {
  const db = await openDb();
  const t = tx(db, ['sessions'], 'readwrite');
  t.objectStore('sessions').put(session);
  await done(t);
}

export async function getSession(id) {
  const db = await openDb();
  return reqToPromise(tx(db, ['sessions'], 'readonly').objectStore('sessions').get(id));
}

export async function listSessions() {
  const db = await openDb();
  const all = await reqToPromise(tx(db, ['sessions'], 'readonly').objectStore('sessions').getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

/** Writes events and their attached assets in one transaction. Returns bytes written (approx). */
export async function putEvents(events) {
  if (!events.length) return 0;
  const db = await openDb();
  const t = tx(db, ['events', 'assets'], 'readwrite');
  const eventStore = t.objectStore('events');
  const assetStore = t.objectStore('assets');
  let bytes = 0;
  for (const ev of events) {
    const assets = ev.assets;
    delete ev.assets;
    if (assets) {
      const refs = {};
      for (const [name, asset] of Object.entries(assets)) {
        if (!asset || asset.data == null) continue;
        const size = asset.size != null ? asset.size : byteLength(asset.data);
        bytes += size;
        const key = await reqToPromise(
          assetStore.add({
            sessionId: ev.sessionId,
            seq: ev.seq,
            kind: asset.kind || name,
            contentType: asset.contentType || 'text/plain',
            size,
            data: asset.data
          })
        );
        refs[name] = key;
      }
      if (Object.keys(refs).length) ev.assetRefs = refs;
    }
    bytes += 256;
    eventStore.put(ev);
  }
  await done(t);
  return bytes;
}

function byteLength(data) {
  if (typeof data === 'string') return data.length * 2;
  if (data && typeof data.size === 'number') return data.size;
  if (data && typeof data.byteLength === 'number') return data.byteLength;
  return 0;
}

export async function getAsset(id) {
  const db = await openDb();
  return reqToPromise(tx(db, ['assets'], 'readonly').objectStore('assets').get(id));
}

export async function countEvents(sessionId) {
  const db = await openDb();
  return reqToPromise(tx(db, ['events'], 'readonly').objectStore('events').count(sessionRange(sessionId)));
}

/** Reads a page of events starting after `afterSeq`. */
export async function readEvents(sessionId, afterSeq = -1, limit = 1000) {
  const db = await openDb();
  const store = tx(db, ['events'], 'readonly').objectStore('events');
  const range = IDBKeyRange.bound([sessionId, afterSeq], [sessionId, []], true, false);
  return new Promise((resolve, reject) => {
    const out = [];
    const req = store.openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return resolve(out);
      out.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function listAssets(sessionId) {
  const db = await openDb();
  const store = tx(db, ['assets'], 'readonly').objectStore('assets');
  return new Promise((resolve, reject) => {
    const out = [];
    const req = store.index('bySession').openCursor(IDBKeyRange.only(sessionId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(out);
      const { id, kind, contentType, size, seq } = cursor.value;
      out.push({ id, kind, contentType, size, seq });
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSession(sessionId) {
  const db = await openDb();
  const t = tx(db, ['sessions', 'events', 'assets'], 'readwrite');
  t.objectStore('sessions').delete(sessionId);
  t.objectStore('events').delete(sessionRange(sessionId));
  const idx = t.objectStore('assets').index('bySession');
  const req = idx.openKeyCursor(IDBKeyRange.only(sessionId));
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    t.objectStore('assets').delete(cursor.primaryKey);
    cursor.continue();
  };
  await done(t);
}
