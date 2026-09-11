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
    start_ms  INTEGER NOT NULL,
    end_ms    INTEGER,
    client    TEXT NOT NULL DEFAULT '',
    task      TEXT NOT NULL DEFAULT '',
    source    TEXT NOT NULL DEFAULT 'self',
    status    TEXT NOT NULL DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS templates (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL,
    client  TEXT NOT NULL DEFAULT '',
    task    TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_entries_start ON entries(start_ms);
`);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

function nowMs() {
  return Date.now();
}

function closeActive(untilMs) {
  // авто-закрытие: закрываем активную (не пассивную) запись
  const stmt = db.prepare(
    `UPDATE entries SET end_ms = ? WHERE status = 'active' AND end_ms IS NULL`
  );
  stmt.run(untilMs);
}

function rowToEntry(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    start: r.start_ms,
    end: r.end_ms,
    client: r.client,
    task: r.task,
    source: r.source,
    status: r.status,
  };
}

// ---------- API: записи ----------

// активная запись (для главного экрана)
app.get('/api/active', (req, res) => {
  const r = db.prepare(`SELECT * FROM entries WHERE end_ms IS NULL ORDER BY id DESC LIMIT 1`).get();
  res.json(rowToEntry(r));
});

// записи за день (локальная дата клиента -> диапазон мс)
app.get('/api/entries', (req, res) => {
  const day = req.query.day; // YYYY-MM-DD
  if (!day) {
    const rows = db.prepare(`SELECT * FROM entries ORDER BY start_ms DESC LIMIT 200`).all();
    return res.json(rows.map(rowToEntry));
  }
  const startOfDay = new Date(day + 'T00:00:00').getTime();
  const endOfDay = startOfDay + 24 * 3600 * 1000;
  const rows = db
    .prepare(`SELECT * FROM entries WHERE start_ms >= ? AND start_ms < ? ORDER BY start_ms DESC`)
    .all(startOfDay, endOfDay);
  res.json(rows.map(rowToEntry));
});

// создать запись
app.post('/api/entries', (req, res) => {
  const { client = '', task = '', source = 'self', status = 'active', start } = req.body;
  const startMs = start != null ? Number(start) : nowMs();

  // авто-закрытие предыдущей активной записи
  closeActive(startMs);

  const info = db
    .prepare(`INSERT INTO entries (start_ms, client, task, source, status) VALUES (?, ?, ?, ?, ?)`)
    .run(startMs, String(client), String(task), String(source), String(status));

  const r = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(Number(info.lastInsertRowid));
  res.status(201).json(rowToEntry(r));
});

// закрыть запись (стоп) — если end не указан, ставим now
app.post('/api/entries/:id/close', (req, res) => {
  const id = Number(req.params.id);
  const endMs = req.body.end != null ? Number(req.body.end) : nowMs();
  db.prepare(`UPDATE entries SET end_ms = ?, status = 'done' WHERE id = ? AND end_ms IS NULL`).run(endMs, id);
  const r = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id);
  res.json(rowToEntry(r));
});

// обновить запись (клиент/задача/статус активна/пассивна)
app.patch('/api/entries/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });

  const fields = ['client', 'task', 'source', 'status', 'start_ms', 'end_ms'];
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

// ---------- API: автодополнение ----------

app.get('/api/clients', (req, res) => {
  const rows = db.prepare(`SELECT client, COUNT(*) c FROM entries WHERE client <> '' GROUP BY client ORDER BY c DESC, client`).all();
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

// ---------- API: шаблоны ----------

app.get('/api/templates', (req, res) => {
  const rows = db.prepare(`SELECT * FROM templates ORDER BY name`).all();
  res.json(rows.map((r) => ({ id: Number(r.id), name: r.name, client: r.client, task: r.task })));
});

app.post('/api/templates', (req, res) => {
  const { name = '', client = '', task = '' } = req.body;
  const info = db
    .prepare(`INSERT INTO templates (name, client, task) VALUES (?, ?, ?)`)
    .run(String(name), String(client), String(task));
  const r = db.prepare(`SELECT * FROM templates WHERE id = ?`).get(Number(info.lastInsertRowid));
  res.status(201).json({ id: Number(r.id), name: r.name, client: r.client, task: r.task });
});

app.delete('/api/templates/:id', (req, res) => {
  db.prepare(`DELETE FROM templates WHERE id = ?`).run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- API: отчёт ----------

// длительность записи в мс (конец или now)
function durationMs(r, refMs) {
  const end = r.end_ms != null ? r.end_ms : refMs;
  return Math.max(0, end - r.start_ms);
}

app.get('/api/report', (req, res) => {
  const { from, to } = req.query; // YYYY-MM-DD
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const fromMs = new Date(from + 'T00:00:00').getTime();
  const toMs = new Date(to + 'T23:59:59.999').getTime();
  const refMs = nowMs();

  const rows = db
    .prepare(`SELECT * FROM entries WHERE start_ms < ? AND (end_ms IS NULL OR end_ms > ?) ORDER BY start_ms`)
    .all(toMs, fromMs);

  // для каждой записи берём пересечение с периодом
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

    const tk = (r.task ? r.task : '(без задачи)');
    if (!byTask[tk]) byTask[tk] = { active: 0, passive: 0, count: 0 };
    byTask[tk].count++;
    if (r.status === 'passive') byTask[tk].passive += r.dur;
    else byTask[tk].active += r.dur;
  }

  const toList = (map) =>
    Object.entries(map)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => (b.active + b.passive) - (a.active + a.passive));

  res.json({
    from,
    to,
    clients: toList(byClient),
    tasks: toList(byTask),
    entries: intersected.map(rowToEntry),
  });
});

// ---------- health ----------

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Сервис учёта времени запущен на порту ${PORT}`);
});