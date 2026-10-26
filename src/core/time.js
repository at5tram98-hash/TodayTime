// Date / time primitives. Dates are local "YYYY-MM-DD" keys, times are minutes since midnight,
// instants are epoch milliseconds. Everything here is pure and timezone-local.

export const MIN = 60_000;
export const DAY_MIN = 1440;

const pad = (n) => String(n).padStart(2, '0');

export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDateKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function isDateKey(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

export function addDays(key, n) {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

export function diffDays(a, b) {
  return Math.round((parseDateKey(b) - parseDateKey(a)) / 86_400_000);
}

export function weekday(key) {
  return parseDateKey(key).getDay();
}

export function startOfWeek(key, weekStart = 1) {
  const wd = weekday(key);
  return addDays(key, -((wd - weekStart + 7) % 7));
}

export function minutesOfDay(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/** Epoch ms for a local date key + minute offset (minutes may exceed a day). */
export function toInstant(key, minute = 0) {
  const d = parseDateKey(key);
  d.setMinutes(Math.round(minute));
  return d.getTime();
}

export function hhmm(minute) {
  const m = ((Math.round(minute) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function parseHHMM(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const h = +m[1], mm = +m[2];
  if (h > 24 || mm > 59) return null;
  return h * 60 + mm;
}

export function formatDuration(min, { short = false } = {}) {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60), r = m % 60;
  if (short) return h ? (r ? `${h}h${r}m` : `${h}h`) : `${r}m`;
  if (!h) return `${r}分`;
  return r ? `${h}時間${r}分` : `${h}時間`;
}

/** "1:02:03" style clock for elapsed milliseconds. */
export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export function formatDateLabel(key, today = dateKey()) {
  const diff = diffDays(today, key);
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  if (diff === 2) return '明後日';
  if (diff === -1) return '昨日';
  const d = parseDateKey(key);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
}

export function formatLongDate(key) {
  const d = parseDateKey(key);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}曜日`;
}

/** Relative description of a deadline, e.g. "あと3時間", "2日超過". */
export function relativeDue(dueTs, now) {
  const diff = dueTs - now;
  const abs = Math.abs(diff);
  let txt;
  if (abs < 60 * MIN) txt = `${Math.max(1, Math.round(abs / MIN))}分`;
  else if (abs < 48 * 60 * MIN) txt = `${Math.round(abs / (60 * MIN))}時間`;
  else txt = `${Math.round(abs / (1440 * MIN))}日`;
  return diff >= 0 ? `あと${txt}` : `${txt}超過`;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function snap(min, step = 5) {
  return Math.round(min / step) * step;
}
