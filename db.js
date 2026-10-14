const Database = require('better-sqlite3');
const crypto = require('crypto');
const db = new Database('/var/www/kanban/data.db');

// WAL — быстрее параллельные чтение/запись
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort INTEGER DEFAULT 0,
    type TEXT DEFAULT 'kanban'
  );
  CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort INTEGER DEFAULT 0,
    board_id INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL,
    horizon TEXT NOT NULL,
    title TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS kulebin (
    person_id INTEGER PRIMARY KEY,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS board_access (
    user_id INTEGER NOT NULL,
    board_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, board_id)
  );
`);

// ---- миграции plans ----
const planCols = db.prepare("PRAGMA table_info(plans)").all().map(c => c.name);
if (!planCols.includes('due_date'))     db.exec("ALTER TABLE plans ADD COLUMN due_date TEXT");
if (!planCols.includes('priority'))     db.exec("ALTER TABLE plans ADD COLUMN priority INTEGER DEFAULT 1");
if (!planCols.includes('completed_at')) db.exec("ALTER TABLE plans ADD COLUMN completed_at DATETIME");
if (!planCols.includes('board_id'))     db.exec("ALTER TABLE plans ADD COLUMN board_id INTEGER DEFAULT 1");

// ---- миграции people ----
const peopleCols = db.prepare("PRAGMA table_info(people)").all().map(c => c.name);
if (!peopleCols.includes('board_id')) db.exec("ALTER TABLE people ADD COLUMN board_id INTEGER DEFAULT 1");
if (!peopleCols.includes('note'))     db.exec("ALTER TABLE people ADD COLUMN note TEXT DEFAULT ''");
if (!peopleCols.includes('avatar'))   db.exec("ALTER TABLE people ADD COLUMN avatar TEXT DEFAULT ''");

// ---- миграции boards ----
const boardCols = db.prepare("PRAGMA table_info(boards)").all().map(c => c.name);
if (!boardCols.includes('type'))          db.exec("ALTER TABLE boards ADD COLUMN type TEXT DEFAULT 'kanban'");
if (!boardCols.includes('column_config')) db.exec("ALTER TABLE boards ADD COLUMN column_config TEXT");

// ---- миграция kulebin ----
const kulebinCols = db.prepare("PRAGMA table_info(kulebin)").all().map(c => c.name);

if (!kulebinCols.includes('values_json')) {
  db.exec("ALTER TABLE kulebin ADD COLUMN values_json TEXT");
  console.log('migration: added kulebin.values_json');
}

const hasOldKulebin = kulebinCols.includes('plan_paid');
if (hasOldKulebin) {
  const need = db.prepare(
    "SELECT COUNT(*) AS c FROM kulebin WHERE values_json IS NULL OR values_json = '' OR values_json = '{}'"
  ).get().c;

  if (need > 0) {
    const rows = db.prepare('SELECT * FROM kulebin').all();
    rows.forEach(r => {
      if (r.values_json && r.values_json !== '{}') return;
      const values = {
        c1: r.plan_paid || '',
        c2: r.plan_skud || '',
        c3: r.plan_services || '',
        c4: r.efficiency || 0,
      };
      db.prepare('UPDATE kulebin SET values_json = ? WHERE person_id = ?')
        .run(JSON.stringify(values), r.person_id);
    });
    console.log('migration: kulebin old data → values_json');
  }
}

// дефолтные столбцы
const DEFAULT_COLS = [
  { key: 'c1', label: 'План платных работ', kind: 'text' },
  { key: 'c2', label: 'План продажи СКУД',  kind: 'text' },
  { key: 'c3', label: 'План продажи услуг', kind: 'text' },
  { key: 'c4', label: 'Эффективность',      kind: 'efficiency' },
];

const boardCount = db.prepare('SELECT COUNT(*) AS c FROM boards').get().c;
if (boardCount === 0) {
  db.prepare("INSERT INTO boards (name, sort, type, column_config) VALUES (?, ?, ?, ?)")
    .run('Основная', 1, 'kanban', null);
  db.prepare("INSERT INTO boards (name, sort, type, column_config) VALUES (?, ?, ?, ?)")
    .run('гр.Кулибин', 2, 'kulebin', JSON.stringify(DEFAULT_COLS));
  console.log('migration: created default boards');
}

db.prepare("SELECT id, type, column_config FROM boards").all().forEach(b => {
  if (b.type === 'kulebin' && !b.column_config) {
    db.prepare('UPDATE boards SET column_config = ? WHERE id = ?')
      .run(JSON.stringify(DEFAULT_COLS), b.id);
    console.log('migration: set default columns for board', b.id);
  }
});

const intervalRow = db.prepare("SELECT value FROM settings WHERE key = 'rotate_interval'").get();
if (!intervalRow) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('rotate_interval', '30');
  console.log('migration: set default rotate_interval = 30');
}

const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  const token = crypto.randomBytes(8).toString('hex');
  db.prepare("INSERT INTO users (name, token, role) VALUES (?, ?, ?)").run('Администратор', token, 'admin');
  console.log('========================================================');
  console.log('Создан первый администратор:');
  console.log('  Имя:     Администратор');
  console.log('  Токен:   ' + token);
  console.log('  Войти:   https://31.130.128.105.nip.io/login?token=' + token);
  console.log('========================================================');
}

// ---- Индексы для скорости ----
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_plans_board        ON plans(board_id);
  CREATE INDEX IF NOT EXISTS idx_plans_person       ON plans(person_id);
  CREATE INDEX IF NOT EXISTS idx_plans_horizon      ON plans(horizon);
  CREATE INDEX IF NOT EXISTS idx_people_board       ON people(board_id);
  CREATE INDEX IF NOT EXISTS idx_board_access_user  ON board_access(user_id);
  CREATE INDEX IF NOT EXISTS idx_board_access_board ON board_access(board_id);
`);

module.exports = db;
