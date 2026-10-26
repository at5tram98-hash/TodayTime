// Automatic schedule adjustment. Produces a *proposal* (never mutates): flexible items
// (planned tasks, events marked 柔軟) are pushed later to make room after a delay, fixed
// items (fixed events, classes) are treated as immovable walls. Items that no longer fit
// today are proposed for tomorrow, with urgent items (deadline today / high priority) kept first.

import { hhmm } from './time.js';
import { span, freeSlots } from './schedule.js';

export function isMovable(item) {
  return !item.fixed && !item.allDay && !item.done && (item.kind === 'task' || item.kind === 'event');
}

export function urgency(item, today) {
  let u = (item.priority || 0) * 10;
  if (item.dueDate) {
    if (item.dueDate < today) u += 100;
    else if (item.dueDate === today) u += 60;
  }
  return u;
}

/**
 * @param {object} p
 * @param {Array} p.items          today's timeline items
 * @param {Array} [p.tomorrowItems]
 * @param {number} p.nowMin        current minute of day
 * @param {string} p.today         date key
 * @param {string} p.tomorrow      date key
 * @param {number} p.dayStartMin
 * @param {number} p.dayEndMin
 * @param {number} [p.bufferMin]
 * @param {{key:string, endMin:number, title:string, overMin:number}|null} [p.running]
 *        the item currently being worked on and when it is now expected to end.
 */
export function planReflow(p) {
  const buffer = p.bufferMin ?? 5;
  const runningKey = p.running?.key || null;
  const cursor0 = Math.max(p.nowMin, p.running ? p.running.endMin : p.nowMin);

  // Movable items that are affected: not started & either already missed or now overlapping
  // the cursor / each other once the cursor moves.
  const movable = p.items.filter((i) => isMovable(i) && i.key !== runningKey && i.endMin > p.dayStartMin);
  const candidates = movable.filter((i) => i.startMin < cursor0 + buffer || i.startMin >= p.nowMin - 1);
  const walls = p.items.filter((i) => !candidates.includes(i) && !i.allDay && !(i.kind === 'task' && i.done));
  if (p.running) walls.push({ key: runningKey, startMin: p.nowMin - 1, endMin: cursor0, travelBeforeMin: 0, travelAfterMin: 0 });

  const byStart = [...candidates].sort((a, b) => a.startMin - b.startMin);
  let placement = place(byStart, walls, cursor0 + buffer, p.dayEndMin, buffer);
  if (placement.overflow.length) {
    // Urgent overflow items get first claim on today's remaining time.
    const maxOverflow = Math.max(...placement.overflow.map((i) => urgency(i, p.today)));
    const minPlaced = placement.placed.length ? Math.min(...placement.placed.map((x) => urgency(x.item, p.today))) : Infinity;
    if (maxOverflow > minPlaced) {
      const byUrgency = [...candidates].sort((a, b) => urgency(b, p.today) - urgency(a, p.today) || a.startMin - b.startMin);
      placement = place(byUrgency, walls, cursor0 + buffer, p.dayEndMin, buffer, true);
    }
  }

  const changes = [];
  for (const { item, start } of placement.placed) {
    if (start === item.startMin) continue;
    const reasons = [];
    if (p.running && item.startMin < cursor0 + buffer) reasons.push(`「${p.running.title}」が${Math.round(p.running.overMin)}分延びたため`);
    else if (item.startMin < p.nowMin) reasons.push('開始時刻を過ぎたため');
    else reasons.push('前の予定が後ろにずれたため');
    if (placement.urgentFirst && urgency(item, p.today) >= 60) reasons.push('締切・優先度を考慮して今日に確保');
    const hopped = walls.find((w) => w.fixed && w.endMin <= start && w.endMin > item.startMin);
    if (hopped) reasons.push(`固定予定「${hopped.title}」を避けて配置`);
    changes.push(change(item, p.today, start, reasons.join('、')));
  }

  // Overflow → tomorrow, packed into tomorrow's free time from the start of day.
  const tomorrowBusy = [...(p.tomorrowItems || []).filter((i) => !i.allDay)];
  const unplaced = [];
  for (const item of placement.overflow) {
    const due = item.dueDate && item.dueDate <= p.today;
    const slot = freeSlots(tomorrowBusy, p.dayStartMin, p.dayEndMin).find((g) => g.end - g.start >= item.durationMin);
    if (!slot) { unplaced.push({ item, reason: '今日も明日も空き時間が足りません' }); continue; }
    tomorrowBusy.push({ startMin: slot.start, endMin: slot.start + item.durationMin, travelBeforeMin: 0, travelAfterMin: 0 });
    const c = change(item, p.tomorrow, slot.start, `今日の終了時刻（${hhmm(p.dayEndMin)}）までに入らないため明日へ`);
    if (due) c.warning = '締切が今日までです。明日に回すと間に合いません';
    changes.push(c);
  }

  const fixedTouched = changes.some((c) => c.fixed);
  return { changes, unplaced, fixedTouched, cursorMin: cursor0 };
}

function change(item, date, startMin, reason) {
  return {
    key: item.key, kind: item.kind, id: item.id, originalDate: item.originalDate, title: item.title, icon: item.icon,
    recurring: !!item.recurring, fixed: !!item.fixed, durationMin: item.durationMin,
    from: { date: item.date, startMin: item.startMin },
    to: { date, startMin },
    reason,
  };
}

function place(order, walls, fromMin, endMin, buffer, urgentFirst = false) {
  const busy = walls.map((w) => ({ ...w }));
  const placed = [], overflow = [];
  for (const item of order) {
    const earliest = Math.max(item.startMin, fromMin);
    let start = null;
    for (const g of freeSlots(busy, earliest, endMin)) {
      if (g.end - g.start >= item.durationMin) { start = g.start; break; }
    }
    if (start === null) { overflow.push(item); continue; }
    placed.push({ item, start });
    busy.push({ startMin: start, endMin: start + item.durationMin + buffer, travelBeforeMin: 0, travelAfterMin: 0 });
  }
  return { placed, overflow, urgentFirst };
}

/**
 * Decide whether a proposal is worth showing right now.
 * Returns {running, nowMin} describing the delay, or null.
 */
export function detectDelay({ items, nowMin, running, graceMin = 5 }) {
  if (running && running.overMin > 0) {
    const affected = items.some((i) => isMovable(i) && i.key !== running.key && i.startMin < running.endMin + graceMin && i.endMin > nowMin);
    if (affected) return { type: 'overrun' };
  }
  const missed = items.filter((i) => isMovable(i) && i.key !== running?.key && i.kind === 'task' && i.startMin + graceMin < nowMin && !i.startedAt);
  if (missed.length) return { type: 'missed', count: missed.length };
  return null;
}

/** Sanity check used by tests and before applying: fixed items must never move. */
export function respectsFixed(proposal) {
  return proposal.changes.every((c) => !c.fixed);
}

export { span };
