// Duration prediction from your own history: how long things *actually* took versus the
// estimate. Uses the median ratio of similar finished tasks (same title words > same category > all).

import { elapsedMin } from './tracker.js';

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const words = (title) => String(title).toLowerCase().split(/[\s・、。/()（）「」【】:：\-_]+/).filter((w) => w.length >= 2);

/** History rows: {title, categoryId, estimateMin, actualMin} for finished tasks with tracked time. */
export function historyRows(state, now = Date.now()) {
  const byTask = new Map();
  for (const s of Object.values(state.sessions)) {
    if (!s.taskId || s.status !== 'done') continue;
    byTask.set(s.taskId, (byTask.get(s.taskId) || 0) + elapsedMin(s, now));
  }
  const rows = [];
  for (const [taskId, actual] of byTask) {
    const t = state.tasks[taskId];
    if (!t || !t.done || actual < 1 || !t.estimateMin) continue;
    rows.push({ title: t.title, categoryId: t.categoryId, estimateMin: t.estimateMin, actualMin: actual });
  }
  return rows;
}

/**
 * @returns {{minutes:number, ratio:number, samples:number, basis:string}|null}
 */
export function predictDuration(task, rows) {
  if (!rows.length) return null;
  const tw = new Set(words(task.title));
  const similar = rows.filter((r) => words(r.title).some((w) => tw.has(w)));
  const sameCat = rows.filter((r) => r.categoryId === task.categoryId);
  let pool, basis;
  if (similar.length >= 2) { pool = similar; basis = '似たタスク'; }
  else if (sameCat.length >= 3) { pool = sameCat; basis = '同じカテゴリ'; }
  else if (rows.length >= 3) { pool = rows; basis = 'これまでの全実績'; }
  else return null;
  const ratio = Math.min(4, Math.max(0.25, median(pool.map((r) => r.actualMin / r.estimateMin))));
  const minutes = Math.max(5, Math.round((task.estimateMin * ratio) / 5) * 5);
  return { minutes, ratio, samples: pool.length, basis };
}

/** Overall accuracy summary for the stats screen. */
export function accuracy(rows) {
  if (!rows.length) return null;
  const ratios = rows.map((r) => r.actualMin / r.estimateMin);
  return {
    samples: rows.length,
    medianRatio: median(ratios),
    within20: ratios.filter((r) => r >= 0.8 && r <= 1.2).length / rows.length,
  };
}
