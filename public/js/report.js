/* ============================================================
   report.js — логика страницы недельного отчёта
   ============================================================ */

// ===== Даты =====
function pad(n) { return String(n).padStart(2, '0'); }
function formatDate(d) { return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear(); }
function formatDateTime(d) { return formatDate(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }

const today = new Date(); today.setHours(23, 59, 59, 999);
const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 6); weekAgo.setHours(0, 0, 0, 0);

document.getElementById('period').textContent =
  'Период: ' + formatDate(weekAgo) + ' — ' + formatDate(today);
document.getElementById('generated').textContent =
  'Сформирован: ' + formatDateTime(new Date());

// ===== Имя пользователя в заголовке =====
fetch('/api/me').then(r => {
  if (r.status === 401) { location.href = '/login'; return null; }
  return r.json();
}).then(me => {
  if (me) document.getElementById('title').textContent = 'ОТЧЁТ ЗА НЕДЕЛЮ — ' + me.name;
});

// ===== Socket =====
const socket = io();
socket.on('board:update', data => {
  try { render(data); } catch (e) {
    document.getElementById('content').innerHTML =
      '<div class="empty">Ошибка отрисовки: ' + escapeHtml(e.message) + '</div>';
    console.error(e);
  }
});

// ===== Рендер =====
function render(state) {
  const { boards, people, plans, kulebin } = state;
  const content = document.getElementById('content');
  content.innerHTML = '';

  if (!boards.length) {
    content.innerHTML = '<div class="empty">Нет доступных досок</div>';
    return;
  }

  const totals = { tasks: 0, done: 0, overdue: 0, plan: 0, fact: 0 };

  boards.forEach(board => {
    const boardPeople = people.filter(p => p.board_id === board.id);
    const boardPlans  = plans.filter(p => p.board_id === board.id);

    const section = document.createElement('div');
    section.className = 'board-section';

    if (board.type === 'kulebin') {
      renderKulebin(section, board, boardPeople, kulebin, totals);
    } else {
      renderKanban(section, board, boardPeople, boardPlans, totals);
    }
    content.appendChild(section);
  });

  const total = document.createElement('div');
  total.className = 'total-section';
  const hasAmounts = totals.plan > 0;
  const totalPct = hasAmounts ? Math.round(totals.fact / totals.plan * 100) : 0;

  total.innerHTML = `
    <h2>ИТОГО ПО КОМПАНИИ</h2>
    <div class="total-grid">
      <div class="total-cell">
        <div class="label">Активных задач</div>
        <div class="value">${totals.tasks}</div>
      </div>
      <div class="total-cell">
        <div class="label">Закрыто за неделю</div>
        <div class="value">${totals.done}</div>
      </div>
      <div class="total-cell">
        <div class="label">Просрочено</div>
        <div class="value">${totals.overdue}</div>
      </div>
    </div>
    ${hasAmounts ? `
    <div class="total-grid" style="margin-top:24px;">
      <div class="total-cell">
        <div class="label">Общий план</div>
        <div class="value">${formatNumber(totals.plan)} ₽</div>
      </div>
      <div class="total-cell">
        <div class="label">Общий факт</div>
        <div class="value">${formatNumber(totals.fact)} ₽</div>
      </div>
      <div class="total-cell">
        <div class="label">Выполнение</div>
        <div class="value">${totalPct}%</div>
      </div>
    </div>` : ''}
  `;
  content.appendChild(total);
}

function renderKanban(section, board, boardPeople, boardPlans, totals) {
  const active = boardPlans.filter(p => p.horizon !== 'done');
  const done = boardPlans.filter(p => p.horizon === 'done');
  const doneThisWeek = done.filter(p => {
    if (!p.completed_at) return false;
    const t = new Date(p.completed_at.replace(' ', 'T') + 'Z').getTime();
    return t >= weekAgo.getTime();
  });
  const overdue = active.filter(p => {
    const d = dayDiff(p.due_date);
    return d !== null && d < 0;
  });

  totals.tasks += active.length;
  totals.done += doneThisWeek.length;
  totals.overdue += overdue.length;

  section.innerHTML = `
    <h2>${escapeHtml(board.name)}</h2>
    <div class="board-type">Канбан</div>
    <div class="stats-row">
      <div class="stat-box">
        <div class="label">Активных</div>
        <div class="value">${active.length}</div>
      </div>
      <div class="stat-box good">
        <div class="label">Закрыто за неделю</div>
        <div class="value">${doneThisWeek.length}</div>
      </div>
      <div class="stat-box ${overdue.length ? 'danger' : ''}">
        <div class="label">Просрочено</div>
        <div class="value">${overdue.length}</div>
      </div>
      <div class="stat-box">
        <div class="label">Сотрудников</div>
        <div class="value">${boardPeople.length}</div>
      </div>
    </div>
    ${boardPeople.length ? `
      <div class="people-list">
        <h3>По сотрудникам</h3>
        ${boardPeople.map(p => {
          const personActive = active.filter(t => t.person_id === p.id).length;
          const personDone = doneThisWeek.filter(t => t.person_id === p.id).length;
          const personOverdue = overdue.filter(t => t.person_id === p.id).length;
          return `
            <div class="person-row">
              <span class="person-name">${escapeHtml(p.name)}</span>
              <span class="person-stats">
                активных: <span class="big">${personActive}</span> ·
                закрыто: <span class="big">${personDone}</span>${personOverdue ? ` ·
                просрочено: <span class="big" style="color:#dc2626;">${personOverdue}</span>` : ''}
              </span>
            </div>
          `;
        }).join('')}
      </div>
    ` : ''}
  `;
}

function renderKulebin(section, board, boardPeople, kulebinAll, totals) {
  const columns = board.columns || [];
  const amountCols = columns.filter(c => c.kind === 'amount');
  const effCols = columns.filter(c => c.kind === 'efficiency');

  let html = `<h2>${escapeHtml(board.name)}</h2><div class="board-type">Таблица</div>`;

  if (amountCols.length) {
    html += '<div style="margin-bottom:20px;">';
    html += '<h3 style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #e2e8f0;">Планы</h3>';
    amountCols.forEach(col => {
      let sum = 0;
      boardPeople.forEach(p => {
        const k = kulebinAll.find(x => x.person_id === p.id) || { values: {} };
        const v = parseFloat((k.values && k.values[col.key]) || 0);
        if (!isNaN(v)) sum += v;
      });
      const totalPlan = (col.plan || 0) * boardPeople.length;
      const pct = totalPlan > 0 ? Math.min(999, Math.round((sum / totalPlan) * 100)) : null;
      totals.plan += totalPlan;
      totals.fact += sum;

      html += `
        <div class="plan-row">
          <span class="plan-name">${escapeHtml(col.label)}</span>
          <span class="plan-values">
            <span class="plan-value">${formatNumber(sum)} ${escapeHtml(col.unit || '₽')}</span>
            ${pct !== null ? `<span class="plan-pct ${pctClass(pct)}">${pct}%</span>` : ''}
          </span>
        </div>
      `;
    });
    html += '</div>';
  }

  if (effCols.length) {
    html += '<div style="margin-bottom:20px;">';
    html += '<h3 style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #e2e8f0;">Эффективность</h3>';
    effCols.forEach(col => {
      let sum = 0, cnt = 0;
      boardPeople.forEach(p => {
        const k = kulebinAll.find(x => x.person_id === p.id) || { values: {} };
        const v = parseInt((k.values && k.values[col.key]) || 0);
        if (!isNaN(v) && v > 0) { sum += v; cnt++; }
      });
      const avg = cnt ? Math.round(sum / cnt) : 0;
      html += `
        <div class="plan-row">
          <span class="plan-name">${escapeHtml(col.label)}</span>
          <span class="plan-values">
            <span class="plan-pct ${effClass(avg)}">${avg}%</span>
          </span>
        </div>
      `;
    });
    html += '</div>';
  }

  if (boardPeople.length && (amountCols.length || effCols.length)) {
    html += '<div class="people-list"><h3>По сотрудникам</h3>';
    boardPeople.forEach(p => {
      const k = kulebinAll.find(x => x.person_id === p.id) || { values: {} };
      const parts = [];
      amountCols.forEach(col => {
        const v = parseFloat((k.values && k.values[col.key]) || 0);
        if (v > 0) parts.push(`${col.label}: <span class="big">${formatNumber(v)} ${col.unit || '₽'}</span>`);
      });
      effCols.forEach(col => {
        const v = parseInt((k.values && k.values[col.key]) || 0);
        if (v > 0) parts.push(`эффективность: <span class="big">${v}%</span>`);
      });
      html += `
        <div class="person-row">
          <span class="person-name">${escapeHtml(p.name)}</span>
          <span class="person-stats">${parts.join(' · ') || '—'}</span>
        </div>
      `;
    });
    html += '</div>';
  }

  section.innerHTML = html;
}
