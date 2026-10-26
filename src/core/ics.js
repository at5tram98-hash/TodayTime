// Minimal RFC 5545 reader/writer: enough for Moodle calendar exports and for exporting
// our schedule (with alarms) to the OS calendar, which can notify reliably in the background.

import { dateKey, hhmm } from './time.js';

export function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

const unescapeText = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const escapeText = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

/** Parse DTSTART-like values to {ts, date, minute, allDay} in local time. */
export function parseIcsDate(value, params = {}) {
  const v = value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || params.VALUE === 'DATE') {
    m = m || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return { ts: d.getTime(), date: dateKey(d), minute: null, allDay: true };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  // TZID values are treated as local time (Moodle normally emits UTC "Z" values).
  const dt = z ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))) : new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  return { ts: dt.getTime(), date: dateKey(dt), minute: dt.getHours() * 60 + dt.getMinutes(), allDay: false };
}

export function parseIcs(text) {
  const lines = unfold(text).split('\n');
  const events = [];
  let cur = null;
  let calName = '';
  let nested = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (/^BEGIN:/.test(line) && cur) { nested++; continue; }
    if (/^END:/.test(line) && nested) { nested--; continue; }
    if (nested) continue;
    if (line === 'END:VEVENT') { if (cur?.uid) events.push(cur); cur = null; continue; }
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const head = line.slice(0, idx), value = line.slice(idx + 1);
    const [name, ...rawParams] = head.split(';');
    const params = Object.fromEntries(rawParams.map((p) => p.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
    const key = name.toUpperCase();
    if (!cur) { if (key === 'X-WR-CALNAME') calName = unescapeText(value); continue; }
    switch (key) {
      case 'UID': cur.uid = value.trim(); break;
      case 'SUMMARY': cur.summary = unescapeText(value); break;
      case 'DESCRIPTION': cur.description = unescapeText(value); break;
      case 'LOCATION': cur.location = unescapeText(value); break;
      case 'URL': cur.url = value.trim(); break;
      case 'CATEGORIES': cur.categories = unescapeText(value); break;
      case 'DTSTART': cur.start = parseIcsDate(value, params); break;
      case 'DTEND': cur.end = parseIcsDate(value, params); break;
      case 'LAST-MODIFIED': cur.lastModified = parseIcsDate(value, params)?.ts ?? null; break;
      case 'DTSTAMP': cur.stamp = parseIcsDate(value, params)?.ts ?? null; break;
      case 'SEQUENCE': cur.sequence = +value || 0; break;
      default: break;
    }
  }
  return { calName, events: events.filter((e) => e.start) };
}

/** Moodle-specific: turn a VEVENT into assignment-ish fields. */
export function moodleItem(ev) {
  let title = ev.summary || '課題';
  title = title.replace(/\s*(の提出期限|の期限|is due|closes|終了)$/i, '').trim() || title;
  const course = (ev.categories || '').split(',')[0].trim();
  return {
    uid: ev.uid,
    title,
    course,
    dueDate: ev.start.date,
    dueMin: ev.start.allDay ? null : ev.start.minute,
    notes: (ev.description || '').trim(),
    url: ev.url || '',
    // Content fingerprint: detects changed due dates or titles even when LAST-MODIFIED is missing.
    hash: [title, ev.start.ts, course, (ev.description || '').length].join('|'),
  };
}

/** Compare remote items to what we already imported. */
export function diffMoodle(known, remote) {
  const added = [], changed = [], unchanged = [];
  for (const it of remote) {
    const k = known[it.uid];
    if (!k) added.push(it);
    else if (k.hash !== it.hash) changed.push(it);
    else unchanged.push(it);
  }
  const remoteIds = new Set(remote.map((r) => r.uid));
  const removed = Object.keys(known).filter((uid) => !remoteIds.has(uid));
  return { added, changed, unchanged, removed };
}

const fmtUtc = (ts) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const fmtDate = (key) => key.replace(/-/g, '');

// Lines are folded at 75 octets (UTF-8), never inside a character.
function fold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > 74) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

/**
 * @param {Array<{uid, title, allDay, date, startTs, endTs, notes, location, alarmMin}>} items
 */
export function buildIcs(items, calName = 'TodayTime Pro') {
  const now = fmtUtc(Date.now());
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TodayTime Pro//JA', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${escapeText(calName)}`];
  for (const it of items) {
    L.push('BEGIN:VEVENT', `UID:${it.uid}`, `DTSTAMP:${now}`);
    if (it.allDay) {
      L.push(`DTSTART;VALUE=DATE:${fmtDate(it.date)}`);
    } else {
      L.push(`DTSTART:${fmtUtc(it.startTs)}`, `DTEND:${fmtUtc(it.endTs)}`);
    }
    L.push(`SUMMARY:${escapeText(it.title)}`);
    if (it.location) L.push(`LOCATION:${escapeText(it.location)}`);
    if (it.notes) L.push(`DESCRIPTION:${escapeText(it.notes)}`);
    if (it.alarmMin != null) {
      L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(it.title)}`, `TRIGGER:-PT${Math.max(0, Math.round(it.alarmMin))}M`, 'END:VALARM');
    }
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

export { hhmm };
