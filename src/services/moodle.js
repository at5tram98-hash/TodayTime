// Moodle integration via the calendar export (iCal) that every student can generate:
//   Moodle → カレンダー → カレンダーをエクスポート → 「イベント: すべて/コース」→ URLを取得
// Moodle's Web Service API needs a token from the site administrator and Moodle does not send
// CORS headers, so a static web app cannot call it. The export URL is fetched directly when the
// server allows it; otherwise the downloaded .ics file can be imported (always works).

import { diffMoodle, moodleItem, parseIcs } from '../core/ics.js';

export class MoodleError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

export function validateUrl(url) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, message: 'URLの形式が正しくありません' }; }
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && u.protocol !== 'webcal:' && !local) return { ok: false, message: 'https:// で始まるURLを入力してください' };
  const looksMoodle = /export_execute\.php/.test(u.pathname) || u.searchParams.has('authtoken');
  return { ok: true, warning: looksMoodle ? null : 'Moodleのカレンダーエクスポート用URL（export_execute.php）ではないようです' };
}

export async function fetchIcs(url, { timeoutMs = 15000 } = {}) {
  const target = url.replace(/^webcal:/i, 'https:');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(target, { cache: 'no-store', credentials: 'omit', signal: ctl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new MoodleError('timeout', '応答がありませんでした（タイムアウト）');
    if (!navigator.onLine) throw new MoodleError('offline', 'オフラインです。通信環境を確認してください');
    throw new MoodleError('cors', 'Moodleサーバーがブラウザからの直接取得を許可していません（CORS）。.icsファイルを読み込んでください');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new MoodleError('auth', 'アクセスが拒否されました。URLのトークンが失効していないか確認してください');
  if (!res.ok) throw new MoodleError('http', `サーバーエラー（${res.status}）`);
  return res.text();
}

export function parseMoodle(text) {
  if (!/BEGIN:VCALENDAR/.test(text)) throw new MoodleError('format', 'iCalendar（.ics）形式ではありません。ログイン画面が返された可能性があります');
  const { events } = parseIcs(text);
  return events.map(moodleItem);
}

/** Returns {items, diff}. Caller merges into state via actions.mergeMoodle. */
export function analyse(state, items) {
  // Ignore items the user deliberately deleted (dismissed) unless Moodle changed them.
  const known = state.moodle.items;
  const diff = diffMoodle(known, items);
  diff.added = diff.added.filter((it) => !known[it.uid]?.dismissed);
  diff.changed = diff.changed.filter((it) => !known[it.uid]?.dismissed);
  return diff;
}
