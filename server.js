const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const PORT = 8989;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ============ COOKIE HELPERS ============
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i < 0) return;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax`);
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}
function generateToken() {
  return crypto.randomBytes(8).toString('hex');
}

// ============ AUTH MIDDLEWARE ============
// Кэш последнего обновления last_seen_at: userId → timestamp (ms).
// Обновляем не чаще LAST_SEEN_DEBOUNCE_MS на юзера — снижает нагрузку на WAL.
const LAST_SEEN_DEBOUNCE_MS = 60 * 1000;
const _lastSeenCache = new Map();

function touchLastSeen(userId) {
  const now = Date.now();
  const last = _lastSeenCache.get(userId) || 0;
  if (now - last < LAST_SEEN_DEBOUNCE_MS) return;
  _lastSeenCache.set(userId, now);
  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(userId);
}

function getUserFromReq(req) {
  let token = parseCookies(req.headers.cookie || '').auth_token;
  if (!token && req.query.token) token = String(req.query.token);
  if (!token) return null;
  const user = db.prepare('SELECT * FROM users WHERE token = ?').get(token);
  if (!user) return null;
  touchLastSeen(user.id);
  return user;
}

function userBoardAccess(user) {
  if (!user) return [];
  if (user.role === 'admin') {
    return db.prepare('SELECT id FROM boards').all().map(r => r.id);
  }
  return db.prepare('SELECT board_id FROM board_access WHERE user_id = ?').all(user.id).map(r => r.board_id);
}

function requireAuth(req, res, next) {
  const user = getUserFromReq(req);
  if (!user) {
    if (req.path.startsWith('/api')) return res.status(401).json({ error: 'unauthorized' });
    return res.redirect('/login');
  }
  if (req.query.token) {
    setCookie(res, 'auth_token', user.token, 365 * 24 * 60 * 60);
  }
  req.user = user;
  req.boardAccess = userBoardAccess(user);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Только для администраторов' });
  }
  next();
}

function checkBoardAccess(req, boardId) {
  return req.boardAccess.includes(parseInt(boardId));
}

// ============ LOGIN ============
const loginPageHTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Вход — План работ</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,'Segoe UI',Roboto,sans-serif; background:#f1f5f9; color:#1e293b; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
  .card { background:#fff; border-radius:16px; padding:36px 32px; max-width:420px; width:100%; box-shadow:0 10px 40px rgba(15,23,42,.1); }
  h1 { font-size:22px; font-weight:700; color:#475569; margin-bottom:8px; letter-spacing:1.5px; text-align:center; }
  .subtitle { font-size:13px; color:#94a3b8; text-align:center; margin-bottom:24px; }
  label { display:block; font-size:12px; color:#64748b; margin-bottom:6px; }
  input { width:100%; padding:12px 14px; font:inherit; font-size:15px; border:1px solid #cbd5e1; border-radius:10px; background:#f8fafc; outline:none; color:#1e293b; }
  input:focus { border-color:#2563eb; background:#fff; }
  button { width:100%; margin-top:18px; padding:12px; font:inherit; font-size:15px; font-weight:600; border:none; border-radius:10px; background:#2563eb; color:#fff; cursor:pointer; }
  button:hover { background:#1d4ed8; }
  .error { background:#fee2e2; color:#b91c1c; padding:10px; border-radius:8px; font-size:13px; margin-bottom:14px; text-align:center; }
  .info { font-size:12px; color:#94a3b8; margin-top:18px; text-align:center; line-height:1.5; }
</style>
</head>
<body>
<div class="card">
  <h1>План работ</h1>
  <div class="subtitle">Вход в админку</div>
  <%ERROR%>
  <form method="POST" action="/login">
    <label>Персональный код доступа</label>
    <input type="text" name="token" placeholder="Например: a7f3k9x2bcde01f" autofocus required>
    <button type="submit">Войти</button>
  </form>
  <div class="info">Код доступа выдаёт администратор.<br>Если вы его забыли — попросите новый.</div>
</div>
</body>
</html>`;

app.get('/login', (req, res) => {
  if (req.query.token) {
    const user = db.prepare('SELECT * FROM users WHERE token = ?').get(String(req.query.token));
    if (user) {
      setCookie(res, 'auth_token', user.token, 365 * 24 * 60 * 60);
      touchLastSeen(user.id);
      return res.redirect('/admin');
    }
  }
  const errorHtml = req.query.error ? '<div class="error">Неверный код доступа</div>' : '';
  res.send(loginPageHTML.replace('<%ERROR%>', errorHtml));
});

app.post('/login', (req, res) => {
  const token = String(req.body.token || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE token = ?').get(token);
  if (!user) return res.redirect('/login?error=1');
  setCookie(res, 'auth_token', user.token, 365 * 24 * 60 * 60);
  touchLastSeen(user.id);
  res.redirect('/admin');
});

app.get('/logout', (req, res) => {
  clearCookie(res, 'auth_token');
  res.redirect('/login');
});

// ============ AUTH-GUARDED ROUTES ============
app.use(['/admin', '/admin.html', '/report', '/report.html'], requireAuth);
app.use('/api', requireAuth);

// ============ STATE ============
function parseBoards() {
  return db.prepare('SELECT * FROM boards ORDER BY sort, id').all().map(b => {
    let cols = null;
    try { cols = b.column_config ? JSON.parse(b.column_config) : null; } catch (e) {}
    return { id: b.id, name: b.name, sort: b.sort, type: b.type, columns: cols };
  });
}

function getBoardState() {
  const boards = parseBoards();
  const people = db.prepare('SELECT * FROM people ORDER BY sort, id').all();
  const plans  = db.prepare('SELECT * FROM plans ORDER BY horizon, position, id').all();
  const kulebin = db.prepare('SELECT * FROM kulebin').all().map(k => {
    let values = {};
    try { values = k.values_json ? JSON.parse(k.values_json) : {}; } catch (e) {}
    return { person_id: k.person_id, values, updated_at: k.updated_at };
  });
  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(r => settings[r.key] = r.value);
  return { boards, people, plans, kulebin, settings };
}

function filterForUser(state, user, boardAccess) {
  if (!user || user.role === 'admin') return state;
  const allowed = new Set(boardAccess || []);
  const peopleFiltered = state.people.filter(p => allowed.has(p.board_id));
  const peopleIds = new Set(peopleFiltered.map(p => p.id));
  return {
    boards: state.boards.filter(b => allowed.has(b.id)),
    people: peopleFiltered,
    plans: state.plans.filter(p => allowed.has(p.board_id)),
    kulebin: state.kulebin.filter(k => peopleIds.has(k.person_id)),
    settings: state.settings,
  };
}

function broadcast(actorName) {
  const all = getBoardState();
  io.sockets.sockets.forEach(socket => {
    // Пересчитываем актуального юзера и его boardAccess —
    // чтобы смена роли/доступа подхватилась на живом сокете без перелогина.
    let user = null;
    if (socket.user && socket.user.id) {
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(socket.user.id) || null;
    }
    socket.user = user;
    socket.boardAccess = user ? userBoardAccess(user) : [];

    if (actorName) {
      socket.emit('board:actor', { name: actorName, at: Date.now() });
    }
    socket.emit('board:update', filterForUser(all, socket.user, socket.boardAccess));
  });
}

// ============ РЕДИРЕКТ КОРНЯ НА /tv ============
app.get('/', (req, res) => res.redirect(302, '/tv'));

// ============ STATIC ============
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ============ ME ============
app.get('/api/me', (req, res) => {
  res.json({
    id: req.user.id,
    name: req.user.name,
    role: req.user.role,
    board_access: req.boardAccess,
  });
});

// ============ USERS ============
app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, name, token, role, created_at, last_seen_at FROM users ORDER BY id').all();
  const access = db.prepare('SELECT user_id, board_id FROM board_access').all();
  res.json(users.map(u => ({
    ...u,
    boards: u.role === 'admin' ? 'all' : access.filter(a => a.user_id === u.id).map(a => a.board_id),
  })));
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { name, role } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const r = role === 'admin' ? 'admin' : 'user';
  const token = generateToken();
  const info = db.prepare('INSERT INTO users (name, token, role) VALUES (?, ?, ?)').run(name, token, r);
  // broadcast не нужен: список юзеров тянется через GET /api/users, а доски не изменились.
  res.json({ id: info.lastInsertRowid, name, token, role: r });
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const { name, role } = req.body;
  const fields = [];
  const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (role !== undefined) { fields.push('role = ?'); params.push(role === 'admin' ? 'admin' : 'user'); }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  // broadcast — чтобы у самого юзера (если меняли роль) обновился список досок на живом сокете.
  broadcast(req.user.name);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить себя' });
  db.prepare('DELETE FROM board_access WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  _lastSeenCache.delete(id);
  // broadcast не нужен: доски не изменились, а удалённого юзера сокет всё равно отвалится.
  res.json({ ok: true });
});

app.post('/api/users/:id/regenerate-token', requireAdmin, (req, res) => {
  const token = generateToken();
  db.prepare('UPDATE users SET token = ? WHERE id = ?').run(token, req.params.id);
  // broadcast не нужен: state досок не меняется.
  res.json({ ok: true, token });
});

app.put('/api/users/:id/boards', requireAdmin, (req, res) => {
  const { board_ids } = req.body;
  if (!Array.isArray(board_ids)) return res.status(400).json({ error: 'board_ids must be array' });
  db.prepare('DELETE FROM board_access WHERE user_id = ?').run(req.params.id);
  const stmt = db.prepare('INSERT OR IGNORE INTO board_access (user_id, board_id) VALUES (?, ?)');
  board_ids.forEach(bid => stmt.run(req.params.id, parseInt(bid)));
  // broadcast — юзеру надо сразу увидеть/потерять доски.
  broadcast(req.user.name);
  res.json({ ok: true });
});

// ============ BOARDS ============
app.get('/api/boards', (req, res) => {
  const all = parseBoards();
  const filtered = req.user.role === 'admin' ? all : all.filter(b => req.boardAccess.includes(b.id));
  res.json(filtered);
});

app.post('/api/boards', requireAdmin, (req, res) => {
  const { name, type } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM boards').get().m;
  const t = (type === 'kulebin') ? 'kulebin' : 'kanban';
  const defaultCols = t === 'kulebin' ? JSON.stringify([
    { key: 'c1', label: 'План 1', kind: 'text' },
    { key: 'c2', label: 'План 2', kind: 'text' },
    { key: 'c3', label: 'План 3', kind: 'text' },
    { key: 'c4', label: 'Эффективность', kind: 'efficiency' },
  ]) : null;
  const info = db.prepare('INSERT INTO boards (name, sort, type, column_config) VALUES (?, ?, ?, ?)')
    .run(name, maxSort + 1, t, defaultCols);
  broadcast(req.user.name);
  res.json({ id: info.lastInsertRowid, name, type: t });
});

app.put('/api/boards/:id', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  db.prepare('UPDATE boards SET name = ? WHERE id = ?').run(name, req.params.id);
  broadcast(req.user.name);
  res.json({ ok: true });
});

app.put('/api/boards/:id/columns', (req, res) => {
  if (!checkBoardAccess(req, req.params.id)) return res.status(403).json({ error: 'forbidden' });
  const { columns } = req.body;
  if (!Array.isArray(columns)) return res.status(400).json({ error: 'columns must be array' });
  const clean = columns.map((c, i) => {
    const kind = ['text', 'efficiency', 'amount', 'attendance'].includes(c.kind) ? c.kind : 'text';
    const base = {
      key: String(c.key || 'c' + (i + 1)),
      label: String(c.label || 'Столбец ' + (i + 1)),
      kind,
    };
    if (kind === 'amount') {
      base.plan = parseFloat(c.plan) || 0;
      base.unit = String(c.unit || '₽');
    }
    return base;
  });
  db.prepare('UPDATE boards SET column_config = ? WHERE id = ?')
    .run(JSON.stringify(clean), req.params.id);
  broadcast(req.user.name);
  res.json({ ok: true, columns: clean });
});

app.delete('/api/boards/:id', requireAdmin, (req, res) => {
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM boards').get().c;
  if (cnt <= 1) return res.status(400).json({ error: 'Нельзя удалить последнюю доску' });
  const id = parseInt(req.params.id);
  const peopleIds = db.prepare('SELECT id FROM people WHERE board_id = ?').all(id).map(p => p.id);
  peopleIds.forEach(pid => {
    db.prepare('DELETE FROM kulebin WHERE person_id = ?').run(pid);
    db.prepare('DELETE FROM plans WHERE person_id = ?').run(pid);
  });
  db.prepare('DELETE FROM people WHERE board_id = ?').run(id);
  db.prepare('DELETE FROM board_access WHERE board_id = ?').run(id);
  db.prepare('DELETE FROM boards WHERE id = ?').run(id);
  broadcast(req.user.name);
  res.json({ ok: true });
});

// ============ PEOPLE ============
app.get('/api/people', (req, res) => {
  const boardId = parseInt(req.query.board_id) || 1;
  if (!checkBoardAccess(req, boardId)) return res.status(403).json({ error: 'forbidden' });
  res.json(db.prepare('SELECT * FROM people WHERE board_id = ? ORDER BY sort, id').all(boardId));
});

app.post('/api/people', (req, res) => {
  const { name, board_id, note, avatar } = req.body;
  const boardId = parseInt(board_id) || 1;
  if (!checkBoardAccess(req, boardId)) return res.status(403).json({ error: 'forbidden' });
  if (!name) return res.status(400).json({ error: 'name required' });
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM people WHERE board_id = ?').get(boardId).m;
  const info = db.prepare('INSERT INTO people (name, sort, board_id, note, avatar) VALUES (?, ?, ?, ?, ?)')
    .run(name, maxSort + 1, boardId, String(note || ''), String(avatar || ''));
  const board = db.prepare('SELECT type FROM boards WHERE id = ?').get(boardId);
  if (board && board.type === 'kulebin') {
    db.prepare('INSERT OR IGNORE INTO kulebin (person_id, values_json) VALUES (?, ?)')
      .run(info.lastInsertRowid, '{}');
  }
  broadcast(req.user.name);
  res.json({ id: info.lastInsertRowid, name });
});

app.put('/api/people/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!checkBoardAccess(req, p.board_id)) return res.status(403).json({ error: 'forbidden' });

  const { name, note, avatar } = req.body;
  const fields = [];
  const params = [];
  if (name !== undefined)   { fields.push('name = ?');   params.push(name); }
  if (note !== undefined)   { fields.push('note = ?');   params.push(String(note)); }
  if (avatar !== undefined) { fields.push('avatar = ?'); params.push(String(avatar)); }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });

  params.push(req.params.id);
  db.prepare(`UPDATE people SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  broadcast(req.user.name);
  res.json({ ok: true });
});

app.delete('/api/people/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!checkBoardAccess(req, p.board_id)) return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM kulebin WHERE person_id = ?').run(req.params.id);
  db.prepare('DELETE FROM plans WHERE person_id = ?').run(req.params.id);
  db.prepare('DELETE FROM people WHERE id = ?').run(req.params.id);
  broadcast(req.user.name);
  res.json({ ok: true });
});

// ============ KULEBIN ============
app.get('/api/kulebin', (req, res) => {
  const board_id = parseInt(req.query.board_id);
  let sql = `SELECT k.*, p.name, p.board_id, p.sort, p.note, p.avatar FROM kulebin k JOIN people p ON p.id = k.person_id`;
  const params = [];
  if (board_id) { sql += ' WHERE p.board_id = ?'; params.push(board_id); }
  sql += ' ORDER BY p.sort, p.id';
  const rows = db.prepare(sql).all(...params);
  const filtered = req.user.role === 'admin' ? rows : rows.filter(r => req.boardAccess.includes(r.board_id));
  res.json(filtered.map(r => {
    let values = {};
    try { values = r.values_json ? JSON.parse(r.values_json) : {}; } catch (e) {}
    return {
      person_id: r.person_id,
      values,
      updated_at: r.updated_at,
      name: r.name,
      board_id: r.board_id,
      note: r.note,
      avatar: r.avatar,
    };
  }));
});

app.put('/api/kulebin/:person_id', (req, res) => {
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.person_id);
  if (!person) return res.status(404).json({ error: 'person not found' });
  if (!checkBoardAccess(req, person.board_id)) return res.status(403).json({ error: 'forbidden' });

  const { values, key, value } = req.body;
  const pid = req.params.person_id;

  db.prepare('INSERT OR IGNORE INTO kulebin (person_id, values_json) VALUES (?, ?)').run(pid, '{}');
  const row = db.prepare('SELECT values_json FROM kulebin WHERE person_id = ?').get(pid);
  let existing = {};
  try { existing = row && row.values_json ? JSON.parse(row.values_json) : {}; } catch (e) {}

  if (values && typeof values === 'object') Object.assign(existing, values);
  else if (key) existing[key] = value;

  db.prepare("UPDATE kulebin SET values_json = ?, updated_at = datetime('now') WHERE person_id = ?")
    .run(JSON.stringify(existing), pid);
  broadcast(req.user.name);
  res.json({ ok: true, values: existing });
});

// ============ PLANS ============
app.get('/api/plans', (req, res) => {
  let sql = 'SELECT * FROM plans';
  const params = [];
  const where = [];
  if (req.query.board_id)  { where.push('board_id = ?');  params.push(parseInt(req.query.board_id)); }
  if (req.query.horizon)   { where.push('horizon = ?');   params.push(req.query.horizon); }
  if (req.query.person_id) { where.push('person_id = ?'); params.push(req.query.person_id); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY position, id';
  const rows = db.prepare(sql).all(...params);
  const filtered = req.user.role === 'admin' ? rows : rows.filter(r => req.boardAccess.includes(r.board_id));
  res.json(filtered);
});

app.post('/api/plans', (req, res) => {
  const { person_id, horizon, title, due_date, priority, board_id } = req.body;
  const boardId = parseInt(board_id) || 1;
  if (!checkBoardAccess(req, boardId)) return res.status(403).json({ error: 'forbidden' });
  if (!person_id || !horizon || !title) return res.status(400).json({ error: 'person_id, horizon, title required' });
  const maxPos = db.prepare('SELECT COALESCE(MAX(position),0) AS m FROM plans WHERE horizon = ? AND board_id = ? AND person_id = ?').get(horizon, boardId, person_id).m;
  const pr = (priority === 0 || priority === 1 || priority === 2) ? priority : 1;
  const completedAt = horizon === 'done' ? new Date().toISOString().replace('T',' ').slice(0,19) : null;
  const info = db.prepare('INSERT INTO plans (person_id, horizon, title, position, due_date, priority, completed_at, board_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(person_id, horizon, title, maxPos + 1, due_date || null, pr, completedAt, boardId);
  broadcast(req.user.name);
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/plans/:id', (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'not found' });
  if (!checkBoardAccess(req, plan.board_id)) return res.status(403).json({ error: 'forbidden' });

  const { title, person_id, horizon, due_date, priority } = req.body;
  const fields = []; const params = [];
  if (title !== undefined)     { fields.push('title = ?');     params.push(title); }
  if (person_id !== undefined) { fields.push('person_id = ?'); params.push(person_id); }
  if (horizon !== undefined)   { fields.push('horizon = ?');   params.push(horizon); }
  if (due_date !== undefined)  { fields.push('due_date = ?');  params.push(due_date || null); }
  if (priority !== undefined)  { fields.push('priority = ?');  params.push(priority); }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  if (horizon !== undefined) {
    if (horizon === 'done') fields.push("completed_at = COALESCE(completed_at, datetime('now'))");
    else fields.push('completed_at = NULL');
  }
  params.push(req.params.id);
  db.prepare(`UPDATE plans SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  broadcast(req.user.name);
  res.json({ ok: true });
});

app.post('/api/plans/:id/move', (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'not found' });
  if (!checkBoardAccess(req, plan.board_id)) return res.status(403).json({ error: 'forbidden' });

  const { horizon, position, person_id } = req.body;
  const newHorizon = horizon !== undefined ? horizon : plan.horizon;
  const newPersonId = (person_id !== undefined && person_id !== null) ? parseInt(person_id) : plan.person_id;
  const newPosition = position ?? plan.position;

  if (newHorizon === 'done') {
    db.prepare(`UPDATE plans SET horizon = ?, position = ?, person_id = ?, completed_at = COALESCE(completed_at, datetime('now')) WHERE id = ?`)
      .run(newHorizon, newPosition, newPersonId, req.params.id);
  } else {
    db.prepare('UPDATE plans SET horizon = ?, position = ?, person_id = ?, completed_at = NULL WHERE id = ?')
      .run(newHorizon, newPosition, newPersonId, req.params.id);
  }
  broadcast(req.user.name);
  res.json({ ok: true });
});

app.delete('/api/plans/:id', (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'not found' });
  if (!checkBoardAccess(req, plan.board_id)) return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM plans WHERE id = ?').run(req.params.id);
  broadcast(req.user.name);
  res.json({ ok: true });
});

// ============ SETTINGS ============
app.get('/api/settings', (req, res) => {
  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(r => settings[r.key] = r.value);
  res.json(settings);
});

app.put('/api/settings', requireAdmin, (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'body required' });
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  Object.entries(updates).forEach(([k, v]) => stmt.run(k, String(v)));
  broadcast(req.user.name);
  res.json({ ok: true });
});

// ============ SOCKET ============
io.on('connection', socket => {
  const cookies = parseCookies(socket.request.headers.cookie || '');
  const token = cookies.auth_token;
  const user = token ? db.prepare('SELECT * FROM users WHERE token = ?').get(token) : null;
  socket.user = user || null;
  socket.boardAccess = user ? userBoardAccess(user) : [];

  const all = getBoardState();
  socket.emit('board:update', filterForUser(all, socket.user, socket.boardAccess));
});

app.get('/healthz', (req, res) => res.json({ ok: true }));
server.listen(PORT, () => console.log(`Kanban server on :${PORT}`));
