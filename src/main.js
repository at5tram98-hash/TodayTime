// Entry point: boot storage, install native-feel guards, render, register the service worker.

import { html, render } from './ui/h.js';
import { App } from './ui/app.js';
import { boot, getBootInfo, getState, subscribe } from './data/store.js';
import { nav, toast } from './ui/runtime.js';
import { onInAppNotice, reschedule } from './services/notify.js';

/* ---------- native-feel guards ----------
   Suppress browser-only behaviour (zoom gestures, callouts, selection on UI chrome, context
   menus) without breaking text entry: inputs, textareas and `.selectable` text stay selectable,
   and the in-app text-size setting replaces pinch zoom. */
const editable = (el) => !!el?.closest?.('input, textarea, select, [contenteditable="true"], .selectable');

document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => { if (!editable(e.target)) e.preventDefault(); });
document.addEventListener('selectstart', (e) => { if (!editable(e.target)) e.preventDefault(); });
document.addEventListener('dragstart', (e) => { if (!editable(e.target)) e.preventDefault(); });
document.addEventListener('dblclick', (e) => { if (!editable(e.target)) e.preventDefault(); }, { passive: false });
addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0'].includes(e.key)) e.preventDefault(); });

// Keep a correct viewport height and expose the on-screen keyboard height to CSS.
function syncViewport() {
  const vv = window.visualViewport;
  const kb = vv ? Math.max(0, innerHeight - vv.height - vv.offsetTop) : 0;
  document.documentElement.style.setProperty('--kb', `${Math.round(kb)}px`);
  document.documentElement.classList.toggle('keyboard', kb > 120);
}
visualViewport?.addEventListener('resize', syncViewport);
visualViewport?.addEventListener('scroll', syncViewport);
// iOS scrolls the whole page to reveal a focused input; snap the document back.
addEventListener('scroll', () => { if (scrollY !== 0 && !document.documentElement.classList.contains('keyboard')) scrollTo(0, 0); });

/* ---------- boot ---------- */

async function start() {
  const root = document.getElementById('root');
  try {
    await boot();
  } catch (e) {
    console.error(e);
    root.innerHTML = '<div class="fatal"><h1>読み込みに失敗しました</h1><p>ブラウザの保存領域にアクセスできません。プライベートブラウズを解除するか、再読み込みしてください。</p><button onclick="location.reload()">再読み込み</button></div>';
    return;
  }
  try { const t = sessionStorage.getItem('tt:tab'); if (t) nav.set({ ...nav.get(), tab: t }); } catch { /* ignore */ }
  render(html`<${App} />`, root);
  document.documentElement.classList.remove('booting');
  document.getElementById('splash')?.remove();

  const info = getBootInfo();
  if (info.source === 'backup') setTimeout(() => toast(`保存データが読めなかったため、${new Date(info.recoveredFrom).toLocaleString('ja-JP')}の自動バックアップから復元しました`, { ms: 8000 }), 600);
  if (info.migrated) {
    const r = info.migrated.report;
    setTimeout(() => toast(`旧バージョンのデータを引き継ぎました（予定${r.events}・課題${r.assignments}・タスク${r.tasks}）`, { ms: 6000 }), 600);
  }

  onInAppNotice(({ title, body }) => toast(`${title} — ${body}`, { ms: 6000 }));
  let last = 0;
  const arm = () => { if (Date.now() - last > 1000) { last = Date.now(); reschedule(getState()); } };
  subscribe(() => setTimeout(arm, 50));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reschedule(getState()); });
  reschedule(getState());

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) registerSW();
}

function registerSW() {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const prompt = (w) => toast('新しいバージョンがあります', { ms: 15000, action: { label: '更新', run: () => w.postMessage('skipWaiting') } });
    if (reg.waiting && navigator.serviceWorker.controller) prompt(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) prompt(w); });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((e) => console.warn('SW registration failed', e));
  // Reload only when an existing worker is replaced (user tapped 更新), never on first install.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
}

start();
