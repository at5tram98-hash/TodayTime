// Domain operations. Each takes a mutable draft (from store.mutate) and applies one change.
// Kept free of UI concerns so they are easy to reason about and test.

import { activeTerm, normalizeEvent, normalizeTask, uid } from '../core/model.js';
import { nextOccurrence } from '../core/recurrence.js';
import { dayItems, findSlot } from '../core/schedule.js';
import { addDays, dateKey, minutesOfDay } from '../core/time.js';
import { exclusiveStart, finishSession, pauseSession, resumeSession } from '../core/tracker.js';

/* ---------- tasks ---------- */

export function createTask(d, fields) {
  const t = normalizeTask({ ...fields, id: uid(), createdAt: Date.now() });
  d.tasks[t.id] = t;
  return t.id;
}

export function updateTask(d, id, patch) {
  const t = d.tasks[id];
  if (!t) return;
  d.tasks[id] = normalizeTask({ ...t, ...patch, id, updatedAt: Date.now() });
}

export function setTaskDone(d, id, done, now = Date.now()) {
  const t = d.tasks[id];
  if (!t || t.done === done) return null;
  t.done = done;
  t.completedAt = done ? now : null;
  t.updatedAt = now;
  let nextId = null;
  if (done) {
    for (const s of Object.values(d.sessions)) if (s.taskId === id && s.status !== 'done') d.sessions[s.id] = finishSession(s, now);
    if (t.repeat) {
      const anchor = t.dueDate || t.plan?.date || dateKey(new Date(now));
      const base = t.repeat.anchor || anchor;
      const next = nextOccurrence(t.repeat, base, anchor < dateKey(new Date(now)) ? dateKey(new Date(now)) : anchor);
      if (next) {
        nextId = createTask(d, {
          ...t, done: false, completedAt: null, subtasks: t.subtasks.map((s) => ({ ...s, done: false })),
          dueDate: t.dueDate ? next : null, plan: t.plan ? { date: next, startMin: t.plan.startMin } : null,
          repeat: { ...t.repeat, anchor: base },
        });
        t.repeat = null; // the finished instance is history; the series continues on the new one
      }
    }
  }
  return nextId;
}

export function deleteTask(d, id) {
  delete d.tasks[id];
  for (const e of Object.values(d.events)) if (e.taskId === id) e.taskId = null;
  for (const [uidKey, m] of Object.entries(d.moodle.items)) if (m.taskId === id) d.moodle.items[uidKey] = { ...m, taskId: null, dismissed: true };
}

/** Put a task on the timeline. Without startMin, the first free slot (from now) is chosen. */
export function planTask(d, id, date, startMin = null, now = Date.now()) {
  const t = d.tasks[id];
  if (!t) return null;
  if (startMin === null) {
    const items = dayItems(d, date).filter((i) => i.key !== `task:${id}`);
    const today = dateKey(new Date(now));
    const from = date === today ? Math.max(d.settings.dayStartMin, Math.ceil(minutesOfDay(now) / 5) * 5) : d.settings.dayStartMin;
    startMin = findSlot(items, t.estimateMin, from, d.settings.dayEndMin);
    if (startMin === null) return null;
  }
  t.plan = { date, startMin };
  t.updatedAt = Date.now();
  return startMin;
}

export function unplanTask(d, id) {
  if (d.tasks[id]) d.tasks[id].plan = null;
}

export function toggleSubtask(d, taskId, subId) {
  const s = d.tasks[taskId]?.subtasks.find((x) => x.id === subId);
  if (s) s.done = !s.done;
}

/* ---------- events ---------- */

export function createEvent(d, fields) {
  const e = normalizeEvent({ ...fields, id: uid(), createdAt: Date.now() });
  d.events[e.id] = e;
  return e.id;
}

const TIMING = ['date', 'startMin', 'durationMin'];

/**
 * Edit an occurrence. scope: 'this' (only this date), 'future' (split series), 'all'.
 * For non-recurring events scope is ignored.
 */
export function updateOccurrence(d, occ, patch, scope = 'all') {
  const e = d.events[occ.id];
  if (!e) return;
  if (!e.repeat) {
    d.events[e.id] = normalizeEvent({ ...e, ...patch, updatedAt: Date.now() });
    return;
  }
  if (scope === 'this') {
    const o = { ...(e.overrides[occ.originalDate] || {}) };
    const base = { date: occ.originalDate, startMin: e.startMin, durationMin: e.durationMin };
    // Store only what differs from the series, so later series edits still apply.
    for (const k of TIMING) if (k in patch) { if (patch[k] === base[k]) delete o[k]; else o[k] = patch[k]; }
    e.overrides[occ.originalDate] = o;
    const rest = Object.fromEntries(Object.entries(patch).filter(([k]) => !TIMING.includes(k)));
    if (Object.keys(rest).length) Object.assign(e, rest);
    d.events[e.id] = normalizeEvent(e);
    return;
  }
  if (scope === 'future' && occ.originalDate > e.date) {
    const until = addDays(occ.originalDate, -1);
    const futureOverrides = Object.fromEntries(Object.entries(e.overrides).filter(([k]) => k >= occ.originalDate));
    e.overrides = Object.fromEntries(Object.entries(e.overrides).filter(([k]) => k < occ.originalDate));
    const oldUntil = e.repeat.until;
    e.repeat = { ...e.repeat, until };
    createEvent(d, { ...e, ...patch, date: patch.date || occ.originalDate, repeat: patch.repeat === undefined ? { ...e.repeat, until: oldUntil } : patch.repeat, overrides: futureOverrides });
    return;
  }
  // 'all': timing changes shift the series base time, not its start date.
  const p = { ...patch };
  if ('date' in p && p.date !== occ.date) {
    const delta = Math.round((new Date(p.date) - new Date(occ.date)) / 86_400_000);
    p.date = addDays(e.date, delta);
  }
  d.events[e.id] = normalizeEvent({ ...e, ...p, updatedAt: Date.now() });
}

export function deleteOccurrence(d, occ, scope = 'all') {
  const e = d.events[occ.id];
  if (!e) return;
  if (!e.repeat || scope === 'all' || (scope === 'future' && occ.originalDate <= e.date)) {
    delete d.events[e.id];
    return;
  }
  if (scope === 'this') e.overrides[occ.originalDate] = { ...(e.overrides[occ.originalDate] || {}), cancelled: true };
  else if (scope === 'future') e.repeat = { ...e.repeat, until: addDays(occ.originalDate, -1) };
}

export function toggleChecklist(d, occ, itemId) {
  if (occ.kind === 'task') return toggleSubtask(d, occ.id, itemId);
  const e = d.events[occ.id];
  if (!e) return;
  if (e.repeat) {
    const o = e.overrides[occ.originalDate] || (e.overrides[occ.originalDate] = {});
    const set = new Set(o.checked || []);
    set.has(itemId) ? set.delete(itemId) : set.add(itemId);
    o.checked = [...set];
  } else {
    const it = e.checklist.find((c) => c.id === itemId);
    if (it) it.done = !it.done;
  }
}

/** Move any timeline item (drag, reflow). Recurring events move only this occurrence. */
export function moveItem(d, item, date, startMin, durationMin = item.durationMin) {
  if (item.kind === 'task') {
    const t = d.tasks[item.id];
    if (!t) return;
    t.plan = { date, startMin };
    if (durationMin !== t.estimateMin) t.estimateMin = durationMin;
  } else if (item.kind === 'event') {
    updateOccurrence(d, item, { date, startMin, durationMin }, 'this');
  }
}

/* ---------- timer ---------- */

export function startTimer(d, info, now = Date.now()) {
  const { sessions, session } = exclusiveStart(d.sessions, info, now);
  d.sessions = sessions;
  if (info.taskId && d.tasks[info.taskId]) d.tasks[info.taskId].startedAt = d.tasks[info.taskId].startedAt || now;
  return session.id;
}

export function pauseTimer(d, id, now = Date.now()) { if (d.sessions[id]) d.sessions[id] = pauseSession(d.sessions[id], now); }

export function resumeTimer(d, id, now = Date.now()) {
  for (const s of Object.values(d.sessions)) if (s.id !== id && s.status === 'running') d.sessions[s.id] = pauseSession(s, now);
  if (d.sessions[id]) d.sessions[id] = resumeSession(d.sessions[id], now);
}

export function finishTimer(d, id, { completeTask = false } = {}, now = Date.now()) {
  const s = d.sessions[id];
  if (!s) return;
  d.sessions[id] = finishSession(s, now);
  if (completeTask && s.taskId) setTaskDone(d, s.taskId, true, now);
}

/* ---------- adjustments ---------- */

export function applyProposal(d, proposal, items, label = '自動調整') {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const applied = [];
  for (const c of proposal.changes) {
    if (c.fixed) continue; // defensive: fixed items are never moved
    const it = byKey.get(c.key);
    if (!it) continue;
    moveItem(d, it, c.to.date, c.to.startMin);
    applied.push({ key: c.key, title: c.title, from: c.from, to: c.to, reason: c.reason });
  }
  d.adjustLog = [...(d.adjustLog || []), { id: uid(), at: Date.now(), label, changes: applied }].slice(-30);
  return applied.length;
}

/* ---------- moodle ---------- */

export function mergeMoodle(d, diff, now = Date.now()) {
  const term = activeTerm(d);
  const courseId = (name) => term?.courses.find((c) => name && (c.name === name || name.includes(c.name) || c.name.includes(name)))?.id || null;
  let created = 0, updated = 0;
  for (const it of diff.added) {
    const id = createTask(d, {
      title: it.title, icon: 'pencil', categoryId: 'school', dueDate: it.dueDate, dueMin: it.dueMin,
      estimateMin: 60, priority: 2, notes: [it.course ? `授業: ${it.course}` : '', it.notes].filter(Boolean).join('\n'),
      courseId: courseId(it.course), source: { kind: 'moodle', uid: it.uid, url: it.url, course: it.course, syncedAt: now },
    });
    d.moodle.items[it.uid] = { hash: it.hash, taskId: id, title: it.title, dueDate: it.dueDate, seenAt: now };
    created++;
  }
  for (const it of diff.changed) {
    const known = d.moodle.items[it.uid];
    const t = known?.taskId && d.tasks[known.taskId];
    if (t) {
      const changes = [];
      if (t.dueDate !== it.dueDate || t.dueMin !== it.dueMin) changes.push('締切');
      if (t.title !== it.title) changes.push('タイトル');
      Object.assign(t, { title: it.title, dueDate: it.dueDate, dueMin: it.dueMin, updatedAt: now });
      t.source = { ...(t.source || {}), kind: 'moodle', uid: it.uid, url: it.url, course: it.course, syncedAt: now, changedAt: now, changes };
      updated++;
    }
    d.moodle.items[it.uid] = { ...(known || {}), hash: it.hash, title: it.title, dueDate: it.dueDate, seenAt: now };
  }
  for (const uidKey of diff.removed) {
    const known = d.moodle.items[uidKey];
    if (!known || known.removed) continue;
    known.removed = true;
    const t = known.taskId && d.tasks[known.taskId];
    if (t) t.source = { ...(t.source || {}), removedAt: now };
  }
  return { created, updated, removed: diff.removed.length };
}
