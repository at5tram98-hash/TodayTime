// Migration from the previous TodayTime app (localStorage "todaytime:v2:main", schemaVersion 2)
// into schema v3. Pure: takes the parsed old document, returns {state, report}.
// The old data is never modified or deleted by the app.

import { defaultState, normalizeCategory, normalizeCourse, normalizeEvent, normalizeSession, normalizeState, normalizeTask, uid } from './model.js';
import { nextOccurrence } from './recurrence.js';
import { isDateKey, parseHHMM } from './time.js';

export const LEGACY_KEYS = { main: 'todaytime:v2:main', staging: 'todaytime:v2:staging', lastGood: 'todaytime:v2:last-good', auto: 'todaytime:v2:auto-backup', v1: 'todaytime_v1' };

const toTs = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const mapPriority = (p) => ({ 1: 0, 2: 0, 3: 0, 4: 2, 5: 3 })[Math.round(+p)] ?? 0;

export function isLegacyV2(doc) {
  return !!doc && doc.schemaVersion === 2 && doc.data && typeof doc.data === 'object';
}

export function migrateV2(doc) {
  const d = doc.data || {};
  const s = defaultState();
  const report = { events: 0, recurring: 0, tasks: 0, assignments: 0, sessions: 0, courses: 0, quizzes: 0, categories: 0, skipped: [] };

  // Categories: keep old calendar ids so references stay valid.
  const cats = new Map(s.categories.map((c) => [c.id, c]));
  const jobByCal = new Map();
  for (const j of Array.isArray(d.jobs) ? d.jobs : []) jobByCal.set(`job:${j.id}`, j);
  for (const c of Array.isArray(d.calendars) ? d.calendars : []) {
    const job = jobByCal.get(c.id) || (c.jobId && jobByCal.get(`job:${c.jobId}`));
    const icon = c.kind === 'travel' ? 'tram' : c.kind === 'rest' ? 'cup' : job ? 'briefcase' : cats.get(c.id)?.icon || 'calendar';
    const n = normalizeCategory({ id: c.id, name: c.name, color: c.color, icon, ...(job ? { wagePerHour: job.wagePerHour || 0, transportPerShift: job.transportCostPerShift || 0 } : {}) });
    if (c.id === 'travel' && n.name === '移動時間') n.name = '移動';
    cats.set(n.id, n);
  }
  s.categories = [...cats.values()];
  report.categories = s.categories.length;

  // Events (templates) + recurrence + per-occurrence overrides.
  const tpls = d.eventTemplates && typeof d.eventTemplates === 'object' ? d.eventTemplates : {};
  const series = d.recurrenceSeries && typeof d.recurrenceSeries === 'object' ? d.recurrenceSeries : {};
  const seriesByTemplate = new Map();
  for (const sr of Object.values(series)) if (sr?.templateEventId) seriesByTemplate.set(sr.templateEventId, sr);
  const eventIdBySeries = new Map();

  for (const t of Object.values(tpls)) {
    try {
      const planned = t.planned || {};
      const sr = (t.recurrenceSeriesId && series[t.recurrenceSeriesId]) || seriesByTemplate.get(t.id);
      let repeat = null;
      if (sr?.recurrenceRule) {
        const r = sr.recurrenceRule;
        repeat = { freq: ['daily', 'weekly', 'monthly'].includes(r.frequency) ? r.frequency : 'weekly', interval: r.interval || 1, byWeekdays: r.byWeekdays || [], until: r.endMode === 'until' && isDateKey(r.untilDate) ? r.untilDate : null };
        if (r.endMode === 'count' && r.count > 0) {
          // Convert "N times" into an end date.
          let date = planned.date, last = planned.date;
          for (let i = 1; i < r.count && date; i++) { date = nextOccurrence({ ...repeat, until: null }, planned.date, date); if (date) last = date; }
          repeat.until = last;
        }
        eventIdBySeries.set(sr.id, t.id);
      }
      const checklist = [
        ...((t.subSchedule?.items) || []).map((x) => ({ id: x.id, title: x.title, done: false })),
        ...((t.belongings) || []).map((x) => ({ id: x.id, title: `持ち物: ${x.text || ''}`, done: false })),
      ];
      const ev = normalizeEvent({
        id: t.id, title: t.title, icon: t.eventIcon, categoryId: t.calendarId || 'plan',
        date: planned.date, startMin: planned.startMinute ?? planned.startMin, durationMin: planned.durationMinute ?? planned.durationMin,
        allDay: !!t.allDay, fixed: t.constraints?.mode !== 'flexible', location: t.location, notes: t.notes, repeat,
        travelBeforeMin: t.travelSet?.enabled ? t.travelSet.before?.durationMinute || 0 : 0,
        travelAfterMin: t.travelSet?.enabled ? t.travelSet.after?.durationMinute || 0 : 0,
        checklist, createdAt: t.createdAt, updatedAt: t.updatedAt,
      });
      if (!cats.has(ev.categoryId)) ev.categoryId = 'plan';
      s.events[ev.id] = ev;
      report.events++;
      if (repeat) report.recurring++;
    } catch (e) {
      report.skipped.push(`予定「${t?.title || '?'}」: ${e.message}`);
    }
  }

  for (const [key, o] of Object.entries(d.occurrenceOverrides || {})) {
    const eventId = eventIdBySeries.get(o?.seriesId) || key.split('@')[0];
    const ev = s.events[eventId];
    const orig = o?.originalDate || key.split('@')[1];
    if (!ev || !isDateKey(orig)) continue;
    const p = o.patch?.planned || {};
    ev.overrides[orig] = {
      ...(o.cancelled ? { cancelled: true } : {}),
      ...(isDateKey(p.date || o.effectiveDate) && (p.date || o.effectiveDate) !== orig ? { date: p.date || o.effectiveDate } : {}),
      ...(Number.isFinite(p.startMinute) ? { startMin: p.startMinute } : {}),
      ...(p.durationMinute > 0 ? { durationMin: p.durationMinute } : {}),
    };
  }
  for (const id of Object.keys(s.events)) s.events[id] = normalizeEvent(s.events[id]);

  // Executions → finished (or paused) sessions.
  for (const [key, x] of Object.entries(d.executions || {})) {
    const st = toTs(x?.event?.actualStartAt), en = toTs(x?.event?.actualEndAt);
    if (!st) continue;
    const [id, date] = key.split('@');
    const ev = s.events[id] || s.events[eventIdBySeries.get(id)];
    const sess = normalizeSession({
      id: uid(), eventKey: ev ? `${ev.id}@${date}` : null, title: ev?.title || '予定', icon: ev?.icon, categoryId: ev?.categoryId,
      plannedMin: ev?.durationMin || 0, segments: [{ start: st, end: en && en >= st ? en : null }],
      status: en && en >= st ? 'done' : 'paused', createdAt: st, endedAt: en,
    });
    if (sess.status === 'paused') sess.segments[0].end = st;
    s.sessions[sess.id] = sess;
    report.sessions++;
  }

  // Assignments → school tasks; loose tasks → inbox tasks.
  for (const a of Array.isArray(d.assignments) ? d.assignments : []) {
    const t = normalizeTask({
      id: a.id, title: a.course && !String(a.title).includes(a.course) ? `${a.title}` : a.title, icon: a.kind === 'exam' ? 'flag' : 'pencil',
      categoryId: 'school', priority: mapPriority(a.priority), dueDate: a.dueDate, dueMin: parseHHMM(a.dueTime || '23:59'),
      estimateMin: a.estimateMinute || 60, notes: [a.course ? `授業: ${a.course}` : '', a.progress ? `進捗: ${a.progress}%` : '', a.notes || ''].filter(Boolean).join('\n'),
      done: !!a.completedAt, completedAt: toTs(a.completedAt), courseId: a.courseId || null,
    });
    s.tasks[t.id] = t;
    report.assignments++;
  }
  for (const l of Array.isArray(d.looseTasks) ? d.looseTasks : []) {
    const t = normalizeTask({ id: l.id, title: l.title, estimateMin: l.durationMinute || 30, priority: mapPriority(l.priority), done: !!l.completedAt || !!l.done, completedAt: toTs(l.completedAt) });
    s.tasks[t.id] = t;
    report.tasks++;
  }

  const qt = Array.isArray(d.quickTemplates) ? d.quickTemplates : [];
  if (qt.length) {
    s.templates = qt.slice(0, 12).map((q) => ({ id: uid(), title: q.name || q.title || 'テンプレート', icon: q.iconName || q.eventIcon || 'circle', categoryId: cats.has(q.calendarId) ? q.calendarId : 'plan', estimateMin: q.durationMinute || q.planned?.durationMinute || 30 }));
  }

  // School: periods, terms, courses; quizzes become fixed events.
  const sc = d.school || {};
  if (sc.periods) s.school.periods = { ...s.school.periods, ...sc.periods };
  if (Array.isArray(sc.terms) && sc.terms.length) {
    s.school.terms = sc.terms.map((t) => ({ id: t.id || uid(), label: t.label || '学期', start: t.start, end: t.end, courses: (t.courses || []).map((c) => normalizeCourse({ ...c, creditStatus: c.creditStatus === 'planned' ? 'taking' : c.creditStatus })) }));
    s.school.activeTermId = sc.activeTermId || s.school.terms[0].id;
    for (const t of sc.terms) {
      report.courses += (t.courses || []).length;
      for (const q of t.quizzes || []) {
        const course = (t.courses || []).find((c) => c.id === q.courseId);
        const ev = normalizeEvent({
          id: q.id, title: `${course ? course.name + ' ' : ''}${q.title || '小テスト'}`, icon: 'flag', categoryId: 'school',
          date: q.date, startMin: parseHHMM(q.time || '') ?? (course && s.school.periods[course.period]?.start) ?? 540, durationMin: q.duration || 30,
          notes: [q.score !== '' && q.score != null ? `点数: ${q.score}/${q.maxScore || 100}` : '', q.notes || ''].filter(Boolean).join('\n'),
        });
        s.events[ev.id] = ev;
        report.quizzes++;
      }
    }
  }
  s.school.creditTarget = sc.creditTarget || 124;
  s.school.pastCredits = sc.pastEarned || 0;

  const pref = doc.preferences || {};
  s.settings.appearance = pref.appearance === 'dark' ? 'dark' : pref.appearance === 'light' ? 'light' : 'system';
  s.settings.haptics = pref.haptics !== false;
  if (pref.tracking) {
    if (Number.isFinite(pref.tracking.startMinute)) s.settings.dayStartMin = pref.tracking.startMinute;
    if (Number.isFinite(pref.tracking.endMinute)) s.settings.dayEndMin = Math.min(1440, pref.tracking.endMinute);
  }
  s.meta.migratedFrom = 'todaytime:v2';
  s.meta.migratedAt = Date.now();
  s.meta.onboarded = true;
  return { state: normalizeState(s), report };
}

/** v1 (very old) docs are first lifted by the old app's own logic; we only support plain events/tasks. */
export function migrateV1(doc) {
  const shim = {
    schemaVersion: 2,
    data: {
      calendars: doc.calendars,
      eventTemplates: Object.fromEntries((doc.events || []).filter((e) => !e.autoGeneratedTravel && !e.autoRest).map((e) => {
        const sm = parseHHMM(e.start || '09:00') ?? 540, em = parseHHMM(e.end || '') ?? sm + 60;
        return [e.id || uid(), { id: e.id, title: e.title, location: e.location, calendarId: e.calendarId, notes: e.notes, planned: { date: e.date, startMinute: sm, durationMinute: Math.max(5, em - sm) } }];
      })),
      assignments: doc.assignments, looseTasks: doc.looseTasks,
    },
    preferences: { appearance: doc.settings?.appearance },
  };
  const r = migrateV2(shim);
  r.state.meta.migratedFrom = 'todaytime_v1';
  return r;
}

/** Pick the best legacy document from a storage-like getter. */
export function readLegacy(get) {
  for (const k of [LEGACY_KEYS.main, LEGACY_KEYS.staging, LEGACY_KEYS.lastGood, LEGACY_KEYS.auto]) {
    const raw = get(k);
    if (!raw) continue;
    try {
      const doc = JSON.parse(raw);
      if (isLegacyV2(doc)) return { key: k, doc, version: 2 };
    } catch { /* try next */ }
  }
  const v1 = get(LEGACY_KEYS.v1);
  if (v1) { try { return { key: LEGACY_KEYS.v1, doc: JSON.parse(v1), version: 1 }; } catch { /* ignore */ } }
  return null;
}

export function migrateLegacy(found) {
  return found.version === 2 ? migrateV2(found.doc) : migrateV1(found.doc);
}
