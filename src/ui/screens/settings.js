// 設定: appearance, day range, notifications (with honest capability info), adjustment,
// categories, templates, history & stats, data (backup/restore/migration), about.

import { html, useEffect, useMemo, useRef, useState } from '../h.js';
import { Icon, ICON_CHOICES } from '../icons.js';
import { NavButton, Row, Screen, Section, Segmented, Stepper, Toggle, Empty } from '../components.js';
import { categoryOf, normalizeCategory, uid } from '../../core/model.js';
import { accuracy, historyRows } from '../../core/predict.js';
import { addDays, dateKey, formatDuration, formatElapsed, hhmm, parseHHMM, toInstant } from '../../core/time.js';
import { elapsedMs, trackedBetween } from '../../core/tracker.js';
import { getBootInfo, getState, legacyAvailable, mutate, onSave, replaceState, saveStatus } from '../../data/store.js';
import { getBackup, listBackups, storageEstimate } from '../../data/storage.js';
import { migrateLegacy } from '../../core/migrate.js';
import { backupJson, calendarIcs, parseBackup, saveFile } from '../../services/exporter.js';
import { capabilities, requestPermission } from '../../services/notify.js';
import { ask, confirmDanger, haptic, openSheet, toast, useNow } from '../runtime.js';

export const VERSION = '3.0.0';

const setS = (label, fn) => mutate(label, (d) => fn(d.settings), { undoable: false });

function TimeRow({ title, value, onChange }) {
  return html`<div class="row"><span class="row-main"><span class="row-title">${title}</span></span>
    <input type="time" value=${hhmm(value)} onChange=${(e) => { const m = parseHHMM(e.target.value); if (m != null) onChange(m); }} aria-label=${title} /></div>`;
}

/* ---------- notifications ---------- */

function NotifySection({ state }) {
  const n = state.settings.notify;
  const [cap, setCap] = useState(capabilities());
  const enable = async (on) => {
    if (on) {
      const p = await requestPermission();
      setCap(capabilities());
      if (p !== 'granted') toast(p === 'denied' ? '通知が拒否されています。端末の設定から許可してください' : 'この環境では通知を使えません。アプリ内の表示で知らせます', { ms: 5000 });
    }
    setS('通知', (s) => { s.notify.enabled = on; });
  };
  const capText = cap.permission === 'granted' ? '許可済み' : cap.permission === 'denied' ? '拒否されています' : cap.permission === 'unsupported' ? (cap.ios && !cap.standalone ? 'ホーム画面に追加すると使えます' : '非対応') : '未許可';
  return html`<${Section} title="通知" footer=${html`<b>通知が届くのはアプリを開いている間（または直前まで開いていた間）だけです。</b>Webアプリは閉じた状態での時刻指定通知ができないため、確実に知らせたい予定は下の「カレンダーに書き出す」でiPhoneのカレンダーに入れてください（アラーム付き）。${cap.ios && !cap.standalone ? ' iPhoneでは「共有 → ホーム画面に追加」したアプリでのみ通知を許可できます。' : ''}`}>
    <div class="row"><span class="row-icon" style="background:var(--red)"><${Icon} name="bell" /></span><span class="row-main"><span class="row-title">通知を使う</span><span class="row-sub">許可の状態: ${capText}</span></span><${Toggle} label="通知を使う" checked=${n.enabled} onChange=${enable} /></div>
    ${n.enabled && html`
      <div class="row"><span class="row-main"><span class="row-title">予定の開始前</span></span><${Stepper} label="予定の何分前" value=${n.eventLeadMin} step=${5} min=${0} max=${120} format=${(v) => `${v}分前`} onChange=${(v) => setS('通知', (s) => { s.notify.eventLeadMin = v; })} /></div>
      <div class="row"><span class="row-main"><span class="row-title">締切の前</span></span><${Stepper} label="締切の何分前" value=${n.dueLeadMin} step=${30} min=${30} max=${2880} format=${(v) => formatDuration(v)} onChange=${(v) => setS('通知', (s) => { s.notify.dueLeadMin = v; })} /></div>
      <div class="row"><span class="row-main"><span class="row-title">期限切れのタスク</span></span><${Toggle} label="期限切れ" checked=${n.overdue} onChange=${(v) => setS('通知', (s) => { s.notify.overdue = v; })} /></div>
      <div class="row"><span class="row-main"><span class="row-title">予定の重なり</span></span><${Toggle} label="重なり" checked=${n.conflicts} onChange=${(v) => setS('通知', (s) => { s.notify.conflicts = v; })} /></div>
      <div class="row"><span class="row-main"><span class="row-title">休憩のすすめ</span><span class="row-sub">計測が続いたら知らせる</span></span><${Stepper} label="休憩" value=${n.breakEveryMin} step=${15} min=${0} max=${240} format=${(v) => (v ? `${v}分ごと` : 'オフ')} onChange=${(v) => setS('通知', (s) => { s.notify.breakEveryMin = v; })} /></div>`}
    <${Row} icon="download" iconColor="var(--green)" title="カレンダーに書き出す（14日分）" subtitle="アラーム付き .ics。iPhoneのカレンダーに追加すると閉じていても通知されます" onClick=${() => saveFile(`todaytime-${dateKey()}.ics`, calendarIcs(getState()), 'text/calendar')} />
  <//>`;
}

/* ---------- categories & templates ---------- */

const PALETTE = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff453a', '#ff9f0a', '#ffd60a', '#34c759', '#30b0c7', '#8e8e93', '#a2845e', '#2d08ff'];

function CategorySheet({ close, cat }) {
  const [c, setC] = useState(() => normalizeCategory(cat || { id: uid(), name: '', color: '#0a84ff', icon: 'tag' }));
  const set = (p) => setC((x) => ({ ...x, ...p }));
  const builtIn = ['plan', 'school'].includes(c.id);
  return html`<div class="sheet-head"><button class="text-btn" onClick=${() => close()}>キャンセル</button><h2>${cat ? 'カテゴリを編集' : '新規カテゴリ'}</h2>
    <button class="text-btn strong" disabled=${!c.name.trim()} onClick=${() => { mutate('カテゴリを保存', (d) => { const i = d.categories.findIndex((x) => x.id === c.id); const n = normalizeCategory(c); if (i >= 0) d.categories[i] = n; else d.categories.push(n); }); close(); }}>完了</button></div>
  <div class="sheet-body form">
    <div class="group"><input class="title-input" placeholder="名前" value=${c.name === 'カテゴリ' && !cat ? '' : c.name} onInput=${(e) => set({ name: e.target.value })} aria-label="名前" /></div>
    <${Section} title="色"><div class="color-pick">${PALETTE.map((col) => html`<button key=${col} aria-label=${col} aria-pressed=${c.color === col} class=${c.color === col ? 'on' : ''} style=${`--c:${col}`} onClick=${() => set({ color: col })}></button>`)}</div><//>
    <${Section} title="アイコン"><div class="icon-grid">${ICON_CHOICES.map((n) => html`<button key=${n} class=${n === c.icon ? 'on' : ''} aria-pressed=${n === c.icon} style=${`--c:${c.color}`} onClick=${() => set({ icon: n })}><${Icon} name=${n} /></button>`)}</div><//>
    <${Section} title="アルバイト" footer="時給を入れると、月表示で勤務時間と給与の見込みを集計します。">
      <div class="row"><span class="row-main"><span class="row-title">時給</span></span><${Stepper} label="時給" value=${c.wagePerHour || 0} step=${10} min=${0} max=${10000} format=${(v) => (v ? `¥${v}` : 'なし')} onChange=${(wagePerHour) => set({ wagePerHour })} /></div>
      <div class="row"><span class="row-main"><span class="row-title">交通費（1回）</span></span><${Stepper} label="交通費" value=${c.transportPerShift || 0} step=${10} min=${0} max=${10000} format=${(v) => (v ? `¥${v}` : 'なし')} onChange=${(transportPerShift) => set({ transportPerShift })} /></div>
    <//>
    ${cat && !builtIn && html`<div class="group"><${Row} danger title="カテゴリを削除" subtitle="このカテゴリの予定・タスクは「予定」に移ります" onClick=${async () => {
      if (!(await confirmDanger(`「${c.name}」を削除しますか？`, ''))) return;
      mutate('カテゴリを削除', (d) => { d.categories = d.categories.filter((x) => x.id !== c.id); for (const x of [...Object.values(d.tasks), ...Object.values(d.events)]) if (x.categoryId === c.id) x.categoryId = 'plan'; });
      toast('カテゴリを削除しました', { undoable: true }); close();
    }} /></div>`}
  </div>`;
}

function TemplatesSheet({ close }) {
  const state = getState();
  const [list, setList] = useState(state.templates);
  const upd = (i, p) => setList(list.map((t, j) => (j === i ? { ...t, ...p } : t)));
  return html`<div class="sheet-head"><button class="text-btn" onClick=${() => close()}>キャンセル</button><h2>テンプレート</h2>
    <button class="text-btn strong" onClick=${() => { mutate('テンプレートを保存', (d) => { d.templates = list.filter((t) => t.title.trim()); }); close(); }}>完了</button></div>
  <div class="sheet-body form">
    <p class="lead-text">追加画面からワンタップで作れるタスクの雛形です。</p>
    <div class="group">${list.map((t, i) => html`<div class="tpl-row" key=${t.id}>
      <select class="select" aria-label="カテゴリ" value=${t.categoryId} onChange=${(e) => upd(i, { categoryId: e.target.value, icon: categoryOf(state, e.target.value).icon })}>${state.categories.map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select>
      <input value=${t.title} onInput=${(e) => upd(i, { title: e.target.value })} aria-label="タイトル" />
      <${Stepper} label="時間" value=${t.estimateMin} step=${5} onChange=${(estimateMin) => upd(i, { estimateMin })} format=${(v) => `${v}分`} />
      <button class="icon-btn" aria-label="削除" onClick=${() => setList(list.filter((_, j) => j !== i))}><${Icon} name="xmark" /></button>
    </div>`)}</div>
    <div class="btn-row"><button class="btn tinted" onClick=${() => setList([...list, { id: uid(), title: '', icon: 'circle', categoryId: 'plan', estimateMin: 30 }])}><${Icon} name="plus" />追加</button></div>
  </div>`;
}

/* ---------- history ---------- */

function HistorySheet({ close }) {
  const state = getState();
  const now = useNow(1000);
  const days = Array.from({ length: 7 }, (_, i) => addDays(dateKey(), -i));
  const rows = historyRows(state, now);
  const acc = accuracy(rows);
  const sessions = Object.values(state.sessions).sort((a, b) => b.createdAt - a.createdAt);
  const byDay = new Map();
  for (const s of sessions) { const k = dateKey(new Date(s.createdAt)); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(s); }
  const max = Math.max(60, ...days.map((d) => trackedBetween(state.sessions, toInstant(d, 0), toInstant(d, 1440), now)));
  return html`<div class="sheet-head"><span></span><h2>実行記録</h2><button class="text-btn strong" onClick=${() => close()}>完了</button></div>
  <div class="sheet-body">
    <div class="bars" role="img" aria-label="過去7日の記録時間">
      ${[...days].reverse().map((d) => { const m = trackedBetween(state.sessions, toInstant(d, 0), toInstant(d, 1440), now); return html`<div class="bar" key=${d}><span style=${`height:${(m / max) * 100}%`}></span><small>${d.slice(8)}</small><b>${m ? formatDuration(m, { short: true }) : ''}</b></div>`; })}
    </div>
    ${acc && html`<div class="notice"><${Icon} name="chart" />見積もりに対する実績の中央値: ${Math.round(acc.medianRatio * 100)}% · 見積もり±20%以内: ${Math.round(acc.within20 * 100)}%（${acc.samples}件）</div>`}
    ${sessions.length === 0 && html`<${Empty} icon="timer" title="記録はまだありません" text="タスクの ▶︎ から計測を始められます" />`}
    ${[...byDay.entries()].slice(0, 30).map(([day, list]) => html`<section class="section" key=${day}><div class="section-head"><h2>${day}</h2></div><div class="group">
      ${list.map((s) => { const ms = elapsedMs(s, now); const diff = s.plannedMin ? Math.round(ms / 60000 - s.plannedMin) : null; return html`<div class="row" key=${s.id}>
        <span class="row-icon" style=${`background:${categoryOf(state, s.categoryId).color}`}><${Icon} name=${s.icon} /></span>
        <span class="row-main"><span class="row-title">${s.title}</span><span class="row-sub">${hhmm((s.segments[0]?.start - toInstant(day, 0)) / 60000)}〜${s.status === 'done' ? hhmm((s.endedAt - toInstant(day, 0)) / 60000) : s.status === 'running' ? '計測中' : '一時停止'}${s.segments.length > 1 ? ` · 中断${s.segments.length - 1}回` : ''}${diff != null ? ` · 予定${s.plannedMin}分（${diff > 0 ? '+' : ''}${diff}分）` : ''}</span></span>
        <span class="row-value mono">${formatElapsed(ms)}</span>
        <button class="icon-btn" aria-label="記録を削除" onClick=${async () => { if (await confirmDanger('この記録を削除しますか？', '')) { mutate('記録を削除', (d) => { delete d.sessions[s.id]; }); toast('記録を削除しました', { undoable: true }); } }}><${Icon} name="trash" /></button>
      </div>`; })}
    </div></section>`)}
  </div>`;
}

function AdjustLogSheet({ close }) {
  const log = [...(getState().adjustLog || [])].reverse();
  return html`<div class="sheet-head"><span></span><h2>調整の履歴</h2><button class="text-btn strong" onClick=${() => close()}>完了</button></div>
  <div class="sheet-body">
    ${log.length === 0 && html`<${Empty} icon="sparkles" title="自動調整の履歴はありません" />`}
    ${log.map((l) => html`<section class="section" key=${l.id}><div class="section-head"><h2>${new Date(l.at).toLocaleString('ja-JP')}</h2></div><div class="group">
      ${l.changes.map((c) => html`<div class="change-row" key=${c.key}><div class="change-title"><strong>${c.title}</strong></div>
        <div class="change-times"><span class="from">${c.from.date?.slice(5)} ${hhmm(c.from.startMin)}</span><${Icon} name="arrowRight" /><span class="to">${c.to.date.slice(5)} ${hhmm(c.to.startMin)}</span></div><div class="change-reason">${c.reason}</div></div>`)}
    </div></section>`)}
  </div>`;
}

/* ---------- data ---------- */

function DataSheet({ close }) {
  const [backups, setBackups] = useState(null);
  const [est, setEst] = useState(null);
  const [st, setSt] = useState(saveStatus());
  const fileRef = useRef();
  const boot = getBootInfo();
  const legacy = useMemo(() => legacyAvailable(), []);
  useEffect(() => { listBackups().then(setBackups); storageEstimate().then(setEst); return onSave(setSt); }, []);

  const restoreFrom = async (doc, label) => {
    if (!(await confirmDanger('現在のデータを置き換えますか？', '置き換える前の状態は自動バックアップに保存され、取り消しもできます', '置き換える'))) return;
    await replaceState(doc, label);
    haptic('success');
    toast(`${label}しました`, { undoable: true });
    close();
  };
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const r = parseBackup(await f.text());
      await restoreFrom(r.state, r.kind === 'legacy' ? '旧バージョンのバックアップから移行' : 'バックアップから復元');
    } catch (err) { toast(err.message, { ms: 5000 }); }
  };

  return html`<div class="sheet-head"><span></span><h2>データ</h2><button class="text-btn strong" onClick=${() => close()}>完了</button></div>
  <div class="sheet-body">
    <${Section} title="保存の状態" footer="データはこの端末のブラウザ内（IndexedDB）に保存され、予備のコピーも保持しています。他の端末とは同期しません。">
      <${Row} title="最終保存" value=${st.lastSavedAt ? new Date(st.lastSavedAt).toLocaleTimeString('ja-JP') : '—'} />
      ${st.lastSaveError && html`<${Row} danger title="保存エラー" subtitle=${st.lastSaveError} />`}
      <${Row} title="使用容量" value=${est?.usage != null ? `${(est.usage / 1024).toFixed(0)} KB` : '—'} />
      <${Row} title="読み込み元" value=${{ indexeddb: 'IndexedDB', mirror: '予備コピー', legacy: '旧バージョンから移行', fresh: '新規' }[boot.source] || '—'} />
    <//>
    <${Section} title="バックアップ" footer="iPhoneでは共有シートから「ファイルに保存」を選べます。旧TodayTimeのバックアップファイルも読み込めます。">
      <${Row} icon="download" iconColor="var(--tint)" title="バックアップを書き出す" onClick=${() => saveFile(`todaytime-backup-${dateKey()}.json`, backupJson(getState()), 'application/json')} />
      <${Row} icon="upload" iconColor="var(--tint)" title="バックアップを読み込む" onClick=${() => fileRef.current.click()} />
      <input type="file" accept="application/json,.json" hidden ref=${fileRef} onChange=${onFile} />
    <//>
    <${Section} title="自動バックアップ（端末内）" footer="1日1回と、復元・移行の直前に自動で保存されます（最大14件）。">
      ${backups === null && html`<${Row} title="読み込み中…" />`}
      ${backups?.length === 0 && html`<${Row} title="まだありません" />`}
      ${backups?.map((b) => html`<${Row} key=${b.id} title=${new Date(b.at).toLocaleString('ja-JP')} subtitle=${`${b.reason} · タスク${b.counts.tasks} · 予定${b.counts.events}`} chevron onClick=${async () => { const d = await getBackup(b.id); if (d) restoreFrom(d, '自動バックアップから復元'); }} />`)}
    <//>
    <${Section} title="旧バージョンからの移行" footer=${legacy ? `この端末に旧TodayTimeのデータ（${legacy.key}）があります。旧データは削除せずにそのまま残します。` : 'この端末に旧TodayTimeのデータは見つかりません。旧アプリのバックアップファイルがあれば上から読み込めます。'}>
      ${boot.migrated && html`<${Row} title="初回起動時に移行済み" subtitle=${`予定${boot.migrated.report.events} · 課題${boot.migrated.report.assignments} · タスク${boot.migrated.report.tasks} · 記録${boot.migrated.report.sessions} · 授業${boot.migrated.report.courses}`} />`}
      ${legacy && html`<${Row} icon="refresh" iconColor="var(--orange)" title="旧データからもう一度移行する" onClick=${() => { const r = migrateLegacy(legacy); restoreFrom(r.state, '旧バージョンから再移行'); }} />`}
      <${Row} icon="link" iconColor="var(--gray)" title="旧バージョンを開く" subtitle="読み取り用に残しています" onClick=${() => { location.href = 'legacy/'; }} />
    <//>
    <div class="group"><${Row} danger title="すべてのデータを消去" onClick=${async () => {
      if (!(await confirmDanger('すべてのデータを消去しますか？', '消去前の状態は自動バックアップに残ります', '消去'))) return;
      const { defaultState } = await import('../../core/model.js');
      await replaceState(defaultState(), 'すべて消去');
      close();
    }} /></div>
  </div>`;
}

/* ---------- screen ---------- */

export function SettingsScreen({ state, active }) {
  const s = state.settings;
  return html`<${Screen} id="settings" active=${active} title="設定">
    <${Section} title="表示">
      <div class="row"><span class="row-icon" style="background:var(--indigo)"><${Icon} name="moon" /></span><span class="row-main"><span class="row-title">外観</span></span>
        <${Segmented} small label="外観" value=${s.appearance} onChange=${(v) => setS('外観', (x) => { x.appearance = v; })} options=${[{ value: 'system', label: '自動' }, { value: 'light', label: 'ライト' }, { value: 'dark', label: 'ダーク' }]} /></div>
      <div class="row"><span class="row-icon" style="background:var(--tint)"><span class="aa">Aa</span></span><span class="row-main"><span class="row-title">文字サイズ</span><span class="row-sub">ピンチの代わりに拡大</span></span>
        <${Segmented} small label="文字サイズ" value=${s.textScale} onChange=${(v) => setS('文字サイズ', (x) => { x.textScale = v; })} options=${[{ value: 1, label: '標準' }, { value: 1.12, label: '大' }, { value: 1.25, label: '特大' }]} /></div>
      <div class="row"><span class="row-icon" style="background:var(--gray)"><${Icon} name="hand" /></span><span class="row-main"><span class="row-title">触覚フィードバック</span><span class="row-sub">Android等の対応端末のみ</span></span><${Toggle} label="触覚フィードバック" checked=${s.haptics} onChange=${(v) => setS('触覚', (x) => { x.haptics = v; })} /></div>
    <//>

    <${Section} title="1日の時間" footer="空き時間の計算・自動調整・タイムラインの表示範囲に使います。">
      <${TimeRow} title="活動開始" value=${s.dayStartMin} onChange=${(v) => setS('活動開始', (x) => { x.dayStartMin = Math.min(v, x.dayEndMin - 60); })} />
      <${TimeRow} title="活動終了" value=${Math.min(s.dayEndMin, 1439)} onChange=${(v) => setS('活動終了', (x) => { x.dayEndMin = Math.max(v, x.dayStartMin + 60); })} />
      <div class="row"><span class="row-main"><span class="row-title">週の始まり</span></span><${Segmented} small label="週の始まり" value=${s.weekStart} onChange=${(v) => setS('週の始まり', (x) => { x.weekStart = v; })} options=${[{ value: 1, label: '月曜' }, { value: 0, label: '日曜' }]} /></div>
      <div class="row"><span class="row-main"><span class="row-title">タイムラインの拡大</span></span><${Segmented} small label="拡大" value=${s.hourHeight} onChange=${(v) => setS('拡大', (x) => { x.hourHeight = v; })} options=${[{ value: 44, label: '小' }, { value: 56, label: '中' }, { value: 80, label: '大' }]} /></div>
    <//>

    <${NotifySection} state=${state} />

    <${Section} title="自動調整" footer="予定が延びたときや開始時刻を過ぎたときに、柔軟な予定の移動案を表示します。固定の予定は動かしません。">
      <div class="row"><span class="row-main"><span class="row-title">予定の間のゆとり</span></span><${Stepper} label="ゆとり" value=${s.adjust.bufferMin} step=${5} min=${0} max=${30} format=${(v) => (v ? `${v}分` : 'なし')} onChange=${(v) => setS('ゆとり', (x) => { x.adjust.bufferMin = v; })} /></div>
      <${Row} icon="sparkles" iconColor="var(--orange)" title="調整の履歴" chevron onClick=${() => openSheet((close) => html`<${AdjustLogSheet} close=${close} />`)} />
    <//>

    <${Section} title="カテゴリ">
      ${state.categories.map((c) => html`<${Row} key=${c.id} icon=${c.icon} iconColor=${c.color} title=${c.name} value=${c.wagePerHour ? `¥${c.wagePerHour}/時` : ''} chevron onClick=${() => openSheet((close) => html`<${CategorySheet} close=${close} cat=${c} />`, { full: true })} />`)}
      <${Row} icon="plus" title="カテゴリを追加" onClick=${() => openSheet((close) => html`<${CategorySheet} close=${close} />`, { full: true })} />
    <//>

    <${Section}>
      <${Row} icon="list" iconColor="var(--teal)" title="テンプレート" value=${`${state.templates.length}件`} chevron onClick=${() => openSheet((close) => html`<${TemplatesSheet} close=${close} />`, { full: true })} />
      <${Row} icon="chart" iconColor="var(--green)" title="実行記録と統計" value=${`${Object.keys(state.sessions).length}件`} chevron onClick=${() => openSheet((close) => html`<${HistorySheet} close=${close} />`, { full: true })} />
      <${Row} icon="cloud" iconColor="var(--tint)" title="データ・バックアップ・移行" chevron onClick=${() => openSheet((close) => html`<${DataSheet} close=${close} />`, { full: true })} />
    <//>

    <p class="about">TodayTime Pro ${VERSION}<br />データはこの端末内だけに保存されます</p>
  <//>`;
}
