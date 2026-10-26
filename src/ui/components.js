// Shared building blocks: screen with collapsing large title, grouped lists, controls, task rows.

import { html, useEffect, useRef, useState } from './h.js';
import { Icon } from './icons.js';
import { categoryOf } from '../core/model.js';
import { formatDateLabel, formatDuration, hhmm, relativeDue, toInstant } from '../core/time.js';
import { predictDuration } from '../core/predict.js';
import { haptic, openMenu, useLongPress } from './runtime.js';
import * as ops from './ops.js';

/* ---------- screen chrome ---------- */

export function Screen({ id, title, subtitle, actions, accessory, children, active, onScrollEl }) {
  const ref = useRef();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = ref.current;
    const on = () => setScrolled(el.scrollTop > 36);
    el.addEventListener('scroll', on, { passive: true });
    onScrollEl?.(el);
    return () => el.removeEventListener('scroll', on);
  }, []);
  return html`
    <div class=${`screen ${active ? 'active' : ''}`} id=${id} aria-hidden=${!active} inert=${!active || undefined}>
      <header class=${`nav ${scrolled ? 'scrolled' : ''}`}>
        <div class="nav-bar">
          <div class="nav-compact-title" aria-hidden="true">${title}</div>
          <div class="nav-actions">${actions}</div>
        </div>
        ${accessory && html`<div class="nav-accessory">${accessory}</div>`}
      </header>
      <div class="scroll" ref=${ref}>
        <div class="large-title">
          <h1>${title}</h1>
          ${subtitle && html`<div class="subtitle">${subtitle}</div>`}
        </div>
        ${children}
        <div class="scroll-end"></div>
      </div>
    </div>`;
}

export function NavButton({ icon, label, onClick, primary }) {
  return html`<button class=${`nav-btn ${primary ? 'primary' : ''}`} aria-label=${label} onClick=${onClick}><${Icon} name=${icon} /></button>`;
}

export function Section({ title, footer, action, children, cls = '' }) {
  return html`<section class=${`section ${cls}`}>
    ${(title || action) && html`<div class="section-head"><h2>${title}</h2>${action}</div>`}
    <div class="group">${children}</div>
    ${footer && html`<p class="section-foot">${footer}</p>`}
  </section>`;
}

export function Row({ icon, iconColor, title, subtitle, value, chevron, onClick, danger, children, cls = '' }) {
  const Tag = onClick ? 'button' : 'div';
  return html`<${Tag} class=${`row ${danger ? 'danger' : ''} ${cls}`} onClick=${onClick}>
    ${icon && html`<span class="row-icon" style=${iconColor ? `background:${iconColor}` : ''}><${Icon} name=${icon} /></span>`}
    <span class="row-main"><span class="row-title">${title}</span>${subtitle && html`<span class="row-sub">${subtitle}</span>`}</span>
    ${value != null && html`<span class="row-value">${value}</span>`}
    ${children}
    ${chevron && html`<${Icon} name="chevronRight" cls="chev" />`}
  </${Tag}>`;
}

export function Toggle({ checked, onChange, label }) {
  return html`<button role="switch" aria-checked=${!!checked} aria-label=${label} class=${`switch ${checked ? 'on' : ''}`}
    onClick=${(e) => { e.stopPropagation(); haptic('light'); onChange(!checked); }}><span></span></button>`;
}

export function Segmented({ options, value, onChange, label, small }) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  return html`<div class=${`segmented ${small ? 'small' : ''}`} role="tablist" aria-label=${label} style=${`--n:${options.length};--i:${idx}`}>
    <span class="seg-thumb"></span>
    ${options.map((o) => html`<button role="tab" key=${String(o.value)} aria-selected=${o.value === value} onClick=${() => { if (o.value !== value) { haptic('light'); onChange(o.value); } }}>${o.label}</button>`)}
  </div>`;
}

export function Stepper({ value, onChange, step = 5, min = 5, max = 600, format = (v) => formatDuration(v), label }) {
  return html`<div class="stepper" aria-label=${label}>
    <button aria-label="減らす" onClick=${() => { haptic('light'); onChange(Math.max(min, value - step)); }}><${Icon} name="minus" /></button>
    <span class="stepper-val">${format(value)}</span>
    <button aria-label="増やす" onClick=${() => { haptic('light'); onChange(Math.min(max, value + step)); }}><${Icon} name="plus" /></button>
  </div>`;
}

export function ProgressRing({ value, size = 44, stroke = 5, color = 'var(--tint)', children }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value || 0));
  return html`<span class="ring" style=${`width:${size}px;height:${size}px`}>
    <svg viewBox=${`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx=${size / 2} cy=${size / 2} r=${r} stroke-width=${stroke} class="ring-track" />
      <circle cx=${size / 2} cy=${size / 2} r=${r} stroke-width=${stroke} stroke=${color} stroke-dasharray=${c} stroke-dashoffset=${c * (1 - v)} class="ring-value" transform=${`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
    <span class="ring-label">${children}</span>
  </span>`;
}

export function Empty({ icon = 'checkCircle', title, text, action }) {
  return html`<div class="empty"><${Icon} name=${icon} /><strong>${title}</strong>${text && html`<p>${text}</p>`}${action}</div>`;
}

export function CatIcon({ state, categoryId, icon, color, size = 30 }) {
  const c = color || categoryOf(state, categoryId).color;
  return html`<span class="cat-icon" style=${`--c:${c};width:${size}px;height:${size}px`}><${Icon} name=${icon} /></span>`;
}

/* ---------- task row: tap, swipe, long press ---------- */

export function dueInfo(task, now) {
  if (!task.dueDate) return null;
  const ts = toInstant(task.dueDate, task.dueMin ?? 1439);
  const diff = ts - now;
  const tone = task.done ? '' : diff < 0 ? 'red' : diff < 24 * 3600_000 ? 'orange' : '';
  const label = `${formatDateLabel(task.dueDate)}${task.dueMin != null ? ' ' + hhmm(task.dueMin) : ''}`;
  return { ts, tone, label, rel: relativeDue(ts, now), overdue: diff < 0 && !task.done };
}

export function taskMenuItems(task, { onEdit } = {}) {
  return [
    !task.done && { label: '開始', icon: 'play', run: () => ops.startTask(task) },
    { label: task.done ? '未完了に戻す' : '完了', icon: 'checkCircle', run: () => ops.toggleDone(task) },
    { label: '編集', icon: 'pencil', run: onEdit },
    '-',
    !task.done && { label: '今日の空き時間に入れる', icon: 'sparkles', run: () => ops.planInFreeTime(task) },
    !task.done && { label: '明日に回す', icon: 'forward', run: () => ops.toTomorrow(task) },
    task.plan && { label: '時間の指定を外す', icon: 'xmark', run: () => ops.unplan(task) },
    '-',
    { label: `優先度: ${['なし', '低', '中', '高'][task.priority]}`, icon: 'flag', run: () => setTimeout(() => openMenu([3, 2, 1, 0].map((p) => ({ label: ['なし', '低 !', '中 !!', '高 !!!'][p], icon: task.priority === p ? 'check' : null, run: () => ops.setPriority(task, p) })), { title: '優先度' }), 250) },
    { label: '複製', icon: 'copy', run: () => ops.duplicateTask(task) },
    { label: '削除', icon: 'trash', danger: true, run: () => ops.removeTask(task) },
  ].filter(Boolean);
}

export function TaskRow({ task, state, now, onOpen, running, rows, showPlan = true }) {
  const ref = useRef();
  const g = useRef(null);
  const [dx, setDx] = useState(0);
  const [settling, setSettling] = useState(false);
  const swiped = useRef(false);
  const cat = categoryOf(state, task.categoryId);
  const due = dueInfo(task, now);
  const pred = !task.done && rows ? predictDuration(task, rows) : null;
  const subDone = task.subtasks.filter((s) => s.done).length;

  const lp = useLongPress(
    ({ x, y }) => { g.current = null; setDx(0); openMenu(taskMenuItems(task, { onEdit: () => onOpen(task) }), { anchor: { x, y }, preview: html`<div class="menu-preview-task"><strong>${task.title}</strong>${due && html`<span class=${due.tone}>${due.label}</span>`}</div>` }); },
    () => onOpen(task),
  );

  // Horizontal swipe with direction lock; vertical movement is left to the scroller.
  const W = 88;
  const onDown = (e) => { lp.onPointerDown(e); g.current = { x: e.clientX, y: e.clientY, lock: null, base: dx }; setSettling(false); };
  const onMove = (e) => {
    lp.onPointerMove(e);
    const s = g.current;
    if (!s) return;
    const mx = e.clientX - s.x, my = e.clientY - s.y;
    if (!s.lock) {
      if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.3) { s.lock = 'x'; ref.current.setPointerCapture?.(e.pointerId); }
      else if (Math.abs(my) > 10) { s.lock = 'y'; g.current = null; return; }
    }
    if (s.lock === 'x') {
      let v = s.base + mx;
      const lim = ref.current.offsetWidth;
      if (Math.abs(v) > W * 2.2) v = Math.sign(v) * (W * 2.2 + (Math.abs(v) - W * 2.2) * 0.4);
      setDx(Math.max(-lim, Math.min(lim, v)));
    }
  };
  const onUp = (e) => {
    lp.onPointerUp(e);
    const s = g.current;
    g.current = null;
    if (!s || s.lock !== 'x') return;
    swiped.current = true; // swallow the click that a mouse/pen emits after a drag
    setTimeout(() => { swiped.current = false; }, 400);
    const width = ref.current.offsetWidth;
    setSettling(true);
    if (dx > width * 0.42) { setDx(0); ops.toggleDone(task); return; }
    if (dx < -width * 0.55) { setDx(0); ops.removeTask(task); return; }
    if (dx > W * 0.6) setDx(W);
    else if (dx < -W * 0.6) setDx(-W * 2);
    else setDx(0);
  };
  const reset = () => { setSettling(true); setDx(0); };

  return html`<div class=${`task-row ${task.done ? 'done' : ''} ${running ? 'running' : ''}`} data-task=${task.id}>
    <div class="swipe-actions left" aria-hidden=${dx <= 0}>
      <button class="sw-green" onClick=${() => { reset(); ops.toggleDone(task); }}><${Icon} name="check" /><span>${task.done ? '戻す' : '完了'}</span></button>
    </div>
    <div class="swipe-actions right" aria-hidden=${dx >= 0}>
      <button class="sw-orange" onClick=${() => { reset(); ops.toTomorrow(task); }}><${Icon} name="forward" /><span>明日</span></button>
      <button class="sw-red" onClick=${() => { reset(); ops.removeTask(task); }}><${Icon} name="trash" /><span>削除</span></button>
    </div>
    <div class=${`task-content ${settling ? 'settle' : ''}`} ref=${ref} style=${dx ? `transform:translateX(${dx}px)` : ''}
      onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${(e) => { lp.onPointerCancel(e); g.current = null; reset(); }}
      onClick=${(e) => { if (swiped.current) { swiped.current = false; return; } if (dx) { e.stopPropagation(); reset(); return; } lp.onClick(e); }} onContextMenu=${(e) => e.preventDefault()}>
      <button class=${`check ${task.done ? 'on' : ''}`} style=${`--c:${cat.color}`} aria-label=${task.done ? '未完了に戻す' : '完了にする'}
        onPointerDown=${(e) => e.stopPropagation()} onClick=${(e) => { e.stopPropagation(); ops.toggleDone(task); }}>
        ${task.done && html`<${Icon} name="check" />`}
      </button>
      ${task.icon !== 'circle' && html`<span class="task-icon" style=${`color:${cat.color}`}><${Icon} name=${task.icon} /></span>`}
      <span class="task-main">
        <span class="task-title">${task.priority ? html`<span class="prio">${'!'.repeat(task.priority)}</span>` : ''}${task.title}</span>
        <span class="task-meta">
          ${showPlan && task.plan && html`<span><${Icon} name="clock" />${formatDateLabel(task.plan.date)} ${hhmm(task.plan.startMin)}</span>`}
          ${due && html`<span class=${due.tone}><${Icon} name="flag" />${due.overdue ? due.rel : due.label}</span>`}
          <span>${formatDuration(task.estimateMin)}${pred && Math.abs(pred.minutes - task.estimateMin) >= 10 ? html` <em class="pred" title=${`${pred.basis}${pred.samples}件から予測`}>→予測${formatDuration(pred.minutes)}</em>` : ''}</span>
          ${task.subtasks.length > 0 && html`<span><${Icon} name="checklist" />${subDone}/${task.subtasks.length}</span>`}
          ${task.repeat && html`<span><${Icon} name="repeat" /></span>`}
          ${task.source?.kind === 'moodle' && html`<span class="badge">${task.source.changedAt && now - task.source.changedAt < 3 * 86400_000 ? 'Moodle 更新' : 'Moodle'}</span>`}
        </span>
      </span>
      ${!task.done && (running
        ? html`<span class="live-dot" aria-label="計測中"></span>`
        : html`<button class="play" aria-label=${`${task.title}を開始`} onPointerDown=${(e) => e.stopPropagation()} onClick=${(e) => { e.stopPropagation(); ops.startTask(task); }}><${Icon} name="play" /></button>`)}
    </div>
  </div>`;
}
