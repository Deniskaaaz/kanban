/* ============================================================
   admin.js — логика админки
   ============================================================ */

initAdminTheme();
initNotifications();

let _selfChangeUntil = 0;
function markSelfChange() { _selfChangeUntil = Date.now() + 2500; }
let _pendingActor = null;

const _origFetch = window.fetch;
window.fetch = function(...args) {
  const url = String(args[0] || '');
  const method = ((args[1] && args[1].method) || 'GET').toUpperCase();
  if (method !== 'GET' && url.includes('/api/')) {
    markSelfChange();
  }
  return _origFetch.apply(this, args);
};

const socket = io();
const statusEl = document.getElementById('status');
const mainEl = document.getElementById('main-area');
const boardSelect = document.getElementById('board-select');

let me = null;
let state = { boards: [], people: [], plans: [], kulebin: [], settings: {} };
let currentBoardId = parseInt(localStorage.getItem('currentBoardId')) || 1;
let sortables = [];
let showArchive = false;
let openFormHorizon = null, openFormPersonId = null, openFormValue = '';
let _editingAvatar = '';

function isAdmin() { return me && me.role === 'admin'; }
function visibleBoards() {
  if (!me) return [];
  if (me.role === 'admin') return state.boards;
  return state.boards.filter(b => me.board_access.includes(b.id));
}
function currentBoard() { return visibleBoards().find(b => b.id === currentBoardId); }
function peopleOfBoard() { return state.people.filter(p => p.board_id === currentBoardId); }
function plansOfBoard()  { return state.plans.filter(p => p.board_id === currentBoardId); }
function colorOf(personId) { return personColor(personId, peopleOfBoard()); }
function kulebinOf(personId) {
  return state.kulebin.find(k => k.person_id === personId) || { person_id: personId, values: {} };
}

// ===== ЛОГОТИП =====
function renderLogo() {
  const url = state.settings?.logo_data_url || '';
  const slot = document.getElementById('header-logo-slot');
  const title = document.getElementById('header-title');
  if (url) {
    slot.innerHTML = `<img src="${url}" alt="Логотип" style="max-height:44px;max-width:200px;object-fit:contain;display:block;">`;
    slot.style.display = '';
    title.style.display = 'none';
  } else {
    slot.innerHTML = '';
    slot.style.display = 'none';
    title.style.display = '';
  }
  const prev = document.getElementById('logo-preview');
  if (prev) {
    prev.innerHTML = url
      ? `<img src="${url}" alt="Логотип" style="max-height:60px;max-width:220px;border:1px solid #e2e8f0;border-radius:8px;padding:6px;background:#fff;object-fit:contain;">`
      : '<span style="font-size:12px;color:#94a3b8;font-style:italic;">Логотип не загружен</span>';
  }
}

function showLogoStatus(text, ok = true) {
  const s = document.getElementById('logo-status');
  s.textContent = text;
  s.style.color = ok ? '#16a34a' : '#dc2626';
  s.style.display = 'block';
  setTimeout(() => { s.style.display = 'none'; }, 3000);
}

document.getElementById('logo-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    alert('Файл больше 10 МБ. Уменьшите размер.');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = async () => {
      try {
        const MAX_W = 600, MAX_H = 200;
        let w = img.width || 600, h = img.height || 200;
        const ratio = Math.min(MAX_W / w, MAX_H / h, 1);
        w = Math.max(1, Math.round(w * ratio));
        h = Math.max(1, Math.round(h * ratio));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        const keepAlpha = file.type === 'image/png' || file.type === 'image/svg+xml' || file.type === 'image/webp';
        if (!keepAlpha) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = keepAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.9);
        const r = await fetch('/api/settings', {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ logo_data_url: dataUrl })
        });
        if (r.ok) {
          const kb = Math.round(dataUrl.length / 1024);
          showLogoStatus('✓ Сохранено (' + w + '×' + h + ', ' + kb + ' КБ)');
        } else {
          showLogoStatus('✗ Ошибка сохранения', false);
        }
      } catch (err) {
        showLogoStatus('✗ ' + err.message, false);
      }
    };
    img.onerror = () => showLogoStatus('✗ Не удалось прочитать картинку', false);
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

document.getElementById('btn-remove-logo').addEventListener('click', async () => {
  if (!state.settings?.logo_data_url) { showLogoStatus('Логотипа нет'); return; }
  if (!confirm('Удалить логотип?')) return;
  const r = await fetch('/api/settings', {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ logo_data_url: '' })
  });
  document.getElementById('logo-file').value = '';
  showLogoStatus(r.ok ? '✓ Удалено' : '✗ Ошибка', r.ok);
});

// ===== Загрузка me =====
async function loadMe() {
  const r = await fetch('/api/me');
  if (r.status === 401) { location.href = '/login'; return; }
  me = await r.json();
  document.getElementById('user-name').textContent = me.name + (me.role === 'admin' ? ' • админ' : '');
  document.querySelectorAll('[data-admin-only]').forEach(el => {
    el.style.display = me.role === 'admin' ? '' : 'none';
  });
  document.getElementById('users-login-hint').textContent = location.origin + '/login?token=КОД';
}
loadMe();

// ===== Отслеживание изменений =====
let _lastStateSnapshot = null;

function snapshotState(st) {
  const s = { people: {}, plans: {}, kulebin: {} };
  st.people.forEach(p => {
    s.people[p.id] = { name: p.name, note: p.note || '' };
  });
  st.plans.forEach(p => {
    s.plans[p.id] = {
      title: p.title,
      person_id: p.person_id,
      horizon: p.horizon,
      due_date: p.due_date || '',
      priority: p.priority,
    };
  });
  st.kulebin.forEach(k => {
    s.kulebin[k.person_id] = JSON.stringify(k.values || {});
  });
  return s;
}

function detectChanges(oldS, newS) {
  if (!oldS) return [];
  const events = [];

  const oldP = oldS.people, newP = newS.people;
  Object.keys(newP).forEach(id => {
    if (!oldP[id]) events.push('добавлен сотрудник «' + newP[id].name + '»');
    else if (oldP[id].name !== newP[id].name) events.push('переименован: «' + oldP[id].name + '» → «' + newP[id].name + '»');
    else if (oldP[id].note !== newP[id].note) events.push('заметка у «' + newP[id].name + '»: ' + (newP[id].note || 'удалена'));
  });
  Object.keys(oldP).forEach(id => {
    if (!newP[id]) events.push('удалён сотрудник «' + oldP[id].name + '»');
  });

  const oldT = oldS.plans, newT = newS.plans;
  const addedTitles = [], removedTitles = [];
  let movedCount = 0;
  Object.keys(newT).forEach(id => {
    if (!oldT[id]) addedTitles.push(newT[id].title);
  });
  Object.keys(oldT).forEach(id => {
    if (!newT[id]) removedTitles.push(oldT[id].title);
  });
  Object.keys(newT).forEach(id => {
    if (!oldT[id]) return;
    if (oldT[id].horizon !== newT[id].horizon) movedCount++;
  });

  if (addedTitles.length === 1) events.push('новая задача: «' + addedTitles[0] + '»');
  else if (addedTitles.length > 1) events.push('добавлено задач: ' + addedTitles.length);

  if (removedTitles.length === 1) events.push('удалена задача: «' + removedTitles[0] + '»');
  else if (removedTitles.length > 1) events.push('удалено задач: ' + removedTitles.length);

  if (movedCount > 0) events.push('перемещено задач: ' + movedCount);

  const oldK = oldS.kulebin, newK = newS.kulebin;
  let changedCells = 0;
  Object.keys(newK).forEach(id => {
    if (oldK[id] !== newK[id]) changedCells++;
  });
  if (changedCells > 0) events.push('изменены данные в таблице');

  return events;
}

// ===== Socket =====
socket.on('connect', () => {
  statusEl.textContent = 'online ' + new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  statusEl.classList.remove('offline');
});
socket.on('disconnect', () => {
  statusEl.textContent = 'offline';
  statusEl.classList.add('offline');
});
socket.on('board:actor', data => {
  if (data && data.name) _pendingActor = data.name;
});
socket.on('board:update', data => {
  const prevSnap = _lastStateSnapshot;
  const newSnap = snapshotState(data);
  const now = Date.now();

  if (prevSnap && now > _selfChangeUntil) {
    const events = detectChanges(prevSnap, newSnap);
    if (events.length > 0) {
      const actor = _pendingActor;
      const body = events.slice(0, 3).join('; ') + (events.length > 3 ? ' …' : '');
      const title = actor ? actor + ' изменил(а) канбан' : 'Изменения в канбане';
      showNotification(title, body);
    }
  }
  _pendingActor = null;
  _lastStateSnapshot = newSnap;

  state = data;
  const vis = visibleBoards();
  if (!vis.find(b => b.id === currentBoardId) && vis.length) {
    currentBoardId = vis[0].id;
  }
  renderBoardSelect();
  renderLogo();
  render();
});

function renderBoardSelect() {
  const vis = visibleBoards();
  boardSelect.innerHTML = vis.map(b =>
    `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  boardSelect.value = String(currentBoardId);
  if (!vis.length) {
    mainEl.innerHTML = '<div class="kulebin-empty">У вас нет доступа ни к одной доске. Обратитесь к администратору.</div>';
  }
}
boardSelect.addEventListener('change', e => {
  currentBoardId = parseInt(e.target.value);
  localStorage.setItem('currentBoardId', currentBoardId);
  openFormHorizon = null;
  render();
});

document.getElementById('btn-archive').addEventListener('click', () => {
  showArchive = !showArchive;
  document.getElementById('btn-archive').classList.toggle('active', showArchive);
  render();
});

// ============ УПРАВЛЕНИЕ ДОСКАМИ ============
const boardModal = document.getElementById('board-modal');
document.getElementById('btn-manage-boards').addEventListener('click', () => {
  renderBoardList();
  const el = document.getElementById('rotate-interval');
  el.value = state.settings?.rotate_interval || 30;
  document.getElementById('interval-status').style.display = 'none';
  document.getElementById('logo-status').style.display = 'none';
  renderLogo();
  boardModal.classList.add('open');
});
document.getElementById('btn-close-boards').addEventListener('click', () => boardModal.classList.remove('open'));
document.getElementById('btn-create-board').addEventListener('click', async () => {
  const name = document.getElementById('board-new-name').value.trim();
  const type = document.getElementById('board-new-type').value;
  if (!name) return;
  const res = await fetch('/api/boards', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name, type }) });
  if (res.ok) {
    const b = await res.json();
    document.getElementById('board-new-name').value = '';
    currentBoardId = b.id;
    localStorage.setItem('currentBoardId', currentBoardId);
    renderBoardList();
  }
});

document.getElementById('btn-save-interval').addEventListener('click', async () => {
  const el = document.getElementById('rotate-interval');
  const status = document.getElementById('interval-status');
  let v = parseInt(el.value) || 30;
  v = Math.max(5, Math.min(3600, v));
  el.value = v;
  const r = await fetch('/api/settings', {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ rotate_interval: v })
  });
  status.textContent = r.ok ? '✓ Сохранено' : '✗ Ошибка';
  status.style.color = r.ok ? '#16a34a' : '#dc2626';
  status.style.display = 'block';
  setTimeout(() => { status.style.display = 'none'; }, 2000);
});
document.getElementById('rotate-interval').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('btn-save-interval').click(); }
});

function renderBoardList() {
  const list = document.getElementById('board-list');
  list.innerHTML = '';
  state.boards.forEach(b => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;';
    row.innerHTML = `
      <span style="font-size:11px;color:#64748b;min-width:60px;">${b.type === 'kulebin' ? 'таблица' : 'канбан'}</span>
      <input type="text" value="${escapeHtml(b.name)}" data-id="${b.id}" style="flex:1;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font:inherit;font-size:13px;">
      <button class="secondary" data-rename="${b.id}" style="padding:6px 10px;font-size:12px;">Сохранить</button>
      <button class="danger" data-delete="${b.id}" style="padding:6px 10px;font-size:12px;">Удалить</button>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-rename]').forEach(btn => {
    btn.addEventListener('click', async e => {
      const id = e.target.dataset.rename;
      const input = list.querySelector(`input[data-id="${id}"]`);
      const name = input.value.trim();
      if (!name) return;
      await fetch(`/api/boards/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
    });
  });
  list.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', async e => {
      const id = parseInt(e.target.dataset.delete);
      if (state.boards.length <= 1) { alert('Нельзя удалить последнюю доску'); return; }
      if (!confirm('Удалить доску? Все люди и данные этой доски тоже удалятся.')) return;
      await fetch(`/api/boards/${id}`, { method: 'DELETE' });
      if (currentBoardId === id) {
        const rest = state.boards.filter(x => x.id !== id);
        if (rest.length) {
          currentBoardId = rest[0].id;
          localStorage.setItem('currentBoardId', currentBoardId);
        }
      }
      renderBoardList();
    });
  });
}

// ============ ПОЛЬЗОВАТЕЛИ ============
const usersModal = document.getElementById('users-modal');
let usersCache = [];

document.getElementById('btn-users').addEventListener('click', async () => {
  await refreshUsers();
  usersModal.classList.add('open');
});
document.getElementById('btn-close-users').addEventListener('click', () => usersModal.classList.remove('open'));
document.getElementById('btn-create-user').addEventListener('click', async () => {
  const name = document.getElementById('new-user-name').value.trim();
  const role = document.getElementById('new-user-role').value;
  if (!name) return;
  const r = await fetch('/api/users', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ name, role })
  });
  if (r.ok) {
    document.getElementById('new-user-name').value = '';
    await refreshUsers();
  }
});

async function refreshUsers() {
  const r = await fetch('/api/users');
  if (!r.ok) return;
  usersCache = await r.json();
  renderUsersList();
}

function renderUsersList() {
  const list = document.getElementById('users-list');
  list.innerHTML = '';

  usersCache.forEach(u => {
    const row = document.createElement('div');
    row.style.cssText = 'border:1px solid #e2e8f0;border-radius:10px;padding:12px;background:#f8fafc;';

    const isMe = me && u.id === me.id;
    const lastSeen = u.last_seen_at ? `последний вход: ${u.last_seen_at}` : 'ещё не входил';

    const boardsHtml = u.role === 'admin'
      ? '<div style="font-size:13px;color:#6d28d9;font-weight:600;">Доступ ко всем доскам</div>'
      : state.boards.map(b => {
          const checked = Array.isArray(u.boards) && u.boards.includes(b.id) ? 'checked' : '';
          return `<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin:2px 0;">
            <input type="checkbox" data-user="${u.id}" data-board="${b.id}" ${checked}>
            <span>${escapeHtml(b.name)}</span>
          </label>`;
        }).join('');

    row.innerHTML = `
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">
        <input type="text" value="${escapeHtml(u.name)}" data-name="${u.id}" style="flex:1;min-width:140px;padding:6px 9px;border:1px solid #cbd5e1;border-radius:6px;font:inherit;font-size:14px;font-weight:600;">
        <select data-role="${u.id}" style="padding:6px 9px;border:1px solid #cbd5e1;border-radius:6px;font:inherit;font-size:13px;">
          <option value="user" ${u.role === 'user' ? 'selected' : ''}>Пользователь</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Администратор</option>
        </select>
        <button class="secondary" data-save-user="${u.id}" style="padding:6px 10px;font-size:12px;">Сохранить</button>
        ${isMe ? '<span style="font-size:11px;color:#64748b;padding:4px 8px;background:#e2e8f0;border-radius:8px;">это вы</span>' : ''}
        ${!isMe ? `<button class="danger" data-del-user="${u.id}" style="padding:6px 10px;font-size:12px;">Удалить</button>` : ''}
      </div>

      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin-bottom:10px;">
        <div style="font-size:11px;color:#64748b;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px;">Код доступа</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <code style="font-family:monospace;font-size:13px;background:#f1f5f9;padding:4px 8px;border-radius:6px;">${u.token}</code>
          <button class="secondary" data-copy-url="${u.id}" style="padding:4px 8px;font-size:12px;">📋 Скопировать ссылку</button>
          <button class="secondary" data-regen="${u.id}" style="padding:4px 8px;font-size:12px;">🔄 Новый код</button>
        </div>
        <div style="font-size:11px;color:#94a3b8;margin-top:4px;">${lastSeen}</div>
      </div>

      ${u.role === 'user' ? `
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px;">
          <div style="font-size:11px;color:#64748b;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px;">Доступ к доскам</div>
          ${boardsHtml || '<div style="font-size:12px;color:#94a3b8;">Нет досок для распределения</div>'}
          <button class="secondary" data-save-boards="${u.id}" style="margin-top:8px;padding:6px 10px;font-size:12px;">Сохранить доступ</button>
        </div>
      ` : ''}
    `;
    list.appendChild(row);
  });

  list.querySelectorAll('[data-save-user]').forEach(btn => {
    btn.addEventListener('click', async e => {
      const id = e.target.dataset.saveUser;
      const name = list.querySelector(`input[data-name="${id}"]`).value.trim();
      const role = list.querySelector(`select[data-role="${id}"]`).value;
      await fetch(`/api/users/${id}`, {
        method: 'PUT', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ name, role })
      });
      await refreshUsers();
    });
  });
  list.querySelectorAll('[data-del-user]').forEach(btn => {
    btn.addEventListener('click', async e => {
      const id = e.target.dataset.delUser;
      if (!confirm('Удалить пользователя?')) return;
      await fetch(`/api/users/${id}`, { method: 'DELETE' });
      await refreshUsers();
    });
  });
  list.querySelectorAll('[data-regen]').forEach(btn => {
    btn.addEventListener('click', async e => {
      const id = e.target.dataset.regen;
      if (!confirm('Сгенерировать новый код? Старый перестанет работать.')) return;
      const r = await fetch(`/api/users/${id}/regenerate-token`, { method: 'POST' });
      if (r.ok) {
        const d = await r.json();
        alert('Новый код: ' + d.token + '\n\nСсылка для входа: ' + location.origin + '/login?token=' + d.token);
        await refreshUsers();
      }
    });
  });
  list.querySelectorAll('[data-copy-url]').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = e.target.dataset.copyUrl;
      const u = usersCache.find(x => x.id === parseInt(id));
      if (!u) return;
      const url = `${location.origin}/login?token=${u.token}`;
      navigator.clipboard.writeText(url).then(() => {
        const old = e.target.textContent;
        e.target.textContent = '✓ Скопировано';
        setTimeout(() => { e.target.textContent = old; }, 1500);
      });
    });
  });
  list.querySelectorAll('[data-save-boards]').forEach(btn => {
    btn.addEventListener('click', async e => {
      const id = e.target.dataset.saveBoards;
      const checks = list.querySelectorAll(`input[data-user="${id}"]:checked`);
      const board_ids = Array.from(checks).map(c => parseInt(c.dataset.board));
      await fetch(`/api/users/${id}/boards`, {
        method: 'PUT', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ board_ids })
      });
      await refreshUsers();
    });
  });
}

// ============ НАСТРОЙКА СТОЛБЦОВ ============
const columnsModal = document.getElementById('columns-modal');
let editingColumns = [];

document.getElementById('btn-columns').addEventListener('click', () => {
  const board = currentBoard();
  if (!board || board.type !== 'kulebin') return;
  editingColumns = (board.columns || []).map(c => ({ ...c }));
  renderColumnsEditor();
  columnsModal.classList.add('open');
});
document.getElementById('btn-cancel-columns').addEventListener('click', () => columnsModal.classList.remove('open'));
document.getElementById('btn-add-column').addEventListener('click', () => {
  saveFormData();
  const key = 'c' + Date.now().toString(36);
  editingColumns.push({ key, label: 'Новый столбец', kind: 'text' });
  renderColumnsEditor();
});
document.getElementById('btn-save-columns').addEventListener('click', async () => {
  saveFormData();
  await fetch(`/api/boards/${currentBoardId}/columns`, {
    method: 'PUT', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ columns: editingColumns })
  });
  columnsModal.classList.remove('open');
});

function renderColumnsEditor() {
  const list = document.getElementById('columns-list');
  list.innerHTML = '';
  editingColumns.forEach((col, i) => {
    const card = document.createElement('div');
    card.className = 'col-card';
    card.dataset.key = col.key;
    card.innerHTML = `
      <div class="col-card-head">
        <span class="num">${i + 1}</span>
        <input type="text" class="col-label-input" value="${escapeHtml(col.label)}">
        <button class="secondary col-up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="secondary col-down" ${i === editingColumns.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="danger col-del">×</button>
      </div>
      <div class="col-card-fields">
        <div>
          <label>Тип столбца</label>
          <select class="col-kind">
            <option value="text" ${col.kind === 'text' ? 'selected' : ''}>Текст</option>
            <option value="amount" ${col.kind === 'amount' ? 'selected' : ''}>Сумма с планом</option>
            <option value="efficiency" ${col.kind === 'efficiency' ? 'selected' : ''}>Эффективность (0–100%)</option>
            <option value="attendance" ${col.kind === 'attendance' ? 'selected' : ''}>Присутствие (0–1)</option>
          </select>
        </div>
        <div class="col-extra" style="display:${col.kind === 'amount' ? '' : 'none'};">
          <div style="display:grid;grid-template-columns:1fr 80px;gap:6px;">
            <div><label>План</label><input type="number" class="col-plan" value="${col.plan || 0}"></div>
            <div><label>Ед.</label><input type="text" class="col-unit" value="${escapeHtml(col.unit || '₽')}"></div>
          </div>
        </div>
      </div>
    `;
    list.appendChild(card);

    card.querySelector('.col-label-input').addEventListener('input', saveFormData);
    card.querySelector('.col-kind').addEventListener('change', e => {
      card.querySelector('.col-extra').style.display = e.target.value === 'amount' ? '' : 'none';
      saveFormData();
    });
    card.querySelector('.col-plan').addEventListener('input', saveFormData);
    card.querySelector('.col-unit').addEventListener('input', saveFormData);
    card.querySelector('.col-up').addEventListener('click', () => { saveFormData(); if (i===0) return; [editingColumns[i-1], editingColumns[i]] = [editingColumns[i], editingColumns[i-1]]; renderColumnsEditor(); });
    card.querySelector('.col-down').addEventListener('click', () => { saveFormData(); if (i===editingColumns.length-1) return; [editingColumns[i], editingColumns[i+1]] = [editingColumns[i+1], editingColumns[i]]; renderColumnsEditor(); });
    card.querySelector('.col-del').addEventListener('click', () => { saveFormData(); if (editingColumns.length <= 1) { alert('Хотя бы один столбец'); return; } editingColumns.splice(i,1); renderColumnsEditor(); });
  });
}

function saveFormData() {
  document.querySelectorAll('#columns-list .col-card').forEach(card => {
    const key = card.dataset.key;
    const col = editingColumns.find(c => c.key === key);
    if (!col) return;
    col.label = card.querySelector('.col-label-input').value;
    col.kind = card.querySelector('.col-kind').value;
    if (col.kind === 'amount') {
      col.plan = parseFloat(card.querySelector('.col-plan').value) || 0;
      col.unit = card.querySelector('.col-unit').value || '₽';
    } else { delete col.plan; delete col.unit; }
  });
}

// ============ RENDER ============
function render() {
  const board = currentBoard();
  if (!board) return;
  const isKulebin = board.type === 'kulebin';
  document.querySelectorAll('[data-kanban-only]').forEach(el => el.style.display = isKulebin ? 'none' : '');
  document.querySelectorAll('[data-kulebin-only]').forEach(el => el.style.display = isKulebin ? '' : 'none');
  if (isKulebin) renderKulebin(); else renderKanban();
}

function renderKulebin() {
  const board = currentBoard();
  const columns = board.columns || [];
  const people = peopleOfBoard();
  mainEl.innerHTML = '';

  if (!people.length) {
    mainEl.innerHTML = '<div class="kulebin-empty">На этой доске пока нет сотрудников. Нажмите «+ Человек» в шапке.</div>';
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'kulebin-wrap';

  const gridCols = '1.2fr ' + columns.map(c => {
    if (c.kind === 'efficiency') return '0.9fr';
    if (c.kind === 'amount') return '1.4fr';
    if (c.kind === 'attendance') return '0.9fr';
    return '2fr';
  }).join(' ');

  const head = document.createElement('div');
  head.className = 'kulebin-head';
  head.style.gridTemplateColumns = gridCols;
  head.innerHTML = `<div>Сотрудник</div>` + columns.map(c => {
    const planTxt = (c.kind === 'amount' && c.plan > 0)
      ? `<span class="col-plan">План: ${formatNumber(c.plan)} ${escapeHtml(c.unit || '₽')}</span>` : '';
    return `<div><span class="col-label">${escapeHtml(c.label)}</span>${planTxt}</div>`;
  }).join('');
  wrap.appendChild(head);

  people.forEach(p => {
    const k = kulebinOf(p.id);
    const row = document.createElement('div');
    row.className = 'kulebin-row';
    row.style.gridTemplateColumns = gridCols;

    row.appendChild(buildPersonCell(p));

    columns.forEach(col => {
      const rawVal = k.values ? k.values[col.key] : undefined;
      row.appendChild(buildValueCell(p, col, rawVal));
    });
    wrap.appendChild(row);
  });

  const totals = computeTotals(people, columns, state.kulebin);
  const totalRow = document.createElement('div');
  totalRow.className = 'kulebin-row kulebin-total';
  totalRow.style.gridTemplateColumns = gridCols;
  const tl = document.createElement('div');
  tl.className = 'total-label';
  tl.textContent = 'Итого';
  totalRow.appendChild(tl);

  columns.forEach(col => {
    totalRow.appendChild(buildTotalCell(col, totals));
  });
  wrap.appendChild(totalRow);
  mainEl.appendChild(wrap);
}

function buildPersonCell(p) {
  const nameDiv = document.createElement('div');
  nameDiv.className = 'kulebin-name';
  nameDiv.style.flexDirection = 'column';
  nameDiv.style.alignItems = 'flex-start';
  nameDiv.style.gap = '2px';

  const nameTop = document.createElement('div');
  nameTop.style.display = 'flex';
  nameTop.style.alignItems = 'center';
  nameTop.style.gap = '10px';
  nameTop.style.cursor = 'pointer';
  nameTop.innerHTML = `
    ${avatarHtml(p, 'md', colorOf(p.id))}
    <span>${escapeHtml(p.name)}</span>`;
  nameTop.addEventListener('click', (e) => {
    if (!isRealClick(e, nameTop)) return;
    openPersonModal(p.id);
  });
  nameDiv.appendChild(nameTop);

  const noteDiv = document.createElement('div');
  noteDiv.className = 'person-note' + (p.note ? '' : ' empty');
  noteDiv.textContent = p.note || 'добавить заметку';
  noteDiv.title = 'Кликните, чтобы изменить заметку';
  noteDiv.addEventListener('click', e => {
    if (!isRealClick(e, noteDiv)) return;
    e.stopPropagation();
    editPersonNote(noteDiv, p.id, p.note || '');
  });
  nameDiv.appendChild(noteDiv);

  return nameDiv;
}

function buildValueCell(p, col, rawVal) {
  if (col.kind === 'efficiency') {
    const eff = document.createElement('div');
    const nv = parseInt(rawVal) || 0;
    eff.className = 'kulebin-eff ' + effClass(nv);
    eff.textContent = nv + '%';
    eff.dataset.label = col.label;
    eff.addEventListener('click', (e) => {
      if (!isRealClick(e, eff)) return;
      editEffCell(eff, p.id, col.key, nv);
    });
    return eff;
  }
  if (col.kind === 'attendance') {
    const cell = document.createElement('div');
    cell.className = 'kulebin-attendance';
    cell.dataset.label = col.label;
    renderAttendanceCell(cell, rawVal);
    cell.addEventListener('click', (e) => {
      if (!isRealClick(e, cell)) return;
      editAttendanceCell(cell, p.id, col.key, rawVal);
    });
    return cell;
  }
  if (col.kind === 'amount') {
    const cell = document.createElement('div');
    cell.className = 'kulebin-amount';
    cell.dataset.label = col.label;
    renderAmountCell(cell, rawVal, col);
    cell.addEventListener('click', (e) => {
      if (!isRealClick(e, cell)) return;
      editAmountCell(cell, p.id, col, rawVal);
    });
    return cell;
  }
  const cell = document.createElement('div');
  cell.className = 'kulebin-cell';
  cell.dataset.label = col.label;
  const val = rawVal || '';
  cell.textContent = val || '— нажмите, чтобы заполнить';
  if (!val) cell.classList.add('empty');
  cell.addEventListener('click', (e) => {
    if (!isRealClick(e, cell)) return;
    editTextCell(cell, p.id, col.key, val);
  });
  return cell;
}

function buildTotalCell(col, totals) {
  if (col.kind === 'amount') {
    const cell = document.createElement('div');
    cell.className = 'kulebin-amount';
    cell.dataset.label = col.label;
    const sum = totals[col.key]?.sum || 0;
    const tp = totals[col.key]?.totalPlan || 0;
    const pct = tp > 0 ? Math.min(999, Math.round((sum / tp) * 100)) : null;
    if (sum === 0) {
      cell.innerHTML = `<div class="amount-value empty">—</div>`;
    } else {
      const ph = pct === null ? '' : `<div class="amount-bar-wrap"><div class="amount-bar"><div class="amount-bar-fill ${pctClass(pct)}" style="width:${Math.min(100,pct)}%"></div></div><div class="amount-pct ${pctClass(pct)}">${pct}%</div></div>`;
      cell.innerHTML = `<div class="amount-value">${formatNumber(sum)} ${escapeHtml(col.unit || '₽')}</div>${ph}`;
    }
    return cell;
  }
  if (col.kind === 'efficiency') {
    const eff = document.createElement('div');
    eff.dataset.label = col.label;
    const avg = totals[col.key]?.avg || 0;
    eff.className = 'kulebin-eff ' + effClass(avg);
    eff.textContent = avg + '%';
    return eff;
  }
  if (col.kind === 'attendance') {
    const cell = document.createElement('div');
    cell.className = 'kulebin-attendance';
    cell.dataset.label = col.label;
    const sum = totals[col.key]?.sum || 0;
    if (sum === 0) {
      cell.innerHTML = `<div class="att-value empty">0,00</div>`;
    } else {
      const display = sum.toFixed(2).replace('.', ',');
      cell.innerHTML = `<div class="att-value" style="background:#7c3aed">Σ ${display}</div>`;
    }
    return cell;
  }
  const cell = document.createElement('div');
  cell.className = 'kulebin-cell';
  cell.dataset.label = col.label;
  return cell;
}

function renderAmountCell(cell, rawVal, col) {
  const num = parseFloat(rawVal);
  const unit = col.unit || '₽';
  const hasValue = !isNaN(num) && num > 0;
  const pct = calcPercent(num, col.plan);
  if (!hasValue) { cell.innerHTML = `<div class="amount-value empty">— нажмите, чтобы заполнить</div>`; return; }
  const ph = pct === null ? '' : `<div class="amount-bar-wrap"><div class="amount-bar"><div class="amount-bar-fill ${pctClass(pct)}" style="width:${Math.min(100,pct)}%"></div></div><div class="amount-pct ${pctClass(pct)}">${pct}%</div></div>`;
  cell.innerHTML = `<div class="amount-value">${formatNumber(num)} ${escapeHtml(unit)}</div>${ph}`;
}

function renderAttendanceCell(cell, rawVal) {
  const v = parseFloat(rawVal);
  const hasValue = !isNaN(v) && v >= 0;
  if (!hasValue) {
    cell.innerHTML = `<div class="att-value empty">—</div>`;
    return;
  }
  const display = v.toFixed(2).replace('.', ',');
  const color = attendanceColor(v);
  const widthPct = Math.min(100, v * 100);
  cell.innerHTML = `
    <div class="att-value" style="background:${color}">${display}</div>
    <div class="att-bar"><div class="att-bar-fill" style="width:${widthPct}%;background:${color}"></div></div>
  `;
}

function editTextCell(cell, personId, key, currentVal) {
  cell.classList.add('editing'); cell.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.className = 'kulebin-input'; ta.style.minHeight = '60px'; ta.value = currentVal || '';
  cell.appendChild(ta); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  let saved = false;
  async function save() { if (saved) return; saved = true; const val = ta.value.trim(); await fetch(`/api/kulebin/${personId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({key, value: val}) }); }
  ta.addEventListener('blur', save);
  ta.addEventListener('keydown', e => { if (e.key==='Escape'){ saved=true; ta.removeEventListener('blur',save); render(); } if (e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); ta.blur(); } });
}
function editEffCell(cell, personId, key, currentVal) {
  cell.classList.add('editing'); cell.textContent = '';
  const inp = document.createElement('input');
  inp.type='number'; inp.min=0; inp.max=100; inp.value=currentVal; inp.className='kulebin-input num';
  cell.appendChild(inp); inp.focus(); inp.select();
  let saved = false;
  async function save() { if (saved) return; saved = true; let v = parseInt(inp.value)||0; v = Math.max(0,Math.min(100,v)); await fetch(`/api/kulebin/${personId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({key, value:v}) }); }
  inp.addEventListener('blur', save);
  inp.addEventListener('keydown', e => { if (e.key==='Escape'){ saved=true; inp.removeEventListener('blur',save); render(); } if (e.key==='Enter'){ e.preventDefault(); inp.blur(); } });
}
function editAmountCell(cell, personId, col, currentVal) {
  cell.classList.add('editing'); const orig = cell.innerHTML; cell.innerHTML = '';
  const inp = document.createElement('input');
  inp.type='number'; inp.min=0; inp.step='any'; inp.value=parseFloat(currentVal)||''; inp.placeholder='0'; inp.className='kulebin-input num';
  cell.appendChild(inp); inp.focus(); inp.select();
  let saved = false;
  async function save() { if (saved) return; saved = true; const v = parseFloat(inp.value)||0; await fetch(`/api/kulebin/${personId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({key:col.key, value:v}) }); }
  inp.addEventListener('blur', save);
  inp.addEventListener('keydown', e => { if (e.key==='Escape'){ saved=true; inp.removeEventListener('blur',save); cell.innerHTML=orig; } if (e.key==='Enter'){ e.preventDefault(); inp.blur(); } });
}
function editAttendanceCell(cell, personId, key, currentVal) {
  cell.classList.add('editing');
  const orig = cell.innerHTML;
  cell.innerHTML = '';
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.min = 0; inp.max = 1; inp.step = '0.01';
  inp.value = parseFloat(currentVal) || '';
  inp.placeholder = '0.00';
  inp.className = 'kulebin-input num';
  cell.appendChild(inp);
  inp.focus(); inp.select();

  let saved = false;
  async function save() {
    if (saved) return;
    saved = true;
    let v = parseFloat(inp.value);
    if (isNaN(v)) v = 0;
    v = Math.max(0, Math.min(1, v));
    await fetch(`/api/kulebin/${personId}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ key, value: v })
    });
  }
  inp.addEventListener('blur', save);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Escape') { saved = true; inp.removeEventListener('blur', save); cell.innerHTML = orig; }
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
  });
}

// ============ КАНБАН (с группировкой по людям) ============
function renderKanban() {
  const existingForm = mainEl.querySelector('.add-form');
  if (existingForm) {
    openFormValue = existingForm.querySelector('.add-input').value;
    openFormPersonId = existingForm.querySelector('.add-person').value;
  }
  sortables.forEach(s => s.destroy());
  sortables = [];
  mainEl.innerHTML = '';
  const boardDiv = document.createElement('div');
  boardDiv.className = 'board';
  mainEl.appendChild(boardDiv);
  const people = peopleOfBoard();
  const plans = plansOfBoard();

  HORIZONS.forEach(h => {
    const col = document.createElement('div');
    col.className = 'column col-' + h.key;
    col.dataset.horizon = h.key;

    const all = h.key === 'people' ? [] : plans.filter(p => p.horizon === h.key);
    const visible = h.key === 'people' ? [] : all.filter(p => showArchive ? true : !isArchived(p));
    const hiddenCount = all.length - visible.length;

    const title = document.createElement('div');
    title.className = 'col-title';
    const cnt = h.key === 'people' ? people.length : visible.length;
    title.innerHTML = `<span class="col-title-left"><span class="col-icon">${ICONS[h.key]||''}</span><span>${h.label}</span></span><span class="col-count">${cnt}</span>`;
    col.appendChild(title);

    if (h.key === 'people') {
      people.forEach(p => col.appendChild(buildPersonCard(p)));
    } else {
      const byPerson = {};
      visible.forEach(p => {
        if (!byPerson[p.person_id]) byPerson[p.person_id] = [];
        byPerson[p.person_id].push(p);
      });

      const bodyWrapper = document.createElement('div');
      bodyWrapper.className = 'col-body-wrapper';
      bodyWrapper.dataset.horizon = h.key;

      people.forEach(person => {
        const tasks = byPerson[person.id] || [];
        // Пустые группы полностью скрыты — не создаём DOM-узел.
        if (!tasks.length) return;

        const group = document.createElement('div');
        group.className = 'person-group';
        group.dataset.personId = person.id;

        const header = document.createElement('div');
        header.className = 'person-group-header';
        header.innerHTML = `${avatarHtml(person, 'sm', colorOf(person.id))}<span>${escapeHtml(person.name)}</span>`;
        header.addEventListener('click', (e) => {
          if (!isRealClick(e, header)) return;
          openPersonModal(person.id);
        });
        group.appendChild(header);

        const tasksWrap = document.createElement('div');
        tasksWrap.className = 'person-tasks';
        tasksWrap.dataset.personId = person.id;
        tasksWrap.dataset.horizon = h.key;

        tasks.forEach(t => tasksWrap.appendChild(buildPlanCard(t)));

        group.appendChild(tasksWrap);
        bodyWrapper.appendChild(group);
      });

      if (hiddenCount && !showArchive) {
        const note = document.createElement('div');
        note.className = 'archived-notice';
        note.textContent = '+ ' + hiddenCount + ' в архиве';
        bodyWrapper.appendChild(note);
      }

      col.appendChild(bodyWrapper);

      const addBtn = document.createElement('button');
      addBtn.className = 'add-task-btn';
      addBtn.textContent = '+ Добавить';
      addBtn.addEventListener('click', e => { e.stopPropagation(); showAddForm(col, h.key); });
      col.appendChild(addBtn);
    }
    boardDiv.appendChild(col);
  });

  // ---- Sortable на каждой группе задач: перетаскивание между людьми и колонками ----
  document.querySelectorAll('.person-tasks').forEach(tw => {
    const s = Sortable.create(tw, {
      group: 'plans',
      animation: 150,
      ghostClass: 'dragging',
      scroll: true,
      scrollSensitivity: 80,
      scrollSpeed: 15,
      bubbleScroll: true,
      fallbackOnBody: true,
      swapThreshold: 0.65,
      onStart: () => { document.querySelectorAll('.card').forEach(c => c.dataset.moved = ''); },
      onEnd: async evt => {
        evt.item.dataset.moved = '1';
        const planId = parseInt(evt.item.dataset.planId);
        if (!planId) return;
        const plan = state.plans.find(p => p.id === planId);
        if (!plan) return;

        const toIsTasks = evt.to.classList.contains('person-tasks');
        const columnEl = evt.to.closest('.column');
        const newHorizon = columnEl ? columnEl.dataset.horizon : plan.horizon;
        const newPersonId = toIsTasks ? parseInt(evt.to.dataset.personId) : plan.person_id;
        const newIndex = toIsTasks ? evt.newIndex : null;

        // Если задача упала вне группы (в пустое место колонки) — SortableJS
        // вставил её как временный DOM-узел. Убираем, ждём перерисовки от сокета.
        if (!toIsTasks) {
          evt.item.remove();
        }

        const body = { horizon: newHorizon, person_id: newPersonId };
        if (newIndex !== null) body.position = newIndex * 100;

        try {
          await fetch(`/api/plans/${planId}/move`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
          });
        } catch (err) { console.error('move failed', err); }
      }
    });
    sortables.push(s);
  });

  // ---- Sortable на колонке целиком: ловит drop в пустое место (не на группу) ----
  // put: true — принимает; pull: false — сам ничего не отдаёт (отдают только .person-tasks).
  document.querySelectorAll('.col-body-wrapper').forEach(wrapper => {
    const s = Sortable.create(wrapper, {
      group: { name: 'plans', put: true, pull: false },
      animation: 150,
      ghostClass: 'dragging',
      draggable: '.card',
      onAdd: async evt => {
        const planId = parseInt(evt.item.dataset.planId);
        evt.item.remove();   // убираем временный DOM-узел
        if (!planId) return;
        const plan = state.plans.find(p => p.id === planId);
        if (!plan) return;

        const horizon = wrapper.dataset.horizon;
        if (!horizon) return;

        try {
          await fetch(`/api/plans/${planId}/move`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ horizon, person_id: plan.person_id })
          });
        } catch (err) { console.error('move failed', err); }
      }
    });
    sortables.push(s);
  });

  if (openFormHorizon) {
    const col = boardDiv.querySelector(`.column[data-horizon="${openFormHorizon}"]`);
    if (col) showAddForm(col, openFormHorizon, true);
  }
}

function buildPersonCard(p) {
  const card = document.createElement('div');
  card.className = 'card person-card';
  card.dataset.personId = p.id;
  card.style.alignItems = 'flex-start';

  const left = document.createElement('span');
  left.className = 'initials';
  left.style.background = colorOf(p.id);
  if (p.avatar) {
    left.innerHTML = `<img src="${p.avatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">`;
  } else {
    left.textContent = getInitials(p.name);
  }
  card.appendChild(left);

  const right = document.createElement('div');
  right.style.display = 'flex';
  right.style.flexDirection = 'column';
  right.style.flex = '1';
  right.style.minWidth = '0';

  const nameLine = document.createElement('span');
  nameLine.className = 'name';
  nameLine.textContent = p.name;
  right.appendChild(nameLine);

  const noteLine = document.createElement('div');
  noteLine.className = 'person-note' + (p.note ? '' : ' empty');
  noteLine.textContent = p.note || 'добавить заметку';
  noteLine.title = 'Кликните, чтобы изменить заметку';
  noteLine.addEventListener('click', e => {
    if (!isRealClick(e, noteLine)) return;
    e.stopPropagation();
    editPersonNote(noteLine, p.id, p.note || '');
  });
  right.appendChild(noteLine);

  card.appendChild(right);
  card.addEventListener('click', (e) => {
    if (!isRealClick(e, card)) return;
    openPersonModal(p.id);
  });
  return card;
}

function buildPlanCard(p) {
  const card = document.createElement('div');
  card.className = 'card';
  if (p.priority === 2) card.classList.add('prio-high');
  else if (p.priority === 0) card.classList.add('prio-low');
  card.dataset.planId = p.id;

  const badges = [];
  if (p.priority === 2) badges.push('<span class="badge prio-high">🔴 Высокий</span>');
  else if (p.priority === 0) badges.push('<span class="badge prio-low">🟢 Низкий</span>');
  if (p.due_date) badges.push(`<span class="badge ${dueClass(p.due_date)}">${dueLabel(p.due_date)}</span>`);
  const bh = badges.length ? `<div class="badges">${badges.join('')}</div>` : '';

  card.innerHTML = `<div class="title">${escapeHtml(p.title)}</div>${bh}`;

  card.addEventListener('click', (e) => {
    if (!isRealClick(e, card)) return;
    if (card.dataset.moved) return;
    openPlanModal(p.id);
  });
  return card;
}

function showAddForm(col, horizon, isRestore = false) {
  if (openFormHorizon && openFormHorizon !== horizon) {
    const old = mainEl.querySelector(`.column[data-horizon="${openFormHorizon}"]`);
    if (old) {
      const f = old.querySelector('.add-form'); if (f) f.remove();
      const b = old.querySelector('.add-task-btn'); if (b) b.style.display = '';
    }
  }
  if (col.querySelector('.add-form')) return;
  const people = peopleOfBoard();
  if (!people.length) { alert('Сначала добавьте ответственного'); return; }
  const btn = col.querySelector('.add-task-btn');
  if (btn) btn.style.display = 'none';
  const form = document.createElement('div');
  form.className = 'add-form';
  form.innerHTML = `
    <select class="add-person">${people.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>
    <input type="text" class="add-input" placeholder="Что нужно сделать? Enter — сохранить">
    <div class="add-actions"><button class="secondary add-cancel">Отмена</button><button class="add-save">Добавить</button></div>
  `;
  col.appendChild(form);
  const select = form.querySelector('.add-person');
  const input = form.querySelector('.add-input');
  if (isRestore) {
    if (openFormPersonId && [...select.options].some(o => o.value === openFormPersonId)) select.value = openFormPersonId;
    input.value = openFormValue || '';
  } else {
    const last = localStorage.getItem('lastPersonId_' + currentBoardId);
    if (last && [...select.options].some(o => o.value === last)) select.value = last;
  }
  openFormHorizon = horizon;
  openFormPersonId = select.value;
  setTimeout(() => input.focus(), 30);
  select.addEventListener('change', () => { openFormPersonId = select.value; });
  input.addEventListener('input', () => { openFormValue = input.value; });
  async function save() {
    const person_id = parseInt(select.value);
    const title = input.value.trim();
    if (!person_id || !title) return;
    localStorage.setItem('lastPersonId_' + currentBoardId, person_id);
    openFormPersonId = String(person_id);
    openFormValue = ''; input.value = ''; input.focus();
    await fetch('/api/plans', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({person_id, horizon, title, priority:1, board_id:currentBoardId}) });
  }
  function close() { openFormHorizon = null; openFormValue = ''; form.remove(); if (btn) btn.style.display = ''; }
  form.querySelector('.add-save').addEventListener('click', save);
  form.querySelector('.add-cancel').addEventListener('click', close);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { e.preventDefault(); close(); } });
}

// ============ PERSON MODAL ============
const personModal = document.getElementById('person-modal');
const personNameEl = document.getElementById('person-name');
const personModalTitle = document.getElementById('person-modal-title');
const btnDeletePerson = document.getElementById('btn-delete-person');
let editingPersonId = null;

document.getElementById('btn-add-person').addEventListener('click', () => openPersonModal(null));
document.getElementById('btn-cancel-person').addEventListener('click', () => personModal.classList.remove('open'));
document.getElementById('btn-save-person').addEventListener('click', savePerson);
document.getElementById('btn-delete-person').addEventListener('click', deletePerson);

function renderAvatarPreview() {
  const slot = document.getElementById('person-avatar-preview');
  if (!slot) return;
  if (_editingAvatar) {
    slot.innerHTML = `<img src="${_editingAvatar}" alt="" style="width:80px;height:80px;object-fit:cover;border-radius:50%;border:2px solid #cbd5e1;">`;
  } else {
    slot.innerHTML = `<div style="width:80px;height:80px;border-radius:50%;border:2px dashed #cbd5e1;background:#f8fafc;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:11px;text-align:center;padding:4px;">нет фото</div>`;
  }
}

document.getElementById('person-avatar-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    alert('Файл больше 5 МБ. Уменьшите размер.');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const SIZE = 200;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext('2d');

      const minSide = Math.min(img.width, img.height);
      const sx = (img.width - minSide) / 2;
      const sy = (img.height - minSide) / 2;

      ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, SIZE, SIZE);

      const keepAlpha = file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/svg+xml';
      _editingAvatar = keepAlpha
        ? canvas.toDataURL('image/png')
        : canvas.toDataURL('image/jpeg', 0.88);
      renderAvatarPreview();
    };
    img.onerror = () => alert('Не удалось прочитать изображение');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

document.getElementById('person-avatar-remove').addEventListener('click', () => {
  _editingAvatar = '';
  document.getElementById('person-avatar-file').value = '';
  renderAvatarPreview();
});

function openPersonModal(id) {
  editingPersonId = id;
  const noteEl = document.getElementById('person-note');
  if (id) {
    const p = state.people.find(x => x.id === id);
    personNameEl.value = p ? p.name : '';
    noteEl.value = p && p.note ? p.note : '';
    _editingAvatar = (p && p.avatar) ? p.avatar : '';
    personModalTitle.textContent = 'Редактировать';
    btnDeletePerson.style.display = 'inline-block';
  } else {
    personNameEl.value = '';
    noteEl.value = '';
    _editingAvatar = '';
    personModalTitle.textContent = 'Новый ответственный';
    btnDeletePerson.style.display = 'none';
  }
  document.getElementById('person-avatar-file').value = '';
  renderAvatarPreview();
  personModal.classList.add('open');
  setTimeout(() => personNameEl.focus(), 50);
}

async function editPersonNote(el, personId, currentVal) {
  if (el.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'person-note-input';
  input.value = currentVal;
  input.placeholder = 'в отпуске / стажёр / на больничном…';
  el.textContent = '';
  el.appendChild(input);
  input.focus();
  input.select();

  let saved = false;
  async function save() {
    if (saved) return;
    saved = true;
    const val = input.value.trim();
    await fetch(`/api/people/${personId}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ note: val })
    });
  }
  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { saved = true; input.removeEventListener('blur', save); render(); }
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });
}

async function savePerson() {
  const name = personNameEl.value.trim();
  const note = document.getElementById('person-note').value.trim();
  if (!name) return;
  const url = editingPersonId ? `/api/people/${editingPersonId}` : '/api/people';
  const method = editingPersonId ? 'PUT' : 'POST';
  const body = editingPersonId
    ? { name, note, avatar: _editingAvatar }
    : { name, note, avatar: _editingAvatar, board_id: currentBoardId };
  const r = await fetch(url, { method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
  if (r.ok) personModal.classList.remove('open');
  else alert('Ошибка: ' + (await r.json()).error);
}
async function deletePerson() {
  if (!editingPersonId) return;
  if (!confirm('Удалить человека?')) return;
  await fetch(`/api/people/${editingPersonId}`, { method: 'DELETE' });
  personModal.classList.remove('open');
}

// ============ PLAN MODAL ============
const planModal = document.getElementById('plan-modal');
const planPersonEl = document.getElementById('plan-person');
const planHorizonEl = document.getElementById('plan-horizon');
const planTitleEl = document.getElementById('plan-title');
const planDueEl = document.getElementById('plan-due');
const planPriorityEl = document.getElementById('plan-priority');
const planModalTitle = document.getElementById('plan-modal-title');
const btnDeletePlan = document.getElementById('btn-delete-plan');
let editingPlanId = null;

document.getElementById('btn-add-plan').addEventListener('click', () => openPlanModal(null));
document.getElementById('btn-cancel-plan').addEventListener('click', () => planModal.classList.remove('open'));
document.getElementById('btn-save-plan').addEventListener('click', savePlan);
document.getElementById('btn-delete-plan').addEventListener('click', deletePlan);
document.getElementById('btn-clear-due').addEventListener('click', () => { planDueEl.value = ''; });

function openPlanModal(id) {
  const people = peopleOfBoard();
  if (!people.length) { alert('Сначала добавьте ответственного'); return; }
  editingPlanId = id;
  planPersonEl.innerHTML = people.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  if (id) {
    const p = state.plans.find(x => x.id === id);
    if (p) {
      planPersonEl.value = p.person_id;
      planHorizonEl.value = p.horizon;
      planTitleEl.value = p.title;
      planDueEl.value = p.due_date || '';
      planPriorityEl.value = p.priority !== undefined ? p.priority : 1;
    }
    planModalTitle.textContent = 'Редактировать план';
    btnDeletePlan.style.display = 'inline-block';
  } else {
    planTitleEl.value = ''; planHorizonEl.value = 'week'; planDueEl.value = ''; planPriorityEl.value = '1';
    planModalTitle.textContent = 'Новый план';
    btnDeletePlan.style.display = 'none';
  }
  planModal.classList.add('open');
  setTimeout(() => planTitleEl.focus(), 50);
}
async function savePlan() {
  const person_id = parseInt(planPersonEl.value);
  const horizon = planHorizonEl.value;
  const title = planTitleEl.value.trim();
  const due_date = planDueEl.value || null;
  const priority = parseInt(planPriorityEl.value);
  if (!person_id || !title) return;
  const url = editingPlanId ? `/api/plans/${editingPlanId}` : '/api/plans';
  const method = editingPlanId ? 'PUT' : 'POST';
  const body = editingPlanId ? { person_id, horizon, title, due_date, priority } : { person_id, horizon, title, due_date, priority, board_id: currentBoardId };
  const r = await fetch(url, { method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
  if (r.ok) planModal.classList.remove('open');
}
async function deletePlan() {
  if (!editingPlanId) return;
  if (!confirm('Удалить план?')) return;
  await fetch(`/api/plans/${editingPlanId}`, { method: 'DELETE' });
  planModal.classList.remove('open');
}

[personModal, planModal, boardModal, columnsModal, usersModal].forEach(m => {
  m.addEventListener('click', e => {
    if (e.target === m && isRealClick(e, m)) m.classList.remove('open');
  });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    personModal.classList.remove('open');
    planModal.classList.remove('open');
    boardModal.classList.remove('open');
    columnsModal.classList.remove('open');
    usersModal.classList.remove('open');
  }
});
