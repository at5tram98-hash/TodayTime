// Recurrence rules: { freq: daily|weekdays|weekly|monthly, interval, byWeekdays, until }.

import { addDays, diffDays, parseDateKey, startOfWeek, weekday } from './time.js';

export function occursOn(rule, baseDate, date) {
  if (!rule) return date === baseDate;
  if (date < baseDate) return false;
  if (rule.until && date > rule.until) return false;
  const n = rule.interval || 1;
  switch (rule.freq) {
    case 'daily':
      return diffDays(baseDate, date) % n === 0;
    case 'weekdays': {
      const wd = weekday(date);
      return wd >= 1 && wd <= 5;
    }
    case 'weekly': {
      const days = rule.byWeekdays?.length ? rule.byWeekdays : [weekday(baseDate)];
      if (!days.includes(weekday(date))) return false;
      const weeks = Math.round(diffDays(startOfWeek(baseDate, 0), startOfWeek(date, 0)) / 7);
      return weeks % n === 0;
    }
    case 'monthly': {
      const b = parseDateKey(baseDate), d = parseDateKey(date);
      if (b.getDate() !== d.getDate()) return false;
      const months = (d.getFullYear() - b.getFullYear()) * 12 + d.getMonth() - b.getMonth();
      return months % n === 0;
    }
    default:
      return date === baseDate;
  }
}

/** First date strictly after `after` (and not before base) that matches the rule. */
export function nextOccurrence(rule, baseDate, after) {
  if (!rule) return null;
  let d = after < baseDate ? baseDate : addDays(after, 1);
  for (let i = 0; i < 800; i++) {
    if (rule.until && d > rule.until) return null;
    if (occursOn(rule, baseDate, d)) return d;
    d = addDays(d, 1);
  }
  return null;
}

export function describeRepeat(rule) {
  if (!rule) return '繰り返しなし';
  const n = rule.interval || 1;
  const names = ['日', '月', '火', '水', '木', '金', '土'];
  let s;
  switch (rule.freq) {
    case 'daily': s = n === 1 ? '毎日' : `${n}日ごと`; break;
    case 'weekdays': s = '平日'; break;
    case 'weekly': {
      const days = rule.byWeekdays?.length ? rule.byWeekdays.map((d) => names[d]).join('・') : '';
      s = (n === 1 ? '毎週' : `${n}週ごと`) + (days ? ` ${days}` : '');
      break;
    }
    case 'monthly': s = n === 1 ? '毎月' : `${n}か月ごと`; break;
    default: s = '繰り返し';
  }
  return rule.until ? `${s}（${rule.until}まで）` : s;
}

/**
 * Expand events into concrete occurrences whose effective date lies in [from, to].
 * Overrides keyed by original date can cancel, move or resize a single occurrence.
 */
export function expandEvents(events, from, to) {
  const out = [];
  for (const e of events) {
    if (!e.repeat) {
      if (e.date >= from && e.date <= to) out.push(toOccurrence(e, e.date, null));
      continue;
    }
    // Moved occurrences may land inside the window from outside it; scan a margin.
    const start = addDays(from, -31) < e.date ? e.date : addDays(from, -31);
    const end = addDays(to, 31);
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (!occursOn(e.repeat, e.date, d)) continue;
      const o = e.overrides?.[d];
      if (o?.cancelled) continue;
      const occ = toOccurrence(e, d, o);
      if (occ.date >= from && occ.date <= to) out.push(occ);
    }
  }
  return out;
}

function toOccurrence(e, originalDate, o) {
  const date = o?.date || originalDate;
  const startMin = o?.startMin ?? e.startMin;
  const durationMin = o?.durationMin ?? e.durationMin;
  const checked = e.repeat ? new Set(o?.checked || []) : null;
  return {
    kind: 'event',
    key: `${e.id}@${originalDate}`,
    id: e.id,
    originalDate,
    date,
    startMin,
    durationMin,
    endMin: startMin + durationMin,
    allDay: e.allDay,
    title: e.title,
    icon: e.icon,
    categoryId: e.categoryId,
    fixed: e.fixed,
    location: e.location,
    notes: e.notes,
    recurring: !!e.repeat,
    travelBeforeMin: e.travelBeforeMin,
    travelAfterMin: e.travelAfterMin,
    checklist: e.checklist.map((c) => ({ ...c, done: checked ? checked.has(c.id) : c.done })),
    taskId: e.taskId,
    courseId: e.courseId,
    source: e.source,
  };
}

/** Timetable classes become fixed occurrences on matching weekdays inside the term. */
export function expandCourses(term, periods, from, to) {
  if (!term) return [];
  const out = [];
  const a = from > term.start ? from : term.start;
  const b = to < term.end ? to : term.end;
  for (let d = a; d <= b; d = addDays(d, 1)) {
    const wd = weekday(d);
    for (const c of term.courses) {
      if (c.day !== wd) continue;
      if (term.cancelled?.includes(`${c.id}@${d}`)) continue;
      const p = periods[c.period];
      if (!p) continue;
      out.push({
        kind: 'course', key: `course:${c.id}@${d}`, id: c.id, originalDate: d, date: d,
        startMin: p.start, durationMin: p.end - p.start, endMin: p.end, allDay: false,
        title: c.name, icon: 'book', categoryId: 'school', color: c.color, fixed: true,
        location: c.room, notes: c.teacher ? `担当: ${c.teacher}` : '', recurring: true,
        travelBeforeMin: 0, travelAfterMin: 0, checklist: [], period: c.period, courseId: c.id,
      });
    }
  }
  return out;
}
