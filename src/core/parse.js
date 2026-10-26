// Quick-add parser: "英語レポート 明日 15:00 45分 !!" → structured task fields.
// Recognised tokens are removed from the title; anything unrecognised stays in the title.

import { addDays, dateKey, weekday } from './time.js';

const DAY_WORDS = { 今日: 0, きょう: 0, 明日: 1, あした: 1, 明後日: 2, あさって: 2 };
const WD = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

export function parseQuickAdd(input, { today = dateKey(), categories = [] } = {}) {
  let text = ` ${String(input || '').normalize('NFKC')} `;
  const out = { title: '', date: null, startMin: null, estimateMin: null, priority: 0, until: false, categoryId: null };
  const take = (re, fn) => {
    text = text.replace(re, (...m) => { const r = fn(...m); return r === false ? m[0] : ' '; });
  };

  take(/\s(!{1,3})(?=\s)/g, (_, b) => { out.priority = b.length; });
  take(/\s#(\S+)(?=\s)/g, (_, name) => {
    const c = categories.find((x) => x.name === name);
    if (!c) return false;
    out.categoryId = c.id;
  });
  take(/(\d+(?:\.\d+)?)\s*(時間|h)(?:(\d+)\s*分)?(?=\s|$)/gi, (_, h, __, m) => { out.estimateMin = Math.round(+h * 60 + (+m || 0)); });
  take(/(\d{1,2})時(?!間)(半|(\d{1,2})分)?(まで)?/g, (_, h, half, m, u) => {
    if (+h > 24) return false;
    out.startMin = +h * 60 + (half === '半' ? 30 : +m || 0);
    if (u) out.until = true;
  });
  take(/(\d+)\s*(分|m|min)(?=\s|$)/gi, (_, m) => { out.estimateMin = +m; });

  take(/(今日|きょう|明日|あした|明後日|あさって)(まで)?/g, (_, w, u) => { out.date = addDays(today, DAY_WORDS[w]); if (u) out.until = true; });
  take(/(?:(\d{4})[/-])?(\d{1,2})[/月](\d{1,2})日?(まで)?/g, (_, y, mo, d, u) => {
    const ty = +today.slice(0, 4);
    let year = y ? +y : ty;
    const k = (yy) => `${yy}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!y && k(year) < today) year += 1;
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return false;
    out.date = k(year);
    if (u) out.until = true;
  });
  take(/(来週)?([日月火水木金土])曜日?(まで)?/g, (_, next, w, u) => {
    let diff = (WD[w] - weekday(today) + 7) % 7;
    if (next) diff += diff === 0 ? 7 : 7;
    out.date = addDays(today, diff);
    if (u) out.until = true;
  });
  take(/(\d{1,2}):(\d{2})(まで)?/g, (_, h, m, u) => {
    if (+h > 24 || +m > 59) return false;
    out.startMin = +h * 60 + +m;
    if (u) out.until = true;
  });

  out.title = text.replace(/\s+/g, ' ').trim();
  if (out.startMin !== null && !out.date) out.date = today;
  return out;
}

/** Map parse output to task fields: "まで" or date-only → deadline, date+time → planned slot. */
export function toTaskFields(p) {
  const f = { title: p.title, priority: p.priority };
  if (p.estimateMin) f.estimateMin = p.estimateMin;
  if (p.categoryId) f.categoryId = p.categoryId;
  if (p.date) {
    if (p.until || p.startMin === null) { f.dueDate = p.date; f.dueMin = p.startMin; }
    else f.plan = { date: p.date, startMin: p.startMin };
  }
  return f;
}
