// 今日: what is happening now, what is next, what to do, and how the day is going.

import { html, useMemo } from '../h.js';
import { Icon } from '../icons.js';
import { CatIcon, Empty, NavButton, ProgressRing, Screen, Section, TaskRow } from '../components.js';
import { openItemDetail, openQuickAdd, openTaskEditor } from '../forms.js';
import { categoryOf } from '../../core/model.js';
import { historyRows } from '../../core/predict.js';
import { detectDelay, planReflow } from '../../core/reflow.js';
import { conflictKeys, dayItems, findConflicts, freeSlots, tasksForDay } from '../../core/schedule.js';
import { addDays, dateKey, formatDuration, formatElapsed, formatLongDate, hhmm, minutesOfDay, toInstant, WEEKDAYS } from '../../core/time.js';
import { activeSessions, elapsedMin, elapsedMs, isStale, overrunMin, runningSession, trackedBetween } from '../../core/tracker.js';
import { ask, nav, openMenu, openSheet, useNow } from '../runtime.js';
import * as ops from '../ops.js';
import { mutate } from '../../data/store.js';
import { endSessionAt } from '../../core/tracker.js';

function TimerCard({ s, now, state }) {
  const el = elapsedMs(s, now);
  const over = overrunMin(s, now);
  const cat = categoryOf(state, s.categoryId);
  const ratio = s.plannedMin ? el / (s.plannedMin * 60_000) : 0;
  const stale = isStale(s, now);
  const running = s.status === 'running';
  const finishMenu = (e) => openMenu([
    s.taskId && { label: '完了にして終了', icon: 'checkCircle', run: () => ops.finish(s, true) },
    { label: '記録だけ終了', icon: 'stop', run: () => ops.finish(s, false) },
  ].filter(Boolean), { anchor: { y: e.clientY }, title: `${formatDuration(el / 60_000)}を記録` });
  return html`<div class=${`timer-card ${running ? 'running' : 'paused'} ${over > 0 ? 'over' : ''}`} style=${`--c:${cat.color}`} role="group" aria-label=${`計測中: ${s.title}`}>
    <div class="timer-top">
      <${CatIcon} state=${state} categoryId=${s.categoryId} icon=${s.icon === 'circle' ? cat.icon : s.icon} />
      <div class="timer-title"><span class="eyebrow">${running ? '実行中' : '一時停止中'}</span><strong>${s.title}</strong></div>
    </div>
    <div class="timer-clock" aria-live="off">${formatElapsed(el)}</div>
    ${s.plannedMin > 0 && html`<div class="timer-bar"><span style=${`width:${Math.min(100, ratio * 100)}%`}></span></div>
      <div class="timer-sub">${over > 0 ? html`<span class="red">予定より${Math.round(over)}分超過</span>` : `予定 ${formatDuration(s.plannedMin)} · 残り ${formatDuration(s.plannedMin - el / 60_000)}`}</div>`}
    ${stale && html`<div class="notice orange"><${Icon} name="warning" />長時間計測中です。止め忘れの場合は終了時刻を修正できます
      <button class="link-btn" onClick=${async () => {
        const v = await ask('終了時刻を修正', '最後に作業していた時刻で記録を終了します', [{ label: '1時間前', value: 60 }, { label: '3時間前', value: 180 }, { label: 'キャンセル', value: null, cancel: true }]);
        if (v) mutate('終了時刻を修正', (d) => { d.sessions[s.id] = endSessionAt(d.sessions[s.id], Date.now() - v * 60_000); });
      }}>修正</button></div>`}
    <div class="timer-actions">
      ${running
        ? html`<button class="btn tinted" onClick=${() => ops.pause(s)}><${Icon} name="pause" />一時停止</button>`
        : html`<button class="btn tinted" onClick=${() => ops.resume(s)}><${Icon} name="play" />再開</button>`}
      <button class="btn filled" onClick=${finishMenu}><${Icon} name="stop" />終了</button>
    </div>
  </div>`;
}

function ProposalSheet({ close, proposal, items }) {
  return html`<div class="sheet-head"><button class="text-btn" onClick=${() => close()}>今はしない</button><h2>調整案</h2>
    <button class="text-btn strong" disabled=${!proposal.changes.length} onClick=${() => { ops.applyAdjust(proposal, items); close(); }}>適用</button></div>
  <div class="sheet-body">
    <p class="lead-text">固定の予定（授業・固定予定）は動かさず、柔軟な予定だけを移動します。適用後も「取り消す」で元に戻せます。</p>
    ${proposal.changes.length === 0 && html`<${Empty} icon="checkCircle" title="調整は不要です" text="後続の予定に影響はありません" />`}
    <div class="group">
      ${proposal.changes.map((c) => html`<div class="change-row" key=${c.key}>
        <div class="change-title"><${Icon} name=${c.icon || 'circle'} /><strong>${c.title}</strong></div>
        <div class="change-times"><span class="from">${c.from.date !== c.to.date ? '今日 ' : ''}${hhmm(c.from.startMin)}</span><${Icon} name="arrowRight" /><span class="to">${c.to.date !== c.from.date ? '明日 ' : ''}${hhmm(c.to.startMin)}</span></div>
        <div class="change-reason">${c.reason}</div>
        ${c.warning && html`<div class="change-reason red">${c.warning}</div>`}
      </div>`)}
    </div>
    ${proposal.unplaced.length > 0 && html`<${Section} title="配置できない予定">${proposal.unplaced.map((u) => html`<div class="row"><span class="row-main"><span class="row-title">${u.item.title}</span><span class="row-sub">${u.reason}</span></span></div>`)}<//>`}
  </div>`;
}

export function computeAdjust(state, now) {
  const today = dateKey(new Date(now));
  const nowM = minutesOfDay(now);
  const items = dayItems(state, today);
  const run = runningSession(state.sessions);
  let running = null;
  if (run) {
    const key = run.taskId ? `task:${run.taskId}` : run.eventKey;
    const remaining = run.plannedMin ? Math.max(0, run.plannedMin - elapsedMin(run, now)) : 0;
    running = { key, endMin: nowM + remaining, title: run.title, overMin: overrunMin(run, now) };
  }
  const delay = detectDelay({ items, nowMin: nowM, running });
  if (!delay) return null;
  const proposal = planReflow({
    items, tomorrowItems: dayItems(state, addDays(today, 1)), nowMin: Math.ceil(nowM / 5) * 5, today, tomorrow: addDays(today, 1),
    dayStartMin: state.settings.dayStartMin, dayEndMin: state.settings.dayEndMin, bufferMin: state.settings.adjust.bufferMin, running,
  });
  if (!proposal.changes.length && !proposal.unplaced.length) return null;
  return { delay, proposal, items };
}

export function openProposal(adj) {
  openSheet((close) => html`<${ProposalSheet} close=${close} proposal=${adj.proposal} items=${adj.items} />`, { label: '調整案' });
}

function Agenda({ items, nowM, conflicts, state }) {
  if (!items.length) return html`<${Empty} icon="calendar" title="予定はありません" text="＋から予定やタスクを追加できます" />`;
  let nowShown = false;
  const rows = [];
  for (const it of items) {
    if (!nowShown && !it.allDay && it.startMin > nowM) {
      rows.push(html`<div class="now-marker" key="now"><span>${hhmm(nowM)}</span></div>`);
      nowShown = true;
    }
    const past = !it.allDay && it.endMin <= nowM;
    const current = !it.allDay && it.startMin <= nowM && it.endMin > nowM;
    const cat = categoryOf(state, it.categoryId);
    rows.push(html`<button key=${it.key} class=${`agenda-row ${past ? 'past' : ''} ${current ? 'current' : ''} ${it.done ? 'done' : ''}`} style=${`--c:${it.color || cat.color}`} onClick=${() => openItemDetail(it)}>
      <span class="agenda-time">${it.allDay ? '終日' : hhmm(it.startMin)}<small>${it.allDay ? '' : hhmm(it.endMin)}</small></span>
      <span class="agenda-bar"></span>
      <span class="agenda-main"><span class="agenda-title"><${Icon} name=${it.icon} />${it.title}</span>
        <span class="agenda-sub">${it.kind === 'task' ? 'タスク' : it.kind === 'course' ? `${it.period}限` : cat.name}${it.location ? ` · ${it.location}` : ''}${!it.fixed ? ' · 柔軟' : ''}${it.travelBeforeMin ? ` · 移動${it.travelBeforeMin}分` : ''}</span></span>
      ${conflicts.has(it.key) && html`<span class="badge red" aria-label="重複"><${Icon} name="warning" />重複</span>`}
    </button>`);
  }
  if (!nowShown) rows.push(html`<div class="now-marker" key="now"><span>${hhmm(nowM)}</span></div>`);
  return html`<div class="group agenda">${rows}</div>`;
}

export function TodayScreen({ state, active }) {
  const now = useNow(1000);
  const today = dateKey(new Date(now));
  const nowM = minutesOfDay(now);
  const minuteKey = Math.floor(now / 60_000);

  const data = useMemo(() => {
    const items = dayItems(state, today);
    const conflicts = conflictKeys(items);
    const tasks = tasksForDay(state, today, today);
    const open = tasks.filter((t) => !t.done).sort((a, b) => {
      const ao = a.dueDate && a.dueDate < today ? 0 : 1, bo = b.dueDate && b.dueDate < today ? 0 : 1;
      return ao - bo || (a.plan?.startMin ?? 9999) - (b.plan?.startMin ?? 9999) || b.priority - a.priority || (a.dueDate || '9').localeCompare(b.dueDate || '9');
    });
    const done = tasks.filter((t) => t.done);
    const soon = Object.values(state.tasks).filter((t) => !t.done && t.categoryId === 'school' && t.dueDate && t.dueDate > today && t.dueDate <= addDays(today, 3) && !open.includes(t))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const freeMin = freeSlots(items, Math.max(nowM, state.settings.dayStartMin), state.settings.dayEndMin).reduce((s, g) => s + g.end - g.start, 0);
    const next = items.find((i) => !i.allDay && i.startMin > nowM && !i.done);
    const current = items.filter((i) => !i.allDay && i.startMin <= nowM && i.endMin > nowM && !i.done);
    const tomorrow = dayItems(state, addDays(today, 1));
    const adj = computeAdjust(state, now);
    const rows = historyRows(state, now);
    const conflictCount = findConflicts(items).length;
    return { items, conflicts, open, done, soon, freeMin, next, current, tomorrow, adj, rows, conflictCount };
  }, [state, today, minuteKey]);

  const sessions = activeSessions(state.sessions);
  const runningTaskIds = new Set(sessions.filter((s) => s.status === 'running').map((s) => s.taskId));
  const tracked = trackedBetween(state.sessions, toInstant(today, 0), toInstant(today, 1440), now);
  const totalTasks = data.open.length + data.done.length;
  const progress = totalTasks ? data.done.length / totalTasks : 0;
  const d = new Date(now);
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  return html`<${Screen} id="today" active=${active} title="今日" subtitle=${html`${formatLongDate(today)} <span class="clock">${clock}</span>`}
    actions=${html`<${NavButton} icon="plus" label="追加" primary onClick=${() => openQuickAdd({ date: today })} />`}>

    ${data.adj && html`<button class="banner orange" onClick=${() => openProposal(data.adj)}>
      <${Icon} name="sparkles" /><span><strong>${data.adj.delay.type === 'overrun' ? '作業が予定より延びています' : '開始時刻を過ぎたタスクがあります'}</strong><small>${data.adj.proposal.changes.length}件の移動案 · タップして確認</small></span><${Icon} name="chevronRight" />
    </button>`}

    ${sessions.map((s) => html`<${TimerCard} key=${s.id} s=${s} now=${now} state=${state} />`)}

    <div class="stats">
      <div class="stat"><${ProgressRing} value=${progress} color="var(--green)">${totalTasks ? Math.round(progress * 100) : '–'}<//>
        <span><strong>${data.done.length}/${totalTasks}</strong><small>完了</small></span></div>
      <div class="stat"><span class="stat-icon"><${Icon} name="clock" /></span><span><strong>${formatDuration(data.freeMin, { short: true })}</strong><small>残りの空き</small></span></div>
      <div class="stat"><span class="stat-icon"><${Icon} name="timer" /></span><span><strong>${formatDuration(tracked, { short: true })}</strong><small>今日の記録</small></span></div>
    </div>

    ${(data.current.length > 0 || data.next) && html`<div class="now-next">
      ${data.current.map((c) => html`<button key=${c.key} class="nn-card current" style=${`--c:${c.color || categoryOf(state, c.categoryId).color}`} onClick=${() => openItemDetail(c)}>
        <span class="eyebrow">いま · あと${formatDuration(c.endMin - nowM)}</span><strong>${c.title}</strong>
        <div class="timer-bar"><span style=${`width:${((nowM - c.startMin) / c.durationMin) * 100}%`}></span></div></button>`)}
      ${data.next && html`<button class="nn-card" style=${`--c:${data.next.color || categoryOf(state, data.next.categoryId).color}`} onClick=${() => openItemDetail(data.next)}>
        <span class="eyebrow">次 · ${hhmm(data.next.startMin)}（あと${formatDuration(data.next.startMin - (data.next.travelBeforeMin || 0) - nowM)}${data.next.travelBeforeMin ? 'で出発' : ''}）</span>
        <strong>${data.next.title}</strong>${data.next.location && html`<small><${Icon} name="pin" />${data.next.location}</small>`}</button>`}
    </div>`}

    ${data.conflictCount > 0 && html`<div class="notice red inset"><${Icon} name="warning" />今日は${data.conflictCount}か所で予定が重なっています</div>`}

    <${Section} title="やること" action=${html`<button class="text-btn" onClick=${() => openTaskEditor(null, { dueDate: today })}>追加</button>`}>
      ${data.open.length === 0 && html`<${Empty} icon="checkCircle" title=${data.done.length ? '今日のタスクはすべて完了' : '今日のタスクはありません'} text=${data.done.length ? 'おつかれさまでした' : 'タスクタブから今日やることを選びましょう'} />`}
      ${data.open.map((t) => html`<${TaskRow} key=${t.id} task=${t} state=${state} now=${now} rows=${data.rows} running=${runningTaskIds.has(t.id)} onOpen=${(x) => openTaskEditor(x)} />`)}
    <//>

    ${data.soon.length > 0 && html`<${Section} title="期限が近い課題">
      ${data.soon.map((t) => html`<${TaskRow} key=${t.id} task=${t} state=${state} now=${now} rows=${data.rows} onOpen=${(x) => openTaskEditor(x)} />`)}
    <//>`}

    <${Section} title="タイムライン" action=${html`<button class="text-btn" onClick=${() => nav.set({ tab: 'calendar', calDate: today, calView: 'day' })}>カレンダー</button>`}>
      <${Agenda} items=${data.items} nowM=${nowM} conflicts=${data.conflicts} state=${state} />
    <//>

    ${data.done.length > 0 && html`<${Section} title=${`完了 ${data.done.length}`}>
      ${data.done.map((t) => html`<${TaskRow} key=${t.id} task=${t} state=${state} now=${now} onOpen=${(x) => openTaskEditor(x)} />`)}
    <//>`}

    <button class="tomorrow-card" onClick=${() => nav.set({ tab: 'calendar', calDate: addDays(today, 1), calView: 'day' })}>
      <span class="eyebrow">明日 ${WEEKDAYS[new Date(now + 86_400_000).getDay()]}曜日</span>
      <strong>${data.tomorrow.length ? `${data.tomorrow.length}件の予定` : '予定なし'}</strong>
      ${data.tomorrow.filter((i) => !i.allDay)[0] && html`<small>最初: ${hhmm(data.tomorrow.filter((i) => !i.allDay)[0].startMin)} ${data.tomorrow.filter((i) => !i.allDay)[0].title}</small>`}
      <${Icon} name="chevronRight" cls="chev" />
    </button>
  <//>`;
}
