import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { migrateLegacy, readLegacy } from '../../src/core/migrate.js';
import { expandEvents } from '../../src/core/recurrence.js';
import { looksLikeState } from '../../src/core/model.js';

const raw = readFileSync(new URL('./fixtures/legacy-v2.json', import.meta.url), 'utf8');

test('legacy v2 document (as saved by the old app) migrates without loss', () => {
  const store = { 'todaytime:v2:main': raw };
  const found = readLegacy((k) => store[k] ?? null);
  assert.equal(found.version, 2);
  const { state, report } = migrateLegacy(found);
  assert.ok(looksLikeState(state));
  assert.deepEqual(report.skipped, []);

  // Categories keep old ids; jobs keep their wage.
  const gu = state.categories.find((c) => c.id === 'job:starter-job-gu');
  assert.equal(gu.name, 'GU');
  assert.equal(gu.wagePerHour, 1300);
  assert.equal(gu.transportPerShift, 840);

  // Weekly series with count=3 → until date; override moves 11/02 to 11/03 13:20.
  const ev = state.events.ev1;
  assert.equal(ev.repeat.freq, 'weekly');
  assert.equal(ev.repeat.until, '2026-11-09');
  assert.equal(ev.travelBeforeMin, 20);
  assert.deepEqual(ev.checklist.map((c) => c.title), ['資料印刷', '持ち物: PC']);
  const occ = expandEvents(Object.values(state.events), '2026-10-26', '2026-11-30').filter((o) => o.id === 'ev1');
  assert.deepEqual(occ.map((o) => [o.date, o.startMin]), [['2026-10-26', 780], ['2026-11-03', 800], ['2026-11-09', 780]]);

  // Flexible job shift stays flexible and in the job category.
  assert.equal(state.events.ev2.fixed, false);
  assert.equal(state.events.ev2.categoryId, 'job:starter-job-gu');

  // Execution → finished session with exact duration (4h).
  const sess = Object.values(state.sessions);
  assert.equal(sess.length, 1);
  assert.equal(sess[0].status, 'done');
  assert.equal(sess[0].segments[0].end - sess[0].segments[0].start, 4 * 3600_000);

  // Assignment and loose task.
  assert.equal(state.tasks.as1.dueDate, '2026-10-30');
  assert.equal(state.tasks.as1.dueMin, 23 * 60 + 59);
  assert.equal(state.tasks.as1.priority, 3);
  assert.equal(state.tasks.as1.categoryId, 'school');
  assert.equal(state.tasks.l1.estimateMin, 20);

  // School: course kept, quiz becomes a fixed event at the course's period.
  assert.equal(state.school.terms[0].courses[0].name, '統計学');
  assert.equal(state.events.q1.startMin, 645);
  assert.match(state.events.q1.notes, /8\/10/);
  assert.equal(state.templates.length, 3);
  assert.equal(state.settings.appearance, 'light');
});

test('readLegacy ignores garbage and falls back to backups', () => {
  const doc = JSON.parse(raw);
  const store = { 'todaytime:v2:main': '{broken', 'todaytime:v2:last-good': JSON.stringify(doc) };
  const found = readLegacy((k) => store[k] ?? null);
  assert.equal(found.key, 'todaytime:v2:last-good');
  assert.equal(readLegacy(() => null), null);
});
