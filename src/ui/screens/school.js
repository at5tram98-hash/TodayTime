// 大学: timetable, assignments, Moodle sync, credits.

import { html, useMemo, useRef, useState } from '../h.js';
import { Icon } from '../icons.js';
import { Empty, NavButton, Row, Screen, Section, Stepper, TaskRow } from '../components.js';
import { openTaskEditor } from '../forms.js';
import { activeTerm, normalizeCourse, uid } from '../../core/model.js';
import { historyRows } from '../../core/predict.js';
import { dateKey, hhmm, parseHHMM, weekday, WEEKDAYS } from '../../core/time.js';
import { getState, mutate } from '../../data/store.js';
import { mergeMoodle } from '../../data/actions.js';
import { analyse, fetchIcs, parseMoodle, validateUrl } from '../../services/moodle.js';
import { ask, confirmDanger, haptic, openMenu, openSheet, toast, useNow } from '../runtime.js';

const COLORS = ['#5e5ce6', '#0a84ff', '#30b0c7', '#34c759', '#ff9f0a', '#ff375f', '#bf5af2', '#a2845e'];

function CourseEditor({ close, course, day, period }) {
  const state = getState();
  const [c, setC] = useState(() => normalizeCourse(course || { id: uid(), day, period, color: COLORS[(day + period) % COLORS.length] }));
  const set = (p) => setC((x) => ({ ...x, ...p }));
  const save = () => {
    mutate(course ? '授業を変更' : '授業を追加', (d) => {
      const t = activeTerm(d);
      const i = t.courses.findIndex((x) => x.id === c.id);
      if (i >= 0) t.courses[i] = normalizeCourse(c); else t.courses.push(normalizeCourse(c));
    });
    toast(course ? '授業を変更しました' : `${WEEKDAYS[c.day]}${c.period}限に「${c.name}」を追加しました`, { undoable: true });
    close();
  };
  const del = async () => {
    if (!(await confirmDanger(`「${course.name}」を削除しますか？`, ''))) return;
    mutate('授業を削除', (d) => { const t = activeTerm(d); t.courses = t.courses.filter((x) => x.id !== c.id); });
    toast('授業を削除しました', { undoable: true });
    close();
  };
  const periods = Object.keys(state.school.periods).map(Number);
  return html`<div class="sheet-head"><button class="text-btn" onClick=${() => close()}>キャンセル</button><h2>${course ? '授業を編集' : '授業を追加'}</h2><button class="text-btn strong" disabled=${!c.name.trim() || c.name === '授業' && !course} onClick=${save}>完了</button></div>
  <div class="sheet-body form">
    <div class="group">
      <input class="title-input" placeholder="授業名" value=${course ? c.name : c.name === '授業' ? '' : c.name} onInput=${(e) => set({ name: e.target.value })} aria-label="授業名" />
      <input class="sub-input" placeholder="教室" value=${c.room} onInput=${(e) => set({ room: e.target.value })} aria-label="教室" />
      <input class="sub-input" placeholder="担当教員" value=${c.teacher} onInput=${(e) => set({ teacher: e.target.value })} aria-label="担当教員" />
    </div>
    <${Section} title="時間">
      <div class="row sub"><select class="select" aria-label="曜日" value=${c.day} onChange=${(e) => set({ day: +e.target.value })}>${[1, 2, 3, 4, 5, 6, 0].map((d) => html`<option value=${d}>${WEEKDAYS[d]}曜日</option>`)}</select>
        <select class="select" aria-label="時限" value=${c.period} onChange=${(e) => set({ period: +e.target.value })}>${periods.map((p) => html`<option value=${p}>${p}限（${hhmm(state.school.periods[p].start)}〜）</option>`)}</select></div>
    <//>
    <${Section} title="単位">
      <div class="row"><span class="row-main"><span class="row-title">単位数</span></span><${Stepper} label="単位数" value=${c.credits} step=${1} min=${0} max=${20} format=${(v) => `${v}単位`} onChange=${(credits) => set({ credits })} /></div>
      <div class="row sub"><select class="select" aria-label="状態" value=${c.creditStatus} onChange=${(e) => set({ creditStatus: e.target.value })}><option value="taking">履修中</option><option value="earned">取得済み</option><option value="failed">未取得</option></select></div>
    <//>
    <${Section} title="色"><div class="color-pick">${COLORS.map((col) => html`<button key=${col} aria-label=${col} aria-pressed=${c.color === col} class=${c.color === col ? 'on' : ''} style=${`--c:${col}`} onClick=${() => set({ color: col })}></button>`)}</div><//>
    <${Section} title="メモ"><textarea class="notes selectable" rows="3" value=${c.notes} onInput=${(e) => set({ notes: e.target.value })} aria-label="メモ"></textarea><//>
    ${course && html`<div class="group"><${Row} danger title="授業を削除" onClick=${del} /></div>`}
  </div>`;
}

const openCourse = (course, day, period) => openSheet((close) => html`<${CourseEditor} close=${close} course=${course} day=${day} period=${period} />`, { full: true });

function Timetable({ state, now }) {
  const term = activeTerm(state);
  const periods = Object.keys(state.school.periods).map(Number).sort((a, b) => a - b);
  const hasSat = term.courses.some((c) => c.day === 6);
  const days = hasSat ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
  const wd = weekday(dateKey(new Date(now)));
  const nowM = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  return html`<div class="timetable" style=${`--cols:${days.length}`}>
    <span></span>${days.map((d) => html`<span key=${'h' + d} class=${`tt-head ${d === wd ? 'today' : ''}`}>${WEEKDAYS[d]}</span>`)}
    ${periods.map((p) => html`
      <span key=${'p' + p} class="tt-period"><b>${p}</b><small>${hhmm(state.school.periods[p].start)}</small></span>
      ${days.map((d) => {
        const c = term.courses.find((x) => x.day === d && x.period === p);
        const live = d === wd && nowM >= state.school.periods[p].start && nowM < state.school.periods[p].end;
        return c
          ? html`<button key=${d + '-' + p} class=${`tt-cell filled ${live ? 'live' : ''}`} style=${`--c:${c.color}`} onClick=${() => openCourse(c)}><strong>${c.name}</strong><small>${c.room}</small></button>`
          : html`<button key=${d + '-' + p} class=${`tt-cell ${live ? 'live' : ''}`} aria-label=${`${WEEKDAYS[d]}${p}限に追加`} onClick=${() => openCourse(null, d, p)}><${Icon} name="plus" /></button>`;
      })}`)}
  </div>`;
}

function MoodleSettings({ close }) {
  const state = getState();
  const [url, setUrl] = useState(state.moodle.url || '');
  const v = url ? validateUrl(url) : null;
  return html`<div class="sheet-head"><button class="text-btn" onClick=${() => close()}>キャンセル</button><h2>Moodle連携</h2>
    <button class="text-btn strong" disabled=${url && !v?.ok} onClick=${() => { mutate('Moodle URLを保存', (d) => { d.moodle.url = url.trim(); }); close(); if (url) syncMoodle(); }}>保存</button></div>
  <div class="sheet-body form">
    <${Section} title="カレンダーのエクスポートURL" footer=${html`取得方法: Moodleにログイン → <b>カレンダー</b> → <b>カレンダーをエクスポート</b> → イベント「すべて」・期間「最近および次の60日間」→ <b>カレンダーURLを取得</b>。URLにはあなた専用のトークンが含まれます。この端末内にだけ保存し、Moodle以外には送信しません。`}>
      <textarea class="notes selectable" rows="3" placeholder="https://moodle.example.ac.jp/calendar/export_execute.php?userid=…&authtoken=…" value=${url} onInput=${(e) => setUrl(e.target.value)} aria-label="エクスポートURL" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
      ${v && !v.ok && html`<p class="section-foot red">${v.message}</p>`}
      ${v?.warning && html`<p class="section-foot orange">${v.warning}</p>`}
    <//>
    <${Section} title="直接取得できない場合" footer="多くの大学のMoodleはブラウザアプリからの直接取得（CORS）を許可していません。その場合は、上のURLをSafariで開いてダウンロードした .ics ファイルを「ファイル」ボタンから取り込んでください。何度読み込んでも課題は重複せず、締切の変更は自動で反映されます。">
    <//>
    ${state.moodle.url && html`<div class="group"><${Row} danger title="URLを削除" onClick=${() => { mutate('Moodle URLを削除', (d) => { d.moodle.url = ''; }); close(); }} /></div>`}
  </div>`;
}

let syncing = false;
export async function syncMoodle(fileText = null) {
  if (syncing) return;
  syncing = true;
  const state = getState();
  mutate('Moodle同期', (d) => { d.moodle.status = 'syncing'; d.moodle.lastAttemptAt = Date.now(); }, { undoable: false });
  try {
    const text = fileText ?? (await fetchIcs(state.moodle.url));
    const items = parseMoodle(text);
    const diff = analyse(getState(), items);
    let r = { created: 0, updated: 0, removed: 0 };
    mutate('Moodleから取り込み', (d) => {
      r = mergeMoodle(d, diff);
      d.moodle.status = 'ok'; d.moodle.error = null; d.moodle.lastSyncAt = Date.now(); d.moodle.lastCount = items.length;
    });
    haptic('success');
    toast(r.created || r.updated ? `課題 新規${r.created}件・更新${r.updated}件` : `新しい課題はありません（${items.length}件確認）`, { undoable: !!(r.created || r.updated) });
  } catch (e) {
    mutate('Moodle同期エラー', (d) => { d.moodle.status = 'error'; d.moodle.error = { kind: e.kind || 'unknown', message: e.message }; }, { undoable: false });
    toast(e.message, { ms: 5000 });
  } finally {
    syncing = false;
  }
}

function MoodleCard({ state, now }) {
  const m = state.moodle;
  const fileRef = useRef();
  const ago = (ts) => { const min = Math.round((now - ts) / 60000); return min < 1 ? 'たった今' : min < 60 ? `${min}分前` : min < 1440 ? `${Math.round(min / 60)}時間前` : `${Math.round(min / 1440)}日前`; };
  const status = m.status === 'syncing' ? '同期中…' : m.status === 'error' ? 'エラー' : m.lastSyncAt ? `最終同期 ${ago(m.lastSyncAt)}` : '未同期';
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) syncMoodle(await f.text());
  };
  const imported = Object.values(m.items).filter((x) => !x.removed).length;
  return html`<${Section} title="Moodle" footer=${m.status === 'error' && m.error ? html`<span class="red"><${Icon} name="warning" /> ${m.error.message}</span>` : `取り込み済みの課題 ${imported}件。重複は自動で防止し、締切の変更を検知します。`}>
    <div class="row"><span class="row-icon" style="background:#f98012"><${Icon} name="cap" /></span>
      <span class="row-main"><span class="row-title">${m.url ? 'カレンダーURL 設定済み' : 'カレンダー未接続'}</span><span class=${`row-sub ${m.status === 'error' ? 'red' : ''}`}>${status}</span></span></div>
    <div class="btn-row">
      <button class="btn tinted" disabled=${!m.url || m.status === 'syncing'} onClick=${() => syncMoodle()}><${Icon} name="refresh" />同期</button>
      <button class="btn tinted" onClick=${() => fileRef.current.click()}><${Icon} name="upload" />ファイル</button>
      <button class="btn tinted" onClick=${() => openSheet((close) => html`<${MoodleSettings} close=${close} />`)}><${Icon} name="link" />設定</button>
    </div>
    <input type="file" accept=".ics,text/calendar" hidden ref=${fileRef} onChange=${onFile} />
  <//>`;
}

function PeriodsSheet({ close }) {
  const state = getState();
  const [periods, setPeriods] = useState(() => JSON.parse(JSON.stringify(state.school.periods)));
  const keys = Object.keys(periods).map(Number).sort((a, b) => a - b);
  return html`<div class="sheet-head"><button class="text-btn" onClick=${() => close()}>キャンセル</button><h2>時限の時刻</h2>
    <button class="text-btn strong" onClick=${() => { mutate('時限を変更', (d) => { d.school.periods = periods; }); close(); }}>保存</button></div>
  <div class="sheet-body form"><div class="group">
    ${keys.map((k) => html`<div class="row sub" key=${k}><span class="row-title">${k}限</span>
      <input type="time" value=${hhmm(periods[k].start)} onChange=${(e) => { const m = parseHHMM(e.target.value); if (m != null) setPeriods({ ...periods, [k]: { ...periods[k], start: m } }); }} aria-label=${`${k}限 開始`} />
      <span class="to">〜</span>
      <input type="time" value=${hhmm(periods[k].end)} onChange=${(e) => { const m = parseHHMM(e.target.value); if (m != null) setPeriods({ ...periods, [k]: { ...periods[k], end: m } }); }} aria-label=${`${k}限 終了`} /></div>`)}
  </div>
  <div class="btn-row">
    <button class="btn tinted" onClick=${() => { const n = keys[keys.length - 1] + 1; const last = periods[keys[keys.length - 1]]; setPeriods({ ...periods, [n]: { start: last.end + 15, end: last.end + 105 } }); }}><${Icon} name="plus" />時限を追加</button>
    ${keys.length > 1 && html`<button class="btn tinted" onClick=${() => { const p = { ...periods }; delete p[keys[keys.length - 1]]; setPeriods(p); }}><${Icon} name="minus" />最後の時限を削除</button>`}
  </div></div>`;
}

function TermSheet({ close }) {
  const state = getState();
  const term = activeTerm(state);
  const [t, setT] = useState({ label: term.label, start: term.start, end: term.end });
  return html`<div class="sheet-head"><button class="text-btn" onClick=${() => close()}>キャンセル</button><h2>学期</h2>
    <button class="text-btn strong" onClick=${() => { mutate('学期を変更', (d) => Object.assign(activeTerm(d), t)); close(); }}>保存</button></div>
  <div class="sheet-body form">
    <div class="group"><input class="title-input" value=${t.label} onInput=${(e) => setT({ ...t, label: e.target.value })} aria-label="学期名" /></div>
    <${Section} title="期間" footer="この期間の時間割が予定とタイムラインに表示されます。">
      <div class="row sub"><input type="date" value=${t.start} onChange=${(e) => setT({ ...t, start: e.target.value })} aria-label="開始日" /><span class="to">〜</span><input type="date" value=${t.end} onChange=${(e) => setT({ ...t, end: e.target.value })} aria-label="終了日" /></div>
    <//>
    <${Section} title="学期を切り替え">
      ${state.school.terms.map((x) => html`<${Row} key=${x.id} title=${x.label} subtitle=${`${x.start} 〜 ${x.end} · ${x.courses.length}科目`} value=${x.id === term.id ? '使用中' : ''} onClick=${() => { mutate('学期を切り替え', (d) => { d.school.activeTermId = x.id; }); close(); }} />`)}
      <${Row} icon="plus" title="新しい学期を作成" onClick=${async () => {
        const copy = await ask('新しい学期', '現在の時間割をコピーしますか？', [{ label: 'コピーする', value: 'copy' }, { label: '空で作成', value: 'empty' }, { label: 'キャンセル', value: null, cancel: true }]);
        if (!copy) return;
        mutate('学期を作成', (d) => {
          const id = uid();
          d.school.terms.push({ id, label: '新しい学期', start: dateKey(), end: dateKey(new Date(Date.now() + 120 * 86400_000)), courses: copy === 'copy' ? activeTerm(d).courses.map((c) => ({ ...c, id: uid(), creditStatus: 'taking' })) : [] });
          d.school.activeTermId = id;
        });
        close();
      }} />
    <//>
  </div>`;
}

export function SchoolScreen({ state, active }) {
  const now = useNow(60_000);
  const term = activeTerm(state);
  const rows = useMemo(() => historyRows(state, now), [state]);
  const assignments = Object.values(state.tasks).filter((t) => !t.done && (t.categoryId === 'school' || t.courseId || t.source?.kind === 'moodle'))
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || (a.dueMin ?? 1440) - (b.dueMin ?? 1440));
  const allCourses = state.school.terms.flatMap((t) => t.courses);
  const earned = state.school.pastCredits + allCourses.filter((c) => c.creditStatus === 'earned').reduce((s, c) => s + c.credits, 0);
  const taking = term.courses.filter((c) => c.creditStatus === 'taking').reduce((s, c) => s + c.credits, 0);
  const target = state.school.creditTarget;

  return html`<${Screen} id="school" active=${active} title="大学" subtitle=${term.label}
    actions=${html`<${NavButton} icon="ellipsis" label="大学の設定" onClick=${(e) => openMenu([
      { label: '学期の設定・切り替え', icon: 'calendar', run: () => openSheet((close) => html`<${TermSheet} close=${close} />`) },
      { label: '時限の時刻', icon: 'clock', run: () => openSheet((close) => html`<${PeriodsSheet} close=${close} />`) },
      { label: '課題を追加', icon: 'plus', run: () => openTaskEditor(null, { categoryId: 'school', icon: 'pencil', dueDate: dateKey(), dueMin: 1439 }) },
    ], { anchor: { y: 90 } })} />`}>

    <${Timetable} state=${state} now=${now} />
    ${term.courses.length === 0 && html`<p class="hint center">空いているコマをタップして授業を追加</p>`}

    <${Section} title=${`課題 ${assignments.length}`} action=${html`<button class="text-btn" onClick=${() => openTaskEditor(null, { categoryId: 'school', icon: 'pencil', dueDate: dateKey(), dueMin: 1439 })}>追加</button>`}>
      ${assignments.length === 0 && html`<${Empty} icon="cap" title="未完了の課題はありません" text="Moodleと同期するか、追加から登録できます" />`}
      ${assignments.map((t) => html`<${TaskRow} key=${t.id} task=${t} state=${state} now=${now} rows=${rows} onOpen=${(x) => openTaskEditor(x)} />`)}
    <//>

    <${MoodleCard} state=${state} now=${now} />

    <${Section} title="単位">
      <div class="credits">
        <div class="credit-bar"><span class="earned" style=${`width:${Math.min(100, (earned / target) * 100)}%`}></span><span class="taking" style=${`width:${Math.min(100 - (earned / target) * 100, (taking / target) * 100)}%`}></span></div>
        <div class="credit-legend"><span><i class="earned"></i>取得 ${earned}</span><span><i class="taking"></i>履修中 ${taking}</span><span>目標 ${target}</span></div>
      </div>
      <div class="row"><span class="row-main"><span class="row-title">卒業に必要な単位</span></span><${Stepper} label="目標単位" value=${target} step=${1} min=${1} max=${300} format=${(v) => `${v}`} onChange=${(v) => mutate('目標単位', (d) => { d.school.creditTarget = v; }, { undoable: false })} /></div>
      <div class="row"><span class="row-main"><span class="row-title">これまでの取得単位</span><span class="row-sub">アプリに登録していない過去の分</span></span><${Stepper} label="過去の取得単位" value=${state.school.pastCredits} step=${1} min=${0} max=${300} format=${(v) => `${v}`} onChange=${(v) => mutate('過去の単位', (d) => { d.school.pastCredits = v; }, { undoable: false })} /></div>
    <//>
  <//>`;
}
