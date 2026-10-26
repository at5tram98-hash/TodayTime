// Overlay host: bottom sheets (drag to dismiss), context menus, dialogs and the undo toast.

import { html, useEffect, useRef, useState } from './h.js';
import { Icon } from './icons.js';
import { doUndo, haptic, overlays, toastState } from './runtime.js';

function Sheet({ o, top }) {
  const ref = useRef();
  const drag = useRef(null);
  const [dy, setDy] = useState(0);

  useEffect(() => {
    if (!top) return;
    const onKey = (e) => { if (e.key === 'Escape') o.close(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [top]);

  // Drag down from the grabber/header area to dismiss, like UISheetPresentationController.
  const down = (e) => {
    if (e.target.closest('button, input, select, textarea, a')) return;
    drag.current = { y: e.clientY, t: Date.now() };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => { if (drag.current) setDy(Math.max(0, e.clientY - drag.current.y)); };
  const up = (e) => {
    if (!drag.current) return;
    const v = (e.clientY - drag.current.y) / Math.max(1, Date.now() - drag.current.t);
    drag.current = null;
    if (dy > 140 || v > 0.6) { haptic('light'); o.close(); } else setDy(0);
  };

  return html`
    <div class=${`sheet-backdrop ${o.closing ? 'out' : ''}`} onClick=${() => o.close()}></div>
    <section ref=${ref} class=${`sheet ${o.closing ? 'out' : ''} ${o.opts.full ? 'full' : ''}`} role="dialog" aria-modal="true" aria-label=${o.opts.label || 'シート'}
      style=${dy ? `transform: translateY(${dy}px); transition: none` : ''}>
      <div class="sheet-drag" onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}>
        <div class="grabber"></div>
      </div>
      ${o.render(o.close)}
    </section>`;
}

function Menu({ o }) {
  const y = o.anchor?.y;
  const vh = innerHeight;
  const pos = y == null ? 'bottom' : (y - 62) > (vh - y - 102) ? 'above' : 'below'; // side with more room
  // Keep the whole menu on screen: anchor next to the finger and cap the list height to the room left.
  const top = Math.max(60, Math.min(y + 12, vh - 300));
  const bottom = Math.max(vh - y + 12, 90);
  const room = y == null ? vh * 0.6 : pos === 'below' ? vh - top - 100 : vh - bottom - 60;
  const style = (y == null ? '' : pos === 'below' ? `top:${top}px;` : `bottom:${bottom}px;`) + `--menu-max:${Math.max(200, room - (o.preview ? 70 : 0))}px`;
  return html`
    <div class=${`menu-backdrop ${o.closing ? 'out' : ''}`} onClick=${() => o.close()} onContextMenu=${(e) => e.preventDefault()}></div>
    <div class=${`menu ${pos} ${o.closing ? 'out' : ''}`} style=${style} role="menu" aria-label=${o.title || 'メニュー'}>
      ${o.preview && html`<div class="menu-preview">${o.preview}</div>`}
      <div class="menu-list">
        ${o.title && html`<div class="menu-title">${o.title}</div>`}
        ${o.items.filter(Boolean).map((it, i) => it === '-' ? html`<div class="menu-sep" key=${'s' + i}></div>` : html`
          <button key=${it.label} role="menuitem" class=${`menu-item ${it.danger ? 'danger' : ''}`} disabled=${it.disabled}
            onClick=${() => { o.close(); haptic('light'); setTimeout(() => it.run?.(), 10); }}>
            <span>${it.label}</span>${it.icon && html`<${Icon} name=${it.icon} />`}
          </button>`)}
      </div>
    </div>`;
}

function Dialog({ o }) {
  const ref = useRef();
  useEffect(() => { ref.current?.querySelector('button:not(.cancel)')?.focus(); }, []);
  const stacked = o.buttons.length > 2;
  return html`
    <div class=${`dialog-backdrop ${o.closing ? 'out' : ''}`}></div>
    <div class=${`dialog ${o.closing ? 'out' : ''}`} role="alertdialog" aria-modal="true" aria-label=${o.title} ref=${ref}>
      <div class="dialog-body"><h2>${o.title}</h2>${o.message && html`<p>${o.message}</p>`}</div>
      <div class=${`dialog-buttons ${stacked ? 'stacked' : ''}`}>
        ${o.buttons.map((b) => html`<button key=${b.label} class=${`${b.danger ? 'danger' : ''} ${b.cancel ? 'cancel' : ''}`} onClick=${() => o.close(b.value)}>${b.label}</button>`)}
      </div>
    </div>`;
}

function Toast() {
  const t = toastState.use();
  if (!t) return null;
  return html`<div class="toast" role="status" aria-live="polite" key=${t.id}>
    <span>${t.message}</span>
    ${t.undoable && html`<button class="toast-btn" onClick=${doUndo}><${Icon} name="undo" /> 取り消す</button>`}
    ${t.action && html`<button class="toast-btn" onClick=${() => { toastState.set(null); t.action.run(); }}>${t.action.label}</button>`}
  </div>`;
}

export function OverlayHost() {
  const list = overlays.use();
  useEffect(() => {
    document.documentElement.classList.toggle('has-overlay', list.length > 0);
  }, [list.length]);
  return html`
    ${list.map((o, i) => html`<div class="overlay-layer" key=${o.id} style=${`z-index:${100 + i * 2}`}>
      ${o.kind === 'sheet' ? html`<${Sheet} o=${o} top=${i === list.length - 1} />` : o.kind === 'menu' ? html`<${Menu} o=${o} />` : html`<${Dialog} o=${o} />`}
    </div>`)}
    <${Toast} />`;
}
