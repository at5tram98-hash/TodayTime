// Timeline assembly: events, classes and planned tasks for a day; conflicts and free time.

import { expandCourses, expandEvents } from './recurrence.js';
import { activeTerm } from './model.js';
import { addDays } from './time.js';

export function taskBlock(t) {
  return {
    kind: 'task', key: `task:${t.id}`, id: t.id, originalDate: t.plan.date, date: t.plan.date,
    startMin: t.plan.startMin, durationMin: t.estimateMin, endMin: t.plan.startMin + t.estimateMin,
    allDay: false, title: t.title, icon: t.icon, categoryId: t.categoryId, fixed: false,
    location: '', notes: t.notes, recurring: false, travelBeforeMin: 0, travelAfterMin: 0,
    checklist: t.subtasks, done: t.done, startedAt: t.startedAt, priority: t.priority, dueDate: t.dueDate, dueMin: t.dueMin, taskId: t.id,
  };
}

/** All timeline items in [from, to], sorted by date then start. */
export function itemsInRange(state, from, to) {
  const items = [
    ...expandEvents(Object.values(state.events), from, to),
    ...expandCourses(activeTerm(state), state.school.periods, from, to),
    ...Object.values(state.tasks).filter((t) => t.plan && t.plan.date >= from && t.plan.date <= to).map(taskBlock),
  ];
  return items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.allDay === b.allDay ? a.startMin - b.startMin : a.allDay ? -1 : 1)));
}

export function dayItems(state, date) {
  return itemsInRange(state, date, date);
}

/** Occupied span including travel buffers. */
export function span(item) {
  return { start: item.startMin - (item.travelBeforeMin || 0), end: item.endMin + (item.travelAfterMin || 0) };
}

/** Overlapping timed items on the same day. Returns [{a, b, minutes}] pairs. */
export function findConflicts(items) {
  const timed = items.filter((i) => !i.allDay && !i.done);
  const out = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i], b = timed[j];
      if (a.date !== b.date) continue;
      const sa = span(a), sb = span(b);
      const overlap = Math.min(sa.end, sb.end) - Math.max(sa.start, sb.start);
      if (overlap > 0) out.push({ a, b, minutes: overlap });
    }
  }
  return out;
}

export function conflictKeys(items) {
  const set = new Set();
  for (const c of findConflicts(items)) { set.add(c.a.key); set.add(c.b.key); }
  return set;
}

/** Free gaps between busy spans within [fromMin, endMin]. */
export function freeSlots(items, fromMin, endMin, minLen = 5) {
  const busy = items.filter((i) => !i.allDay && !(i.kind === 'task' && i.done)).map(span).sort((a, b) => a.start - b.start);
  const out = [];
  let cur = fromMin;
  for (const b of busy) {
    if (b.end <= cur) continue;
    if (b.start > cur) {
      const e = Math.min(b.start, endMin);
      if (e - cur >= minLen) out.push({ start: cur, end: e });
    }
    cur = Math.max(cur, b.end);
    if (cur >= endMin) break;
  }
  if (endMin - cur >= minLen) out.push({ start: cur, end: endMin });
  return out;
}

export function totalFree(items, fromMin, endMin) {
  return freeSlots(items, fromMin, endMin).reduce((s, g) => s + g.end - g.start, 0);
}

/** First free start >= fromMin that fits `duration`, or null. */
export function findSlot(items, duration, fromMin, endMin) {
  const g = freeSlots(items, fromMin, endMin).find((s) => s.end - s.start >= duration);
  return g ? g.start : null;
}

/** Lay out overlapping items in columns for timeline rendering. */
export function layoutColumns(items) {
  const timed = items.filter((i) => !i.allDay).sort((a, b) => a.startMin - b.startMin || b.durationMin - a.durationMin);
  const result = new Map();
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const cols = [];
    for (const it of cluster) {
      let c = cols.findIndex((end) => end <= it.startMin);
      if (c < 0) { c = cols.length; cols.push(0); }
      cols[c] = it.endMin;
      result.set(it.key, { col: c, cols: 0 });
    }
    for (const it of cluster) result.get(it.key).cols = cols.length;
    cluster = []; clusterEnd = -1;
  };
  for (const it of timed) {
    if (cluster.length && it.startMin >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  if (cluster.length) flush();
  return result;
}

/** Tasks that matter for a given day: planned that day, due that day/overdue, or undated & open. */
export function tasksForDay(state, date, today) {
  return Object.values(state.tasks).filter((t) => {
    if (t.done) return t.completedAt && sameLocalDay(t.completedAt, date);
    if (t.plan?.date === date) return true;
    if (t.dueDate && t.dueDate <= date && (date === today ? true : t.dueDate === date)) return true;
    return false;
  });
}

function sameLocalDay(ts, key) {
  const d = new Date(ts);
  const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return k === key;
}

export function weekKeys(start, n = 7) {
  return Array.from({ length: n }, (_, i) => addDays(start, i));
}
