'use strict';

// ---------- утилиты ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function fmtDuration(ms) {
  if (ms == null) return '—';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return m + ' мин';
  if (m === 0) return h + ' ч';
  return h + ' ч ' + m + ' мин';
}

function fmtClock(ms) {
  if (!ms) return '';
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
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

// ---------- навигация ----------
function showView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'current') loadCurrent();
  if (name === 'tasks') loadTodos();
  if (name === 'today') loadToday();
  if (name === 'report') setupReport();
}

$$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

// ---------- автодополнение ----------
async function loadClients() {
  try {
    const clients = await api('/api/clients');
    $('#clients-list').innerHTML = clients.map((c) => '<option value="' + escapeHtml(c) + '"></option>').join('');
    const tasks = await api('/api/tasks');
    $('#tasks-list').innerHTML = tasks.map((t) => '<option value="' + escapeHtml(t) + '"></option>').join('');
    return clients;
  } catch (e) {
    return [];
  }
}

// ---------- лента «Текущее» ----------
async function loadCurrent() {
  try {
    const rows = await api('/api/current');
    const list = $('#current-list');
    list.innerHTML = '';
    if (!rows.length) {
      list.innerHTML = '<li class="empty-hint">Нет незавершённых задач</li>';
      return;
    }
    for (const r of rows) list.appendChild(makeEntryCard(r));
  } catch (e) {
    toast('Нет связи с сервером');
  }
}

function tagLabel(r) {
  if (r.source === 'call') return 'звонок';
  if (r.status === 'new') return 'новая';
  if (r.status === 'active') return 'идёт';
  if (r.status === 'passive') return 'ожидание';
  return 'завершено';
}

function isOverdue(r) {
  return !!(r.due && r.due < todayStr() && r.status !== 'done');
}

// универсальная карточка
function makeEntryCard(r) {
  const li = document.createElement('li');
  li.className = 'entry ' + r.status;
  li.dataset.id = r.id;

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
  head.appendChild(info);

  const right = document.createElement('div');
  right.style.textAlign = 'right';
  const tag = document.createElement('span');
  tag.className = 'entry-tag ' + r.status + (r.source === 'call' ? ' call' : '');
  tag.textContent = tagLabel(r);
  const time = document.createElement('div');
  time.className = 'entry-time';
  if (r.start != null) {
    time.dataset.start = r.start;
    time.textContent = r.end != null ? fmtRange(r.start, r.end) : fmtDuration(Date.now() - r.start);
  }
  right.appendChild(tag);
  if (time.textContent) right.appendChild(time);
  head.appendChild(right);
  li.appendChild(head);

  if (r.due) {
    const due = document.createElement('div');
    due.className = 'entry-due' + (isOverdue(r) ? ' overdue' : '');
    due.textContent = 'Срок: ' + r.due + (isOverdue(r) ? ' — просрочено' : '');
    li.appendChild(due);
  }

  const note = document.createElement('textarea');
  note.className = 'entry-note';
  note.placeholder = 'Заметки…';
  note.value = r.note || '';
  note.addEventListener('change', async () => {
    await api('/api/entries/' + r.id, { method: 'PATCH', body: { note: note.value } });
  });
  li.appendChild(note);

  const actions = document.createElement('div');
  actions.className = 'entry-actions';

  if (r.status === 'new') {
    const bStart = document.createElement('button');
    bStart.className = 'btn btn-primary';
    bStart.textContent = 'Начать';
    bStart.addEventListener('click', async () => {
      await api('/api/entries/' + r.id + '/start', { method: 'POST', body: {} });
      loadCurrent();
      loadTodos();
      toast('Задача в работе');
    });
    actions.appendChild(bStart);
  } else if (r.status === 'active' || r.status === 'passive') {
    const bPass = document.createElement('button');
    bPass.className = 'btn';
    bPass.textContent = r.status === 'passive' ? 'Активно' : 'В ожидании';
    bPass.addEventListener('click', async () => {
      const next = r.status === 'passive' ? 'active' : 'passive';
      await api('/api/entries/' + r.id, { method: 'PATCH', body: { status: next } });
      loadCurrent();
    });
    const bStop = document.createElement('button');
    bStop.className = 'btn btn-stop';
    bStop.textContent = 'Завершить';
    bStop.addEventListener('click', async () => {
      await api('/api/entries/' + r.id + '/close', { method: 'POST', body: {} });
      loadCurrent();
      loadTodos();
      toast('Завершено');
    });
    actions.appendChild(bPass);
    actions.appendChild(bStop);
  }

  // кнопка «+ Задача» на активной карточке — добавить дело с привязкой к клиенту
  if (r.status === 'active' || r.status === 'passive' || r.status === 'new') {
    const bAdd = document.createElement('button');
    bAdd.className = 'btn';
    bAdd.textContent = '+ Задача';
    bAdd.addEventListener('click', () => openTodoForm(r.client || ''));
    actions.appendChild(bAdd);
  }

  li.appendChild(actions);
  return li;
}

function updateTimers() {
  $$('#current-list .entry-time[data-start], #today-list .entry-time[data-start]').forEach((el) => {
    const start = Number(el.dataset.start);
    if (start) el.textContent = fmtDuration(Date.now() - start);
  });
}

// ---------- формы «Звонок» / «Начать задачу» ----------
function hideAllForms() {
  ['#call-form', '#self-form', '#todo-form'].forEach((s) => $(s).classList.add('hidden'));
}

function openForm(sel) {
  hideAllForms();
  $(sel).classList.remove('hidden');
  loadClients();
}

$('#btn-call').addEventListener('click', () => {
  const f = $('#call-form');
  if (!f.classList.contains('hidden')) { f.classList.add('hidden'); return; }
  openForm('#call-form');
  $('#call-client').focus();
});

$('#btn-self').addEventListener('click', () => {
  const f = $('#self-form');
  if (!f.classList.contains('hidden')) { f.classList.add('hidden'); return; }
  openForm('#self-form');
  $('#f-client').focus();
});

$('#call-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const client = $('#call-client').value.trim();
  if (!client) { toast('Укажите клиента'); return; }
  try {
    await api('/api/entries', {
      method: 'POST',
      body: { client, task: $('#call-task').value.trim(), source: 'call' },
    });
    $('#call-client').value = '';
    $('#call-task').value = '';
    hideAllForms();
    loadCurrent();
    toast('Звонок начат');
  } catch (e) { toast('Ошибка'); }
});

$('#self-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/entries', {
      method: 'POST',
      body: {
        client: $('#f-client').value.trim(),
        task: $('#f-task').value.trim(),
        source: 'self',
      },
    });
    $('#f-client').value = '';
    $('#f-task').value = '';
    hideAllForms();
    loadCurrent();
    toast('Задача запущена');
  } catch (e) { toast('Ошибка'); }
});

// ---------- новая задача-дело ----------
function openTodoForm(client) {
  hideAllForms();
  $('#todo-form').classList.remove('hidden');
  $('#t-client').value = client || '';
  loadClients();
  $('#t-task').focus();
}

$('#todo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const task = $('#t-task').value.trim();
  if (!task) { toast('Укажите задачу'); return; }
  try {
    await api('/api/entries', {
      method: 'POST',
      body: {
        client: $('#t-client').value.trim(),
        task,
        due: $('#t-due').value,
        source: 'todo',
        status: 'new',
      },
    });
    ['#t-client', '#t-task', '#t-due'].forEach((s) => { $(s).value = ''; });
    hideAllForms();
    loadTodos();
    toast('Задача добавлена');
  } catch (e) { toast('Ошибка'); }
});

// ---------- задачи по клиентам ----------
async function loadTodos() {
  const container = $('#todos-by-client');
  container.innerHTML = '<div class="empty-hint">Загрузка…</div>';
  const todos = await api('/api/todos');
  const groups = {};
  for (const t of todos) {
    const key = t.client || '(без клиента)';
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }
  container.innerHTML = '';

  const keys = Object.keys(groups).sort((a, b) => (a === '(без клиента)' ? 1 : b === '(без клиента)' ? -1 : a.localeCompare(b)));

  for (const key of keys) {
    const items = groups[key];
    const pending = items.filter((x) => x.status !== 'done');
    const done = items.filter((x) => x.status === 'done');

    const group = document.createElement('div');
    group.className = 'client-group open';

    const head = document.createElement('div');
    head.className = 'client-group-head ' + colorFor(key);
    head.innerHTML = '<span class="caret">▸</span>' + escapeHtml(key) + '<span class="count">' + pending.length + '</span>';
    head.addEventListener('click', () => group.classList.toggle('open'));

    const body = document.createElement('div');
    body.className = 'client-group-body';

    const addBtn = document.createElement('button');
    addBtn.className = 'todo-save';
    addBtn.textContent = '+ Новая задача';
    addBtn.addEventListener('click', () => showView('current') && openTodoForm(key === '(без клиента)' ? '' : key));
    body.appendChild(addBtn);

    for (const t of pending) body.appendChild(makeTodoRow(t));

    if (done.length) {
      const doneWrap = document.createElement('div');
      doneWrap.className = 'client-group';
      const doneHead = document.createElement('div');
      doneHead.className = 'client-group-head';
      doneHead.innerHTML = '<span class="caret">▸</span>Выполненные<span class="count">' + done.length + '</span>';
      doneHead.addEventListener('click', () => doneWrap.classList.toggle('open'));
      const doneBody = document.createElement('div');
      doneBody.className = 'client-group-body';
      for (const t of done) doneBody.appendChild(makeTodoRow(t));
      doneWrap.appendChild(doneHead);
      doneWrap.appendChild(doneBody);
      body.appendChild(doneWrap);
    }

    group.appendChild(head);
    group.appendChild(body);
    container.appendChild(group);
  }
}

function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h + name.charCodeAt(i)) % 997;
  return 'pc' + ((h % 6) + 1);
}

// компактная строка задачи в разделе «Задачи»
function makeTodoRow(r) {
  const li = document.createElement('li');
  li.className = 'entry todo-row ' + r.status;

  const head = document.createElement('div');
  head.className = 'entry-head';

  const info = document.createElement('div');
  const txt = document.createElement('div');
  txt.className = 'todo-text';
  txt.textContent = r.task || '(без задачи)';
  const sub = document.createElement('div');
  sub.className = 'entry-task';
  const subs = [];
  if (r.client) subs.push(r.client);
  if (r.due) subs.push('срок: ' + r.due + (isOverdue(r) ? ' ⚠' : ''));
  else subs.push('срок не указан');
  if (r.status === 'active') subs.push('в работе · ' + fmtDuration((r.end || Date.now()) - r.start));
  if (r.status === 'passive') subs.push('ожидание');
  if (r.status === 'done') subs.push('выполнена');
  sub.textContent = subs.join(' · ');
  info.appendChild(txt);
  info.appendChild(sub);
  head.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'entry-actions todo-actions';

  if (r.status === 'new') {
    const bStart = document.createElement('button');
    bStart.className = 'btn btn-primary';
    bStart.textContent = 'Начать';
    bStart.addEventListener('click', async () => {
      await api('/api/entries/' + r.id + '/start', { method: 'POST', body: {} });
      loadTodos();
      toast('Задача в работе');
    });
    actions.appendChild(bStart);
  } else if (r.status === 'active' || r.status === 'passive') {
    const bStop = document.createElement('button');
    bStop.className = 'btn btn-stop';
    bStop.textContent = 'Завершить';
    bStop.addEventListener('click', async () => {
      await api('/api/entries/' + r.id + '/close', { method: 'POST', body: {} });
      loadTodos();
      toast('Выполнено');
    });
    actions.appendChild(bStop);
  }

  if (r.status !== 'done') {
    const bDel = document.createElement('button');
    bDel.className = 'btn';
    bDel.textContent = 'Удалить';
    bDel.addEventListener('click', async () => {
      await api('/api/entries/' + r.id, { method: 'DELETE' });
      loadTodos();
    });
    actions.appendChild(bDel);
  }

  if (r.note) {
    const note = document.createElement('div');
    note.className = 'todo-note';
    note.textContent = r.note;
    li.appendChild(note);
  }

  li.appendChild(head);
  li.appendChild(actions);
  return li;
}

// ---------- сегодня ----------
async function loadToday() {
  const day = todayStr();
  $('#today-date').textContent = day;
  const rows = await api('/api/entries?day=' + day);
  const withTime = rows.filter((r) => r.start != null);
  const ref = Date.now();
  const total = withTime.reduce((s, r) => s + ((r.end != null ? r.end : ref) - r.start), 0);
  $('#day-total').textContent = 'Всего: ' + fmtDuration(total);

  const list = $('#today-list');
  list.innerHTML = '';
  if (!withTime.length) { list.innerHTML = '<li class="empty-hint">Сегодня нет записей времени</li>'; return; }
  for (const r of withTime) list.appendChild(makeTodayRow(r));
}

// свод сегодняшней записи: без кнопок, время со-до, заметки текстом
function makeTodayRow(r) {
  const li = document.createElement('li');
  li.className = 'entry today-row ' + r.status;

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
  head.appendChild(info);

  const tag = document.createElement('span');
  tag.className = 'entry-tag ' + r.status + (r.source === 'call' ? ' call' : '');
  tag.textContent = tagLabel(r);
  head.appendChild(tag);
  li.appendChild(head);

  // время: со скольки — до скольки (до редактируемое)
  const timeRow = document.createElement('div');
  timeRow.className = 'today-time';
  const fromSpan = document.createElement('span');
  fromSpan.textContent = 'Со ' + fmtClockTime(r.start);

  const toLabel = document.createElement('span');
  toLabel.textContent = ' · до ';

  const toEdit = document.createElement('input');
  toEdit.type = 'time';
  toEdit.className = 'to-edit';
  if (r.end != null) toEdit.value = fmtClockTime(r.end);

  const dur = document.createElement('span');
  const ref = r.end != null ? r.end : Date.now();
  dur.textContent = ' · ' + fmtRounded15(ref - r.start);

  toEdit.addEventListener('change', async () => {
    if (!toEdit.value) return;
    const d = new Date(r.start);
    const [hh, mm] = toEdit.value.split(':').map(Number);
    d.setHours(hh, mm, 0, 0);
    await api('/api/entries/' + r.id, { method: 'PATCH', body: { end_ms: d.getTime() } });
    loadToday();
  });

  timeRow.appendChild(fromSpan);
  timeRow.appendChild(toLabel);
  timeRow.appendChild(toEdit);
  timeRow.appendChild(dur);
  li.appendChild(timeRow);

  // заметки — только отображение (если были указаны)
  if (r.note) {
    const note = document.createElement('div');
    note.className = 'today-note';
    note.textContent = r.note;
    li.appendChild(note);
  }

  return li;
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

// округление до ближайших 15 минут
function fmtRounded15(ms) {
  const min = Math.round(ms / 60000 / 15) * 15;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return m + ' мин';
  if (m === 0) return h + ' ч';
  return h + ' ч ' + m + ' мин';
}

function fmtClockTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

function renderReportTable(el, rows, type) {
  el.innerHTML = '';
  if (!rows.length) { el.innerHTML = '<tr><td>Нет данных</td></tr>'; return; }
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  if (type === 'task') {
    trh.innerHTML = '<th>Задача</th><th>Клиент</th><th class="num">Активное</th><th class="num">Ожидание</th><th class="num">Итого</th>';
  } else {
    trh.innerHTML = '<th>Клиент</th><th class="num">Активное</th><th class="num">Ожидание</th><th class="num">Итого</th>';
  }
  thead.appendChild(trh);
  el.appendChild(thead);
  const tbody = document.createElement('tbody');
  let i = 0;
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.className = 'row-' + ((i++) % 2);
    const total = r.active + r.passive;
    if (type === 'task') {
      tr.innerHTML =
        '<td>' + escapeHtml(r.name) + '</td>' +
        '<td>' + escapeHtml(r.client || '—') + '</td>' +
        '<td class="num">' + (r.active ? fmtHMS(r.active) : '—') + '</td>' +
        '<td class="num">' + (r.passive ? fmtHMS(r.passive) : '—') + '</td>' +
        '<td class="num"><b>' + fmtHMS(total) + '</b></td>';
    } else {
      tr.innerHTML =
        '<td>' + escapeHtml(r.name) + '</td>' +
        '<td class="num">' + (r.active ? fmtHMS(r.active) : '—') + '</td>' +
        '<td class="num">' + (r.passive ? fmtHMS(r.passive) : '—') + '</td>' +
        '<td class="num"><b>' + fmtHMS(total) + '</b></td>';
    }
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
    renderReportTable($('#rep-clients'), reportData.clients, 'client');
    renderReportTable($('#rep-tasks'), reportData.tasks, 'task');
    const list = $('#report-entries');
    list.innerHTML = '';
    for (const r of reportData.entries) {
      const li = document.createElement('li');
      li.className = 'entry';
      const typeBadge = r.source === 'call' ? '<span class="entry-tag call">звонок</span> ' : '';
      li.innerHTML =
        '<div class="entry-head"><span><b>' + typeBadge + escapeHtml(r.client || 'Без клиента') + '</b></span><span class="entry-time">' + fmtRange(r.start, r.end) + '</span></div>' +
        '<div class="entry-task">' + escapeHtml(r.task || '') + '</div>' +
        '<div class="report-dur">Выполнение: ' + fmtRounded15(r.dur || 0) + '</div>';
      if (r.note) li.innerHTML += '<div class="muted" style="font-size:13px;margin-top:4px">' + escapeHtml(r.note) + '</div>';
      list.appendChild(li);
    }
  } catch (e) { toast('Ошибка отчёта'); }
}

$('#btn-csv').addEventListener('click', () => {
  if (!reportData) { toast('Сначала загрузите отчёт'); return; }
  let csv = '\uFEFFКлиент;Активное(мин);Ожидание(мин);Итого(мин)\n';
  for (const r of reportData.clients) {
    csv += r.name + ';' + Math.round(r.active / 60000) + ';' + Math.round(r.passive / 60000) + ';' + Math.round((r.active + r.passive) / 60000) + '\n';
  }
  csv += '\nЗадача;Клиент;Активное(мин);Ожидание(мин);Итого(мин)\n';
  for (const r of reportData.tasks) {
    csv += r.name + ';' + (r.client || '—') + ';' + Math.round(r.active / 60000) + ';' + Math.round(r.passive / 60000) + ';' + Math.round((r.active + r.passive) / 60000) + '\n';
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'отчёт-' + reportData.from + '_' + reportData.to + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- инициализация ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

loadCurrent();
loadClients();
setInterval(updateTimers, 1000);