// Editors and detail sheets: quick add, task editor, event editor, timeline item detail.

import { html, useEffect, useMemo, useRef, useState } from './h.js';
import { Icon, ICON_CHOICES } from './icons.js';
import { Row, Section, Segmented, Stepper, Toggle, CatIcon, dueInfo } from './components.js';
import { activeTerm, categoryOf, normalizeRepeat, uid } from '../core/model.js';
import { parseQuickAdd, toTaskFields } from '../core/parse.js';
import { historyRows, predictDuration } from '../core/predict.js';
import { describeRepeat } from '../core/recurrence.js';
import { dayItems, conflictKeys } from '../core/schedule.js';
import { actualMinForTask } from '../core/tracker.js';
import { weekday, addDays, dateKey, formatDateLabel, formatDuration, formatLongDate, hhmm, minutesOfDay, parseHHMM, WEEKDAYS } from '../core/time.js';
import { getState } from '../data/store.js';
import { confirmDanger, openSheet } from './runtime.js';
import * as ops from './ops.js';

function SheetHeader({ title, onCancel, onSave, saveLabel = '完了', saveDisabled }) {
  return html`<div class="sheet-head">
    <button class="text-btn" onClick=${onCancel}>キャンセル</button>
    <h2>${title}</h2>
    <button class="text-btn strong" disabled=${saveDisabled} onClick=${onSave}>${saveLabel}</button>
  </div>`;
}

function IconCategoryPicker({ state, icon, categoryId, onIcon, onCategory }) {
  const [open, setOpen] = useState(false);
  const cat = categoryOf(state, categoryId);
  return html`<div class="picker">
    <div class="picker-head">
      <button class="icon-pick" aria-label="アイコンを選ぶ" aria-expanded=${open} onClick=${() => setOpen(!open)} style=${`--c:${cat.color}`}><${Icon} name=${icon} /></button>
      <div class="chips" role="radiogroup" aria-label="カテゴリ">
        ${state.categories.map((c) => html`<button key=${c.id} role="radio" aria-checked=${c.id === categoryId} class=${`chip ${c.id === categoryId ? 'on' : ''}`} style=${`--c:${c.color}`} onClick=${() => onCategory(c.id)}><span class="dot"></span>${c.name}</button>`)}
      </div>
    </div>
    ${open && html`<div class="icon-grid" role="radiogroup" aria-label="アイコン">
      ${ICON_CHOICES.map((n) => html`<button key=${n} role="radio" aria-checked=${n === icon} class=${n === icon ? 'on' : ''} style=${`--c:${cat.color}`} onClick=${() => { onIcon(n); setOpen(false); }}><${Icon} name=${n} /></button>`)}
    </div>`}
  </div>`;
}

function RepeatEditor({ value, onChange, baseDate }) {
  const freq = value?.freq || 'none';
  const set = (patch) => onChange(normalizeRepeat({ interval: 1, byWeekdays: [], ...(value || {}), ...patch }));
  return html`<div class="field-block">
    <select class="select" aria-label="繰り返し" value=${freq} onChange=${(e) => {
      const f = e.target.value;
      onChange(f === 'none' ? null : normalizeRepeat({ freq: f, interval: 1, byWeekdays: f === 'weekly' ? [weekday(baseDate)] : [] }));
    }}>
      <option value="none">繰り返しなし</option><option value="daily">毎日</option><option value="weekdays">平日（月〜金）</option><option value="weekly">毎週</option><option value="monthly">毎月</option>
    </select>
    ${freq === 'weekly' && html`<div class="weekday-pick" role="group" aria-label="曜日">
      ${[1, 2, 3, 4, 5, 6, 0].map((d) => html`<button key=${d} aria-pressed=${value.byWeekdays.includes(d)} class=${value.byWeekdays.includes(d) ? 'on' : ''}
        onClick=${() => { const s = new Set(value.byWeekdays); s.has(d) ? s.delete(d) : s.add(d); if (s.size) set({ byWeekdays: [...s] }); }}>${WEEKDAYS[d]}</button>`)}
    </div>`}
    ${freq !== 'none' && html`<label class="inline-field">終了日<input type="date" value=${value.until || ''} onChange=${(e) => set({ until: e.target.value || null })} /></label>`}
  </div>`;
}

function ChecklistEditor({ items, onChange, label = 'サブタスク' }) {
  const [text, setText] = useState('');
  const add = () => { const t = text.trim(); if (!t) return; onChange([...items, { id: uid(), title: t, done: false }]); setText(''); };
  return html`<div class="checklist-edit">
    ${items.map((it) => html`<div class="cl-row" key=${it.id}>
      <button class=${`mini-check ${it.done ? 'on' : ''}`} aria-label="チェック" onClick=${() => onChange(items.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)))}>${it.done && html`<${Icon} name="check" />`}</button>
      <input value=${it.title} aria-label=${label} onInput=${(e) => onChange(items.map((x) => (x.id === it.id ? { ...x, title: e.target.value } : x)))} />
      <button class="icon-btn" aria-label="削除" onClick=${() => onChange(items.filter((x) => x.id !== it.id))}><${Icon} name="xmark" /></button>
    </div>`)}
    <div class="cl-row add"><${Icon} name="plus" /><input placeholder=${`${label}を追加`} value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(); } }} onBlur=${add} /></div>
  </div>`;
}

/* ---------- Quick add ---------- */

export function openQuickAdd(opts = {}) {
  openSheet((close) => html`<${QuickAdd} close=${close} ...${opts} />`, { label: '追加' });
}

function QuickAdd({ close, date, startMin, mode: initialMode }) {
  const state = getState();
  const today = dateKey();
  const [text, setText] = useState('');
  const [mode, setMode] = useState(initialMode || (startMin != null ? 'event' : 'task'));
  const inputRef = useRef();
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 320); }, []);
  const p = useMemo(() => parseQuickAdd(text, { today, categories: state.categories }), [text]);

  const submit = (tpl) => {
    const base = tpl ? { title: tpl.title, icon: tpl.icon, categoryId: tpl.categoryId, estimateMin: tpl.estimateMin } : null;
    const title = base?.title || p.title;
    if (!title) return;
    if (mode === 'event') {
      const d = p.date || date || today;
      const s = p.startMin ?? startMin ?? Math.min(1380, Math.ceil(minutesOfDay(Date.now()) / 30) * 30);
      ops.addEvent({ title, date: d, startMin: s, durationMin: p.estimateMin || base?.estimateMin || 60, categoryId: p.categoryId || base?.categoryId || 'plan', icon: base?.icon || 'calendar' });
    } else {
      const f = { ...toTaskFields(p), ...(base || {}) };
      if (base && text.trim()) Object.assign(f, toTaskFields(p), { title: p.title || base.title });
      if (!f.dueDate && !f.plan && date && date !== today) f.dueDate = date;
      ops.addTask(f);
    }
    close();
  };

  const chips = [];
  if (p.date) chips.push(html`<span class="chip on" key="d"><${Icon} name="calendar" />${formatDateLabel(p.date)}${p.startMin != null ? ' ' + hhmm(p.startMin) : ''}${p.until ? ' まで' : ''}</span>`);
  if (p.estimateMin) chips.push(html`<span class="chip on" key="e"><${Icon} name="timer" />${formatDuration(p.estimateMin)}</span>`);
  if (p.priority) chips.push(html`<span class="chip on" key="p">${'!'.repeat(p.priority)} 優先度</span>`);
  if (p.categoryId) chips.push(html`<span class="chip on" key="c">#${categoryOf(state, p.categoryId).name}</span>`);

  return html`<div class="sheet-body quick-add">
    <${Segmented} label="種類" value=${mode} onChange=${setMode} options=${[{ value: 'task', label: 'タスク' }, { value: 'event', label: '予定' }]} />
    <form class="qa-form" onSubmit=${(e) => { e.preventDefault(); submit(); }}>
      <input ref=${inputRef} class="qa-input" enterkeyhint="done" placeholder=${mode === 'task' ? '例: レポート 金曜まで 2時間 !!' : '例: ゼミ 明日 13:00 90分'} value=${text} onInput=${(e) => setText(e.target.value)} aria-label="内容" />
      <button class="qa-send" type="submit" disabled=${!p.title} aria-label="追加"><${Icon} name="arrowRight" /></button>
    </form>
    <div class="qa-chips">${chips.length ? chips : html`<span class="hint">日付・時刻・「◯分」「!!」「#カテゴリ」を入力すると自動で読み取ります</span>`}</div>
    ${state.templates.length > 0 && html`<div class="qa-templates">
      <div class="label">テンプレート</div>
      <div class="chips wrap">${state.templates.map((t) => html`<button class="chip" key=${t.id} style=${`--c:${categoryOf(state, t.categoryId).color}`} onClick=${() => submit(t)}><${Icon} name=${t.icon} />${t.title}<small>${formatDuration(t.estimateMin)}</small></button>`)}</div>
    </div>`}
    <button class="link-btn" onClick=${() => { close(); setTimeout(() => (mode === 'task' ? openTaskEditor(null, { title: p.title, ...toTaskFields(p) }) : openEventEditor(null, { title: p.title, date: p.date || date || today, startMin: p.startMin ?? startMin ?? 540, durationMin: p.estimateMin || 60 })), 300); }}>詳細を入力…</button>
  </div>`;
}

/* ---------- Task editor ---------- */

export function openTaskEditor(task, preset = {}) {
  openSheet((close) => html`<${TaskEditor} close=${close} task=${task} preset=${preset} />`, { full: true, label: task ? 'タスクを編集' : '新規タスク' });
}

function TaskEditor({ close, task, preset }) {
  const state = getState();
  const today = dateKey();
  const [t, setT] = useState(() => ({
    title: '', icon: 'circle', categoryId: 'plan', priority: 0, dueDate: null, dueMin: null, estimateMin: 30,
    plan: null, notes: '', repeat: null, subtasks: [], courseId: null, ...(task || {}), ...preset,
  }));
  const set = (patch) => setT((x) => ({ ...x, ...patch }));
  const pred = useMemo(() => predictDuration(t, historyRows(state)), [t.title, t.estimateMin, t.categoryId]);
  const actual = task ? actualMinForTask(state.sessions, task.id) : 0;
  const courses = activeTerm(state)?.courses || [];

  const save = () => {
    if (!t.title.trim()) return;
    if (task) ops.saveTask(task.id, t); else ops.addTask(t);
    close();
  };

  return html`<${SheetHeader} title=${task ? 'タスクを編集' : '新規タスク'} onCancel=${() => close()} onSave=${save} saveDisabled=${!t.title.trim()} />
  <div class="sheet-body form">
    <div class="group">
      <input class="title-input" placeholder="タイトル" value=${t.title} onInput=${(e) => set({ title: e.target.value })} aria-label="タイトル" autofocus=${!task} />
      <${IconCategoryPicker} state=${state} icon=${t.icon} categoryId=${t.categoryId} onIcon=${(icon) => set({ icon })} onCategory=${(categoryId) => set({ categoryId })} />
    </div>

    <${Section} title="優先度・所要時間">
      <div class="row"><span class="row-main"><span class="row-title">優先度</span></span>
        <${Segmented} small label="優先度" value=${t.priority} onChange=${(priority) => set({ priority })} options=${[{ value: 0, label: 'なし' }, { value: 1, label: '!' }, { value: 2, label: '!!' }, { value: 3, label: '!!!' }]} /></div>
      <div class="row"><span class="row-main"><span class="row-title">見積もり</span>
        ${pred && html`<span class="row-sub">予測 ${formatDuration(pred.minutes)}（${pred.basis} ${pred.samples}件の実績から）${pred.minutes !== t.estimateMin ? html` <button class="link-btn inline" onClick=${() => set({ estimateMin: pred.minutes })}>反映</button>` : ''}</span>`}
        ${actual > 0 && html`<span class="row-sub">これまでの実績 ${formatDuration(actual)}</span>`}</span>
        <${Stepper} label="見積もり" value=${t.estimateMin} step=${t.estimateMin >= 120 ? 15 : 5} onChange=${(estimateMin) => set({ estimateMin })} max=${1440} /></div>
    <//>

    <${Section} title="日時">
      <div class="row"><${Icon} name="flag" cls="lead" /><span class="row-main"><span class="row-title">締切</span></span>
        <${Toggle} label="締切" checked=${!!t.dueDate} onChange=${(on) => set({ dueDate: on ? today : null, dueMin: on ? 1439 : null })} /></div>
      ${t.dueDate && html`<div class="row sub"><input type="date" value=${t.dueDate} onChange=${(e) => e.target.value && set({ dueDate: e.target.value })} aria-label="締切日" />
        <input type="time" value=${t.dueMin != null ? hhmm(t.dueMin) : ''} onChange=${(e) => set({ dueMin: parseHHMM(e.target.value) })} aria-label="締切時刻" /></div>`}
      <div class="row"><${Icon} name="clock" cls="lead" /><span class="row-main"><span class="row-title">時間を決めて実行</span><span class="row-sub">タイムラインに入り、遅れたら自動調整の対象になります</span></span>
        <${Toggle} label="時間を決める" checked=${!!t.plan} onChange=${(on) => set({ plan: on ? { date: t.dueDate && t.dueDate < addDays(today, 7) ? (t.dueDate < today ? today : t.dueDate) : today, startMin: Math.min(1380, Math.ceil(minutesOfDay(Date.now()) / 15) * 15) } : null })} /></div>
      ${t.plan && html`<div class="row sub"><input type="date" value=${t.plan.date} onChange=${(e) => e.target.value && set({ plan: { ...t.plan, date: e.target.value } })} aria-label="実行日" />
        <input type="time" value=${hhmm(t.plan.startMin)} onChange=${(e) => { const m = parseHHMM(e.target.value); if (m != null) set({ plan: { ...t.plan, startMin: m } }); }} aria-label="開始時刻" /></div>`}
      <div class="row"><${Icon} name="repeat" cls="lead" /><span class="row-main"><span class="row-title">繰り返し</span></span></div>
      <div class="row sub"><${RepeatEditor} value=${t.repeat} onChange=${(repeat) => set({ repeat })} baseDate=${t.dueDate || t.plan?.date || today} /></div>
    <//>

    <${Section} title="サブタスク"><${ChecklistEditor} items=${t.subtasks} onChange=${(subtasks) => set({ subtasks })} /><//>

    ${courses.length > 0 && html`<${Section} title="授業">
      <div class="row"><select class="select" aria-label="授業" value=${t.courseId || ''} onChange=${(e) => set({ courseId: e.target.value || null, categoryId: e.target.value ? 'school' : t.categoryId })}>
        <option value="">指定なし</option>${courses.map((c) => html`<option value=${c.id}>${WEEKDAYS[c.day]}${c.period}限 ${c.name}</option>`)}
      </select></div>
    <//>`}

    <${Section} title="メモ"><textarea class="notes selectable" rows="4" placeholder="メモ" value=${t.notes} onInput=${(e) => set({ notes: e.target.value })} aria-label="メモ"></textarea><//>

    ${t.source?.kind === 'moodle' && html`<p class="section-foot">Moodleから取り込んだ課題です${t.source.course ? `（${t.source.course}）` : ''}。${t.source.url ? html` <a href=${t.source.url} target="_blank" rel="noopener">Moodleで開く</a>` : ''}</p>`}

    ${task && html`<div class="group"><${Row} danger title="タスクを削除" onClick=${async () => { if (await confirmDanger(`「${task.title}」を削除しますか？`, '取り消しはトーストから行えます')) { close(); ops.removeTask(task); } }} /></div>`}
  </div>`;
}

/* ---------- Event editor ---------- */

export function openEventEditor(occ, preset = {}) {
  openSheet((close) => html`<${EventEditor} close=${close} occ=${occ} preset=${preset} />`, { full: true, label: occ ? '予定を編集' : '新規予定' });
}

function EventEditor({ close, occ, preset }) {
  const state = getState();
  const src = occ ? state.events[occ.id] : null;
  const [e, setE] = useState(() => ({
    title: '', icon: 'calendar', categoryId: 'plan', date: dateKey(), startMin: 540, durationMin: 60, allDay: false, fixed: true,
    location: '', notes: '', repeat: null, travelBeforeMin: 0, travelAfterMin: 0, checklist: [],
    ...(src || {}), ...(occ ? { date: occ.date, startMin: occ.startMin, durationMin: occ.durationMin } : {}), ...preset,
  }));
  const set = (patch) => setE((x) => ({ ...x, ...patch }));
  const end = e.startMin + e.durationMin;

  const conflicts = useMemo(() => {
    if (e.allDay) return [];
    const items = dayItems(state, e.date).filter((i) => !(occ && i.key === occ.key) && !i.allDay);
    return items.filter((i) => Math.min(i.endMin + (i.travelAfterMin || 0), end + e.travelAfterMin) - Math.max(i.startMin - (i.travelBeforeMin || 0), e.startMin - e.travelBeforeMin) > 0);
  }, [e.date, e.startMin, e.durationMin, e.travelBeforeMin, e.travelAfterMin, e.allDay]);

  const save = async () => {
    if (!e.title.trim()) return;
    if (occ) {
      const patch = { ...e };
      delete patch.id; delete patch.overrides;
      if (await ops.saveOccurrence(occ, patch)) close();
    } else { ops.addEvent(e); close(); }
  };

  return html`<${SheetHeader} title=${occ ? '予定を編集' : '新規予定'} onCancel=${() => close()} onSave=${save} saveDisabled=${!e.title.trim()} />
  <div class="sheet-body form">
    <div class="group">
      <input class="title-input" placeholder="タイトル" value=${e.title} onInput=${(ev) => set({ title: ev.target.value })} aria-label="タイトル" />
      <input class="sub-input" placeholder="場所" value=${e.location} onInput=${(ev) => set({ location: ev.target.value })} aria-label="場所" />
      <${IconCategoryPicker} state=${state} icon=${e.icon} categoryId=${e.categoryId} onIcon=${(icon) => set({ icon })} onCategory=${(categoryId) => set({ categoryId })} />
    </div>

    <${Section} title="日時" footer=${conflicts.length ? html`<span class="red"><${Icon} name="warning" /> ${conflicts.map((c) => `「${c.title}」`).join('')}と重なっています</span>` : null}>
      <div class="row"><span class="row-main"><span class="row-title">終日</span></span><${Toggle} label="終日" checked=${e.allDay} onChange=${(allDay) => set({ allDay })} /></div>
      <div class="row sub"><input type="date" value=${e.date} onChange=${(ev) => ev.target.value && set({ date: ev.target.value })} aria-label="日付" />
        ${!e.allDay && html`<input type="time" value=${hhmm(e.startMin)} onChange=${(ev) => { const m = parseHHMM(ev.target.value); if (m != null) set({ startMin: m }); }} aria-label="開始" />
        <span class="to">〜</span>
        <input type="time" value=${hhmm(Math.min(end, 1439))} onChange=${(ev) => { const m = parseHHMM(ev.target.value); if (m != null) set({ durationMin: Math.max(5, (m <= e.startMin ? m + 1440 : m) - e.startMin) }); }} aria-label="終了" />`}
      </div>
      ${!e.allDay && html`<div class="row"><span class="row-main"><span class="row-title">長さ</span></span><${Stepper} label="長さ" value=${e.durationMin} step=${15} min=${5} max=${1440} onChange=${(durationMin) => set({ durationMin })} /></div>`}
      <div class="row"><${Icon} name="repeat" cls="lead" /><span class="row-main"><span class="row-title">繰り返し</span>${e.repeat && html`<span class="row-sub">${describeRepeat(e.repeat)}</span>`}</span></div>
      <div class="row sub"><${RepeatEditor} value=${e.repeat} onChange=${(repeat) => set({ repeat })} baseDate=${e.date} /></div>
    <//>

    ${!e.allDay && html`<${Section} title="自動調整" footer=${e.fixed ? '固定の予定は自動調整で動かしません。授業・バイト・約束などに。' : '柔軟な予定は、前の予定が遅れたときに移動案の対象になります。'}>
      <div class="row"><${Segmented} label="予定の種類" value=${e.fixed} onChange=${(fixed) => set({ fixed })} options=${[{ value: true, label: '固定' }, { value: false, label: '柔軟' }]} /></div>
    <//>
    <${Section} title="移動時間" footer="前後の移動時間も重なりチェックと通知に含まれます。">
      <div class="row"><span class="row-main"><span class="row-title">行き</span></span><${Stepper} label="行きの移動" value=${e.travelBeforeMin} step=${5} min=${0} max=${240} format=${(v) => (v ? formatDuration(v) : 'なし')} onChange=${(travelBeforeMin) => set({ travelBeforeMin })} /></div>
      <div class="row"><span class="row-main"><span class="row-title">帰り</span></span><${Stepper} label="帰りの移動" value=${e.travelAfterMin} step=${5} min=${0} max=${240} format=${(v) => (v ? formatDuration(v) : 'なし')} onChange=${(travelAfterMin) => set({ travelAfterMin })} /></div>
    <//>`}

    <${Section} title="チェックリスト・持ち物"><${ChecklistEditor} label="項目" items=${e.checklist} onChange=${(checklist) => set({ checklist })} /><//>
    <${Section} title="メモ"><textarea class="notes selectable" rows="4" placeholder="メモ" value=${e.notes} onInput=${(ev) => set({ notes: ev.target.value })} aria-label="メモ"></textarea><//>
    ${occ && html`<div class="group"><${Row} danger title="予定を削除" onClick=${async () => { if (await ops.removeOccurrence(occ)) close(); }} /></div>`}
  </div>`;
}

/* ---------- Item detail (timeline tap) ---------- */

export function openItemDetail(occ) {
  if (occ.kind === 'task') {
    const t = getState().tasks[occ.id];
    if (t) return openTaskDetail(t);
  }
  openSheet((close) => html`<${ItemDetail} close=${close} occKey=${occ.key} date=${occ.date} fallback=${occ} />`, { label: occ.title });
}

function ItemDetail({ close, occKey, date, fallback }) {
  const state = getState();
  const items = dayItems(state, date);
  const occ = items.find((i) => i.key === occKey) || fallback;
  const cat = categoryOf(state, occ.categoryId);
  const conflict = conflictKeys(items).has(occ.key);
  const editable = occ.kind === 'event';
  return html`<div class="sheet-body detail">
    <div class="detail-head" style=${`--c:${occ.color || cat.color}`}>
      <${CatIcon} state=${state} categoryId=${occ.categoryId} icon=${occ.icon} color=${occ.color} size=${44} />
      <div><h2 class="selectable">${occ.title}</h2>
        <p>${formatLongDate(occ.date)}${occ.allDay ? ' 終日' : ` ${hhmm(occ.startMin)}〜${hhmm(occ.endMin)}（${formatDuration(occ.durationMin)}）`}</p>
        <p class="muted">${cat.name}${occ.kind === 'course' ? ` · ${occ.period}限` : ''}${occ.recurring && occ.kind === 'event' ? ' · 繰り返し' : ''}${occ.fixed ? ' · 固定' : ' · 柔軟'}</p></div>
    </div>
    ${conflict && html`<div class="notice red"><${Icon} name="warning" />他の予定と時間が重なっています</div>`}
    ${(occ.travelBeforeMin || occ.travelAfterMin) ? html`<div class="notice"><${Icon} name="tram" />移動 ${occ.travelBeforeMin ? `行き${occ.travelBeforeMin}分（${hhmm(occ.startMin - occ.travelBeforeMin)}出発）` : ''} ${occ.travelAfterMin ? `帰り${occ.travelAfterMin}分` : ''}</div>` : ''}
    ${occ.location && html`<div class="notice"><${Icon} name="pin" /><span class="selectable">${occ.location}</span></div>`}
    ${occ.checklist.length > 0 && html`<${Section} title="チェックリスト">
      ${occ.checklist.map((c) => html`<button class="row" key=${c.id} onClick=${() => { ops.toggleCheck(occ, c.id); close(); setTimeout(() => openItemDetail(occ), 300); }}>
        <span class=${`mini-check ${c.done ? 'on' : ''}`}>${c.done && html`<${Icon} name="check" />`}</span><span class="row-main"><span class=${`row-title ${c.done ? 'struck' : ''}`}>${c.title}</span></span></button>`)}
    <//>`}
    ${occ.notes && html`<p class="notes-view selectable">${occ.notes}</p>`}
    <div class="action-grid">
      <button onClick=${() => { close(); ops.startItem(occ); }}><${Icon} name="play" />開始</button>
      ${editable && html`<button onClick=${() => { close(); setTimeout(() => openEventEditor(occ), 300); }}><${Icon} name="pencil" />編集</button>`}
      ${editable && !occ.fixed && html`<button onClick=${() => { close(); ops.moveOccurrence(occ, addDays(occ.date, 1), occ.startMin); }}><${Icon} name="forward" />明日へ</button>`}
      ${editable && html`<button class="danger" onClick=${async () => { if (await ops.removeOccurrence(occ)) close(); }}><${Icon} name="trash" />削除</button>`}
    </div>
  </div>`;
}

export function openTaskDetail(task) {
  openTaskEditor(task);
}

export { dueInfo };
