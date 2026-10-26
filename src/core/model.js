// Schema v3 — the single source of truth for persisted data.
// normalize* functions accept anything (old data, partial imports) and return a valid shape.

import { dateKey, clamp, isDateKey } from './time.js';

export const SCHEMA = 3;

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export const DEFAULT_CATEGORIES = [
  { id: 'plan', name: '予定', color: '#0a84ff', icon: 'calendar' },
  { id: 'school', name: '大学', color: '#5e5ce6', icon: 'book' },
  { id: 'study', name: '勉強', color: '#30b0c7', icon: 'pencil' },
  { id: 'work', name: 'アルバイト', color: '#ff9f0a', icon: 'briefcase', wagePerHour: 0 },
  { id: 'life', name: '生活', color: '#34c759', icon: 'house' },
  { id: 'travel', name: '移動', color: '#8e8e93', icon: 'tram' },
  { id: 'rest', name: '休憩', color: '#ff375f', icon: 'cup' },
];

export const PRIORITY = [
  { value: 0, label: 'なし', mark: '' },
  { value: 1, label: '低', mark: '!' },
  { value: 2, label: '中', mark: '!!' },
  { value: 3, label: '高', mark: '!!!' },
];

export function defaultSchool(now = new Date()) {
  const y = now.getFullYear(), fall = now.getMonth() >= 7;
  return {
    periods: {
      1: { start: 540, end: 630 }, 2: { start: 645, end: 735 }, 3: { start: 795, end: 885 },
      4: { start: 900, end: 990 }, 5: { start: 1005, end: 1095 }, 6: { start: 1110, end: 1200 },
    },
    terms: [{
      id: 'term-' + y + (fall ? 'f' : 's'),
      label: `${y} ${fall ? '秋' : '春'}学期`,
      start: fall ? `${y}-09-01` : `${y}-04-01`,
      end: fall ? `${y + 1}-01-31` : `${y}-07-31`,
      courses: [],
    }],
    activeTermId: 'term-' + y + (fall ? 'f' : 's'),
    creditTarget: 124,
    pastCredits: 0,
  };
}

export function defaultSettings() {
  return {
    appearance: 'system', // system | light | dark
    textScale: 1,
    haptics: true,
    sounds: false,
    dayStartMin: 420,
    dayEndMin: 1410,
    weekStart: 1,
    calendarView: 'day',
    hourHeight: 56,
    notify: { enabled: false, eventLeadMin: 10, dueLeadMin: 180, overdue: true, conflicts: true, breakEveryMin: 0 },
    adjust: { bufferMin: 5, autoPrompt: true },
  };
}

export function defaultState() {
  const now = Date.now();
  return {
    schema: SCHEMA,
    rev: 0,
    tasks: {},
    events: {},
    sessions: {},
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    templates: [
      { id: uid(), title: '課題', icon: 'pencil', categoryId: 'study', estimateMin: 60 },
      { id: uid(), title: '買い物', icon: 'cart', categoryId: 'life', estimateMin: 30 },
      { id: uid(), title: '洗濯', icon: 'house', categoryId: 'life', estimateMin: 20 },
    ],
    school: defaultSchool(),
    moodle: { url: '', lastSyncAt: null, lastAttemptAt: null, status: 'never', error: null, items: {} },
    settings: defaultSettings(),
    adjustLog: [],
    meta: { createdAt: now, updatedAt: now, migratedFrom: null, migratedAt: null, lastBackupAt: null, onboarded: false },
  };
}

const str = (v, d = '') => (typeof v === 'string' ? v : v == null ? d : String(v));
const num = (v, d = 0) => (Number.isFinite(+v) && v !== '' && v !== null ? +v : d);
const minuteOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : clamp(Math.round(+v), 0, 1439));

export function normalizeRepeat(r) {
  if (!r || typeof r !== 'object' || !r.freq || r.freq === 'none') return null;
  const freq = ['daily', 'weekdays', 'weekly', 'monthly'].includes(r.freq) ? r.freq : 'weekly';
  return {
    freq,
    interval: clamp(Math.round(num(r.interval, 1)) || 1, 1, 52),
    byWeekdays: Array.isArray(r.byWeekdays) ? [...new Set(r.byWeekdays.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [],
    until: isDateKey(r.until) ? r.until : null,
    ...(isDateKey(r.anchor) ? { anchor: r.anchor } : {}),
  };
}

const normList = (arr) => (Array.isArray(arr) ? arr : []).map((x) => ({ id: str(x?.id) || uid(), title: str(x?.title ?? x?.text), done: !!x?.done })).filter((x) => x.title);

export function normalizeTask(t = {}) {
  const now = Date.now();
  return {
    id: str(t.id) || uid(),
    title: str(t.title).trim() || '無題のタスク',
    icon: str(t.icon, 'circle') || 'circle',
    categoryId: str(t.categoryId, 'plan') || 'plan',
    priority: clamp(Math.round(num(t.priority, 0)), 0, 3),
    dueDate: isDateKey(t.dueDate) ? t.dueDate : null,
    dueMin: minuteOrNull(t.dueMin),
    estimateMin: clamp(Math.round(num(t.estimateMin, 30)), 5, 24 * 60),
    plan: t.plan && isDateKey(t.plan.date) ? { date: t.plan.date, startMin: minuteOrNull(t.plan.startMin) ?? 540 } : null,
    notes: str(t.notes),
    repeat: normalizeRepeat(t.repeat),
    subtasks: normList(t.subtasks),
    done: !!t.done,
    completedAt: t.done ? num(t.completedAt, now) : null,
    startedAt: t.startedAt ? num(t.startedAt, null) : null,
    courseId: t.courseId ? str(t.courseId) : null,
    source: t.source && typeof t.source === 'object' ? { ...t.source } : null,
    createdAt: num(t.createdAt, now),
    updatedAt: num(t.updatedAt, now),
  };
}

export function normalizeEvent(e = {}) {
  const now = Date.now();
  const overrides = {};
  if (e.overrides && typeof e.overrides === 'object') {
    for (const [k, v] of Object.entries(e.overrides)) {
      if (!isDateKey(k) || !v || typeof v !== 'object') continue;
      const o = {};
      if (v.cancelled) o.cancelled = true;
      if (isDateKey(v.date)) o.date = v.date;
      if (minuteOrNull(v.startMin) !== null) o.startMin = minuteOrNull(v.startMin);
      if (num(v.durationMin, 0) > 0) o.durationMin = clamp(Math.round(+v.durationMin), 5, 1440);
      if (Array.isArray(v.checked)) o.checked = v.checked.map(String);
      overrides[k] = o;
    }
  }
  return {
    id: str(e.id) || uid(),
    title: str(e.title).trim() || '予定',
    icon: str(e.icon, 'calendar') || 'calendar',
    categoryId: str(e.categoryId, 'plan') || 'plan',
    date: isDateKey(e.date) ? e.date : dateKey(),
    startMin: minuteOrNull(e.startMin) ?? 540,
    durationMin: clamp(Math.round(num(e.durationMin, 60)), 5, 1440),
    allDay: !!e.allDay,
    fixed: e.fixed !== false,
    location: str(e.location),
    notes: str(e.notes),
    repeat: normalizeRepeat(e.repeat),
    overrides,
    travelBeforeMin: clamp(Math.round(num(e.travelBeforeMin, 0)), 0, 240),
    travelAfterMin: clamp(Math.round(num(e.travelAfterMin, 0)), 0, 240),
    checklist: normList(e.checklist),
    taskId: e.taskId ? str(e.taskId) : null,
    courseId: e.courseId ? str(e.courseId) : null,
    source: e.source && typeof e.source === 'object' ? { ...e.source } : null,
    createdAt: num(e.createdAt, now),
    updatedAt: num(e.updatedAt, now),
  };
}

export function normalizeSession(s = {}) {
  const segments = (Array.isArray(s.segments) ? s.segments : [])
    .map((g) => ({ start: num(g?.start, NaN), end: g?.end == null ? null : num(g.end, NaN) }))
    .filter((g) => Number.isFinite(g.start) && (g.end === null || (Number.isFinite(g.end) && g.end >= g.start)));
  // Only the last segment may be open.
  segments.forEach((g, i) => { if (i < segments.length - 1 && g.end === null) g.end = segments[i + 1].start; });
  let status = ['running', 'paused', 'done'].includes(s.status) ? s.status : 'done';
  const open = segments.length && segments[segments.length - 1].end === null;
  if (status === 'running' && !open) status = 'paused';
  if (status !== 'running' && open) segments[segments.length - 1].end = segments[segments.length - 1].start;
  return {
    id: str(s.id) || uid(),
    taskId: s.taskId ? str(s.taskId) : null,
    eventKey: s.eventKey ? str(s.eventKey) : null,
    title: str(s.title) || '作業',
    icon: str(s.icon, 'timer') || 'timer',
    categoryId: str(s.categoryId, 'plan') || 'plan',
    plannedMin: clamp(Math.round(num(s.plannedMin, 0)), 0, 1440),
    segments,
    status,
    createdAt: num(s.createdAt, segments[0]?.start ?? Date.now()),
    endedAt: status === 'done' ? num(s.endedAt, segments[segments.length - 1]?.end ?? Date.now()) : null,
  };
}

export function normalizeCategory(c = {}) {
  return {
    id: str(c.id) || uid(),
    name: str(c.name).trim() || 'カテゴリ',
    color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#0a84ff',
    icon: str(c.icon, 'tag') || 'tag',
    ...(c.wagePerHour != null ? { wagePerHour: Math.max(0, num(c.wagePerHour, 0)) } : {}),
    ...(c.transportPerShift != null ? { transportPerShift: Math.max(0, num(c.transportPerShift, 0)) } : {}),
  };
}

export function normalizeCourse(c = {}) {
  return {
    id: str(c.id) || uid(),
    name: str(c.name).trim() || '授業',
    day: clamp(Math.round(num(c.day, 1)), 0, 6),
    period: clamp(Math.round(num(c.period, 1)), 1, 8),
    room: str(c.room),
    teacher: str(c.teacher),
    credits: Math.max(0, num(c.credits, 2)),
    color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#5e5ce6',
    creditStatus: ['taking', 'earned', 'failed'].includes(c.creditStatus) ? c.creditStatus : 'taking',
    notes: str(c.notes),
  };
}

export function normalizeState(raw) {
  const d = defaultState();
  if (!raw || typeof raw !== 'object') return d;
  const s = { ...d };
  s.rev = num(raw.rev, 0);
  const mapOf = (obj, fn) => {
    const out = {};
    const list = Array.isArray(obj) ? obj : Object.values(obj || {});
    for (const x of list) { if (!x || typeof x !== 'object') continue; try { const n = fn(x); out[n.id] = n; } catch { /* skip corrupt row */ } }
    return out;
  };
  s.tasks = mapOf(raw.tasks, normalizeTask);
  s.events = mapOf(raw.events, normalizeEvent);
  s.sessions = mapOf(raw.sessions, normalizeSession);
  const cats = Array.isArray(raw.categories) && raw.categories.length ? raw.categories.map(normalizeCategory) : d.categories;
  s.categories = cats;
  s.templates = Array.isArray(raw.templates)
    ? raw.templates.map((t) => ({ id: str(t.id) || uid(), title: str(t.title) || 'テンプレート', icon: str(t.icon, 'circle'), categoryId: str(t.categoryId, 'plan'), estimateMin: clamp(num(t.estimateMin, 30), 5, 1440) }))
    : d.templates;
  const sc = raw.school && typeof raw.school === 'object' ? raw.school : {};
  s.school = {
    periods: { ...d.school.periods, ...(sc.periods || {}) },
    terms: Array.isArray(sc.terms) && sc.terms.length
      ? sc.terms.map((t) => ({ id: str(t.id) || uid(), label: str(t.label) || '学期', start: isDateKey(t.start) ? t.start : d.school.terms[0].start, end: isDateKey(t.end) ? t.end : d.school.terms[0].end, courses: (t.courses || []).map(normalizeCourse) }))
      : d.school.terms,
    activeTermId: str(sc.activeTermId),
    creditTarget: num(sc.creditTarget, 124),
    pastCredits: num(sc.pastCredits, 0),
  };
  if (!s.school.terms.some((t) => t.id === s.school.activeTermId)) s.school.activeTermId = s.school.terms[0].id;
  s.moodle = { ...d.moodle, ...(raw.moodle || {}), items: { ...((raw.moodle && raw.moodle.items) || {}) } };
  const st = raw.settings || {};
  s.settings = { ...d.settings, ...st, notify: { ...d.settings.notify, ...(st.notify || {}) }, adjust: { ...d.settings.adjust, ...(st.adjust || {}) } };
  if (!['system', 'light', 'dark'].includes(s.settings.appearance)) s.settings.appearance = 'system';
  s.settings.textScale = clamp(num(s.settings.textScale, 1), 0.9, 1.4);
  s.settings.dayStartMin = clamp(num(s.settings.dayStartMin, 420), 0, 1380);
  s.settings.dayEndMin = clamp(num(s.settings.dayEndMin, 1410), s.settings.dayStartMin + 60, 1440);
  s.adjustLog = Array.isArray(raw.adjustLog) ? raw.adjustLog.slice(-30) : [];
  s.meta = { ...d.meta, ...(raw.meta || {}) };
  return s;
}

/** Shallow validation used before trusting a stored or imported document. */
export function looksLikeState(raw) {
  return !!raw && typeof raw === 'object' && raw.schema === SCHEMA && typeof raw.tasks === 'object' && typeof raw.events === 'object';
}

export function categoryOf(state, id) {
  return state.categories.find((c) => c.id === id) || state.categories[0] || DEFAULT_CATEGORIES[0];
}

export function activeTerm(state) {
  return state.school.terms.find((t) => t.id === state.school.activeTermId) || state.school.terms[0];
}
