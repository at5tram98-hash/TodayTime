// Time tracking. A session is a list of [start, end] segments; elapsed time is always derived
// from those timestamps, so reloads, sleep and backgrounding never lose or invent time.

import { normalizeSession, uid } from './model.js';
import { MIN } from './time.js';

export function elapsedMs(s, now = Date.now()) {
  let ms = 0;
  for (const g of s.segments) ms += Math.max(0, (g.end ?? now) - g.start);
  return ms;
}

export function elapsedMin(s, now = Date.now()) {
  return elapsedMs(s, now) / MIN;
}

export function runningSession(sessions) {
  return Object.values(sessions).find((s) => s.status === 'running') || null;
}

export function activeSessions(sessions) {
  return Object.values(sessions).filter((s) => s.status !== 'done').sort((a, b) => b.createdAt - a.createdAt);
}

export function createSession(info, now = Date.now()) {
  return normalizeSession({
    id: uid(),
    taskId: info.taskId || null,
    eventKey: info.eventKey || null,
    title: info.title,
    icon: info.icon,
    categoryId: info.categoryId,
    plannedMin: info.plannedMin || 0,
    segments: [{ start: now, end: null }],
    status: 'running',
    createdAt: now,
  });
}

export function pauseSession(s, now = Date.now()) {
  if (s.status !== 'running') return s;
  const segments = s.segments.map((g, i) => (i === s.segments.length - 1 && g.end === null ? { ...g, end: Math.max(g.start, now) } : g));
  return { ...s, segments, status: 'paused' };
}

export function resumeSession(s, now = Date.now()) {
  if (s.status !== 'paused') return s;
  return { ...s, segments: [...s.segments, { start: now, end: null }], status: 'running' };
}

export function finishSession(s, now = Date.now()) {
  if (s.status === 'done') return s;
  const p = pauseSession(s, now);
  return { ...p, status: 'done', endedAt: now };
}

/** Pauses any other running session, so only one clock runs at a time. */
export function exclusiveStart(sessions, info, now = Date.now()) {
  const next = {};
  for (const [id, s] of Object.entries(sessions)) next[id] = s.status === 'running' ? pauseSession(s, now) : s;
  const s = createSession(info, now);
  next[s.id] = s;
  return { sessions: next, session: s };
}

/** Minutes the session ran past its plan (0 when on time or unplanned). */
export function overrunMin(s, now = Date.now()) {
  if (!s.plannedMin) return 0;
  return Math.max(0, elapsedMin(s, now) - s.plannedMin);
}

export function actualMinForTask(sessions, taskId, now = Date.now()) {
  let m = 0;
  for (const s of Object.values(sessions)) if (s.taskId === taskId) m += elapsedMin(s, now);
  return m;
}

/** Total tracked minutes whose segments fall inside [fromTs, toTs). */
export function trackedBetween(sessions, fromTs, toTs, now = Date.now()) {
  let ms = 0;
  for (const s of Object.values(sessions)) {
    for (const g of s.segments) {
      const a = Math.max(g.start, fromTs), b = Math.min(g.end ?? now, toTs);
      if (b > a) ms += b - a;
    }
  }
  return ms / MIN;
}

/** Sessions that have been running suspiciously long (likely forgotten). */
export function isStale(s, now = Date.now(), limitMin = 8 * 60) {
  if (s.status !== 'running') return false;
  const last = s.segments[s.segments.length - 1];
  return (now - last.start) / MIN > limitMin;
}

/** Trim the open segment of a forgotten session so it ends at `endTs`. */
export function endSessionAt(s, endTs) {
  const segments = s.segments
    .filter((g) => g.start < endTs)
    .map((g) => ({ start: g.start, end: Math.min(g.end ?? endTs, endTs) }));
  return { ...s, segments, status: 'done', endedAt: endTs };
}
