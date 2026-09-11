'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS entries (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    start_ms  INTEGER,
    end_ms    INTEGER,
    client    TEXT NOT NULL DEFAULT '',
    task      TEXT NOT NULL DEFAULT '',
    note      TEXT NOT NULL DEFAULT '',
    due       TEXT NOT NULL DEFAULT '',
    source    TEXT NOT NULL DEFAULT 'self',
    status    TEXT NOT NULL DEFAULT 'new',
    prev_status        TEXT,
    paused_by_call_id  INTEGER,
    done_ms   INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_entries_start ON entries(start_ms);
`);

// миграция существующих таблиц (добавляем колонки, если их нет)
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
ensureColumn('entries', 'prev_status', 'TEXT');
ensureColumn('entries', 'paused_by_call_id', 'INTEGER');
ensureColumn('entries', 'note', 'TEXT NOT NULL DEFAULT \'\'');
ensureColumn('entries', 'due', 'TEXT NOT NULL DEFAULT \'\'');
ensureColumn('entries', 'done_ms', 'INTEGER');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

function nowMs() {
  return Date.now();
}

function rowToEntry(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    start: r.start_ms,
    end: r.end_ms,
    client: r.client,
    task: r.task,
    note: r.note,
    due: r.due,
    source: r.source,
    status: r.status,
    doneMs: r.done_ms,
  };
}

// завершить звонок: вернуть прежние статусы приостановленным из-за него записям
function restorePaused(id) {
  db.prepare(
    `UPDATE entries
       SET status = prev_status, prev_status = NULL, paused_by_call_id = NULL
     WHERE paused_by_call_id = ?`
  ).run(id);
}

// ---------- API: записи ----------

// лента «Текущее» — незавершённые звонки и задачи (не задачи-дела)
app.get('/api/current', (req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM entries
       WHERE source != 'todo' AND status IN ('new','active','passive')
       ORDER BY start_ms IS NULL, start_ms, id`
    )
    .all();
  res.json(rows.map(rowToEntry));
});

// записи за день (локальная дата клиента -> диапазон мс)
app.get('/api/entries', (req, res) => {
  const day = req.query.day; // YYYY-MM-DD
  if (!day) {
    const rows = db.prepare(`SELECT * FROM entries ORDER BY start_ms DESC LIMIT 300`).all();
    return res.json(rows.map(rowToEntry));
  }
  const startOfDay = new Date(day + 'T00:00:00').getTime();
  const endOfDay = startOfDay + 24 * 3600 * 1000;
  const rows = db
    .prepare(`SELECT * FROM entries WHERE start_ms >= ? AND start_ms < ? ORDER BY start_ms DESC`)
    .all(startOfDay, endOfDay);
  res.json(rows.map(rowToEntry));
});

// создать запись: звонок / задача / задача-дело
app.post('/api/entries', (req, res) => {
  const { client = '', task = '', note = '', due = '', source = 'self', status, start } = req.body;
  const src = String(source);

  let startMs = null;
  let st = status || 'active';

  if (src === 'call') {
    // звонок стартует сразу
    startMs = start != null ? Number(start) : nowMs();
    st = 'active';
  } else if (src === 'todo') {
    // задача-дело: по умолчанию новая (без таймера)
    st = status || 'new';
    if (st === 'active') startMs = start != null ? Number(start) : nowMs();
  } else {
    // обычная задача стартует сразу
    startMs = start != null ? Number(start) : nowMs();
    st = 'active';
  }

  const info = db
    .prepare(
      `INSERT INTO entries (start_ms, client, task, note, due, source, status) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(startMs, String(client), String(task), String(note), String(due), src, st);

  const id = Number(info.lastInsertRowid);

  // звонок переводит активные записи в ожидание
  if (src === 'call') {
    db.prepare(
      `UPDATE entries SET status = 'passive', prev_status = 'active', paused_by_call_id = ? WHERE status = 'active' AND id <> ?`
    ).run(id, id);
  }

  const r = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id);
  res.status(201).json(rowToEntry(r));
});

// начать задачу-дело (new -> active)
app.post('/api/entries/:id/start', (req, res) => {
  const id = Number(req.params.id);
  const startMs = req.body.start != null ? Number(req.body.start) : nowMs();
  db.prepare(`UPDATE entries SET start_ms = ?, status = 'active' WHERE id = ?`).run(startMs, id);
  const r = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id);
  res.json(rowToEntry(r));
});

// завершить запись (стоп) — возврат статусов после звонка
app.post('/api/entries/:id/close', (req, res) => {
  const id = Number(req.params.id);
  const endMs = req.body.end != null ? Number(req.body.end) : nowMs();
  const cur = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });

  db.prepare(`UPDATE entries SET end_ms = ?, status = 'done', done_ms = ? WHERE id = ?`).run(endMs, nowMs(), id);

  // если завершаем звонок — вернуть прежние статусы
  if (cur.source === 'call') {
    restorePaused(id);
  }

  const r = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id);
  res.json(rowToEntry(r));
});

// обновить запись
app.patch('/api/entries/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });

  const fields = ['client', 'task', 'note', 'due', 'source', 'status', 'start_ms', 'end_ms', 'done_ms'];
  const set = [];
  const vals = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      set.push(`${f} = ?`);
      vals.push(req.body[f]);
    }
  }
  if (set.length) {
    vals.push(id);
    db.prepare(`UPDATE entries SET ${set.join(', ')} WHERE id = ?`).run(...vals);
  }
  const r = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id);
  res.json(rowToEntry(r));
});

// удалить запись
app.delete('/api/entries/:id', (req, res) => {
  db.prepare(`DELETE FROM entries WHERE id = ?`).run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- API: клиенты (для выбора при звонке/задаче) ----------

app.get('/api/clients', (req, res) => {
  const rows = db
    .prepare(
      `SELECT client, MAX(COALESCE(start_ms, 0)) last FROM entries
       WHERE client <> '' GROUP BY client ORDER BY last DESC, client`
    )
    .all();
  res.json(rows.map((r) => r.client));
});

app.get('/api/tasks', (req, res) => {
  const client = req.query.client || '';
  const rows = db
    .prepare(
      `SELECT task, COUNT(*) c FROM entries
       WHERE task <> '' AND (? = '' OR client = ?)
       GROUP BY task ORDER BY c DESC, task`
    )
    .all(client, client);
  res.json(rows.map((r) => r.task));
});

// ---------- API: задачи-дела (раздел «Задачи») ----------

app.get('/api/todos', (req, res) => {
  const rows = db.prepare(`SELECT * FROM entries WHERE source = 'todo' ORDER BY done_ms IS NOT NULL, due, id`).all();
  res.json(rows.map(rowToEntry));
});

// ---------- API: отчёт ----------

app.get('/api/report', (req, res) => {
  const { from, to } = req.query; // YYYY-MM-DD
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const fromMs = new Date(from + 'T00:00:00').getTime();
  const toMs = new Date(to + 'T23:59:59.999').getTime();
  const refMs = nowMs();

  // только начатые записи (со временем)
  const rows = db
    .prepare(
      `SELECT * FROM entries
       WHERE start_ms IS NOT NULL AND start_ms < ? AND (end_ms IS NULL OR end_ms > ?)
       ORDER BY start_ms`
    )
    .all(toMs, fromMs);

  const intersected = rows.map((r) => {
    const s = Math.max(r.start_ms, fromMs);
    const e = r.end_ms != null ? Math.min(r.end_ms, toMs) : Math.min(refMs, toMs);
    return { ...r, start_ms: s, end_ms: e, dur: Math.max(0, e - s) };
  });

  const byClient = {};
  const byTask = {};

  for (const r of intersected) {
    if (!r.client && !r.task) continue;
    const key = r.client || '(без клиента)';
    if (!byClient[key]) byClient[key] = { active: 0, passive: 0, count: 0 };
    byClient[key].count++;
    if (r.status === 'passive') byClient[key].passive += r.dur;
    else byClient[key].active += r.dur;

    const tk = r.task || '(без задачи)';
    const tkKey = tk + '||' + (r.client || '');
    if (!byTask[tkKey]) byTask[tkKey] = { name: tk, client: r.client || '', active: 0, passive: 0, count: 0 };
    byTask[tkKey].count++;
    if (r.status === 'passive') byTask[tkKey].passive += r.dur;
    else byTask[tkKey].active += r.dur;
  }

  const toList = (map) =>
    Object.entries(map)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.active + b.passive - (a.active + a.passive));

  res.json({
    from,
    to,
    clients: toList(byClient),
    tasks: toList(byTask),
    entries: intersected.map((r) => ({ ...rowToEntry(r), dur: r.dur })),
  });
});

// ---------- health ----------

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Сервис учёта времени запущен на порту ${PORT}`);
});