/* ============================================================
   best-tv.js — доска «Отличники службы» на ТВ.
   Перехватывает window.render() и, если текущая доска best,
   рисует крупный подиум 1-2-3.
   ============================================================ */

function renderBestTV() {
  if (!lastData) return;

  const board = lastData.boards.find(b => b.id === currentBoardId);
  if (!board) return;

  const list = (lastData.best || []).filter(b => b.board_id === currentBoardId);
  const byPlace = { 1: null, 2: null, 3: null };
  list.forEach(item => { byPlace[item.place] = item; });

  mainEl.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'best-wrap';

  const header = document.createElement('div');
  header.className = 'best-header';
  header.innerHTML =
    '<h2>🏆 Отличники службы</h2>' +
    '<div class="best-sub">' + escapeHtml(board.name) + '</div>';
  wrap.appendChild(header);

  const podium = document.createElement('div');
  podium.className = 'best-podium';

  [2, 1, 3].forEach(place => {
    podium.appendChild(buildBestCardTV(place, byPlace[place]));
  });

  wrap.appendChild(podium);
  mainEl.appendChild(wrap);
}

function buildBestCardTV(place, item) {
  const card = document.createElement('div');
  card.className = 'best-card place-' + place;

  if (!item) {
    card.classList.add('empty');
    card.innerHTML =
      '<div class="best-empty-icon">—</div>' +
      '<div class="best-empty-text">Место свободно</div>';
    return card;
  }

  const medal = document.createElement('div');
  medal.className = 'best-medal';
  card.appendChild(medal);

  const av = document.createElement('div');
  av.className = 'best-avatar';
  if (item.avatar) {
    av.innerHTML = '<img src="' + item.avatar + '" alt="">';
  } else {
    av.textContent = getInitials(item.name);
  }
  card.appendChild(av);

  const name = document.createElement('div');
  name.className = 'best-name';
  name.textContent = item.name;
  card.appendChild(name);

  if (item.comment) {
    const comm = document.createElement('div');
    comm.className = 'best-comment';
    comm.textContent = item.comment;
    card.appendChild(comm);
  }

  return card;
}

// ---------- Перехват render() ----------
(function wrapRenderForBestTV() {
  const _orig = window.render;
  if (typeof _orig !== 'function') return;
  window.render = function() {
    if (!lastData) return _orig.apply(this, arguments);
    const board = lastData.boards.find(b => b.id === currentBoardId);
    if (board && board.type === 'best') {
      // Скрываем алерты — они только для канбана
      const alertsEl = document.getElementById('alerts');
      if (alertsEl) alertsEl.style.display = 'none';
      renderBestTV();
      return;
    }
    // Возвращаем алерты (если ушли с best-доски)
    const alertsEl = document.getElementById('alerts');
    if (alertsEl) alertsEl.style.display = '';
    _orig.apply(this, arguments);
  };
})();
