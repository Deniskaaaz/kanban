/* ============================================================
   best-admin.js — «Отличники службы» в админке.
   Стиль как на ТВ: постер-карточки. Клик → редактирование прямо
   в карточке (без модалки).
   ============================================================ */

let _editingBestId = null;        // id редактируемой карточки (null — новая)
let _editingBestPlace = null;     // 1 | 2 | 3
let _editingBestAvatar = '';      // base64 фото

// ---------- Главный рендер ----------
function renderBestAdmin() {
  const board = currentBoard();
  if (!board) return;

  const list = (state.best || []).filter(b => b.board_id === currentBoardId);
  const byPlace = { 1: null, 2: null, 3: null };
  list.forEach(item => { byPlace[item.place] = item; });

  mainEl.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'best-wrap';

  const header = document.createElement('div');
  header.className = 'best-header';
  header.innerHTML =
    '<h2>🏆 Отличники службы</h2>' +
    '<div class="best-sub">Кликните на карточку, чтобы отредактировать</div>';
  wrap.appendChild(header);

  const podium = document.createElement('div');
  podium.className = 'best-podium';

  [2, 1, 3].forEach(place => {
    podium.appendChild(buildCard(place, byPlace[place]));
  });

  wrap.appendChild(podium);
  mainEl.appendChild(wrap);
}

// ---------- Карточка (просмотр или редактирование) ----------
function buildCard(place, item) {
  const isEditing = _editingBestPlace === place;
  const card = document.createElement('div');
  card.className = 'best-card place-' + place;
  card.dataset.place = place;

  // Слот пустой
  if (!item && !isEditing) {
    card.classList.add('empty');
    card.innerHTML =
      '<div class="best-empty-icon">+</div>' +
      '<div class="best-empty-text">Свободно<br><span style="font-size:12px;">нажмите, чтобы добавить</span></div>';
    card.addEventListener('click', () => startEdit(place, null));
    return card;
  }

  // Режим редактирования
  if (isEditing) {
    return buildEditCard(place, item);
  }

  // Режим просмотра (item существует)
  card.dataset.id = item.id;

  // Медаль
  const medal = document.createElement('div');
  medal.className = 'best-medal';
  card.appendChild(medal);

  // Фото
  const av = document.createElement('div');
  av.className = 'best-avatar';
  if (item.avatar) {
    av.innerHTML = '<img src="' + item.avatar + '" alt="">';
  } else {
    av.textContent = getInitials(item.name);
  }
  card.appendChild(av);

  // Имя
  const name = document.createElement('div');
  name.className = 'best-name';
  name.textContent = item.name;
  card.appendChild(name);

  // Комментарий
  if (item.comment) {
    const comm = document.createElement('div');
    comm.className = 'best-comment';
    comm.textContent = item.comment;
    card.appendChild(comm);
  }

  // Ховер-кнопки: удалить
  const actions = document.createElement('div');
  actions.className = 'best-actions';
  actions.innerHTML = '<button title="Удалить" data-act="del" class="danger">✕</button>';
  actions.querySelector('[data-act="del"]').addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm('Удалить «' + item.name + '» с доски?')) return;
    await fetch('/api/best/' + item.id, { method: 'DELETE' });
  });
  card.appendChild(actions);

  // Клик → редактировать
  card.addEventListener('click', () => startEdit(place, item));

  return card;
}

// ---------- Карточка в режиме редактирования ----------
function buildEditCard(place, item) {
  const isNew = !item;
  const card = document.createElement('div');
  card.className = 'best-card place-' + place + ' best-card-edit';

  // Фон-фото
  const av = document.createElement('div');
  av.className = 'best-avatar';
  if (_editingBestAvatar) {
    av.innerHTML = '<img src="' + _editingBestAvatar + '" alt="">';
  } else {
    av.textContent = isNew ? '?' : getInitials(item.name || '');
  }
  card.appendChild(av);

  // Скрытый input для файла
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/webp';
  fileInput.style.display = 'none';
  card.appendChild(fileInput);
  fileInput.addEventListener('change', e => handleFileChange(e, av, isNew ? '' : (item.name || '')));

  // Оверлей редактирования
  const overlay = document.createElement('div');
  overlay.className = 'best-edit-overlay';

  // Кнопка загрузки фото — ЯВНАЯ
  const photoBtn = document.createElement('button');
  photoBtn.type = 'button';
  photoBtn.className = 'best-edit-photo-btn';
  photoBtn.innerHTML = '📷 ' + (_editingBestAvatar ? 'Изменить фото' : 'Загрузить фото');
  photoBtn.addEventListener('click', e => {
    e.stopPropagation();
    fileInput.click();
  });
  overlay.appendChild(photoBtn);

  if (_editingBestAvatar) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'best-edit-photo-remove';
    removeBtn.textContent = 'Удалить фото';
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      _editingBestAvatar = '';
      av.innerHTML = isNew ? '?' : getInitials(item.name || '');
      removeBtn.remove();
      photoBtn.innerHTML = '📷 Загрузить фото';
    });
    overlay.appendChild(removeBtn);
  }

  // Поля
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'best-edit-input';
  nameInput.placeholder = 'ФИО';
  nameInput.value = isNew ? '' : (item.name || '');
  overlay.appendChild(nameInput);

  const commInput = document.createElement('textarea');
  commInput.className = 'best-edit-textarea';
  commInput.placeholder = 'За что отличился';
  commInput.maxLength = 500;
  commInput.rows = 3;
  commInput.value = isNew ? '' : (item.comment || '');
  overlay.appendChild(commInput);

  // Кнопки
  const btns = document.createElement('div');
  btns.className = 'best-edit-btns';

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'best-edit-btn danger';
  delBtn.textContent = '🗑';
  delBtn.title = 'Удалить';
  delBtn.style.visibility = isNew ? 'hidden' : 'visible';
  delBtn.style.flex = '0 0 44px';
  delBtn.addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm('Удалить «' + item.name + '» с доски?')) return;
    await fetch('/api/best/' + item.id, { method: 'DELETE' });
    cancelEdit();
  });
  btns.appendChild(delBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'best-edit-btn secondary';
  cancelBtn.textContent = 'Отмена';
  cancelBtn.addEventListener('click', e => {
    e.stopPropagation();
    cancelEdit();
  });
  btns.appendChild(cancelBtn);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'best-edit-btn primary';
  saveBtn.textContent = '✓ Сохранить';
  saveBtn.addEventListener('click', async e => {
    e.stopPropagation();
    await saveCard(place, item, nameInput.value, commInput.value);
  });
  btns.appendChild(saveBtn);

  overlay.appendChild(btns);
  card.appendChild(overlay);

  // Не закрывать при клике внутрь
  card.addEventListener('click', e => e.stopPropagation());

  // Enter в поле ФИО — сохранить, Esc — отмена
  nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveCard(place, item, nameInput.value, commInput.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  });
  commInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveCard(place, item, nameInput.value, commInput.value);
    }
  });

  // Автофокус
  setTimeout(() => nameInput.focus(), 30);

  return card;
}

// ---------- Действия ----------
function startEdit(place, item) {
  _editingBestId = item ? item.id : null;
  _editingBestPlace = place;
  _editingBestAvatar = item ? (item.avatar || '') : '';
  renderBestAdmin();
}

function cancelEdit() {
  _editingBestId = null;
  _editingBestPlace = null;
  _editingBestAvatar = '';
  renderBestAdmin();
}

async function saveCard(place, item, name, comment) {
  name = (name || '').trim();
  comment = (comment || '').trim();
  if (!name) { alert('Укажите ФИО'); return; }

  const payload = { place, name, comment, avatar: _editingBestAvatar };

  let url, method;
  if (item && item.id) {
    url = '/api/best/' + item.id;
    method = 'PUT';
  } else {
    url = '/api/best';
    method = 'POST';
    payload.board_id = currentBoardId;
  }

  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (r.ok) {
    _editingBestId = null;
    _editingBestPlace = null;
    _editingBestAvatar = '';
    // Рендер придёт через socket
  } else {
    const err = await r.json().catch(() => ({}));
    alert('Ошибка: ' + (err.error || r.status));
  }
}

function handleFileChange(e, avEl, fallbackInitials) {
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
      const SIZE = 400;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      const minSide = Math.min(img.width, img.height);
      const sx = (img.width - minSide) / 2;
      const sy = (img.height - minSide) / 2;
      ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, SIZE, SIZE);
      const keepAlpha = file.type === 'image/png' || file.type === 'image/webp';
      _editingBestAvatar = keepAlpha
        ? canvas.toDataURL('image/png')
        : canvas.toDataURL('image/jpeg', 0.9);

      // Обновить превью прямо в карточке
      if (avEl) {
        avEl.innerHTML = '<img src="' + _editingBestAvatar + '" alt="">';
      }

      // Обновить кнопку + добавить кнопку "удалить фото" если её нет
      const photoBtn = document.querySelector('.best-edit-photo-btn');
      if (photoBtn) photoBtn.innerHTML = '📷 Изменить фото';

      if (!document.querySelector('.best-edit-photo-remove')) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'best-edit-photo-remove';
        removeBtn.textContent = 'Удалить фото';
        removeBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          _editingBestAvatar = '';
          if (avEl) avEl.innerHTML = fallbackInitials ? getInitials(fallbackInitials) : '?';
          removeBtn.remove();
          if (photoBtn) photoBtn.innerHTML = '📷 Загрузить фото';
        });
        if (photoBtn) photoBtn.after(removeBtn);
      }
    };
    img.onerror = () => alert('Не удалось прочитать изображение');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// ---------- Перехват render() ----------
(function wrapRenderForBest() {
  const _orig = window.render;
  if (typeof _orig !== 'function') return;
  window.render = function() {
    const board = currentBoard();
    if (board && board.type === 'best') {
      document.querySelectorAll('[data-kanban-only]').forEach(el => el.style.display = 'none');
      document.querySelectorAll('[data-kulebin-only]').forEach(el => el.style.display = 'none');
      renderBestAdmin();
      if (typeof renderTvLockBtn === 'function') renderTvLockBtn();
      return;
    }
    _orig.apply(this, arguments);
  };
})();
