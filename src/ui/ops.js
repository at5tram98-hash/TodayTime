// User-facing operations: mutate state + give feedback (haptics, toast with undo).

import * as A from '../data/actions.js';
import { getState, mutate } from '../data/store.js';
import { dayItems } from '../core/schedule.js';
import { addDays, dateKey, formatDateLabel, hhmm, minutesOfDay } from '../core/time.js';
import { elapsedMin, overrunMin, runningSession } from '../core/tracker.js';
import { askScope, confirmDanger, haptic, toast } from './runtime.js';

const today = () => dateKey();

export function addTask(fields, { silent = false } = {}) {
  let id;
  mutate('タスクを追加', (d) => { id = A.createTask(d, fields); });
  haptic('light');
  if (!silent) toast(`「${getState().tasks[id].title}」を追加しました`, { undoable: true });
  return id;
}

export function saveTask(id, patch) {
  mutate('タスクを変更', (d) => A.updateTask(d, id, patch));
}

export function toggleDone(task) {
  const done = !task.done;
  let nextId = null;
  mutate(done ? 'タスクを完了' : '完了を取り消し', (d) => { nextId = A.setTaskDone(d, task.id, done); });
  haptic(done ? 'success' : 'light');
  if (done) {
    const next = nextId && getState().tasks[nextId];
    toast(next ? `完了しました · 次回 ${formatDateLabel(next.dueDate || next.plan?.date || today())}` : `「${task.title}」を完了しました`, { undoable: true });
  }
}

export async function removeTask(task) {
  mutate('タスクを削除', (d) => A.deleteTask(d, task.id));
  haptic('medium');
  toast(`「${task.title}」を削除しました`, { undoable: true });
}

export function toTomorrow(task) {
  const tomorrow = addDays(today(), 1);
  mutate('明日に移動', (d) => {
    const t = d.tasks[task.id];
    if (t.plan) A.planTask(d, task.id, tomorrow, t.plan.startMin);
    if (!t.plan && (!t.dueDate || t.dueDate <= today())) t.dueDate = tomorrow;
  });
  haptic('light');
  toast(`「${task.title}」を明日に移動しました`, { undoable: true });
}

export function planInFreeTime(task, date = today()) {
  let start = null;
  mutate('空き時間に配置', (d) => { start = A.planTask(d, task.id, date, null); });
  if (start === null) {
    toast(`${formatDateLabel(date)}は${task.estimateMin}分の空き時間がありません`);
    return null;
  }
  haptic('light');
  toast(`${formatDateLabel(date)} ${hhmm(start)} に配置しました`, { undoable: true });
  return start;
}

export function unplan(task) {
  mutate('予定から外す', (d) => A.unplanTask(d, task.id));
  toast('時間の指定を外しました', { undoable: true });
}

export function setPriority(task, p) {
  mutate('優先度を変更', (d) => A.updateTask(d, task.id, { priority: p }));
}

export function duplicateTask(task) {
  addTask({ ...task, id: undefined, done: false, completedAt: null, startedAt: null, source: null, title: task.title + ' のコピー' });
}

/* ---------- timer ---------- */

export function startTask(task) {
  const s = getState();
  const prev = runningSession(s.sessions);
  mutate('計測を開始', (d) => A.startTimer(d, { taskId: task.id, title: task.title, icon: task.icon, categoryId: task.categoryId, plannedMin: task.estimateMin }));
  haptic('medium');
  toast(prev ? `「${prev.title}」を一時停止して開始しました` : `「${task.title}」を開始しました`, { undoable: true });
}

export function startItem(item) {
  if (item.kind === 'task') { const t = getState().tasks[item.id]; if (t) return startTask(t); }
  mutate('計測を開始', (d) => A.startTimer(d, { eventKey: item.key, title: item.title, icon: item.icon, categoryId: item.categoryId, plannedMin: item.durationMin }));
  haptic('medium');
  toast(`「${item.title}」を開始しました`, { undoable: true });
}

export function startFree(title = '作業') {
  mutate('計測を開始', (d) => A.startTimer(d, { title, icon: 'timer', categoryId: 'plan' }));
  haptic('medium');
}

export function pause(session) { mutate('一時停止', (d) => A.pauseTimer(d, session.id)); haptic('light'); }
export function resume(session) { mutate('再開', (d) => A.resumeTimer(d, session.id)); haptic('light'); }

export function finish(session, completeTask) {
  const min = Math.round(elapsedMin(session));
  const over = Math.round(overrunMin(session));
  mutate(completeTask ? '完了' : '計測を終了', (d) => A.finishTimer(d, session.id, { completeTask }));
  haptic('success');
  const vs = session.plannedMin ? `（予定${session.plannedMin}分${over ? ` / ${over}分超過` : ''}）` : '';
  toast(`${min}分 記録しました${vs}`, { undoable: true });
}

/* ---------- events ---------- */

export function addEvent(fields) {
  let id;
  mutate('予定を追加', (d) => { id = A.createEvent(d, fields); });
  haptic('light');
  toast(`「${fields.title || '予定'}」を追加しました`, { undoable: true });
  return id;
}

export async function saveOccurrence(occ, patch) {
  let scope = 'all';
  if (occ.recurring && occ.kind === 'event') {
    scope = await askScope('変更');
    if (!scope) return false;
  }
  mutate('予定を変更', (d) => A.updateOccurrence(d, occ, patch, scope));
  return true;
}

export async function removeOccurrence(occ) {
  if (occ.kind === 'task') {
    const t = getState().tasks[occ.id];
    if (t) unplan(t);
    return true;
  }
  if (occ.kind === 'course') { toast('授業は「大学」タブの時間割から編集できます'); return false; }
  let scope = 'all';
  if (occ.recurring) {
    scope = await askScope('削除');
    if (!scope) return false;
  } else if (!(await confirmDanger(`「${occ.title}」を削除しますか？`, ''))) return false;
  mutate('予定を削除', (d) => A.deleteOccurrence(d, occ, scope));
  haptic('medium');
  toast('予定を削除しました', { undoable: true });
  return true;
}

export function moveOccurrence(occ, date, startMin, durationMin) {
  mutate('予定を移動', (d) => A.moveItem(d, occ, date, startMin, durationMin));
  haptic('light');
  toast(`${formatDateLabel(date)} ${hhmm(startMin)} に移動しました`, { undoable: true });
}

export function toggleCheck(occ, itemId) {
  mutate('チェック', (d) => A.toggleChecklist(d, occ, itemId), { undoable: false });
  haptic('light');
}

/* ---------- adjustments ---------- */

export function applyAdjust(proposal, items) {
  let n = 0;
  mutate('自動調整', (d) => { n = A.applyProposal(d, proposal, items); });
  haptic('success');
  toast(`${n}件の予定を調整しました`, { undoable: true, ms: 6000 });
}

export function nowMin() { return minutesOfDay(Date.now()); }
export function todayItems() { return dayItems(getState(), today()); }
