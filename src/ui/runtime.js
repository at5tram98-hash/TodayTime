// UI runtime: store binding, clock, overlays (sheets / menus / dialogs), toasts with undo, haptics.

import { useEffect, useRef, useState } from './h.js';
import { getState, subscribe, undo } from '../data/store.js';

/* ---------- store ---------- */

export function useAppState() {
  const [s, set] = useState(getState());
  useEffect(() => subscribe(set), []);
  return s;
}

/* ---------- clock: re-render on a wall-clock boundary; resyncs when the app returns ---------- */

export function useNow(stepMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let t;
    const tick = () => {
      setNow(Date.now());
      t = setTimeout(tick, stepMs - (Date.now() % stepMs) + 5);
    };
    t = setTimeout(tick, stepMs - (Date.now() % stepMs) + 5);
    const vis = () => { if (document.visibilityState === 'visible') setNow(Date.now()); };
    document.addEventListener('visibilitychange', vis);
    addEventListener('focus', vis);
    return () => { clearTimeout(t); document.removeEventListener('visibilitychange', vis); removeEventListener('focus', vis); };
  }, [stepMs]);
  return now;
}

/* ---------- tiny observable for UI-only state ---------- */

function observable(initial) {
  let v = initial;
  const subs = new Set();
  return {
    get: () => v,
    set: (n) => { v = typeof n === 'function' ? n(v) : n; subs.forEach((f) => f(v)); },
    use() {
      const [x, setX] = useState(v);
      useEffect(() => { subs.add(setX); return () => subs.delete(setX); }, []);
      return x;
    },
  };
}

export const overlays = observable([]);
export const toastState = observable(null);
export const nav = observable({ tab: 'today', calDate: null, calView: null });

let seq = 0;

/** Open a bottom sheet. `render(close)` returns content. Returns a close function. */
export function openSheet(render, opts = {}) {
  const id = ++seq;
  const close = (result) => {
    overlays.set((list) => list.map((o) => (o.id === id ? { ...o, closing: true } : o)));
    setTimeout(() => overlays.set((list) => list.filter((o) => o.id !== id)), 280);
    opts.onClose?.(result);
  };
  overlays.set((list) => [...list, { id, kind: 'sheet', render, close, opts }]);
  haptic('light');
  return close;
}

/** iOS-like context menu / action sheet. items: [{label, icon, danger, run, disabled}] or '-' */
export function openMenu(items, { title, anchor, preview } = {}) {
  const id = ++seq;
  const close = () => {
    overlays.set((list) => list.map((o) => (o.id === id ? { ...o, closing: true } : o)));
    setTimeout(() => overlays.set((list) => list.filter((o) => o.id !== id)), 220);
  };
  overlays.set((list) => [...list, { id, kind: 'menu', items, title, anchor, preview, close }]);
  haptic('medium');
  return close;
}

/** Promise-based confirm/choice dialog. buttons: [{label, value, danger, cancel}] */
export function ask(title, message, buttons) {
  return new Promise((resolve) => {
    const id = ++seq;
    const close = (value) => {
      overlays.set((list) => list.map((o) => (o.id === id ? { ...o, closing: true } : o)));
      setTimeout(() => overlays.set((list) => list.filter((o) => o.id !== id)), 200);
      resolve(value);
    };
    overlays.set((list) => [...list, { id, kind: 'dialog', title, message, buttons, close }]);
  });
}

export const confirmDanger = (title, message, label = '削除') =>
  ask(title, message, [{ label: 'キャンセル', value: false, cancel: true }, { label, value: true, danger: true }]);

/** Ask which occurrences a change applies to. Resolves 'this' | 'future' | 'all' | null. */
export function askScope(verb = '変更') {
  return ask(`繰り返しの予定を${verb}`, 'どの予定に適用しますか？', [
    { label: 'この予定のみ', value: 'this' },
    { label: 'これ以降のすべて', value: 'future' },
    { label: 'すべての予定', value: 'all' },
    { label: 'キャンセル', value: null, cancel: true },
  ]);
}

/* ---------- toast + undo ---------- */

let toastTimer;
export function toast(message, { undoable = false, action = null, ms = 3200 } = {}) {
  clearTimeout(toastTimer);
  toastState.set({ id: ++seq, message, undoable, action });
  toastTimer = setTimeout(() => toastState.set(null), ms + (undoable ? 1800 : 0));
}

export function doUndo() {
  const label = undo();
  clearTimeout(toastTimer);
  if (label) {
    haptic('light');
    toastState.set({ id: ++seq, message: `「${label}」を取り消しました`, undoable: false });
    toastTimer = setTimeout(() => toastState.set(null), 2200);
  } else toastState.set(null);
}

/* ---------- haptics (Android/Chrome; iOS Safari has no vibration API) ---------- */

export function haptic(kind = 'light') {
  try {
    if (!getState().settings.haptics || !navigator.vibrate) return;
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    navigator.vibrate(kind === 'heavy' ? 18 : kind === 'medium' ? 12 : kind === 'success' ? [8, 40, 12] : 6);
  } catch { /* ignore */ }
}

/* ---------- gestures ---------- */

/**
 * Long press that does not fight scrolling. Returns props to spread on an element.
 * onLongPress({x, y, target}); onTap() for a normal short tap.
 */
export function useLongPress(onLongPress, onTap, { delay = 420, moveTolerance = 8 } = {}) {
  const st = useRef({});
  const clear = () => { clearTimeout(st.current.timer); st.current.timer = null; };
  return {
    onPointerDown(e) {
      if (e.button > 0) return;
      st.current = { x: e.clientX, y: e.clientY, fired: false, moved: false };
      st.current.timer = setTimeout(() => {
        st.current.fired = true;
        onLongPress?.({ x: st.current.x, y: st.current.y, target: e.currentTarget });
      }, delay);
    },
    onPointerMove(e) {
      if (!st.current.timer) return;
      if (Math.hypot(e.clientX - st.current.x, e.clientY - st.current.y) > moveTolerance) { st.current.moved = true; clear(); }
    },
    onPointerUp() { clear(); },
    onPointerCancel() { st.current.moved = true; clear(); },
    onPointerLeave() { clear(); },
    onClick(e) {
      if (st.current.fired) { e.preventDefault(); e.stopPropagation(); return; }
      if (!st.current.moved) onTap?.(e);
    },
  };
}
