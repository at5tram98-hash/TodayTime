import test from 'node:test';
import assert from 'node:assert/strict';

import { addDays, dateKey, diffDays, formatDuration, formatElapsed, hhmm, parseHHMM, startOfWeek, toInstant } from '../../src/core/time.js';
import { defaultState, normalizeEvent, normalizeSession, normalizeState, normalizeTask } from '../../src/core/model.js';
import { expandCourses, expandEvents, nextOccurrence, occursOn } from '../../src/core/recurrence.js';
import { dayItems, findConflicts, findSlot, freeSlots, layoutColumns } from '../../src/core/schedule.js';
import { actualMinForTask, createSession, elapsedMin, elapsedMs, endSessionAt, exclusiveStart, finishSession, isStale, overrunMin, pauseSession, resumeSession, runningSession } from '../../src/core/tracker.js';
import { parseQuickAdd, toTaskFields } from '../../src/core/parse.js';

const M = 60_000;

test('time helpers', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(diffDays('2026-10-26', '2026-11-02'), 7);
  assert.equal(startOfWeek('2026-10-29', 1), '2026-10-26'); // Thu → Mon
  assert.equal(startOfWeek('2026-10-25', 1), '2026-10-19'); // Sun → previous Mon
  assert.equal(hhmm(605), '10:05');
  assert.equal(parseHHMM('7:30'), 450);
  assert.equal(parseHHMM('25:00'), null);
  assert.equal(formatDuration(95), '1時間35分');
  assert.equal(formatElapsed(3_723_000), '1:02:03');
  assert.equal(dateKey(new Date(toInstant('2026-10-26', 90))), '2026-10-26');
});

test('normalize repairs bad input', () => {
  const t = normalizeTask({ title: '  ', priority: 9, estimateMin: -3, dueDate: 'bad' });
  assert.equal(t.title, '無題のタスク');
  assert.equal(t.priority, 3);
  assert.equal(t.estimateMin, 5);
  assert.equal(t.dueDate, null);
  const s = normalizeState({ tasks: [t, null, 3], settings: { appearance: 'neon', dayStartMin: 600, dayEndMin: 10 } });
  assert.equal(Object.keys(s.tasks).length, 1, 'corrupt rows are skipped');
  assert.equal(s.settings.appearance, 'system');
  assert.ok(s.settings.dayEndMin > s.settings.dayStartMin);
});

test('session normalize closes dangling segments', () => {
  const s = normalizeSession({ status: 'paused', segments: [{ start: 1000, end: null }, { start: 5000, end: null }] });
  assert.equal(s.segments[0].end, 5000);
  assert.equal(s.segments[1].end, 5000);
  const r = normalizeSession({ status: 'running', segments: [{ start: 1000, end: 2000 }] });
  assert.equal(r.status, 'paused');
});

test('recurrence rules', () => {
  const weekly = { freq: 'weekly', interval: 1, byWeekdays: [1, 3], until: null };
  assert.ok(occursOn(weekly, '2026-10-26', '2026-10-28')); // Wed
  assert.ok(!occursOn(weekly, '2026-10-26', '2026-10-27'));
  assert.ok(!occursOn(weekly, '2026-10-26', '2026-10-19'), 'never before start');
  const biweekly = { freq: 'weekly', interval: 2, byWeekdays: [1], until: null };
  assert.ok(occursOn(biweekly, '2026-10-26', '2026-11-09'));
  assert.ok(!occursOn(biweekly, '2026-10-26', '2026-11-02'));
  const monthly = { freq: 'monthly', interval: 1, byWeekdays: [], until: '2026-12-31' };
  assert.ok(occursOn(monthly, '2026-10-26', '2026-11-26'));
  assert.ok(!occursOn(monthly, '2026-10-26', '2027-01-26'), 'until respected');
  assert.equal(nextOccurrence({ freq: 'weekdays', interval: 1, byWeekdays: [] }, '2026-10-26', '2026-10-30'), '2026-11-02');
});

test('expandEvents applies overrides (cancel, move)', () => {
  const e = normalizeEvent({ id: 'e1', title: 'ゼミ', date: '2026-10-26', startMin: 600, durationMin: 60, repeat: { freq: 'daily' },
    overrides: { '2026-10-27': { cancelled: true }, '2026-10-28': { date: '2026-11-05', startMin: 700 } } });
  const occ = expandEvents([e], '2026-10-26', '2026-10-29');
  assert.deepEqual(occ.map((o) => o.date), ['2026-10-26', '2026-10-29']);
  const moved = expandEvents([e], '2026-11-05', '2026-11-05');
  assert.equal(moved.length, 2);
  assert.ok(moved.some((o) => o.originalDate === '2026-10-28' && o.startMin === 700));
});

test('courses expand within term', () => {
  const term = { start: '2026-10-01', end: '2026-10-31', courses: [{ id: 'c', name: '線形代数', day: 1, period: 2, room: '101', color: '#000000' }] };
  const occ = expandCourses(term, { 2: { start: 645, end: 735 } }, '2026-10-26', '2026-11-02');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].startMin, 645);
  assert.equal(occ[0].fixed, true);
});

test('conflicts, free slots and columns', () => {
  const s = defaultState();
  s.events.a = normalizeEvent({ id: 'a', date: '2026-10-26', startMin: 600, durationMin: 60 });
  s.events.b = normalizeEvent({ id: 'b', date: '2026-10-26', startMin: 630, durationMin: 60 });
  s.events.c = normalizeEvent({ id: 'c', date: '2026-10-26', startMin: 720, durationMin: 30, travelBeforeMin: 45 });
  const items = dayItems(s, '2026-10-26');
  const conf = findConflicts(items);
  assert.equal(conf.length, 2, 'a×b overlap and b×c overlap via travel time');
  const free = freeSlots(items, 540, 800);
  assert.deepEqual(free, [{ start: 540, end: 600 }, { start: 750, end: 800 }]);
  assert.equal(findSlot(items, 45, 540, 800), 540);
  assert.equal(findSlot(items, 70, 540, 800), null);
  const cols = layoutColumns(items);
  assert.equal(cols.get('a@2026-10-26').cols, 2);
});

test('tracker survives reload: elapsed is derived from timestamps', () => {
  const t0 = 1_000_000;
  let s = createSession({ title: 'レポート', plannedMin: 30 }, t0);
  s = pauseSession(s, t0 + 10 * M);
  s = resumeSession(s, t0 + 20 * M);
  // Simulate a reload: serialize/deserialize, then read later.
  const restored = normalizeSession(JSON.parse(JSON.stringify(s)));
  assert.equal(restored.status, 'running');
  assert.equal(elapsedMin(restored, t0 + 45 * M), 35);
  assert.equal(overrunMin(restored, t0 + 45 * M), 5);
  const done = finishSession(restored, t0 + 50 * M);
  assert.equal(done.status, 'done');
  assert.equal(elapsedMs(done, t0 + 999 * M), 40 * M, 'finished sessions stop counting');
  assert.equal(pauseSession(done, t0).status, 'done');
});

test('only one session runs at a time', () => {
  const a = createSession({ title: 'A', taskId: 'x' }, 0);
  const { sessions, session } = exclusiveStart({ [a.id]: a }, { title: 'B', taskId: 'y' }, 5 * M);
  assert.equal(sessions[a.id].status, 'paused');
  assert.equal(runningSession(sessions).id, session.id);
  assert.equal(actualMinForTask(sessions, 'x', 60 * M), 5);
  assert.ok(isStale(session, 5 * M + 9 * 60 * M));
  const trimmed = endSessionAt(session, 6 * M);
  assert.equal(elapsedMin(trimmed, 999 * M), 1);
});

test('quick add parser', () => {
  const today = '2026-10-26'; // Monday
  let p = parseQuickAdd('英語レポート 明日 15:00 45分 !!', { today });
  assert.deepEqual([p.title, p.date, p.startMin, p.estimateMin, p.priority], ['英語レポート', '2026-10-27', 900, 45, 2]);
  assert.deepEqual(toTaskFields(p).plan, { date: '2026-10-27', startMin: 900 });
  p = parseQuickAdd('統計 課題 金曜まで 2時間', { today });
  assert.equal(p.date, '2026-10-30');
  assert.equal(p.until, true);
  assert.equal(p.estimateMin, 120);
  assert.equal(toTaskFields(p).dueDate, '2026-10-30');
  p = parseQuickAdd('歯医者 11/3 10時半', { today });
  assert.equal(p.date, '2026-11-03');
  assert.equal(p.startMin, 630);
  p = parseQuickAdd('ゼミ準備 1時間30分', { today });
  assert.equal(p.estimateMin, 90);
  assert.equal(p.startMin, null);
  p = parseQuickAdd('月例会の資料', { today });
  assert.equal(p.title, '月例会の資料', 'bare 月 is not a weekday');
  assert.equal(p.date, null);
  p = parseQuickAdd('洗濯 #生活', { today, categories: [{ id: 'life', name: '生活' }] });
  assert.equal(p.categoryId, 'life');
  assert.equal(p.title, '洗濯');
});
