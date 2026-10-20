'use strict';

const path = require('node:path');
const express = require('express');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

// ---------- доступ к БД: PostgreSQL (прод) или SQLite (локально) ----------

let db;
let isPg = false;

if (process.env.DATABASE_URL) {
  // PostgreSQL на проде
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL !== 'false' ? { rejectUnauthorized: false } : false,
  });
  const conv = (sql) => {
    let i = 0;
    return sql.replace(/\?/g, () => '$' + (++i));
  };
  db = {
    init: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS entries (
          id        SERIAL PRIMARY KEY,
          start_ms  BIGINT,
          end_ms    BIGINT,
          client    TEXT NOT NULL DEFAULT '',
          task      TEXT NOT NULL DEFAULT '',
          note      TEXT NOT NULL DEFAULT '',
          due       TEXT NOT NULL DEFAULT '',
          source    TEXT NOT NULL DEFAULT 'self',
          status    TEXT NOT NULL DEFAULT 'new',
          prev_status        TEXT,
          paused_by_call_id  INTEGER,
          done_ms   BIGINT
        );
        CREATE INDEX IF NOT EXISTS idx_entries_start ON entries(start_ms);
      `);
    },
    all: (sql, p = []) => pool.query(conv(sql), p).then((r) => r.rows),
    get: (sql, p = []) => pool.query(conv(sql), p).then((r) => r.rows[0] || null),
    run: (sql, p = []) => pool.query(conv(sql), p).then(() => ({})),
    insert: (sql, p = []) => pool.query(conv(sql) + ' RETURNING id', p).then((r) => Number(r.rows[0].id)),
  };
  isPg = true;
} else {
  // SQLite локально (для разработки)
  const { DatabaseSync } = require('node:sqlite');
  const s = new DatabaseSync(DB_PATH);
  s.exec(`
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
  // миграция существующих таблиц
  function ensureColumn(table, column, ddl) {
    const cols = s.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      s.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }
  ensureColumn('entries', 'prev_status', 'TEXT');
  ensureColumn('entries', 'paused_by_call_id', 'INTEGER');
  ensureColumn('entries', 'note', 'TEXT NOT NULL DEFAULT \'\'');
  ensureColumn('entries', 'due', 'TEXT NOT NULL DEFAULT \'\'');
  ensureColumn('entries', 'done_ms', 'INTEGER');

  db = {
    init: async () => {},
    all: (sql, p = []) => Promise.resolve(s.prepare(sql).all(...p)),
    get: (sql, p = []) => Promise.resolve(s.prepare(sql).get(...p) || null),
    run: (sql, p = []) => {
      s.prepare(sql).run(...p);
      return Promise.resolve({});
    },
    insert: (sql, p = []) => {
      const info = s.prepare(sql).run(...p);
      return Promise.resolve(Number(info.lastInsertRowid));
    },
  };
}

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
async function restorePaused(id) {
  await db.run(
    `UPDATE entries SET status = prev_status, prev_status = NULL, paused_by_call_id = NULL WHERE paused_by_call_id = ?`,
    [id]
  );
}

// ---------- API: записи ----------

// лента «Текущее» — незавершённые звонки и задачи; задачи-дела только в работе/ожидании
app.get('/api/current', async (req, res) => {
  const rows = await db.all(
    `SELECT * FROM entries
     WHERE (source IN ('call','self') AND status IN ('new','active','passive'))
        OR (source = 'todo' AND status IN ('active','passive'))
     ORDER BY start_ms IS NULL, start_ms, id`
  );
  res.json(rows.map(rowToEntry));
});

// записи за день (локальная дата клиента -> диапазон мс)
app.get('/api/entries', async (req, res) => {
  const day = req.query.day; // YYYY-MM-DD
  if (!day) {
    const rows = await db.all(`SELECT * FROM entries ORDER BY start_ms DESC LIMIT 300`);
    return res.json(rows.map(rowToEntry));
  }
  const startOfDay = new Date(day + 'T00:00:00').getTime();
  const endOfDay = startOfDay + 24 * 3600 * 1000;
  const rows = await db.all(
    `SELECT * FROM entries WHERE start_ms >= ? AND start_ms < ? ORDER BY start_ms DESC`,
    [startOfDay, endOfDay]
  );
  res.json(rows.map(rowToEntry));
});

// создать запись: звонок / задача / задача-дело
app.post('/api/entries', async (req, res) => {
  const { client = '', task = '', note = '', due = '', source = 'self', status, start } = req.body;
  const src = String(source);

  let startMs = null;
  let st = status || 'active';

  if (src === 'call') {
    startMs = start != null ? Number(start) : nowMs();
    st = 'active';
  } else if (src === 'todo') {
    st = status || 'new';
    if (st === 'active') startMs = start != null ? Number(start) : nowMs();
  } else {
    startMs = start != null ? Number(start) : nowMs();
    st = 'active';
  }

  const id = await db.insert(
    `INSERT INTO entries (start_ms, client, task, note, due, source, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [startMs, String(client), String(task), String(note), String(due), src, st]
  );

  // звонок переводит активные записи в ожидание
  if (src === 'call') {
    await db.run(
      `UPDATE entries SET status = 'passive', prev_status = 'active', paused_by_call_id = ? WHERE status = 'active' AND id <> ?`,
      [id, id]
    );
  }

  const r = await db.get(`SELECT * FROM entries WHERE id = ?`, [id]);
  res.status(201).json(rowToEntry(r));
});

// начать задачу-дело (new -> active)
app.post('/api/entries/:id/start', async (req, res) => {
  const id = Number(req.params.id);
  const startMs = req.body.start != null ? Number(req.body.start) : nowMs();
  await db.run(`UPDATE entries SET start_ms = ?, status = 'active' WHERE id = ?`, [startMs, id]);
  const r = await db.get(`SELECT * FROM entries WHERE id = ?`, [id]);
  res.json(rowToEntry(r));
});

// завершить запись (стоп) — возврат статусов после звонка
app.post('/api/entries/:id/close', async (req, res) => {
  const id = Number(req.params.id);
  const endMs = req.body.end != null ? Number(req.body.end) : nowMs();
  const cur = await db.get(`SELECT * FROM entries WHERE id = ?`, [id]);
  if (!cur) return res.status(404).json({ error: 'not found' });

  await db.run(`UPDATE entries SET end_ms = ?, status = 'done', done_ms = ? WHERE id = ?`, [endMs, nowMs(), id]);

  // если завершаем звонок — вернуть прежние статусы
  if (cur.source === 'call') {
    await restorePaused(id);
  }

  const r = await db.get(`SELECT * FROM entries WHERE id = ?`, [id]);
  res.json(rowToEntry(r));
});

// обновить запись
app.patch('/api/entries/:id', async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.get(`SELECT * FROM entries WHERE id = ?`, [id]);
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
    await db.run(`UPDATE entries SET ${set.join(', ')} WHERE id = ?`, vals);
  }
  const r = await db.get(`SELECT * FROM entries WHERE id = ?`, [id]);
  res.json(rowToEntry(r));
});

// удалить запись
app.delete('/api/entries/:id', async (req, res) => {
  await db.run(`DELETE FROM entries WHERE id = ?`, [Number(req.params.id)]);
  res.json({ ok: true });
});

// ---------- API: клиенты (для выбора при звонке/задаче) ----------

app.get('/api/clients', async (req, res) => {
  const rows = await db.all(
    `SELECT client, MAX(COALESCE(start_ms, 0)) last FROM entries
     WHERE client <> '' GROUP BY client ORDER BY last DESC, client`
  );
  res.json(rows.map((r) => r.client));
});

app.get('/api/tasks', async (req, res) => {
  const client = req.query.client || '';
  const rows = await db.all(
    `SELECT task, COUNT(*) c FROM entries
     WHERE task <> '' AND (? = '' OR client = ?)
     GROUP BY task ORDER BY c DESC, task`,
    [client, client]
  );
  res.json(rows.map((r) => r.task));
});

// ---------- API: раздел «Задачи» (все задачи: обычные и дела) ----------

app.get('/api/todos', async (req, res) => {
  const rows = await db.all(
    `SELECT * FROM entries WHERE source IN ('self','todo') ORDER BY done_ms IS NOT NULL, due, id`
  );
  res.json(rows.map(rowToEntry));
});

// ---------- API: отчёт ----------

app.get('/api/report', async (req, res) => {
  const { from, to } = req.query; // YYYY-MM-DD
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const fromMs = new Date(from + 'T00:00:00').getTime();
  const toMs = new Date(to + 'T23:59:59.999').getTime();
  const refMs = nowMs();

  // только начатые записи (со временем)
  const rows = await db.all(
    `SELECT * FROM entries
     WHERE start_ms IS NOT NULL AND start_ms < ? AND (end_ms IS NULL OR end_ms > ?)
     ORDER BY start_ms`,
    [toMs, fromMs]
  );

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

app.get('/api/health', async (req, res) => {
  let dbInfo = 'none';
  try {
    if (isPg) {
      const r = await db.all(`SELECT COUNT(*)::int AS n FROM entries`);
      dbInfo = 'pg:' + r[0].n;
    } else {
      const r = await db.all(`SELECT COUNT(*) AS n FROM entries`);
      dbInfo = 'sqlite:' + r[0].n;
    }
  } catch (e) {
    dbInfo = 'error:' + e.message;
  }
  res.json({ ok: true, db: dbInfo });
});

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Сервис учёта времени запущен на порту ${PORT} (БД: ${isPg ? 'PostgreSQL' : 'SQLite'})`);
  });
}).catch((e) => {
  console.error('Ошибка инициализации БД:', e);
  process.exit(1);
});