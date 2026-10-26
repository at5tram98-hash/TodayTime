import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultState } from '../../src/core/model.js';
import { applyProposal, createEvent, createTask, deleteOccurrence, finishTimer, mergeMoodle, planTask, setTaskDone, startTimer, updateOccurrence } from '../../src/data/actions.js';
import { expandEvents } from '../../src/core/recurrence.js';
import { dayItems } from '../../src/core/schedule.js';
import { planReflow } from '../../src/core/reflow.js';
import { toInstant } from '../../src/core/time.js';

test('completing a repeating task creates the next instance', () => {
  const d = defaultState();
  const id = createTask(d, { title: 'ゴミ出し', dueDate: '2026-10-26', repeat: { freq: 'weekly', byWeekdays: [1, 4] } });
  const next = setTaskDone(d, id, true, toInstant('2026-10-26', 600));
  assert.ok(next);
  assert.equal(d.tasks[next].dueDate, '2026-10-29');
  assert.equal(d.tasks[next].done, false);
  assert.equal(d.tasks[id].repeat, null, 'finished instance keeps no rule');
  const next2 = setTaskDone(d, next, true, toInstant('2026-10-29', 600));
  assert.equal(d.tasks[next2].dueDate, '2026-11-02');
});

test('editing recurring events: this / future / all', () => {
  const d = defaultState();
  const id = createEvent(d, { title: '朝ラン', date: '2026-10-26', startMin: 420, durationMin: 30, repeat: { freq: 'daily' } });
  const occ = (date) => expandEvents(Object.values(d.events), date, date).find((o) => o.title.includes('ラン') || o.id === id);
  updateOccurrence(d, occ('2026-10-27'), { startMin: 480 }, 'this');
  assert.equal(occ('2026-10-27').startMin, 480);
  assert.equal(occ('2026-10-28').startMin, 420);
  updateOccurrence(d, occ('2026-10-30'), { title: '夜ラン', startMin: 1200 }, 'future');
  assert.equal(occ('2026-10-29').title, '朝ラン');
  assert.equal(occ('2026-10-31').title, '夜ラン');
  assert.equal(occ('2026-10-31').startMin, 1200);
  deleteOccurrence(d, occ('2026-10-28'), 'this');
  assert.equal(occ('2026-10-28'), undefined);
});

test('auto-plan finds a free slot and reflow apply never touches fixed events', () => {
  const d = defaultState();
  createEvent(d, { title: '固定', date: '2026-10-26', startMin: 600, durationMin: 60, fixed: true });
  const t = createTask(d, { title: '課題', estimateMin: 90 });
  const start = planTask(d, t, '2026-10-26', null, toInstant('2026-10-26', 540));
  assert.equal(start, 660, '9:00–10:00 is too short for 90 min, so after the fixed event');
  const items = dayItems(d, '2026-10-26');
  const p = planReflow({ items, nowMin: 700, today: '2026-10-26', tomorrow: '2026-10-27', dayStartMin: 420, dayEndMin: 1380, bufferMin: 0, running: null });
  // Tamper: try to sneak a fixed change in; apply must ignore it.
  p.changes.push({ key: items[0].key, fixed: true, to: { date: '2026-10-26', startMin: 0 }, from: {}, title: '固定' });
  const n = applyProposal(d, p, items);
  assert.equal(n, 1);
  assert.equal(Object.values(d.events)[0].startMin, 600);
  assert.equal(d.tasks[t].plan.startMin, 700);
  assert.equal(d.adjustLog.length, 1);
});

test('timer finish can complete the task', () => {
  const d = defaultState();
  const t = createTask(d, { title: 'x', estimateMin: 30 });
  const s = startTimer(d, { taskId: t, title: 'x', plannedMin: 30 }, 0);
  finishTimer(d, s, { completeTask: true }, 60_000 * 25);
  assert.equal(d.sessions[s].status, 'done');
  assert.equal(d.tasks[t].done, true);
});

test('moodle merge: create once, update on change, keep on removal', () => {
  const d = defaultState();
  d.school.terms[0].courses.push({ id: 'c1', name: '統計学', day: 1, period: 1, room: '', teacher: '', credits: 2, color: '#000000', creditStatus: 'taking', notes: '' });
  const it = { uid: 'u1', title: 'レポート', course: '統計学', dueDate: '2026-10-30', dueMin: 1439, notes: '', url: '', hash: 'h1' };
  let r = mergeMoodle(d, { added: [it], changed: [], unchanged: [], removed: [] });
  assert.equal(r.created, 1);
  const taskId = d.moodle.items.u1.taskId;
  assert.equal(d.tasks[taskId].courseId, 'c1');
  r = mergeMoodle(d, { added: [], changed: [{ ...it, dueDate: '2026-10-31', hash: 'h2' }], unchanged: [], removed: [] });
  assert.equal(r.updated, 1);
  assert.equal(d.tasks[taskId].dueDate, '2026-10-31');
  assert.deepEqual(d.tasks[taskId].source.changes, ['締切']);
  mergeMoodle(d, { added: [], changed: [], unchanged: [], removed: ['u1'] });
  assert.ok(d.tasks[taskId], 'task kept when Moodle drops the event');
  assert.ok(d.tasks[taskId].source.removedAt);
});
