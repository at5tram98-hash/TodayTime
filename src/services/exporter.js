// Backup / restore files and calendar export.

import { looksLikeState, normalizeState } from '../core/model.js';
import { isLegacyV2, migrateV2 } from '../core/migrate.js';
import { buildIcs } from '../core/ics.js';
import { itemsInRange } from '../core/schedule.js';
import { addDays, dateKey, toInstant } from '../core/time.js';

export async function saveFile(name, text, type) {
  const blob = new Blob([text], { type });
  const file = typeof File !== 'undefined' ? new File([blob], name, { type }) : null;
  // iOS Home Screen apps cannot trigger downloads reliably; the share sheet can save to Files.
  if (file && navigator.canShare?.({ files: [file] }) && /iP(hone|ad)/.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: name }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

export function backupJson(state) {
  return JSON.stringify({ app: 'TodayTime Pro', exportedAt: new Date().toISOString(), state }, null, 1);
}

/** Accepts v3 backups, raw v3 state, or old-app (v2) backups. Returns {state, kind, report?}. */
export function parseBackup(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('JSONとして読み込めませんでした'); }
  const inner = doc?.state ?? doc;
  if (looksLikeState(inner)) return { state: normalizeState(inner), kind: 'v3' };
  for (const cand of [doc, doc?.state, doc?.data?.state, doc?.payload]) {
    if (isLegacyV2(cand)) { const r = migrateV2(cand); return { state: r.state, kind: 'legacy', report: r.report }; }
  }
  throw new Error('TodayTimeのバックアップファイルではありません');
}

/** Next `days` days of events + task deadlines, with alarms, for the OS calendar. */
export function calendarIcs(state, days = 14) {
  const today = dateKey();
  const lead = state.settings.notify.eventLeadMin;
  const items = itemsInRange(state, today, addDays(today, days - 1)).filter((i) => i.kind !== 'task' || !i.done);
  const rows = items.map((i) => ({
    uid: `${i.key}@todaytime-pro`,
    title: i.title,
    allDay: i.allDay,
    date: i.date,
    startTs: toInstant(i.date, i.startMin - (i.travelBeforeMin || 0)),
    endTs: toInstant(i.date, i.endMin + (i.travelAfterMin || 0)),
    location: i.location,
    notes: [i.travelBeforeMin ? `移動 ${i.travelBeforeMin}分を含む` : '', i.notes].filter(Boolean).join('\n'),
    alarmMin: i.allDay ? null : lead,
  }));
  for (const t of Object.values(state.tasks)) {
    if (t.done || !t.dueDate || t.dueDate < today || t.dueDate > addDays(today, days)) continue;
    const end = toInstant(t.dueDate, t.dueMin ?? 1439);
    rows.push({ uid: `due:${t.id}@todaytime-pro`, title: `締切: ${t.title}`, allDay: false, startTs: end - 15 * 60_000, endTs: end, notes: t.notes, alarmMin: state.settings.notify.dueLeadMin });
  }
  return buildIcs(rows);
}
