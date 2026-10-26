import test from 'node:test';
import assert from 'node:assert/strict';

import { planReflow, respectsFixed, detectDelay } from '../../src/core/reflow.js';
import { predictDuration, historyRows } from '../../src/core/predict.js';
import { buildIcs, diffMoodle, moodleItem, parseIcs } from '../../src/core/ics.js';
import { defaultState, normalizeSession, normalizeTask } from '../../src/core/model.js';

const item = (key, startMin, durationMin, extra = {}) => ({
  key, id: key, kind: 'task', date: '2026-10-26', originalDate: '2026-10-26', title: key, startMin, durationMin,
  endMin: startMin + durationMin, allDay: false, fixed: false, travelBeforeMin: 0, travelAfterMin: 0, priority: 0, ...extra,
});

const base = { today: '2026-10-26', tomorrow: '2026-10-27', dayStartMin: 420, dayEndMin: 1380, bufferMin: 0 };

test('overrun pushes following flexible tasks, fixed ones stay', () => {
  const items = [
    item('A', 600, 60),                                  // running, planned 10:00-11:00
    item('B', 660, 30),                                  // flexible 11:00
    item('ゼミ', 720, 90, { kind: 'event', fixed: true }), // fixed 12:00-13:30
    item('C', 700, 20),                                  // flexible 11:40
  ];
  // It's 11:20 and A is still running (20 min over).
  const p = planReflow({ ...base, items, nowMin: 680, running: { key: 'A', endMin: 680, title: 'A', overMin: 20 } });
  assert.ok(respectsFixed(p));
  const to = Object.fromEntries(p.changes.map((c) => [c.key, c.to.startMin]));
  assert.equal(to.B, 680, 'B starts right after A');
  assert.equal(to.C, 810, 'C would collide with fixed ゼミ → after it');
  assert.ok(!('ゼミ' in to));
  assert.match(p.changes.find((c) => c.key === 'C').reason, /固定予定「ゼミ」/);
  assert.match(p.changes.find((c) => c.key === 'B').reason, /20分延びた/);
});

test('overflow goes to tomorrow; urgent items keep today', () => {
  const items = [
    item('low', 1300, 60, { priority: 0 }),
    item('due', 1310, 60, { priority: 0, dueDate: '2026-10-26' }),
  ];
  const p = planReflow({ ...base, items, nowMin: 1300, running: null, tomorrowItems: [item('朝', 420, 60, { fixed: true, date: '2026-10-27' })] });
  const due = p.changes.find((c) => c.key === 'due');
  const low = p.changes.find((c) => c.key === 'low');
  assert.equal(low.to.date, '2026-10-27');
  assert.equal(low.to.startMin, 480, 'packed after tomorrow\'s fixed item');
  assert.ok(!due || due.to.date === '2026-10-26', 'deadline-today task stays today');
});

test('missed planned tasks are detected and rescheduled from now', () => {
  const items = [item('朝の課題', 540, 30)];
  assert.deepEqual(detectDelay({ items, nowMin: 600, running: null }), { type: 'missed', count: 1 });
  const p = planReflow({ ...base, items, nowMin: 600, running: null });
  assert.equal(p.changes[0].to.startMin, 600);
  assert.equal(detectDelay({ items: [item('x', 700, 30)], nowMin: 600, running: null }), null);
});

test('duration prediction learns from history', () => {
  const s = defaultState();
  const add = (title, est, actual, i) => {
    const t = normalizeTask({ id: 't' + i, title, estimateMin: est, done: true, categoryId: 'study' });
    s.tasks[t.id] = t;
    s.sessions['s' + i] = normalizeSession({ id: 's' + i, taskId: t.id, status: 'done', segments: [{ start: 0, end: actual * 60_000 }] });
  };
  add('英語 課題 1', 30, 45, 1);
  add('英語 課題 2', 30, 60, 2);
  add('数学 演習', 60, 60, 3);
  const rows = historyRows(s);
  assert.equal(rows.length, 3);
  const p = predictDuration({ title: '英語 課題 3', estimateMin: 40, categoryId: 'study' }, rows);
  assert.equal(p.basis, '似たタスク');
  assert.equal(p.samples, 2);
  assert.equal(p.minutes, 70); // 40 × median(1.5, 2) = 70
  assert.equal(predictDuration({ title: 'x', estimateMin: 30 }, []), null);
});

const MOODLE = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Moodle Pty Ltd//NONSGML Moodle Version 2024//EN',
  'BEGIN:VEVENT', 'UID:1234@moodle.example.ac.jp', 'SUMMARY:レポート課題1 の提出期限', 'DESCRIPTION:A4で2枚\\, PDF提出',
  'CATEGORIES:統計学', 'DTSTAMP:20261020T000000Z', 'DTSTART:20261030T145900Z', 'DTEND:20261030T145900Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:99@moodle.example.ac.jp', 'SUMMARY:小テスト 終了', 'DTSTART;VALUE=DATE:20261101', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('Moodle iCal parsing, dedupe and update detection', () => {
  const { events } = parseIcs(MOODLE);
  assert.equal(events.length, 2);
  const items = events.map(moodleItem);
  assert.equal(items[0].title, 'レポート課題1');
  assert.equal(items[0].course, '統計学');
  assert.equal(items[0].notes, 'A4で2枚, PDF提出');
  assert.equal(items[1].dueMin, null);
  const known = { [items[0].uid]: { hash: items[0].hash } };
  let d = diffMoodle(known, items);
  assert.equal(d.added.length, 1);
  assert.equal(d.unchanged.length, 1);
  const moved = parseIcs(MOODLE.replace('20261030T145900Z', '20261031T145900Z')).events.map(moodleItem);
  d = diffMoodle({ [items[0].uid]: { hash: items[0].hash }, [items[1].uid]: { hash: items[1].hash } }, moved);
  assert.equal(d.changed.length, 1, 'due date change detected');
  assert.equal(d.added.length, 0, 'no duplicates');
});

test('ics export round-trips and folds by bytes', () => {
  const long = 'とても長いタイトル'.repeat(10);
  const text = buildIcs([{ uid: 'u1', title: long, allDay: false, startTs: Date.UTC(2026, 9, 26, 1, 0), endTs: Date.UTC(2026, 9, 26, 2, 0), alarmMin: 10, notes: 'a,b;c' }]);
  assert.ok(text.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75));
  const { events } = parseIcs(text);
  assert.equal(events[0].summary, long);
  assert.equal(events[0].description, 'a,b;c');
  assert.match(text, /TRIGGER:-PT10M/);
});
