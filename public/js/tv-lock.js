/* ============================================================
   tv-lock.js — кнопка фиксации доски на ТВ.
   Подключается в admin.html ПОСЛЕ admin.js.
   Использует переменные admin.js: me, state, currentBoardId, socket.
   ============================================================ */

function renderTvLockBtn() {
  const btn = document.getElementById('btn-tv-lock');
  if (!btn) return;
  if (!me || me.role !== 'admin') { btn.style.display = 'none'; return; }
  btn.style.display = '';

  const lockId = parseInt(state && state.settings && state.settings.tv_lock_board_id) || 0;

  if (lockId === currentBoardId) {
    btn.classList.add('active');
    btn.textContent = '📺 Открепить ТВ';
    btn.title = 'ТВ зафиксирован на этой доске. Клик — вернуть ротацию.';
  } else if (lockId) {
    const lockedBoard = state.boards.find(b => b.id === lockId);
    btn.classList.remove('active');
    btn.textContent = '📺 Перевести ТВ сюда';
    btn.title = 'ТВ сейчас на «' + (lockedBoard ? lockedBoard.name : '?') + '». Клик — переключить.';
  } else {
    btn.classList.remove('active');
    btn.textContent = '📺 На ТВ';
    btn.title = 'Зафиксировать текущую доску на всех ТВ (без ротации).';
  }
}

async function toggleTvLock() {
  if (!me || me.role !== 'admin') return;
  const lockId = parseInt(state && state.settings && state.settings.tv_lock_board_id) || 0;
  const newLock = (lockId === currentBoardId) ? null : currentBoardId;

  const r = await fetch('/api/tv/lock', {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ board_id: newLock })
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    alert('Ошибка: ' + (err.error || r.status));
  }
}

(function initTvLock() {
  const btn = document.getElementById('btn-tv-lock');
  if (btn) btn.addEventListener('click', toggleTvLock);

  // Перерисовка кнопки при каждом обновлении состояния от сервера.
  socket.on('board:update', () => {
    setTimeout(renderTvLockBtn, 0);
  });

  // И при смене доски в селекте (клик по опции).
  const boardSelect = document.getElementById('board-select');
  if (boardSelect) boardSelect.addEventListener('change', () => setTimeout(renderTvLockBtn, 0));

  renderTvLockBtn();
})();
