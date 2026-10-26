// App state container: immutable snapshots, labelled mutations, undo, debounced persistence,
// cross-tab coordination. UI code calls `mutate(label, draft => {...})` and subscribes.

import { defaultState, looksLikeState, normalizeState } from '../core/model.js';
import { migrateLegacy, readLegacy } from '../core/migrate.js';
import { addBackup, latestValidBackup, loadDoc, requestPersistence, saveDoc } from './storage.js';

const listeners = new Set();
const undoStack = [];
const UNDO_LIMIT = 40;

let state = defaultState();
let saveTimer = null;
let saving = Promise.resolve();
let lastSaveError = null;
let lastSavedAt = null;
let bootInfo = { source: null, migrated: null };
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('todaytime-pro') : null;

export const getState = () => state;
export const getBootInfo = () => bootInfo;
export const saveStatus = () => ({ lastSaveError, lastSavedAt });

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) { try { fn(state); } catch (e) { console.error(e); } }
}

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

/**
 * Apply a change. `fn` receives a deep copy it may mutate (or return a replacement).
 * @returns {object} the new state
 */
export function mutate(label, fn, { undoable = true } = {}) {
  const before = state;
  const draft = clone(state);
  const ret = fn(draft);
  const next = ret && typeof ret === 'object' && ret.schema ? ret : draft;
  next.rev = (before.rev || 0) + 1;
  next.meta.updatedAt = Date.now();
  if (undoable) {
    undoStack.push({ label, state: before });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }
  state = next;
  scheduleSave();
  emit();
  return state;
}

export function canUndo() { return undoStack.length > 0; }
export function peekUndo() { return undoStack[undoStack.length - 1]?.label || null; }

export function undo() {
  const entry = undoStack.pop();
  if (!entry) return null;
  const restored = clone(entry.state);
  restored.rev = (state.rev || 0) + 1; // newer than anything saved, so it wins on reload
  state = restored;
  scheduleSave();
  emit();
  return entry.label;
}

function scheduleSave(delay = 250) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, delay);
}

export function flush() {
  clearTimeout(saveTimer);
  const doc = state;
  saving = saving.then(async () => {
    try {
      await saveDoc(doc);
      lastSaveError = null;
      lastSavedAt = Date.now();
      channel?.postMessage({ type: 'saved', rev: doc.rev });
      await maybeDailyBackup(doc);
    } catch (e) {
      lastSaveError = e?.message || String(e);
      console.error('save failed', e);
    }
    for (const fn of saveListeners) fn({ lastSaveError, lastSavedAt });
  });
  return saving;
}

const saveListeners = new Set();
export function onSave(fn) { saveListeners.add(fn); return () => saveListeners.delete(fn); }

async function maybeDailyBackup(doc) {
  const last = doc.meta.lastBackupAt || 0;
  if (Date.now() - last < 20 * 3600_000) return;
  if (await addBackup(doc, 'daily')) {
    state.meta.lastBackupAt = Date.now(); // metadata only; no rev bump, no undo entry
  }
}

/** Replace the whole state (restore / import). Always undoable and backed up first. */
export async function replaceState(doc, label) {
  await addBackup(state, `before:${label}`);
  mutate(label, () => normalizeState({ ...doc, rev: state.rev }));
  await flush();
}

export async function boot() {
  const { doc, source, idbError, corrupt, raw } = await loadDoc(looksLikeState);
  const backup = !doc && corrupt ? await latestValidBackup(looksLikeState) : null;
  if (doc) {
    state = normalizeState(doc);
    bootInfo = { source, migrated: null, idbError: idbError?.message || null };
  } else if (backup) {
    // Main copies are unreadable: recover from the newest automatic backup.
    state = normalizeState(backup.doc);
    bootInfo = { source: 'backup', recoveredFrom: backup.at, migrated: null, idbError: idbError?.message || null };
    await saveDoc(state).catch(() => {});
  } else {
    // Keep an unreadable document as a backup entry instead of silently overwriting it.
    if (corrupt && raw && typeof raw === 'object') await addBackup(raw, 'unreadable-original');
    // First launch of v3: import the previous app's data if present (read-only on the old keys).
    let found = null;
    try { found = readLegacy((k) => localStorage.getItem(k)); } catch { /* storage blocked */ }
    if (found) {
      const { state: migrated, report } = migrateLegacy(found);
      state = migrated;
      bootInfo = { source: 'legacy', migrated: { from: found.key, report }, idbError: idbError?.message || null };
      await saveDoc(state).catch(() => {});
      await addBackup(state, 'after-migration');
    } else {
      state = defaultState();
      bootInfo = { source: 'fresh', migrated: null, idbError: idbError?.message || null };
    }
  }
  requestPersistence();
  channel?.addEventListener('message', async (ev) => {
    if (ev.data?.type !== 'saved' || ev.data.rev <= state.rev) return;
    const { doc: d } = await loadDoc(looksLikeState);
    if (d && looksLikeState(d) && d.rev > state.rev) { state = normalizeState(d); undoStack.length = 0; emit(); }
  });
  const flushNow = () => { if (saveTimer) flush(); };
  addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });
  emit();
  return state;
}

/** Re-run the legacy import on demand (Settings → データ移行). */
export function legacyAvailable() {
  try { return readLegacy((k) => localStorage.getItem(k)); } catch { return null; }
}
