/* ============================================================
   tv.js — логика ТВ-версии
   ============================================================ */

const params = new URLSearchParams(location.search);
const rotateList = (params.get('rotate') || '').split(',').map(s => parseInt(s)).filter(n => !isNaN(n));
let currentBoardId = parseInt(params.get('board')) || (rotateList[0] || parseInt(localStorage.getItem('tvBoardId')) || 1);
let rotateIndex = rotateList.indexOf(currentBoardId);
if (rotateIndex < 0) rotateIndex = 0;
let ROTATE_INTERVAL = 30 * 1000;
let carouselTimer = null;

const AUTOSCROLL_SPEED = 30;
const AUTOSCROLL_PAUSE = 3000;

const socket = io({ reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
const statusEl = document.getElementById('status');
const mainEl   = document.getElementById('main-area');
let lastDisconnectAt = null;
let lastUpdateAt = Date.now();
let lastData = null;
let rotateListFiltered = false;
const STALE_RELOAD_MS = 60 * 1000;
const HIDDEN_RELOAD_MS = 10 * 60 * 1000;

// ===== Часы =====
function tickClock() {
  const now = new Date();
  document.getElementById('clock').textContent =
    String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const days = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  document.getElementById('date').textContent =
    days[now.getDay()] + ', ' + now.getDate() + ' ' + months[now.getMonth()];
}
tickClock();
setInterval(tickClock, 30 * 1000);

// ===== Ночной режим (22:00 – 07:00) =====
function applyNightMode() {
  const h = new Date().getHours();
  const night = (h >= 22 || h < 7);
  document.body.classList.toggle('night', night);
}
applyNightMode();
setInterval(applyNightMode, 5 * 60 * 1000);

// ===== Карусель =====
function startCarousel() {
  if (carouselTimer) return;
  if (rotateList.length < 2) return;
  carouselTimer = setInterval(() => {
    rotateIndex = (rotateIndex + 1) % rotateList.length;
    currentBoardId = rotateList[rotateIndex];
    localStorage.setItem('tvBoardId', currentBoardId);
    if (lastData) render();
  }, ROTATE_INTERVAL);
}

function updateInterval(newMs) {
  ROTATE_INTERVAL = newMs;
  if (carouselTimer) {
    clearInterval(carouselTimer);
    carouselTimer = null;
  }
  startCarousel();
}

// ===== Socket =====
socket.on('connect', () => {
  statusEl.textContent = 'online';
  statusEl.classList.remove('offline');
  lastDisconnectAt = null;
});
socket.on('disconnect', () => {
  statusEl.textContent = 'offline';
  statusEl.classList.add('offline');
  lastDisconnectAt = Date.now();
});
socket.on('board:update', data => {
  lastUpdateAt = Date.now();
  lastData = data;

  if (!rotateListFiltered) {
    rotateListFiltered = true;
    if (rotateList.length > 0) {
      const existing = new Set(data.boards.map(b => b.id));
      const filtered = rotateList.filter(id => existing.has(id));
      rotateList.length = 0;
      if (filtered.length === 0) {
        data.boards.forEach(b => rotateList.push(b.id));
      } else {
        filtered.forEach(id => rotateList.push(id));
      }
    } else if (!params.get('board')) {
      data.boards.forEach(b => rotateList.push(b.id));
    }
    rotateIndex = rotateList.indexOf(currentBoardId);
    if (rotateIndex < 0) rotateIndex = 0;
    if (rotateList.length && !rotateList.includes(currentBoardId)) {
      currentBoardId = rotateList[0];
    }
  }

  if (!data.boards.find(b => b.id === currentBoardId) && data.boards.length) {
    currentBoardId = data.boards[0].id;
  }

  const intervalSec = parseInt(data.settings?.rotate_interval) || 30;
  const newMs = Math.max(5, Math.min(3600, intervalSec)) * 1000;
  if (newMs !== ROTATE_INTERVAL) {
    updateInterval(newMs);
  } else {
    startCarousel();
  }

  render();
});

// ===== Render =====
function render() {
  if (!lastData) return;
  const { boards, people: allPeople, plans: allPlans, kulebin } = lastData;

  const board = boards.find(b => b.id === currentBoardId);
  if (!board) {
    if (boards.length) {
      currentBoardId = boards[0].id;
      rotateIndex = rotateList.indexOf(currentBoardId);
      if (rotateIndex < 0) rotateIndex = 0;
    }
    return;
  }

  document.getElementById('board-name').textContent = board.name;

  const logoUrl = lastData.settings?.logo_data_url || '';
  const logoEl = document.getElementById('tv-logo');
  const titleEl = document.getElementById('tv-title');
  if (logoUrl) {
    if (logoEl.getAttribute('src') !== logoUrl) logoEl.setAttribute('src', logoUrl);
    logoEl.style.display = 'inline-block';
    titleEl.style.display = 'none';
  } else {
    logoEl.style.display = 'none';
    titleEl.style.display = '';
  }

  const people = allPeople.filter(p => p.board_id === currentBoardId);
  const isKanban = board.type !== 'kulebin';
  document.getElementById('alerts').style.display = isKanban ? '' : 'none';

  if (board.type === 'kulebin') {
    renderKulebin(people, kulebin);
  } else {
    renderKanban(people, allPlans.filter(p => p.board_id === currentBoardId).filter(p => !isArchived(p)));
  }
}

// ===== Итоги таблицы =====
function computeTotals(people, columns, kulebinAll) {
  const totals = {};
  columns.forEach(col => {
    if (col.kind === 'amount') {
      let sum = 0;
      people.forEach(p => {
        const k = kulebinAll.find(x => x.person_id === p.id) || { values: {} };
        const v = parseFloat(k.values ? k.values[col.key] : 0);
        if (!isNaN(v)) sum += v;
      });
      totals[col.key] = { sum, totalPlan: (col.plan || 0) * people.length };
    } else if (col.kind === 'efficiency') {
      let sum = 0, cnt = 0;
      people.forEach(p => {
        const k = kulebinAll.find(x => x.person_id === p.id) || { values: {} };
        const v = parseInt(k.values ? k.values[col.key] : 0);
        if (!isNaN(v)) { sum += v; cnt++; }
      });
      totals[col.key] = { avg: cnt ? Math.round(sum / cnt) : 0 };
    } else if (col.kind === 'attendance') {
      let sum = 0;
      people.forEach(p => {
        const k = kulebinAll.find(x => x.person_id === p.id) || { values: {} };
        const v = parseFloat(k.values ? k.values[col.key] : 0);
        if (!isNaN(v)) sum += v;
      });
      totals[col.key] = { sum };
    }
  });
  return totals;
}

function renderKulebin(people, kulebinAll) {
  const board = lastData.boards.find(b => b.id === currentBoardId);
  const columns = (board && board.columns) ? board.columns : [];

  mainEl.innerHTML = '';
  const viewport = document.createElement('div');
  viewport.className = 'kulebin-viewport';

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
      ? `<span class="col-plan">План: ${formatNumber(c.plan)} ${escapeHtml(c.unit || '₽')}</span>`
      : '';
    return `<div><span class="col-label">${escapeHtml(c.label)}</span>${planTxt}</div>`;
  }).join('');
  viewport.appendChild(head);

  if (!people.length) {
    const empty = document.createElement('div');
    empty.className = 'kulebin-empty';
    empty.textContent = 'Сотрудников пока нет';
    viewport.appendChild(empty);
    mainEl.appendChild(viewport);
    return;
  }

  const rowsWrapper = document.createElement('div');
  rowsWrapper.className = 'kulebin-rows-wrapper';
  const rowsTrack = document.createElement('div');
  rowsTrack.className = 'kulebin-rows-track';
  rowsWrapper.appendChild(rowsTrack);
  viewport.appendChild(rowsWrapper);

  people.forEach(p => {
    const k = kulebinAll.find(x => x.person_id === p.id) || { values: {} };
    const values = k.values || {};
    const row = document.createElement('div');
    row.className = 'kulebin-row';
    row.style.gridTemplateColumns = gridCols;

    const nameDiv = document.createElement('div');
    nameDiv.className = 'kulebin-name';
    nameDiv.style.flexDirection = 'column';
    nameDiv.style.alignItems = 'flex-start';
    nameDiv.style.gap = '4px';
    const noteHtml = p.note
      ? `<div style="font-size:13px;color:#94a3b8;font-style:italic;line-height:1.3;">${escapeHtml(p.note)}</div>`
      : '';
    nameDiv.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;">
        ${avatarHtml(p, 'xl', personColor(p.id, people))}
        <span>${escapeHtml(p.name)}</span>
      </div>
      ${noteHtml}
    `;
    row.appendChild(nameDiv);

    columns.forEach(col => {
      const raw = values[col.key];
      if (col.kind === 'efficiency') {
        const eff = document.createElement('div');
        const numVal = parseInt(raw) || 0;
        eff.className = 'kulebin-eff ' + effClass(numVal);
        eff.textContent = numVal + '%';
        row.appendChild(eff);
      } else if (col.kind === 'attendance') {
        const cell = document.createElement('div');
        cell.className = 'kulebin-attendance';
        const v = parseFloat(raw);
        if (isNaN(v)) {
          cell.innerHTML = `<div class="att-value empty">—</div>`;
        } else {
          const display = v.toFixed(2).replace('.', ',');
          const color = attendanceColor(v);
          const widthPct = Math.min(100, v * 100);
          cell.innerHTML = `
            <div class="att-value" style="background:${color}">${display}</div>
            <div class="att-bar"><div class="att-bar-fill" style="width:${widthPct}%;background:${color}"></div></div>
          `;
        }
        row.appendChild(cell);
      } else if (col.kind === 'amount') {
        const cell = document.createElement('div');
        cell.className = 'kulebin-amount';
        const num = parseFloat(raw);
        const unit = col.unit || '₽';
        const hasValue = !isNaN(num) && num > 0;
        const pct = calcPercent(num, col.plan);
        if (!hasValue) {
          cell.innerHTML = `<div class="amount-value empty">—</div>`;
        } else {
          const pctHtml = pct === null ? '' : `
            <div class="amount-bar-wrap">
              <div class="amount-bar"><div class="amount-bar-fill ${pctClass(pct)}" style="width:${Math.min(100, pct)}%"></div></div>
              <div class="amount-pct ${pctClass(pct)}">${pct}%</div>
            </div>`;
          cell.innerHTML = `
            <div class="amount-value">${formatNumber(num)} ${escapeHtml(unit)}</div>
            ${pctHtml}
          `;
        }
        row.appendChild(cell);
      } else {
        const cell = document.createElement('div');
        cell.className = 'kulebin-cell';
        const v = raw || '';
        cell.textContent = v || '—';
        if (!v) cell.classList.add('empty');
        row.appendChild(cell);
      }
    });

    rowsTrack.appendChild(row);
  });

  const totals = computeTotals(people, columns, kulebinAll);
  const totalRow = document.createElement('div');
  totalRow.className = 'kulebin-total';
  totalRow.style.gridTemplateColumns = gridCols;

  const totalLabel = document.createElement('div');
  totalLabel.className = 'total-label';
  totalLabel.textContent = 'Итого';
  totalRow.appendChild(totalLabel);

  columns.forEach(col => {
    if (col.kind === 'amount') {
      const cell = document.createElement('div');
      cell.className = 'kulebin-amount';
      const sum = totals[col.key]?.sum || 0;
      const totalPlan = totals[col.key]?.totalPlan || 0;
      const pct = totalPlan > 0 ? Math.min(999, Math.round((sum / totalPlan) * 100)) : null;
      if (sum === 0) {
        cell.innerHTML = `<div class="amount-value empty">—</div>`;
      } else {
        const pctHtml = pct === null ? '' : `
          <div class="amount-bar-wrap">
            <div class="amount-bar"><div class="amount-bar-fill ${pctClass(pct)}" style="width:${Math.min(100, pct)}%"></div></div>
            <div class="amount-pct ${pctClass(pct)}">${pct}%</div>
          </div>`;
        cell.innerHTML = `
          <div class="amount-value">${formatNumber(sum)} ${escapeHtml(col.unit || '₽')}</div>
          ${pctHtml}
        `;
      }
      totalRow.appendChild(cell);
    } else if (col.kind === 'efficiency') {
      const eff = document.createElement('div');
      const avg = totals[col.key]?.avg || 0;
      eff.className = 'kulebin-eff ' + effClass(avg);
      eff.textContent = avg + '%';
      totalRow.appendChild(eff);
    } else if (col.kind === 'attendance') {
      const cell = document.createElement('div');
      cell.className = 'kulebin-attendance';
      const sum = totals[col.key]?.sum || 0;
      if (sum === 0) {
        cell.innerHTML = `<div class="att-value empty">0,00</div>`;
      } else {
        const display = sum.toFixed(2).replace('.', ',');
        cell.innerHTML = `<div class="att-value" style="background:#7c3aed">Σ ${display}</div>`;
      }
      totalRow.appendChild(cell);
    } else {
      const cell = document.createElement('div');
      cell.className = 'kulebin-cell';
      cell.textContent = '';
      totalRow.appendChild(cell);
    }
  });

  rowsTrack.appendChild(totalRow);
  mainEl.appendChild(viewport);

  runAutoScrollGeneric(rowsWrapper, rowsTrack);
}

// ===== Рендер канбана =====
function renderKanban(people, plans) {
  let lateCount = 0, todayCount = 0, highCount = 0;
  plans.forEach(p => {
    if (p.horizon === 'done') return;
    if (p.priority === 2) highCount++;
    const d = dayDiff(p.due_date);
    if (d === null) return;
    if (d < 0) lateCount++;
    else if (d === 0) todayCount++;
  });
  const ah = document.getElementById('alert-high'), al = document.getElementById('alert-late'), at = document.getElementById('alert-today');
  ah.textContent = '🔴 важных: ' + highCount;
  al.textContent = '🔥 просрочено: ' + lateCount;
  at.textContent = '⏰ сегодня: ' + todayCount;
  ah.style.display = highCount ? 'inline-block' : 'none';
  al.style.display = lateCount ? 'inline-block' : 'none';
  at.style.display = todayCount ? 'inline-block' : 'none';

  mainEl.innerHTML = '';
  const boardEl = document.createElement('div');
  boardEl.className = 'board';
  mainEl.appendChild(boardEl);

  HORIZONS.forEach(h => {
    const col = document.createElement('div');
    col.className = 'column col-' + h.key;
    col.dataset.horizon = h.key;
    col.innerHTML = `
      <div class="col-title">
        <span class="col-title-left">
          <span class="col-icon">${ICONS[h.key] || ''}</span>
          <span>${h.label}</span>
        </span>
        <span class="col-count">0</span>
      </div>
      <div class="col-body-wrapper"><div class="col-body"></div></div>
    `;
    boardEl.appendChild(col);

    const body = col.querySelector('.col-body');
    const countEl = col.querySelector('.col-count');
    let html = '', count = 0;

    if (h.key === 'people') {
      count = people.length;
      if (!people.length) html = '<div class="empty">нет ответственных</div>';
      else people.forEach(p => {
        const noteHtml = p.note
          ? `<div style="font-size:13px;color:#94a3b8;font-style:italic;margin-top:2px;">${escapeHtml(p.note)}</div>`
          : '';
        html += `<div class="card person-card" style="align-items:flex-start;">
          ${avatarHtml(p, 'xl', personColor(p.id, people))}
          <div style="display:flex;flex-direction:column;flex:1;min-width:0;">
            <span class="person-badge">${escapeHtml(p.name)}</span>
            ${noteHtml}
          </div>
        </div>`;
      });
    } else {
      const byPerson = {};
      plans.filter(p => p.horizon === h.key).forEach(p => {
        if (!byPerson[p.person_id]) byPerson[p.person_id] = [];
        byPerson[p.person_id].push(p); count++;
      });
      if (!count) html = '<div class="empty">пусто</div>';
      else people.forEach(person => {
        const tasks = byPerson[person.id];
        if (!tasks || !tasks.length) return;
        const hasLate = tasks.some(t => dayDiff(t.due_date) !== null && dayDiff(t.due_date) < 0);
        const hasHigh = tasks.some(t => t.priority === 2);
        const tasksHtml = tasks.map(t => {
          const dc = t.priority === 2 ? 'high' : (t.priority === 0 ? 'low' : '');
          const cls = dueClass(t.due_date, '');
          const lbl = dueLabel(t.due_date);
          const dueSpan = lbl ? `<span class="task-due ${cls}">${lbl}</span>` : '';
          return `<div class="task"><span class="task-dot ${dc}"></span>${escapeHtml(t.title)}${dueSpan}</div>`;
        }).join('');
        const cardCls = 'card' + (hasLate ? ' has-late' : (hasHigh ? ' has-high' : ''));
        html += `<div class="${cardCls}">
          <div class="card-name">
            ${avatarHtml(person, 'md', personColor(person.id, people))}
            <span>${escapeHtml(person.name)}</span>
          </div>${tasksHtml}</div>`;
      });
    }
    if (body.innerHTML.trim() !== html.trim()) {
      body.innerHTML = html;
      body.style.transition = 'none';
      body.style.transform = 'translateY(0)';
    }
    countEl.textContent = count;
  });

  ensureAutoScroll();
}

// ===== Автоскролл =====
const autoScrollState = new WeakMap();
const delay = ms => new Promise(r => setTimeout(r, ms));

function ensureAutoScroll() {
  document.querySelectorAll('.column').forEach(col => {
    const wrapper = col.querySelector('.col-body-wrapper');
    const body = col.querySelector('.col-body');
    if (!wrapper || !body) return;
    runAutoScrollGeneric(wrapper, body);
  });
}

function runAutoScrollGeneric(container, track) {
  const state = autoScrollState.get(container);
  if (state && state.running) return;
  autoScrollState.set(container, { running: true });
  runLoop(container, track);
}

async function runLoop(container, track) {
  await delay(1500);

  while (container.isConnected) {
    const overflow = track.offsetHeight - container.clientHeight;

    if (overflow < 30) {
      await delay(4000);
      continue;
    }

    track.style.transition = 'none';
    track.style.transform = 'translateY(0)';
    await delay(50);

    await delay(AUTOSCROLL_PAUSE);
    if (!container.isConnected) break;

    const duration = (overflow / AUTOSCROLL_SPEED) * 1000;

    track.style.transition = `transform ${duration}ms linear`;
    track.style.transform = `translateY(-${overflow}px)`;
    await delay(duration);

    await delay(AUTOSCROLL_PAUSE);
    if (!container.isConnected) break;

    track.style.transition = `transform ${duration}ms linear`;
    track.style.transform = 'translateY(0)';
    await delay(duration);
  }
}

// ===== Самовосстановление =====
setInterval(() => { if (lastDisconnectAt && Date.now() - lastDisconnectAt > STALE_RELOAD_MS) location.reload(); }, 15 * 1000);
setInterval(() => { if (document.hidden && Date.now() - lastUpdateAt > HIDDEN_RELOAD_MS) location.reload(); }, 60 * 1000);
setInterval(() => location.reload(), 6 * 60 * 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (socket.disconnected) socket.connect();
    lastUpdateAt = Date.now();
  }
});
