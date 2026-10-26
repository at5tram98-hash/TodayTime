// End-to-end tests in a real browser (Chromium, iPhone 13 viewport, Asia/Tokyo, controlled clock).
// Usage: node tests/e2e/run.js [filter]
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { serve } from './serve.js';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const PORT = 4174;
const BASE = `http://localhost:${PORT}/TodayTime/`;
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const T0 = new Date('2026-10-26T08:50:00+09:00'); // Monday morning
const legacyFixture = readFileSync(new URL('../unit/fixtures/legacy-v2.json', import.meta.url), 'utf8');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let browser;
async function open({ dark = false, time = T0, init, permissions = [] } = {}) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ja-JP', timezoneId: 'Asia/Tokyo', colorScheme: dark ? 'dark' : 'light', acceptDownloads: true });
  if (permissions.length) await ctx.grantPermissions(permissions, { origin: `http://localhost:${PORT}` });
  if (init) await ctx.addInitScript(init.fn, init.arg);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.clock.install({ time });
  await page.goto(BASE);
  await page.clock.resume();
  await page.waitForSelector('.tabbar');
  return page;
}

const tab = (page, label) => page.click(`.tab:has-text("${label}")`);
const doc = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('todaytime:v3:mirror') || 'null'));
async function waitDoc(page, pred, msg = 'state condition') {
  for (let i = 0; i < 40; i++) {
    const d = await doc(page);
    if (d && pred(d)) return d;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for ${msg}`);
}
const tasksOf = (d) => Object.values(d.tasks);
async function quickAdd(page, text, mode) {
  await page.click('.screen.active .nav-btn.primary');
  await page.waitForSelector('.qa-input');
  if (mode === 'event') await page.click('.sheet .segmented button:has-text("予定")');
  await page.fill('.qa-input', text);
  await page.press('.qa-input', 'Enter');
  await page.waitForSelector('.sheet', { state: 'detached' });
}
async function swipe(page, sel, dx) {
  const box = await page.locator(sel).first().boundingBox();
  const y = box.y + box.height / 2, x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x + (dx * i) / 12, y + i * 0.3);
  await page.mouse.up();
}
async function longPress(page, sel, ms = 650) {
  const box = await page.locator(sel).first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/* ------------------------------------------------------------------ */

test('native feel: no zoom, no selection on chrome, no horizontal overflow', async () => {
  const page = await open();
  const meta = await page.getAttribute('meta[name="viewport"]', 'content');
  assert.match(meta, /user-scalable=no/);
  assert.match(meta, /maximum-scale=1/);
  assert.match(meta, /viewport-fit=cover/);
  const css = await page.evaluate(() => ({
    touch: getComputedStyle(document.documentElement).touchAction,
    select: getComputedStyle(document.body).userSelect || getComputedStyle(document.body).webkitUserSelect,
    callout: getComputedStyle(document.body).webkitTouchCallout,
    overscroll: getComputedStyle(document.body).overscrollBehaviorY,
  }));
  assert.equal(css.touch, 'manipulation');
  assert.equal(css.select, 'none');
  assert.equal(css.overscroll, 'none');
  for (const t of ['今日', '予定', 'タスク', '大学', '設定']) {
    await tab(page, t);
    await page.waitForTimeout(250);
    const o = await page.evaluate(() => {
      const sc = document.querySelector('.screen.active .scroll');
      const inputs = [...document.querySelectorAll('.screen.active input, .screen.active textarea')].map((i) => parseFloat(getComputedStyle(i).fontSize));
      return { doc: document.documentElement.scrollWidth - innerWidth, inner: sc.scrollWidth - sc.clientWidth, minInput: Math.min(16, ...inputs) };
    });
    assert.ok(o.doc <= 0, `${t}: document overflows horizontally by ${o.doc}px`);
    assert.ok(o.inner <= 1, `${t}: screen overflows horizontally by ${o.inner}px`);
    assert.ok(o.minInput >= 16, `${t}: input font-size < 16px causes iOS zoom`);
    await page.screenshot({ path: `${OUT}light-${t}.png` });
  }
  // Context menu suppressed on UI, allowed in inputs.
  const prevented = await page.evaluate(() => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.querySelector('.tab').dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  assert.ok(prevented);
  await tab(page, 'タスク');
  const inputSelectable = await page.evaluate(() => getComputedStyle(document.querySelector('.inline-add input')).userSelect);
  assert.equal(inputSelectable, 'text');
  return page;
});

test('tasks: create (natural language), edit, swipe complete, undo, long-press delete', async () => {
  const page = await open();
  await tab(page, 'タスク');
  await page.fill('.inline-add input', 'レポート 明日 30分 !!');
  await page.waitForSelector('.inline-hint');
  await page.press('.inline-add input', 'Enter');
  let d = await waitDoc(page, (d) => tasksOf(d).some((t) => t.title === 'レポート'), 'task saved');
  let t = tasksOf(d).find((t) => t.title === 'レポート');
  assert.equal(t.dueDate, '2026-10-27');
  assert.equal(t.estimateMin, 30);
  assert.equal(t.priority, 2);
  await page.waitForSelector('#tasks .section:has-text("明日") .task-row:has-text("レポート")');

  // Edit via tap → editor sheet
  await page.click('#tasks .task-row:has-text("レポート") .task-title');
  await page.waitForSelector('.sheet .title-input');
  await page.fill('.sheet .title-input', '統計レポート');
  await page.click('.sheet-head button:has-text("完了")');
  d = await waitDoc(page, (d) => tasksOf(d).some((t) => t.title === '統計レポート'), 'edit saved');

  // Swipe right → complete, then undo from toast
  await swipe(page, '#tasks .task-row:has-text("統計レポート") .task-content', 260);
  d = await waitDoc(page, (d) => tasksOf(d).find((t) => t.title === '統計レポート')?.done, 'completed by swipe');
  await page.click('.toast-btn:has-text("取り消す")');
  d = await waitDoc(page, (d) => tasksOf(d).find((t) => t.title === '統計レポート')?.done === false, 'undo complete');

  // Long press → context menu → 削除
  await longPress(page, '#tasks .task-row:has-text("統計レポート") .task-main');
  await page.waitForSelector('.menu');
  await page.screenshot({ path: `${OUT}context-menu.png` });
  await page.click('.menu-item:has-text("削除")');
  d = await waitDoc(page, (d) => !tasksOf(d).some((t) => t.title === '統計レポート'), 'deleted');
  // Left swipe reveals actions without deleting on a short swipe
  await page.fill('.inline-add input', '洗濯 今日 20分');
  await page.press('.inline-add input', 'Enter');
  await page.waitForSelector('#tasks .task-row:has-text("洗濯")');
  await swipe(page, '#tasks .task-row:has-text("洗濯") .task-content', -120);
  await page.waitForSelector('#tasks .task-row:has-text("洗濯") .sw-orange', { state: 'visible' });
  await page.click('#tasks .task-row:has-text("洗濯") .sw-orange');
  d = await waitDoc(page, (d) => tasksOf(d).find((t) => t.title === '洗濯')?.dueDate === '2026-10-27', 'moved to tomorrow');
  return page;
});

test('timer: start / pause / resume / finish, survives reload', async () => {
  const page = await open();
  await quickAdd(page, '数学の演習 今日 30分');
  await page.waitForSelector('#today .task-row:has-text("数学の演習")');
  await page.click('#today .task-row:has-text("数学の演習") .play');
  await page.waitForSelector('#today .timer-card.running');
  await page.clock.fastForward('10:00');
  await page.waitForTimeout(1200);
  let clock = await page.textContent('#today .timer-clock');
  assert.match(clock, /^10:0\d$/, `elapsed after 10 min: ${clock}`);

  await page.reload();
  await page.waitForSelector('#today .timer-card.running');
  await page.clock.fastForward('05:00');
  await page.waitForTimeout(1200);
  clock = await page.textContent('#today .timer-clock');
  assert.match(clock, /^15:\d\d$/, `restored after reload: ${clock}`);

  await page.click('#today .timer-card button:has-text("一時停止")');
  await page.waitForSelector('#today .timer-card.paused');
  const paused = await page.textContent('#today .timer-clock');
  await page.clock.fastForward('20:00');
  await page.waitForTimeout(1200);
  assert.equal(await page.textContent('#today .timer-clock'), paused, 'paused clock does not move');
  await page.click('#today .timer-card button:has-text("再開")');
  await page.clock.fastForward('20:00');
  await page.waitForTimeout(1200);
  clock = await page.textContent('#today .timer-clock');
  assert.match(clock, /^3[5-6]:\d\d$/, `after resume: ${clock}`);
  assert.ok(await page.isVisible('#today .timer-card.over'), 'shows over-time state after 30 min plan');
  await page.screenshot({ path: `${OUT}timer.png` });
  await page.click('#today .timer-card button:has-text("終了")');
  await page.click('.menu-item:has-text("完了にして終了")');
  const d = await waitDoc(page, (d) => Object.values(d.sessions).some((s) => s.status === 'done'), 'session finished');
  const s = Object.values(d.sessions)[0];
  const mins = s.segments.reduce((a, g) => a + (g.end - g.start), 0) / 60000;
  assert.ok(mins > 34 && mins < 37, `recorded ${mins} min`);
  assert.equal(s.segments.length, 2, 'pause split the session into two segments');
  assert.ok(tasksOf(d).find((t) => t.title === '数学の演習').done);
  return page;
});

test('auto adjust: overrun moves flexible tasks around fixed events, undoable', async () => {
  const page = await open();
  await quickAdd(page, '課題A 9:00 30分');
  await quickAdd(page, '課題B 9:30 30分');
  await quickAdd(page, 'ゼミ 10:00 60分', 'event');
  let d = await waitDoc(page, (d) => Object.keys(d.events).length === 1 && tasksOf(d).length === 2, 'seeded');
  assert.equal(tasksOf(d).find((t) => t.title === '課題B').plan.startMin, 570);
  await page.clock.fastForward('10:00'); // 09:00
  await page.click('#today .task-row:has-text("課題A") .play');
  await page.clock.fastForward('45:00'); // 09:45, 15 min over
  await page.waitForSelector('#today .banner', { timeout: 5000 });
  await page.click('#today .banner');
  await page.waitForSelector('.change-row:has-text("課題B")');
  const text = await page.textContent('.change-row:has-text("課題B")');
  assert.match(text, /09:30.*11:00/s, `proposal: ${text}`);
  assert.match(text, /固定予定「ゼミ」/);
  assert.equal(await page.locator('.change-title:has-text("ゼミ")').count(), 0, 'fixed event is not in the proposal');
  await page.screenshot({ path: `${OUT}adjust-proposal.png` });
  await page.click('.sheet-head button:has-text("適用")');
  d = await waitDoc(page, (d) => tasksOf(d).find((t) => t.title === '課題B').plan.startMin === 660, 'applied');
  assert.equal(Object.values(d.events)[0].startMin, 600, 'fixed event untouched');
  assert.equal(d.adjustLog.length, 1);
  await page.click('.toast-btn:has-text("取り消す")');
  await waitDoc(page, (d) => tasksOf(d).find((t) => t.title === '課題B').plan.startMin === 570, 'undo restores');
  return page;
});

test('calendar: tap to add, long-press drag to move, resize, conflicts, week/month', async () => {
  const page = await open();
  await tab(page, '予定');
  await page.waitForSelector('#calendar .timeline');
  const tl = await page.locator('#calendar .timeline').boundingBox();
  const hourH = 56;
  await page.locator('#calendar .scroll').evaluate((el, y) => { el.scrollTop = y; }, 13 * hourH);
  const box = await page.locator('#calendar .timeline').boundingBox();
  await page.mouse.click(box.x + box.width * 0.6, box.y + 15 * hourH + 20);
  await page.waitForSelector('.qa-input');
  await page.fill('.qa-input', '打ち合わせ');
  await page.press('.qa-input', 'Enter');
  await page.waitForSelector('.sheet', { state: 'detached' });
  await page.waitForSelector('#calendar .block:has-text("打ち合わせ")');
  assert.match(await page.getAttribute('#calendar .block:has-text("打ち合わせ")', 'aria-label'), /^15:00/);

  // Long-press, then drag down one hour.
  const b = await page.locator('#calendar .block:has-text("打ち合わせ")').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + 10);
  await page.mouse.down();
  await page.waitForTimeout(550);
  for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + b.width / 2, b.y + 10 + (hourH * i) / 10);
  await page.screenshot({ path: `${OUT}drag.png` });
  await page.mouse.up();
  await page.waitForTimeout(200);
  assert.match(await page.getAttribute('#calendar .block:has-text("打ち合わせ")', 'aria-label'), /^16:00/);

  // Resize: drag the bottom handle +30 min.
  const r = await page.locator('#calendar .block:has-text("打ち合わせ") .resize').boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2 + (hourH / 2) * (i / 6));
  await page.mouse.up();
  let d = await waitDoc(page, (d) => Object.values(d.events).find((e) => e.title === '打ち合わせ')?.durationMin === 90, 'resized');
  assert.equal(Object.values(d.events).find((e) => e.title === '打ち合わせ').startMin, 960);

  // Conflict detection.
  await quickAdd(page, '面談 16:30 60分', 'event');
  await page.waitForSelector('#calendar .block.conflict:has-text("面談")');
  assert.equal(await page.locator('#calendar .block.conflict').count(), 2);
  await page.screenshot({ path: `${OUT}calendar-day.png` });

  await page.click('#calendar .segmented button:has-text("週")');
  await page.waitForSelector('#calendar .week .wblock');
  await page.screenshot({ path: `${OUT}calendar-week.png` });
  await page.click('#calendar .segmented button:has-text("月")');
  await page.waitForSelector('#calendar .month .mday.today');
  await page.screenshot({ path: `${OUT}calendar-month.png` });
  return page;
});

test('recurring event: edit only this occurrence', async () => {
  const page = await open();
  await tab(page, '予定');
  await page.click('#calendar .nav-btn.primary');
  await page.click('.sheet .segmented button:has-text("予定")');
  await page.fill('.qa-input', '朝ラン 7:00 30分');
  await page.click('.link-btn:has-text("詳細を入力")');
  await page.waitForSelector('.sheet .title-input');
  await page.selectOption('.sheet select[aria-label="繰り返し"]', 'daily');
  await page.click('.sheet-head button:has-text("完了")');
  await waitDoc(page, (d) => Object.values(d.events).some((e) => e.repeat?.freq === 'daily'), 'recurring saved');
  // Open tomorrow's occurrence and move it.
  await page.click('#calendar .strip-day:nth-child(3)');
  await page.locator('#calendar .scroll').evaluate((el) => { el.scrollTop = 0; });
  await page.click('#calendar .block:has-text("朝ラン")');
  await page.click('.action-grid button:has-text("編集")');
  await page.waitForSelector('.sheet input[aria-label="開始"]');
  await page.fill('.sheet input[aria-label="開始"]', '08:00');
  await page.click('.sheet-head button:has-text("完了")');
  await page.click('.dialog button:has-text("この予定のみ")');
  const d = await waitDoc(page, (d) => Object.values(Object.values(d.events)[0].overrides).length === 1, 'override saved');
  const e = Object.values(d.events)[0];
  assert.equal(e.startMin, 420);
  assert.deepEqual(e.overrides['2026-10-27'], { startMin: 480 });
  return page;
});

test('moodle: sync via URL, no duplicates, update detection, CORS error, file import', async () => {
  const page = await open();
  await tab(page, '大学');
  await page.click('#school .btn:has-text("設定")');
  await page.fill('.sheet textarea', `http://127.0.0.1:${PORT}/__moodle.ics?cors=1&authtoken=x`);
  await page.click('.sheet-head button:has-text("保存")');
  await page.waitForSelector('.toast:has-text("新規2件")');
  let d = await waitDoc(page, (d) => tasksOf(d).filter((t) => t.source?.kind === 'moodle').length === 2, 'imported');
  const rep = tasksOf(d).find((t) => t.title === '統計学レポート');
  assert.equal(rep.dueDate, '2026-10-30');
  assert.equal(rep.dueMin, 23 * 60 + 59);
  await page.click('#school .btn:has-text("同期")');
  await page.waitForSelector('.toast:has-text("新しい課題はありません")');
  d = await doc(page);
  assert.equal(tasksOf(d).length, 2, 'no duplicates');
  // Due date moved on the server.
  await page.click('#school .btn:has-text("設定")');
  await page.fill('.sheet textarea', `http://127.0.0.1:${PORT}/__moodle.ics?cors=1&shift=1&authtoken=x`);
  await page.click('.sheet-head button:has-text("保存")');
  await page.waitForSelector('.toast:has-text("更新1件")');
  d = await waitDoc(page, (d) => tasksOf(d).find((t) => t.title === '統計学レポート').dueDate === '2026-10-31', 'due date updated');
  await page.waitForSelector('#school .badge:has-text("Moodle 更新")');
  // Server without CORS → clear error.
  await page.click('#school .btn:has-text("設定")');
  await page.fill('.sheet textarea', `http://127.0.0.1:${PORT}/__moodle.ics?authtoken=x`); // other origin, no CORS headers
  await page.click('.sheet-head button:has-text("保存")');
  await page.waitForSelector('#school .section-foot:has-text("CORS")');
  await page.screenshot({ path: `${OUT}moodle-error.png` });
  // File import always works.
  const ics = readFileSync(new URL('./moodle-sample.ics', import.meta.url), 'utf8').replaceAll('{{SHIFT}}', '0');
  await page.setInputFiles('#school input[type="file"]', { name: 'icalexport.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
  await page.waitForSelector('.toast:has-text("更新1件")');
  d = await waitDoc(page, (d) => d.moodle.status === 'ok', 'status ok after file import');
  assert.equal(tasksOf(d).length, 2);
  // The browser itself logs the blocked cross-origin request; that is the expected outcome here.
  page.errors = page.errors.filter((e) => !/CORS policy|ERR_FAILED/.test(e));
  return page;
});

test('backup: export, wipe, import restores data', async () => {
  const page = await open();
  await quickAdd(page, 'バックアップ確認 今日');
  await waitDoc(page, (d) => tasksOf(d).length === 1, 'task');
  await tab(page, '設定');
  await page.click('#settings .row:has-text("データ・バックアップ・移行")');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.sheet .row:has-text("バックアップを書き出す")')]);
  const file = `${OUT}backup.json`;
  await dl.saveAs(file);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(Object.values(json.state.tasks)[0].title, 'バックアップ確認');
  await page.click('.sheet .row:has-text("すべてのデータを消去")');
  await page.click('.dialog button:has-text("消去")');
  await waitDoc(page, (d) => tasksOf(d).length === 0, 'wiped');
  await page.click('#settings .row:has-text("データ・バックアップ・移行")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.sheet .row:has-text("バックアップを読み込む")')]);
  await chooser.setFiles(file);
  await page.click('.dialog button:has-text("置き換える")');
  await waitDoc(page, (d) => tasksOf(d).length === 1, 'restored');
  return page;
});

test('migration: data saved by the previous app is imported on first launch', async () => {
  const page = await open({ init: { fn: (raw) => { if (!localStorage.getItem('todaytime:v2:main')) localStorage.setItem('todaytime:v2:main', raw); }, arg: legacyFixture } });
  await page.waitForSelector('.toast:has-text("旧バージョンのデータを引き継ぎました")');
  const d = await waitDoc(page, (d) => tasksOf(d).length >= 2, 'migrated');
  assert.equal(d.meta.migratedFrom, 'todaytime:v2');
  assert.ok(tasksOf(d).some((t) => t.title === '統計レポート'));
  assert.ok(await page.evaluate(() => !!localStorage.getItem('todaytime:v2:main')), 'old data left untouched');
  await page.waitForSelector('#today .agenda-row:has-text("ゼミ")'); // weekly event on Monday
  await tab(page, '大学');
  await page.waitForSelector('#school .tt-cell.filled:has-text("統計学")');
  await page.screenshot({ path: `${OUT}migrated-school.png` });
  return page;
});

test('recovery: corrupt main data is restored from the automatic backup', async () => {
  const page = await open();
  await quickAdd(page, '消えてはいけないタスク 今日');
  await waitDoc(page, (d) => tasksOf(d).length === 1, 'saved');
  await page.waitForTimeout(800); // daily backup after first save
  await page.evaluate(() => new Promise((res) => {
    localStorage.setItem('todaytime:v3:mirror', '{"broken":');
    const r = indexedDB.open('todaytime-pro');
    r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ schema: 99, garbage: true }, 'state'); tx.oncomplete = () => { r.result.close(); res(); }; };
  }));
  await page.reload();
  await page.waitForSelector('.toast:has-text("自動バックアップから復元")');
  await page.waitForSelector('#today .task-row:has-text("消えてはいけないタスク")');
  return page;
});

test('notifications: fire while open when permitted; honest settings copy', async () => {
  const page = await open({
    permissions: ['notifications'],
    init: { fn: () => {
      window.__notes = [];
      window.Notification = class { constructor(t, o) { window.__notes.push({ t, body: o?.body }); } static get permission() { return 'granted'; } static requestPermission() { return Promise.resolve('granted'); } };
      if (window.ServiceWorkerRegistration) ServiceWorkerRegistration.prototype.showNotification = function (t, o) { window.__notes.push({ t, body: o?.body, via: 'sw' }); return Promise.resolve(); };
    } },
  });
  await tab(page, '設定');
  await page.click('#settings button[role="switch"][aria-label="通知を使う"]');
  await page.waitForSelector('#settings .row:has-text("予定の開始前")');
  const foot = await page.textContent('#settings .section:has-text("通知") .section-foot');
  assert.match(foot, /アプリを開いている間/);
  await tab(page, '今日');
  await quickAdd(page, '歯医者 9:05 30分', 'event');
  await page.clock.fastForward('03:00'); // 08:53 → alert at 08:55 (10 min before)
  await page.waitForTimeout(300);
  await page.clock.fastForward('02:30');
  await page.waitForTimeout(500);
  const notes = await page.evaluate(() => window.__notes);
  assert.ok(notes.some((n) => /歯医者/.test(n.t)), `notifications: ${JSON.stringify(notes)}`);
  return page;
});

test('dark mode follows the system and is readable', async () => {
  const page = await open({ dark: true });
  await quickAdd(page, '夜のタスク 今日 !!!');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(bg, 'rgb(0, 0, 0)');
  for (const t of ['今日', '予定', 'タスク', '大学', '設定']) {
    await tab(page, t);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}dark-${t}.png` });
  }
  return page;
});

test('offline: the service worker serves the app without network', async () => {
  const page = await open();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller || (location.reload(), false), null, { timeout: 10000 }).catch(() => {});
  await page.reload();
  await page.waitForSelector('.tabbar');
  assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'page is controlled by the SW');
  await quickAdd(page, 'オフライン確認 今日');
  await page.context().setOffline(true);
  await page.reload();
  await page.waitForSelector('#today .task-row:has-text("オフライン確認")');
  await page.context().setOffline(false);
  return page;
});

/* ------------------------------------------------------------------ */

const filter = process.argv[2];
const server = await serve(PORT);
browser = await chromium.launch();
let failed = 0;
const results = [];
for (const t of tests) {
  if (filter && !t.name.includes(filter)) continue;
  const started = Date.now();
  let page;
  try {
    page = await t.fn();
    if (page?.errors?.length) throw new Error('page errors: ' + page.errors.join(' | '));
    results.push(`ok   ${t.name} (${Date.now() - started}ms)`);
  } catch (e) {
    failed++;
    results.push(`FAIL ${t.name}\n     ${e.message}\n     ${(e.stack || "").split("\n").find((l) => l.includes("run.js")) || ""}`);
    try { const pages = browser.contexts().flatMap((c) => c.pages()); await pages[pages.length - 1]?.screenshot({ path: `${OUT}FAIL-${t.name.slice(0, 20)}.png` }); } catch { /* ignore */ }
  } finally {
    for (const c of browser.contexts()) await c.close();
  }
  console.log(results[results.length - 1]);
}
await browser.close();
server.close();
writeFileSync(`${OUT}results.txt`, results.join('\n') + '\n');
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
