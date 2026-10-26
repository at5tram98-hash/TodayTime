// Persistence: IndexedDB is primary (large quota, transactional); a localStorage mirror is kept
// as a second copy so a broken/evicted IDB never means lost data. Rolling backups live in IDB.

const DB_NAME = 'todaytime-pro';
const DB_VERSION = 1;
export const MIRROR_KEY = 'todaytime:v3:mirror';
const MAX_BACKUPS = 14;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('backups')) db.createObjectStore('backups', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  }).catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  }));
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function loadDoc(isValid) {
  let idbDoc = null, idbError = null;
  try {
    idbDoc = await tx('kv', 'readonly', (s) => reqP(s.get('state')));
  } catch (e) { idbError = e; }
  let mirror = null;
  try { const raw = localStorage.getItem(MIRROR_KEY); if (raw) mirror = JSON.parse(raw); } catch { /* ignore */ }
  // Prefer the newest *valid* copy; a corrupt copy never wins over a good one.
  const valid = [idbDoc, mirror].filter((d) => isValid?.(d) ?? !!d).sort((a, b) => (b.rev || 0) - (a.rev || 0));
  const pick = valid[0] || null;
  const corrupt = !pick && !!(idbDoc || mirror);
  return { doc: pick, source: pick === idbDoc ? 'indexeddb' : pick ? 'mirror' : null, idbError, corrupt, raw: corrupt ? idbDoc || mirror : null };
}

export async function saveDoc(doc) {
  const json = JSON.stringify(doc);
  let idbOk = false, mirrorOk = false, error = null;
  try { await tx('kv', 'readwrite', (s) => reqP(s.put(JSON.parse(json), 'state'))); idbOk = true; } catch (e) { error = e; }
  try { localStorage.setItem(MIRROR_KEY, json); mirrorOk = true; } catch (e) { error = error || e; }
  if (!idbOk && !mirrorOk) throw error || new Error('保存できませんでした');
  return { idbOk, mirrorOk, bytes: json.length };
}

export async function addBackup(doc, reason = 'auto') {
  try {
    await tx('backups', 'readwrite', async (s) => {
      await reqP(s.add({ at: Date.now(), reason, rev: doc.rev, doc: JSON.parse(JSON.stringify(doc)) }));
      const keys = await reqP(s.getAllKeys());
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_BACKUPS))) s.delete(k);
    });
    return true;
  } catch { return false; }
}

export async function listBackups() {
  try {
    const all = await tx('backups', 'readonly', (s) => reqP(s.getAll()));
    return all.map((b) => ({ id: b.id, at: b.at, reason: b.reason, rev: b.rev, counts: { tasks: Object.keys(b.doc.tasks || {}).length, events: Object.keys(b.doc.events || {}).length } })).reverse();
  } catch { return []; }
}

/** Newest backup document that passes `isValid`, or null. */
export async function latestValidBackup(isValid) {
  try {
    const all = await tx('backups', 'readonly', (s) => reqP(s.getAll()));
    for (const b of all.reverse()) if (isValid(b.doc)) return b;
  } catch { /* ignore */ }
  return null;
}

export async function getBackup(id) {
  const b = await tx('backups', 'readonly', (s) => reqP(s.get(id)));
  return b?.doc || null;
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) || false;
  } catch { return false; }
}

export async function storageEstimate() {
  try { return await navigator.storage?.estimate?.(); } catch { return null; }
}
