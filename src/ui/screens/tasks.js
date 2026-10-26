// タスク: smart lists, search, category filter, swipe/long-press rows, inline quick add.

import { html, useMemo, useState } from '../h.js';
import { Icon } from '../icons.js';
import { Empty, NavButton, Screen, Section, Segmented, TaskRow } from '../components.js';
import { openQuickAdd, openTaskEditor } from '../forms.js';
import { parseQuickAdd, toTaskFields } from '../../core/parse.js';
import { historyRows } from '../../core/predict.js';
import { addDays, dateKey, formatDateLabel, formatDuration, hhmm } from '../../core/time.js';
import { activeSessions } from '../../core/tracker.js';
import { confirmDanger, useNow } from '../runtime.js';
import { mutate } from '../../data/store.js';
import * as ops from '../ops.js';

function group(tasks, today) {
  const g = { overdue: [], today: [], tomorrow: [], week: [], later: [], none: [] };
  for (const t of tasks) {
    const d = t.plan?.date && (!t.dueDate || t.plan.date < t.dueDate) ? t.plan.date : t.dueDate;
    if (!d) g.none.push(t);
    else if (t.dueDate && t.dueDate < today) g.overdue.push(t);
    else if (d <= today) g.today.push(t);
    else if (d === addDays(today, 1)) g.tomorrow.push(t);
    else if (d <= addDays(today, 7)) g.week.push(t);
    else g.later.push(t);
  }
  const key = (t) => [t.plan?.date || t.dueDate || '9999', String(t.plan?.startMin ?? t.dueMin ?? 9999).padStart(4, '0'), 9 - t.priority].join('|');
  for (const k of Object.keys(g)) g[k].sort((a, b) => key(a).localeCompare(key(b)));
  return g;
}

const LABELS = { overdue: '期限切れ', today: '今日', tomorrow: '明日', week: '7日以内', later: 'それ以降', none: '期限なし' };

export function TasksScreen({ state, active }) {
  const now = useNow(60_000);
  const today = dateKey(new Date(now));
  const [filter, setFilter] = useState('focus');
  const [cat, setCat] = useState(null);
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const rows = useMemo(() => historyRows(state, now), [state]);
  const running = new Set(activeSessions(state.sessions).filter((s) => s.status === 'running').map((s) => s.taskId));

  const all = Object.values(state.tasks);
  const q = query.trim().toLowerCase();
  const match = (t) => (!cat || t.categoryId === cat) && (!q || t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q));
  const open = all.filter((t) => !t.done && match(t));
  const done = all.filter((t) => t.done && match(t)).sort((a, b) => b.completedAt - a.completedAt);
  const g = group(open, today);
  const sections = filter === 'focus' ? ['overdue', 'today', 'tomorrow', 'week'] : filter === 'all' ? ['overdue', 'today', 'tomorrow', 'week', 'later', 'none'] : [];
  const focusCount = g.overdue.length + g.today.length + g.tomorrow.length + g.week.length;
  const p = parseQuickAdd(text, { today, categories: state.categories });

  const add = (e) => {
    e.preventDefault();
    if (!p.title) return;
    ops.addTask({ ...toTaskFields(p), ...(cat && !p.categoryId ? { categoryId: cat } : {}) });
    setText('');
  };

  const clearDone = async () => {
    if (!(await confirmDanger(`完了済み${done.length}件を削除しますか？`, '実行記録は残ります', 'すべて削除'))) return;
    mutate('完了済みを削除', (d) => { for (const t of done) delete d.tasks[t.id]; });
  };

  const row = (t) => html`<${TaskRow} key=${t.id} task=${t} state=${state} now=${now} rows=${rows} running=${running.has(t.id)} onOpen=${(x) => openTaskEditor(x)} />`;

  return html`<${Screen} id="tasks" active=${active} title="タスク" subtitle=${`未完了 ${open.length}件${g.overdue.length ? ` · 期限切れ ${g.overdue.length}件` : ''}`}
    actions=${html`<${NavButton} icon="plus" label="タスクを追加" primary onClick=${() => openQuickAdd({ mode: 'task' })} />`}
>

    <${Segmented} label="表示" value=${filter} onChange=${setFilter} options=${[{ value: 'focus', label: `7日間${focusCount ? ' ' + focusCount : ''}` }, { value: 'all', label: 'すべて' }, { value: 'done', label: '完了' }]} />
    <div class="search"><${Icon} name="search" /><input type="search" placeholder="検索" value=${query} onInput=${(e) => setQuery(e.target.value)} aria-label="タスクを検索" />${query && html`<button class="icon-btn" aria-label="クリア" onClick=${() => setQuery('')}><${Icon} name="xmark" /></button>`}</div>
    <div class="chips scroll-x" role="radiogroup" aria-label="カテゴリで絞り込み">
      <button role="radio" aria-checked=${!cat} class=${`chip ${!cat ? 'on' : ''}`} onClick=${() => setCat(null)}>すべて</button>
      ${state.categories.map((c) => html`<button key=${c.id} role="radio" aria-checked=${cat === c.id} class=${`chip ${cat === c.id ? 'on' : ''}`} style=${`--c:${c.color}`} onClick=${() => setCat(cat === c.id ? null : c.id)}><span class="dot"></span>${c.name}</button>`)}
    </div>

    <form class="inline-add" onSubmit=${add}>
      <span class="plus"><${Icon} name="plus" /></span>
      <input placeholder="新しいタスク（例: 洗濯 明日 20分）" value=${text} onInput=${(e) => setText(e.target.value)} enterkeyhint="done" aria-label="新しいタスク" />
      ${p.title && (p.date || p.estimateMin || p.priority) ? html`<span class="inline-hint">${p.date ? formatDateLabel(p.date) + (p.startMin != null ? ' ' + hhmm(p.startMin) : '') : ''}${p.estimateMin ? ' ' + formatDuration(p.estimateMin) : ''}${p.priority ? ' ' + '!'.repeat(p.priority) : ''}</span>` : ''}
    </form>

    ${filter !== 'done' && sections.every((k) => !g[k].length) && html`<${Empty} icon="checkCircle" title=${q || cat ? '該当するタスクはありません' : filter === 'focus' ? '7日以内のタスクはありません' : 'タスクはありません'} text=${filter === 'focus' && g.none.length + g.later.length ? `期限なし・先の予定が${g.none.length + g.later.length}件あります` : '上の入力欄から追加できます'} />`}
    ${sections.map((k) => g[k].length > 0 && html`<${Section} key=${k} title=${`${LABELS[k]} ${g[k].length}`} cls=${k === 'overdue' ? 'overdue' : ''}>${g[k].map(row)}<//>`)}
    ${filter === 'focus' && (g.none.length + g.later.length) > 0 && html`<button class="more-btn" onClick=${() => setFilter('all')}>期限なし・それ以降の${g.none.length + g.later.length}件を表示</button>`}

    ${filter === 'done' && html`
      ${done.length === 0 && html`<${Empty} icon="checkCircle" title="完了したタスクはまだありません" />`}
      ${done.length > 0 && html`<${Section} title=${`完了 ${done.length}`} action=${html`<button class="text-btn danger" onClick=${clearDone}>すべて削除</button>`}>${done.slice(0, 200).map(row)}<//>`}`}

    <p class="hint center">右スワイプで完了 · 左スワイプで明日へ/削除 · 長押しでメニュー</p>
  <//>`;
}
