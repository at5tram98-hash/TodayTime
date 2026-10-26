// Notifications. Honest scope: a web app can only fire local notifications while it is running
// (foreground, or briefly in the background on some browsers). There is no reliable way to
// schedule a notification for a closed PWA without a push server, so for guaranteed alerts we
// export events with alarms to the OS calendar (see exportCalendar in services/exporter.js).

import { dayItems, findConflicts } from '../core/schedule.js';
import { addDays, dateKey, hhmm, toInstant, MIN } from '../core/time.js';
import { elapsedMin, runningSession } from '../core/tracker.js';

const FIRED_KEY = 'todaytime:v3:notified';
let timers = [];
let inAppHandler = null;

export function onInAppNotice(fn) { inAppHandler = fn; }

export function capabilities() {
  const supported = typeof Notification !== 'undefined';
  const standalone = matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return {
    supported,
    permission: supported ? Notification.permission : 'unsupported',
    standalone,
    ios,
    // iOS only exposes notifications to Home Screen web apps (16.4+).
    needsHomeScreen: ios && !standalone && !supported,
  };
}

export async function requestPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

function firedSet() {
  try {
    const raw = JSON.parse(localStorage.getItem(FIRED_KEY) || '{}');
    const today = dateKey();
    // Keep only today's and yesterday's keys.
    return Object.fromEntries(Object.entries(raw).filter(([, d]) => d >= addDays(today, -1)));
  } catch { return {}; }
}

function markFired(key) {
  const s = firedSet();
  s[key] = dateKey();
  try { localStorage.setItem(FIRED_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

async function show(key, title, body) {
  if (firedSet()[key]) return;
  markFired(key);
  const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  if (perm === 'granted') {
    try {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg) { await reg.showNotification(title, { body, tag: key, icon: 'icon-192.png', badge: 'icon-192.png' }); return; }
      new Notification(title, { body, tag: key });
      return;
    } catch { /* fall through to in-app */ }
  }
  inAppHandler?.({ title, body });
}

/** Build the list of upcoming alerts (pure-ish; used by tests via the returned array). */
export function upcomingAlerts(state, now = Date.now()) {
  const n = state.settings.notify;
  const out = [];
  if (!n.enabled) return out;
  const today = dateKey(new Date(now));
  const horizon = now + 26 * 60 * MIN;
  for (const date of [today, addDays(today, 1)]) {
    const items = dayItems(state, date);
    for (const it of items) {
      if (it.allDay || it.done) continue;
      const at = toInstant(date, it.startMin - (it.travelBeforeMin || 0)) - n.eventLeadMin * MIN;
      if (at >= now - MIN && at < horizon) {
        const lead = it.travelBeforeMin ? `移動${it.travelBeforeMin}分を含め` : '';
        out.push({ key: `ev:${it.key}`, at, title: `${n.eventLeadMin}分後: ${it.title}`, body: `${hhmm(it.startMin)} 開始${lead ? `（${lead}）` : ''}${it.location ? ` ・${it.location}` : ''}` });
      }
    }
    if (n.conflicts) {
      for (const c of findConflicts(items)) {
        const at = Math.max(now, toInstant(date, Math.min(c.a.startMin, c.b.startMin)) - 60 * MIN);
        if (at < horizon && toInstant(date, Math.max(c.a.startMin, c.b.startMin)) > now) {
          out.push({ key: `cf:${c.a.key}|${c.b.key}`, at, title: '予定が重なっています', body: `「${c.a.title}」と「${c.b.title}」が${Math.round(c.minutes)}分重複` });
        }
      }
    }
  }
  for (const t of Object.values(state.tasks)) {
    if (t.done || !t.dueDate) continue;
    const due = toInstant(t.dueDate, t.dueMin ?? 1439);
    const at = due - n.dueLeadMin * MIN;
    if (at >= now - MIN && at < horizon) out.push({ key: `due:${t.id}:${t.dueDate}`, at, title: `締切が近づいています: ${t.title}`, body: `${t.dueDate === today ? '今日' : t.dueDate} ${hhmm(t.dueMin ?? 1439)} まで` });
    if (n.overdue && due < now) out.push({ key: `over:${t.id}:${today}`, at: now, title: `期限を過ぎています: ${t.title}`, body: '完了にするか、新しい予定を決めましょう' });
  }
  const run = runningSession(state.sessions);
  if (run && n.breakEveryMin > 0) {
    const el = elapsedMin(run, now);
    const at = now + (n.breakEveryMin - (el % n.breakEveryMin)) * MIN;
    out.push({ key: `brk:${run.id}:${Math.floor(el / n.breakEveryMin) + 1}`, at, title: '休憩しませんか', body: `「${run.title}」を${n.breakEveryMin}分続けています` });
  }
  if (run && run.plannedMin) {
    const at = now + (run.plannedMin - elapsedMin(run, now)) * MIN;
    if (at > now) out.push({ key: `end:${run.id}`, at, title: `予定時間です: ${run.title}`, body: `見積もり${run.plannedMin}分が経過しました` });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** (Re)arm in-page timers. Call whenever state changes or the app becomes visible. */
export function reschedule(state) {
  for (const t of timers) clearTimeout(t);
  timers = [];
  const now = Date.now();
  for (const a of upcomingAlerts(state, now)) {
    const delay = a.at - now;
    if (delay > 2 ** 31 - 1) continue;
    timers.push(setTimeout(() => show(a.key, a.title, a.body), Math.max(0, delay)));
  }
}

