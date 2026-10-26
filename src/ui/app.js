// App shell: screens stay mounted (scroll positions survive tab switches), tab bar, overlays.

import { html, useEffect } from './h.js';
import { Icon } from './icons.js';
import { OverlayHost } from './overlays.js';
import { haptic, nav, useAppState } from './runtime.js';
import { TodayScreen } from './screens/today.js';
import { CalendarScreen } from './screens/calendar.js';
import { TasksScreen } from './screens/tasks.js';
import { SchoolScreen } from './screens/school.js';
import { SettingsScreen } from './screens/settings.js';
import { dateKey } from '../core/time.js';

const TABS = [
  { id: 'today', label: '今日', icon: 'today' },
  { id: 'calendar', label: '予定', icon: 'calendar' },
  { id: 'tasks', label: 'タスク', icon: 'checklist' },
  { id: 'school', label: '大学', icon: 'cap' },
  { id: 'settings', label: '設定', icon: 'gear' },
];

function TabBar({ tab, state }) {
  const today = dateKey();
  const overdue = Object.values(state.tasks).filter((t) => !t.done && t.dueDate && t.dueDate < today).length;
  return html`<nav class="tabbar" role="tablist" aria-label="メインメニュー">
    ${TABS.map((t) => html`<button key=${t.id} role="tab" aria-selected=${tab === t.id} class=${`tab ${tab === t.id ? 'on' : ''}`}
      onClick=${() => {
        if (tab === t.id) document.querySelector(`#${t.id} .scroll`)?.scrollTo({ top: 0, behavior: 'smooth' });
        else { haptic('light'); nav.set({ ...nav.get(), tab: t.id }); }
      }}>
      <span class="tab-icon"><${Icon} name=${t.icon} />${t.id === 'tasks' && overdue > 0 ? html`<span class="tab-badge" aria-label=${`期限切れ${overdue}件`}>${overdue}</span>` : ''}</span>
      <span class="tab-label">${t.label}</span>
    </button>`)}
  </nav>`;
}

export function App() {
  const state = useAppState();
  const { tab } = nav.use();

  useEffect(() => {
    const root = document.documentElement;
    const mode = state.settings.appearance;
    const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    root.style.setProperty('--scale', String(state.settings.textScale || 1));
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#f2f2f7');
    try { localStorage.setItem('tt:appearance', mode); localStorage.setItem('tt:scale', String(state.settings.textScale || 1)); } catch { /* ignore */ }
  }, [state.settings.appearance, state.settings.textScale]);

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => { if (state.settings.appearance === 'system') document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light'; };
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [state.settings.appearance]);

  useEffect(() => { try { sessionStorage.setItem('tt:tab', tab); } catch { /* ignore */ } }, [tab]);

  return html`<div class="app">
    <main class="screens">
      <${TodayScreen} state=${state} active=${tab === 'today'} />
      <${CalendarScreen} state=${state} active=${tab === 'calendar'} />
      <${TasksScreen} state=${state} active=${tab === 'tasks'} />
      <${SchoolScreen} state=${state} active=${tab === 'school'} />
      <${SettingsScreen} state=${state} active=${tab === 'settings'} />
    </main>
    <${TabBar} tab=${tab} state=${state} />
    <${OverlayHost} />
  </div>`;
}
