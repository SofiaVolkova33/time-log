'use strict';

// ---------- утилиты ----------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function fmtDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return m + ' мин';
  if (m === 0) return h + ' ч';
  return h + ' ч ' + m + ' мин';
}

function fmtClock(ms) {
  const d = new Date(ms);
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

function fmtRange(startMs, endMs) {
  const s = fmtClock(startMs);
  if (endMs == null) return s + ' — …';
  return s + ' — ' + fmtClock(endMs);
}

function todayStr() {
  const d = new Date();
  return toDateStr(d);
}

function toDateStr(d) {
  return (
    d.getFullYear() + '-' +
    (d.getMonth() + 1).toString().padStart(2, '0') + '-' +
    d.getDate().toString().padStart(2, '0')
  );
}

function addDays(str, n) {
  const d = new Date(str + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error('Ошибка запроса');
  return res.json();
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

// ---------- состояние ----------

let activeList = [];   // активные (незакрытые) записи
let pollTimer = null;

// ---------- навигация ----------

function showView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'today') loadToday();
  if (name === 'report') setupReport();
  if (name === 'templates') loadTemplates();
}

$$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

// ---------- активные записи ----------

function renderActive() {
  const section = $('#active-section');
  const list = $('#active-list');
  list.innerHTML = '';
  if (!activeList.length) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  for (const r of activeList) {
    list.appendChild(makeActiveItem(r));
  }
}

function makeActiveItem(r) {
  const el = document.createElement('div');
  el.className = 'active-item' + (r.status === 'passive' ? ' passive' : '');

  const client = document.createElement('div');
  client.className = 'active-client';
  client.textContent = r.client || 'Без клиента';
  const task = document.createElement('div');
  task.className = 'active-task';
  task.textContent = r.task || '';
  const time = document.createElement('div');
  time.className = 'active-time';
  time.dataset.start = r.start;
  time.dataset.status = r.status;

  const actions = document.createElement('div');
  actions.className = 'active-actions';
  const bPass = document.createElement('button');
  bPass.className = 'btn';
  bPass.textContent = r.status === 'passive' ? 'Активно' : 'В ожидании';
  bPass.addEventListener('click', async () => {
    const next = r.status === 'passive' ? 'active' : 'passive';
    const upd = await api('/api/entries/' + r.id, { method: 'PATCH', body: { status: next } });
    const idx = activeList.findIndex((x) => x.id === r.id);
    if (idx >= 0) activeList[idx] = upd;
    renderActive();
    tick();
  });
  const bStop = document.createElement('button');
  bStop.className = 'btn';
  bStop.textContent = 'Завершить';
  bStop.addEventListener('click', async () => {
    await api('/api/entries/' + r.id + '/close', { method: 'POST', body: {} });
    activeList = activeList.filter((x) => x.id !== r.id);
    renderActive();
    loadToday();
  });
  actions.appendChild(bPass);
  actions.appendChild(bStop);

  el.appendChild(client);
  el.appendChild(task);
  el.appendChild(time);
  el.appendChild(actions);
  return el;
}

function tick() {
  const now = Date.now();
  $$('#active-list .active-time').forEach((el) => {
    const start = Number(el.dataset.start);
    el.textContent = fmtDuration(now - start);
  });
}

async function loadActive() {
  try {
    activeList = await api('/api/active');
    renderActive();
    tick();
  } catch (e) {
    toast('Нет связи с сервером');
  }
}

// пуск задачи через шаблон/кнопку
async function startEntry(client, task, source = 'self') {
  try {
    await api('/api/entries', { method: 'POST', body: { client, task, source, status: 'active' } });
    $('#self-form').classList.add('hidden');
    await loadActive();
    toast('Задача запущена');
  } catch (e) {
    toast('Ошибка');
  }
}

// кнопка «Звонок» — подхватываем последнего клиента из шаблонов или истории
async function callStart() {
  let client = '';
  let task = 'Звонок клиенту';
  try {
    const tpls = await api('/api/templates');
    const last = tpls[0];
    if (last && last.client) client = last.client;
  } catch (e) { /* ignore */ }
  await startEntry(client, task, 'call');
}

$('#btn-call').addEventListener('click', callStart);

$('#btn-self').addEventListener('click', () => {
  $('#self-form').classList.toggle('hidden');
  loadClients();
});

$('#btn-cancel-self').addEventListener('click', () => $('#self-form').classList.add('hidden'));

$('#self-form').addEventListener('submit', (e) => {
  e.preventDefault();
  startEntry($('#f-client').value.trim(), $('#f-task').value.trim(), 'self');
  $('#f-client').value = '';
  $('#f-task').value = '';
});

// ---------- сегодня ----------

async function loadToday() {
  const day = todayStr();
  $('#today-date').textContent = day;
  const rows = await api('/api/entries?day=' + day);
  const ref = Date.now();
  const total = rows.reduce((s, r) => s + ((r.end != null ? r.end : ref) - r.start), 0);
  $('#day-total').textContent = 'Всего: ' + fmtDuration(total);

  const list = $('#today-list');
  list.innerHTML = '';
  for (const r of rows) {
    list.appendChild(makeEntryItem(r));
  }
}

function makeEntryItem(r) {
  const li = document.createElement('li');
  li.className = 'entry' + (r.status === 'active' ? ' active' : '') + (r.status === 'passive' ? ' passive' : '');

  const head = document.createElement('div');
  head.className = 'entry-head';

  const info = document.createElement('div');
  const client = document.createElement('div');
  client.className = 'entry-client';
  client.textContent = r.client || 'Без клиента';
  const task = document.createElement('div');
  task.className = 'entry-task';
  task.textContent = r.task || '';
  info.appendChild(client);
  info.appendChild(task);

  const right = document.createElement('div');
  right.style.textAlign = 'right';
  const tag = document.createElement('span');
  tag.className = 'entry-tag ' + r.status;
  tag.textContent = r.status === 'active' ? 'идёт' : r.status === 'passive' ? 'ожидание' : '';
  const time = document.createElement('div');
  time.className = 'entry-time';
  time.textContent = fmtRange(r.start, r.end);
  right.appendChild(tag);
  right.appendChild(time);

  head.appendChild(info);
  head.appendChild(right);
  li.appendChild(head);

  const actions = document.createElement('div');
  actions.className = 'entry-actions';

  const bStop = document.createElement('button');
  bStop.className = 'btn';
  bStop.textContent = 'Завершить';
  bStop.addEventListener('click', async () => {
    await api('/api/entries/' + r.id + '/close', { method: 'POST', body: {} });
    loadToday();
    loadActive();
  });

  const bPass = document.createElement('button');
  bPass.className = 'btn';
  bPass.textContent = r.status === 'passive' ? 'Активно' : 'В ожидании';
  bPass.addEventListener('click', async () => {
    const next = r.status === 'passive' ? 'active' : 'passive';
    await api('/api/entries/' + r.id, { method: 'PATCH', body: { status: next } });
    loadToday();
    loadActive();
  });

  const bDel = document.createElement('button');
  bDel.className = 'btn btn-sm';
  bDel.textContent = '✕';
  bDel.addEventListener('click', async () => {
    await api('/api/entries/' + r.id, { method: 'DELETE' });
    loadToday();
    loadActive();
  });

  actions.appendChild(bStop);
  actions.appendChild(bPass);
  actions.appendChild(bDel);
  li.appendChild(actions);
  return li;
}

// ---------- автодополнение ----------

async function loadClients() {
  try {
    const clients = await api('/api/clients');
    $('#clients-list').innerHTML = clients.map((c) => '<option value="' + escapeHtml(c) + '"></option>').join('');
    const tasks = await api('/api/tasks');
    $('#tasks-list').innerHTML = tasks.map((t) => '<option value="' + escapeHtml(t) + '"></option>').join('');
  } catch (e) { /* ignore */ }
}

// ---------- отчёт ----------

const RANGES = {
  day: () => [todayStr(), todayStr()],
  week: () => {
    const d = new Date();
    const wd = (d.getDay() + 6) % 7;
    const mon = addDays(todayStr(), -wd);
    return [mon, todayStr()];
  },
  month: () => [todayStr().slice(0, 8) + '01', todayStr()],
};

let reportData = null;

function setupReport() {
  // задаём диапазон по умолчанию (не сбрасываем, если уже был)
  const range = document.querySelector('.range.active').dataset.range;
  const [from, to] = RANGES[range]();
  $('#r-from').value = from;
  $('#r-to').value = to;
  loadReport();
}

$$('.range').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.range').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const [from, to] = RANGES[b.dataset.range]();
    $('#r-from').value = from;
    $('#r-to').value = to;
    loadReport();
  })
);

$('#btn-report').addEventListener('click', loadReport);

function fmtHMS(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  if (h === 0) return m + ' мин';
  if (m === 0) return h + ' ч';
  return h + ' ч ' + m + ' мин';
}

function renderReportTable(el, rows, isClient) {
  el.innerHTML = '';
  if (!rows.length) {
    el.innerHTML = '<tr><td>Нет данных</td></tr>';
    return;
  }
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  trh.innerHTML = '<th>' + (isClient ? 'Клиент' : 'Задача') + '</th><th class="num">Активное</th><th class="num">Ожидание</th><th class="num">Итого</th>';
  thead.appendChild(trh);
  el.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    const total = r.active + r.passive;
    tr.innerHTML =
      '<td>' + escapeHtml(r.name) + '</td>' +
      '<td class="num">' + (r.active ? fmtHMS(r.active) : '—') + '</td>' +
      '<td class="num">' + (r.passive ? fmtHMS(r.passive) : '—') + '</td>' +
      '<td class="num"><b>' + fmtHMS(total) + '</b></td>';
    tbody.appendChild(tr);
  }
  el.appendChild(tbody);
}

async function loadReport() {
  const from = $('#r-from').value;
  const to = $('#r-to').value;
  if (!from || !to) return;
  try {
    reportData = await api('/api/report?from=' + from + '&to=' + to);
    renderReportTable($('#rep-clients'), reportData.clients, true);
    renderReportTable($('#rep-tasks'), reportData.tasks, false);

    const list = $('#report-entries');
    list.innerHTML = '';
    for (const r of reportData.entries) {
      const li = document.createElement('li');
      li.className = 'entry';
      li.innerHTML =
        '<div class="entry-head"><span><b>' + escapeHtml(r.client || 'Без клиента') + '</b></span><span class="entry-time">' + fmtRange(r.start, r.end) + '</span></div>' +
        '<div class="entry-task">' + escapeHtml(r.task || '') + '</div>';
      list.appendChild(li);
    }
  } catch (e) {
    toast('Ошибка отчёта');
  }
}

$('#btn-csv').addEventListener('click', () => {
  if (!reportData) return;
  let csv = '\uFEFFКлиент;Активное(мин);Ожидание(мин);Итого(мин)\n';
  for (const r of reportData.clients) {
    csv += r.name + ';' + Math.round(r.active / 60000) + ';' + Math.round(r.passive / 60000) + ';' + Math.round((r.active + r.passive) / 60000) + '\n';
  }
  csv += '\nЗадача;Активное(мин);Ожидание(мин);Итого(мин)\n';
  for (const r of reportData.tasks) {
    csv += r.name + ';' + Math.round(r.active / 60000) + ';' + Math.round(r.passive / 60000) + ';' + Math.round((r.active + r.passive) / 60000) + '\n';
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'отчёт-' + reportData.from + '_' + reportData.to + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- шаблоны ----------

async function loadTemplates() {
  const list = $('#template-list');
  list.innerHTML = '';
  const tpls = await api('/api/templates');
  for (const t of tpls) {
    const li = document.createElement('li');
    li.className = 'template-item';
    const info = document.createElement('div');
    info.className = 'template-info';
    info.innerHTML = '<div class="template-name">' + escapeHtml(t.name) + '</div>' +
      '<div class="template-sub">' + escapeHtml(t.client || '') + (t.client && t.task ? ' · ' : '') + escapeHtml(t.task || '') + '</div>';
    const run = document.createElement('button');
    run.className = 'template-run';
    run.textContent = '▶';
    run.addEventListener('click', () => startEntry(t.client, t.task, 'self'));
    const del = document.createElement('button');
    del.className = 'template-del';
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      await api('/api/templates/' + t.id, { method: 'DELETE' });
      loadTemplates();
    });
    li.appendChild(info);
    li.appendChild(run);
    li.appendChild(del);
    list.appendChild(li);
  }
}

$('#template-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#t-name').value.trim();
  if (!name) { toast('Укажите название'); return; }
  await api('/api/templates', {
    method: 'POST',
    body: { name, client: $('#t-client').value.trim(), task: $('#t-task').value.trim() },
  });
  $('#t-name').value = ''; $('#t-client').value = ''; $('#t-task').value = '';
  loadTemplates();
  toast('Шаблон сохранён');
});

// ---------- запуск ----------

// поллинг активной записи и времени
setInterval(tick, 1000);
setInterval(loadActive, 15000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

loadActive();
loadClients();