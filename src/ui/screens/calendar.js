// 予定: day timeline (drag to move, drag handle to resize, tap empty slot to add), week, month.

import { html, useEffect, useMemo, useRef, useState } from '../h.js';
import { Icon } from '../icons.js';
import { Empty, NavButton, Screen, Section, Segmented } from '../components.js';
import { openItemDetail, openQuickAdd } from '../forms.js';
import { categoryOf } from '../../core/model.js';
import { conflictKeys, dayItems, itemsInRange, layoutColumns, span } from '../../core/schedule.js';
import { addDays, dateKey, diffDays, formatDuration, hhmm, minutesOfDay, parseDateKey, startOfWeek, WEEKDAYS, snap, clamp } from '../../core/time.js';
import { haptic, nav, openSheet, useAppState, useNow } from '../runtime.js';
import * as ops from '../ops.js';

const SNAP = 5;

function useSwipeNav(onPrev, onNext) {
  const s = useRef(null);
  return {
    onTouchStart(e) { if (e.touches.length === 1) s.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }; },
    onTouchEnd(e) {
      const st = s.current; s.current = null;
      if (!st || document.documentElement.classList.contains('dragging')) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - st.x, dy = t.clientY - st.y;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8 && Date.now() - st.t < 600) { haptic('light'); dx < 0 ? onNext() : onPrev(); }
    },
  };
}

/* ---------- day timeline ---------- */

function DayTimeline({ state, date, now, hourH }) {
  const items = useMemo(() => dayItems(state, date), [state, date]);
  const timed = items.filter((i) => !i.allDay);
  const allDay = items.filter((i) => i.allDay);
  const cols = useMemo(() => layoutColumns(timed), [items]);
  const conflicts = useMemo(() => conflictKeys(items), [items]);
  const ref = useRef();
  const [drag, setDrag] = useState(null); // {item, mode:'move'|'resize', startMin, durationMin}
  const dragRef = useRef(null);
  const isToday = date === dateKey(new Date(now));
  const nowM = minutesOfDay(now);
  const pxPerMin = hourH / 60;

  // Scroll to "now" (today) or to the start of the day.
  useEffect(() => {
    const scroller = ref.current?.closest('.scroll');
    if (!scroller) return;
    const target = isToday ? nowM - 90 : Math.min(state.settings.dayStartMin, timed[0]?.startMin ?? 1440);
    const top = ref.current.offsetTop + Math.max(0, target) * pxPerMin - 8;
    scroller.scrollTop = top;
  }, [date]);

  // Block page scrolling while dragging (non-passive listener; React-style handlers are passive).
  useEffect(() => {
    const el = ref.current;
    const stop = (e) => { if (dragRef.current) e.preventDefault(); };
    el.addEventListener('touchmove', stop, { passive: false });
    return () => el.removeEventListener('touchmove', stop);
  }, []);

  const minuteAt = (clientY) => (clientY - ref.current.getBoundingClientRect().top) / pxPerMin;

  const beginDrag = (item, mode, e) => {
    if (item.kind === 'course') return;
    const st = { item, mode, y0: e.clientY, startMin: item.startMin, durationMin: item.durationMin, pointerId: e.pointerId };
    dragRef.current = st;
    setDrag({ ...st });
    document.documentElement.classList.add('dragging');
    haptic('medium');
  };
  const onMove = (e) => {
    const st = dragRef.current;
    if (!st) return;
    const dm = (e.clientY - st.y0) / pxPerMin;
    if (st.mode === 'move') st.startMin = clamp(snap(st.item.startMin + dm, SNAP), 0, 1440 - st.item.durationMin);
    else st.durationMin = clamp(snap(st.item.durationMin + dm, SNAP), 5, 1440 - st.item.startMin);
    setDrag({ ...st });
  };
  const justDragged = useRef(false);
  const endDrag = () => {
    const st = dragRef.current;
    dragRef.current = null;
    const changed = st && (st.startMin !== st.item.startMin || st.durationMin !== st.item.durationMin);
    // A tap on the resize grip is still a tap; only a real drag swallows the following click.
    if (st && (changed || st.mode === 'move')) { justDragged.current = true; setTimeout(() => { justDragged.current = false; }, 400); }
    document.documentElement.classList.remove('dragging');
    setDrag(null);
    if (!st) return;
    if (changed) ops.moveOccurrence(st.item, date, st.startMin, st.durationMin);
  };

  const pressTimer = useRef(null);
  const blockHandlers = (item) => ({
    onPointerDown(e) {
      if (e.target.closest('.resize')) return;
      const x = e.clientX, y = e.clientY;
      pressTimer.current = { x, y, t: setTimeout(() => { pressTimer.current = null; beginDrag(item, 'move', e); }, 380) };
    },
    onPointerMove(e) {
      if (pressTimer.current && Math.hypot(e.clientX - pressTimer.current.x, e.clientY - pressTimer.current.y) > 8) { clearTimeout(pressTimer.current.t); pressTimer.current = null; }
    },
    onPointerUp() { if (pressTimer.current) { clearTimeout(pressTimer.current.t); pressTimer.current = null; } },
    onClick(e) { e.stopPropagation(); if (!drag && !justDragged.current) openItemDetail(item); },
    onContextMenu(e) { e.preventDefault(); },
  });

  const hours = Array.from({ length: 25 }, (_, h) => h);
  const dayStart = state.settings.dayStartMin, dayEnd = state.settings.dayEndMin;

  return html`
    ${allDay.length > 0 && html`<div class="allday">${allDay.map((i) => html`<button key=${i.key} class="allday-chip" style=${`--c:${categoryOf(state, i.categoryId).color}`} onClick=${() => openItemDetail(i)}>${i.title}</button>`)}</div>`}
    <div class=${`timeline ${drag ? 'is-dragging' : ''}`} ref=${ref} style=${`height:${24 * hourH}px;--h:${hourH}px`}
      onPointerMove=${onMove} onPointerUp=${endDrag} onPointerCancel=${endDrag}
      onClick=${(e) => {
        if (drag || justDragged.current || e.target.closest('.block')) return;
        const m = snap(minuteAt(e.clientY) - 15, 15);
        openQuickAdd({ mode: 'event', date, startMin: clamp(m, 0, 1425) });
      }}>
      <div class="off-hours" style=${`top:0;height:${dayStart * pxPerMin}px`}></div>
      <div class="off-hours" style=${`top:${dayEnd * pxPerMin}px;height:${(1440 - dayEnd) * pxPerMin}px`}></div>
      ${hours.map((h) => html`<div class="hour" key=${h} style=${`top:${h * hourH}px`}><span>${h < 24 ? `${h}:00` : ''}</span></div>`)}
      ${timed.map((it) => {
        const live = drag && drag.item.key === it.key ? drag : null;
        const start = live ? live.startMin : it.startMin, dur = live ? live.durationMin : it.durationMin;
        const c = cols.get(it.key) || { col: 0, cols: 1 };
        const cat = categoryOf(state, it.categoryId);
        const color = it.color || cat.color;
        const sp = span({ ...it, startMin: start, endMin: start + dur });
        const left = `calc(var(--gutter) + (100% - var(--gutter) - 6px) * ${c.col / c.cols})`;
        const width = `calc((100% - var(--gutter) - 6px) / ${c.cols} - 3px)`;
        return html`
          ${it.travelBeforeMin > 0 && html`<div class="travel" key=${it.key + 'tb'} style=${`top:${sp.start * pxPerMin}px;height:${it.travelBeforeMin * pxPerMin}px;left:${left};width:${width};--c:${color}`}><span>移動 ${it.travelBeforeMin}分</span></div>`}
          ${it.travelAfterMin > 0 && html`<div class="travel" key=${it.key + 'ta'} style=${`top:${(start + dur) * pxPerMin}px;height:${it.travelAfterMin * pxPerMin}px;left:${left};width:${width};--c:${color}`}></div>`}
          <div key=${it.key} role="button" tabindex="0" aria-label=${`${hhmm(start)} ${it.title}`}
            class=${`block ${it.kind} ${it.fixed ? 'fixed' : 'flex'} ${it.done ? 'done' : ''} ${conflicts.has(it.key) ? 'conflict' : ''} ${live ? 'lifted' : ''} ${dur < 30 ? 'short' : ''}`}
            style=${`top:${start * pxPerMin}px;height:${Math.max(18, dur * pxPerMin - 2)}px;left:${left};width:${width};--c:${color}`}
            ...${blockHandlers(it)} onKeyDown=${(e) => { if (e.key === 'Enter') openItemDetail(it); }}>
            <span class="block-title"><${Icon} name=${it.icon} />${it.title}</span>
            ${dur >= 30 && html`<span class="block-time">${hhmm(start)}–${hhmm(start + dur)}${it.location ? ` · ${it.location}` : ''}</span>`}
            ${live && html`<span class="drag-label">${hhmm(start)}–${hhmm(start + dur)}</span>`}
            ${it.kind !== 'course' && html`<span class="resize" aria-hidden="true" onPointerDown=${(e) => { e.stopPropagation(); beginDrag(it, 'resize', e); }}></span>`}
          </div>`;
      })}
      ${date === dateKey(new Date(now)) && html`<div class="now-line" style=${`top:${nowM * pxPerMin}px`}><span>${hhmm(nowM)}</span></div>`}
    </div>`;
}

/* ---------- week ---------- */

function WeekGrid({ state, start, now, onPick }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const items = useMemo(() => itemsInRange(state, days[0], days[6]), [state, start]);
  const H = 34, px = H / 60;
  const from = Math.floor(state.settings.dayStartMin / 60), to = Math.ceil(state.settings.dayEndMin / 60);
  const today = dateKey(new Date(now));
  return html`<div class="week">
    <div class="week-head">${days.map((d) => html`<button key=${d} class=${`wd ${d === today ? 'today' : ''}`} onClick=${() => onPick(d)}><small>${WEEKDAYS[parseDateKey(d).getDay()]}</small><span>${parseDateKey(d).getDate()}</span></button>`)}</div>
    <div class="week-body" style=${`height:${(to - from) * H}px`}>
      ${Array.from({ length: to - from }, (_, i) => html`<div class="whour" key=${i} style=${`top:${i * H}px`}><span>${from + i}</span></div>`)}
      ${days.map((d, col) => html`<button key=${d} class="wcol" style=${`left:calc(var(--wg) + (100% - var(--wg)) / 7 * ${col});width:calc((100% - var(--wg)) / 7)`} onClick=${() => onPick(d)} aria-label=${`${d}を表示`}>
        ${items.filter((i) => i.date === d && !i.allDay).map((i) => html`<span key=${i.key} class=${`wblock ${i.done ? 'done' : ''}`} style=${`top:${Math.max(0, i.startMin - from * 60) * px}px;height:${Math.max(10, i.durationMin * px - 1)}px;--c:${i.color || categoryOf(state, i.categoryId).color}`}>${i.title}</span>`)}
        ${d === today && html`<span class="wnow" style=${`top:${(minutesOfDay(now) - from * 60) * px}px`}></span>`}
      </button>`)}
    </div>
  </div>`;
}

/* ---------- month ---------- */

function MonthGrid({ state, month, selected, onSelect, now }) {
  const first = parseDateKey(month);
  const gridStart = startOfWeek(month, state.settings.weekStart);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const items = useMemo(() => itemsInRange(state, days[0], days[41]), [state, month]);
  const byDay = useMemo(() => { const m = new Map(); for (const i of items) { if (!m.has(i.date)) m.set(i.date, []); m.get(i.date).push(i); } return m; }, [items]);
  const dueByDay = useMemo(() => { const m = new Map(); for (const t of Object.values(state.tasks)) if (!t.done && t.dueDate) m.set(t.dueDate, (m.get(t.dueDate) || 0) + 1); return m; }, [state]);
  const today = dateKey(new Date(now));
  const heads = Array.from({ length: 7 }, (_, i) => WEEKDAYS[(state.settings.weekStart + i) % 7]);
  return html`<div class="month">
    <div class="month-head">${heads.map((h) => html`<span key=${h}>${h}</span>`)}</div>
    <div class="month-grid">${days.map((d) => {
      const inMonth = parseDateKey(d).getMonth() === first.getMonth();
      const list = byDay.get(d) || [];
      return html`<button key=${d} class=${`mday ${inMonth ? '' : 'other'} ${d === today ? 'today' : ''} ${d === selected ? 'sel' : ''}`} onClick=${() => onSelect(d)} aria-label=${`${d} ${list.length}件`}>
        <span class="mnum">${parseDateKey(d).getDate()}</span>
        <span class="mbars">${list.slice(0, 3).map((i) => html`<i key=${i.key} style=${`--c:${i.color || categoryOf(state, i.categoryId).color}`}></i>`)}${list.length > 3 ? html`<b>+${list.length - 3}</b>` : ''}</span>
        ${dueByDay.get(d) ? html`<span class="mdue">${dueByDay.get(d)}</span>` : ''}
      </button>`;
    })}</div>
  </div>`;
}

function Earnings({ state, month }) {
  const first = month, last = addDays(addDays(month.slice(0, 8) + '01', 32).slice(0, 8) + '01', -1);
  const paid = state.categories.filter((c) => c.wagePerHour > 0);
  if (!paid.length) return null;
  const items = itemsInRange(state, first, last);
  const rows = paid.map((c) => {
    const list = items.filter((i) => i.categoryId === c.id && !i.allDay);
    const min = list.reduce((s, i) => s + i.durationMin, 0);
    return { c, shifts: list.length, min, yen: Math.round((min / 60) * c.wagePerHour + list.length * (c.transportPerShift || 0)) };
  }).filter((r) => r.shifts);
  if (!rows.length) return null;
  return html`<${Section} title="今月の勤務" footer="予定の時間 × 時給 ＋ 交通費の見込みです（休憩は含みません）。">
    ${rows.map((r) => html`<div class="row" key=${r.c.id}><span class="row-icon" style=${`background:${r.c.color}`}><${Icon} name="briefcase" /></span>
      <span class="row-main"><span class="row-title">${r.c.name}</span><span class="row-sub">${r.shifts}回 · ${formatDuration(r.min)}</span></span><span class="row-value">¥${r.yen.toLocaleString()}</span></div>`)}
  <//>`;
}

function PlanTasksSheet({ close, date }) {
  const s = useAppState();
  const tasks = Object.values(s.tasks).filter((t) => !t.done && !t.plan).sort((a, b) => b.priority - a.priority || (a.dueDate || '9').localeCompare(b.dueDate || '9'));
  return html`<div class="sheet-head"><span></span><h2>空き時間に入れる</h2><button class="text-btn strong" onClick=${() => close()}>完了</button></div>
    <div class="sheet-body">
      <p class="lead-text">タップすると${date === dateKey() ? '今から' : 'その日'}の最初の空き時間に配置します。</p>
      ${tasks.length === 0 && html`<${Empty} title="未配置のタスクはありません" />`}
      <div class="group">${tasks.map((t) => html`<button class="row" key=${t.id} onClick=${() => { ops.planInFreeTime(t, date); }}>
        <span class="row-main"><span class="row-title">${t.title}</span><span class="row-sub">${formatDuration(t.estimateMin)}${t.dueDate ? ` · 締切 ${t.dueDate}` : ''}</span></span><${Icon} name="plus" cls="chev" /></button>`)}</div>
    </div>`;
}

export function CalendarScreen({ state, active }) {
  const now = useNow(60_000);
  const navState = nav.use();
  const today = dateKey(new Date(now));
  const [view, setView] = useState(state.settings.calendarView || 'day');
  const [date, setDate] = useState(today);
  const hourH = state.settings.hourHeight || 56;

  useEffect(() => {
    if (navState.tab === 'calendar' && navState.calDate) {
      setDate(navState.calDate);
      if (navState.calView) setView(navState.calView);
      nav.set({ ...navState, calDate: null, calView: null });
    }
  }, [navState]);

  const step = (n) => setDate((d) => (view === 'day' ? addDays(d, n) : view === 'week' ? addDays(d, 7 * n) : (() => { const x = parseDateKey(d); x.setDate(1); x.setMonth(x.getMonth() + n); return dateKey(x); })()));
  const swipe = useSwipeNav(() => step(-1), () => step(1));
  const weekStart = startOfWeek(date, state.settings.weekStart);
  const strip = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const d = parseDateKey(date);
  const title = view === 'month' ? `${d.getFullYear()}年${d.getMonth() + 1}月` : `${d.getMonth() + 1}月${view === 'day' ? `${d.getDate()}日` : ''}`;
  const rel = diffDays(today, date);
  const subtitle = view === 'day' ? `${WEEKDAYS[d.getDay()]}曜日${rel === 0 ? ' · 今日' : rel === 1 ? ' · 明日' : rel === -1 ? ' · 昨日' : ''}` : view === 'week' ? `${weekStart.slice(5).replace('-', '/')} 〜 ${addDays(weekStart, 6).slice(5).replace('-', '/')}` : '';
  const stripCounts = useMemo(() => { const m = {}; for (const i of itemsInRange(state, strip[0], strip[6])) m[i.date] = (m[i.date] || 0) + 1; return m; }, [state, weekStart]);

  return html`<${Screen} id="calendar" active=${active} title=${title} subtitle=${subtitle}
    actions=${html`
      ${date !== today && html`<button class="pill-btn" onClick=${() => setDate(today)}>今日</button>`}
      <${NavButton} icon="plus" label="予定を追加" primary onClick=${() => openQuickAdd({ mode: 'event', date })} />`}
    accessory=${html`<${Segmented} label="表示" value=${view} onChange=${setView} options=${[{ value: 'day', label: '日' }, { value: 'week', label: '週' }, { value: 'month', label: '月' }]} />
      ${view === 'day' && html`<div class="strip" ...${swipe}>
        <button class="strip-nav" aria-label="前の週" onClick=${() => setDate(addDays(date, -7))}><${Icon} name="chevronLeft" /></button>
        ${strip.map((s) => html`<button key=${s} class=${`strip-day ${s === date ? 'sel' : ''} ${s === today ? 'today' : ''}`} onClick=${() => { haptic('light'); setDate(s); }}>
          <small>${WEEKDAYS[parseDateKey(s).getDay()]}</small><span>${parseDateKey(s).getDate()}</span><i class=${stripCounts[s] ? 'has' : ''}></i></button>`)}
        <button class="strip-nav" aria-label="次の週" onClick=${() => setDate(addDays(date, 7))}><${Icon} name="chevronRight" /></button>
      </div>`}
      ${view !== 'day' && html`<div class="period-nav"><button class="icon-btn" aria-label="前へ" onClick=${() => step(-1)}><${Icon} name="chevronLeft" /></button><button class="icon-btn" aria-label="次へ" onClick=${() => step(1)}><${Icon} name="chevronRight" /></button></div>`}`}>

    <div class="cal-body" ...${swipe}>
      ${view === 'day' && html`
        <div class="cal-tools">
          <button class="chip" onClick=${() => openSheet((close) => html`<${PlanTasksSheet} close=${close} date=${date} />`)}><${Icon} name="sparkles" />空き時間にタスクを入れる</button>
        </div>
        <${DayTimeline} state=${state} date=${date} now=${now} hourH=${hourH} />
        <p class="hint center">空いている所をタップで追加 · 長押しで移動 · 下端をドラッグで長さを変更 · 左右スワイプで日付移動</p>`}
      ${view === 'week' && html`<${WeekGrid} state=${state} start=${weekStart} now=${now} onPick=${(x) => { setDate(x); setView('day'); }} />`}
      ${view === 'month' && html`
        <${MonthGrid} state=${state} month=${date.slice(0, 8) + '01'} selected=${date} now=${now} onSelect=${(x) => { haptic('light'); setDate(x); }} />
        <${Section} title=${`${parseDateKey(date).getMonth() + 1}月${parseDateKey(date).getDate()}日`} action=${html`<button class="text-btn" onClick=${() => setView('day')}>日表示</button>`}>
          ${dayItems(state, date).length === 0 && html`<${Empty} icon="calendar" title="予定なし" />`}
          ${dayItems(state, date).map((i) => html`<button class="row" key=${i.key} onClick=${() => openItemDetail(i)}>
            <span class="row-icon" style=${`background:${i.color || categoryOf(state, i.categoryId).color}`}><${Icon} name=${i.icon} /></span>
            <span class="row-main"><span class="row-title">${i.title}</span><span class="row-sub">${i.allDay ? '終日' : `${hhmm(i.startMin)}–${hhmm(i.endMin)}`}</span></span></button>`)}
        <//>
        <${Earnings} state=${state} month=${date.slice(0, 8) + '01'} />`}
    </div>
  <//>`;
}
