/* ============================================================
   common.js — общие функции для всех страниц
   ============================================================ */

// ===== Утилиты =====
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function formatNumber(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const parts = String(Math.round(n)).split('');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const fr = parts.length - i;
    out.push(parts[i]);
    if (fr > 1 && fr % 3 === 1) out.push(' ');
  }
  return out.join('');
}

function getInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.slice(0, 2).map(p => p[0].toUpperCase()).join('');
}

// ===== Цвета =====
const PALETTE = ['#7c3aed', '#ea580c'];

function personColor(personId, people) {
  const idx = people.findIndex(p => p.id === personId);
  return PALETTE[(idx < 0 ? 0 : idx) % PALETTE.length];
}

function effClass(v) {
  if (!v) return 'zero';
  if (v < 30) return 'low';
  if (v < 70) return 'mid';
  return 'high';
}

function pctClass(p) {
  if (p < 50) return 'low';
  if (p < 80) return 'mid';
  return 'high';
}

function attendanceColor(v) {
  const t = Math.max(0, Math.min(1, parseFloat(v) || 0));
  const hue = t * 120;
  const sat = 65 + t * 15;
  const light = 45 - t * 5;
  return `hsl(${hue.toFixed(0)}, ${sat.toFixed(0)}%, ${light.toFixed(0)}%)`;
}

// ===== Даты =====
function pad(n) { return String(n).padStart(2, '0'); }

function formatDate(d) {
  return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
}

function formatDateTime(d) {
  return formatDate(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function dayDiff(iso) {
  if (!iso) return null;
  const t = new Date(todayISO() + 'T00:00:00');
  const d = new Date(iso + 'T00:00:00');
  return Math.round((d - t) / 86400000);
}

function dueClass(iso, prefix) {
  const d = dayDiff(iso);
  if (d === null) return null;
  const p = prefix === undefined ? 'due-' : prefix;
  if (d < 0) return p + 'late';
  if (d === 0) return p + 'today';
  if (d <= 3) return p + 'soon';
  if (d <= 30) return p + 'future';
  return p + 'plain';
}

function dueLabel(iso) {
  const d = dayDiff(iso);
  if (d === null) return '';
  if (d < 0) return 'просрочено ' + Math.abs(d) + ' дн.';
  if (d === 0) return 'сегодня';
  if (d === 1) return 'завтра';
  if (d <= 7) return 'через ' + d + ' дн.';
  const dt = new Date(iso + 'T00:00:00');
  return pad(dt.getDate()) + '.' + pad(dt.getMonth() + 1);
}

// ===== Проценты =====
function calcPercent(value, plan) {
  if (!plan || plan <= 0) return null;
  const v = parseFloat(value) || 0;
  return Math.min(999, Math.round((v / plan) * 100));
}

// ===== Итоги таблицы (Кулибин) =====
// people   — массив сотрудников доски
// columns  — конфиг столбцов (col.kind: 'amount' | 'efficiency' | 'attendance' | 'text')
// kulebin  — массив { person_id, values: {...} }
function computeTotals(people, columns, kulebin) {
  const totals = {};
  const byPerson = new Map();
  (kulebin || []).forEach(k => byPerson.set(k.person_id, k.values || {}));

  columns.forEach(col => {
    if (col.kind === 'amount') {
      let sum = 0;
      people.forEach(p => {
        const values = byPerson.get(p.id) || {};
        const v = parseFloat(values[col.key]);
        if (!isNaN(v)) sum += v;
      });
      totals[col.key] = { sum, totalPlan: (col.plan || 0) * people.length };
    } else if (col.kind === 'efficiency') {
      let sum = 0, cnt = 0;
      people.forEach(p => {
        const values = byPerson.get(p.id) || {};
        const v = parseInt(values[col.key]);
        if (!isNaN(v)) { sum += v; cnt++; }
      });
      totals[col.key] = { avg: cnt ? Math.round(sum / cnt) : 0 };
    } else if (col.kind === 'attendance') {
      let sum = 0;
      people.forEach(p => {
        const values = byPerson.get(p.id) || {};
        const v = parseFloat(values[col.key]);
        if (!isNaN(v)) sum += v;
      });
      totals[col.key] = { sum };
    }
  });
  return totals;
}

// ===== Архив =====
const ARCHIVE_DAYS = 7;

function isArchived(p) {
  if (p.horizon !== 'done' || !p.completed_at) return false;
  const t = new Date(p.completed_at.replace(' ', 'T') + 'Z').getTime();
  return (Date.now() - t) > ARCHIVE_DAYS * 86400000;
}

// ===== Аватарка сотрудника =====
// Возвращает HTML-строку: если у person.avatar есть base64 — картинка,
// иначе — кружок с инициалами и фоном.
// size: 'sm' (22px), 'md' (28px), 'lg' (40px), 'xl' (44px)
function avatarHtml(person, size, colorFallback) {
  if (!person) return '';
  const s = size || 'md';
  const color = colorFallback || '#94a3b8';
  const initials = getInitials(person.name);
  const img = person.avatar
    ? `<img src="${person.avatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">`
    : '';
  const inner = person.avatar ? img : escapeHtml(initials);
  return `<span class="initials avatar-${s}" style="background:${color}">${inner}</span>`;
}

// ===== Защита от ложных кликов =====
let _mouseDownTarget = null;
let _mouseDownX = 0;
let _mouseDownY = 0;

document.addEventListener('mousedown', e => {
  _mouseDownTarget = e.target;
  _mouseDownX = e.clientX;
  _mouseDownY = e.clientY;
}, true);

function isRealClick(e, scope) {
  const dx = Math.abs(e.clientX - _mouseDownX);
  const dy = Math.abs(e.clientY - _mouseDownY);
  if (dx > 5 || dy > 5) return false;

  if (window.getSelection && window.getSelection().toString().length > 0) return false;

  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
    const s = ae.selectionStart;
    const en = ae.selectionEnd;
    if (s !== null && en !== null && s !== en) return false;
  }

  if (_mouseDownTarget && (_mouseDownTarget.tagName === 'INPUT' || _mouseDownTarget.tagName === 'TEXTAREA')) {
    if (e.target !== _mouseDownTarget && !_mouseDownTarget.contains(e.target)) {
      return false;
    }
  }

  if (scope) {
    const downInScope = _mouseDownTarget && (_mouseDownTarget === scope || scope.contains(_mouseDownTarget));
    const upInScope = e.target && (e.target === scope || scope.contains(e.target));
    if (!downInScope || !upInScope) return false;
  }

  if (e.target.closest && e.target.closest('[data-moved="1"]')) return false;

  return true;
}

// ===== Тема админки =====
function applyAdminTheme() {
  const theme = localStorage.getItem('admin_theme') || 'light';
  document.body.classList.toggle('dark', theme === 'dark');
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = theme === 'dark' ? '☀' : '🌙';
}

function initAdminTheme() {
  applyAdminTheme();
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btn-theme');
    if (btn) {
      btn.addEventListener('click', () => {
        const cur = localStorage.getItem('admin_theme') || 'light';
        localStorage.setItem('admin_theme', cur === 'dark' ? 'light' : 'dark');
        applyAdminTheme();
      });
    }
  });
}

// ===== Web-уведомления в браузере =====
function notificationsSupported() {
  return 'Notification' in window;
}

function notificationsEnabled() {
  return notificationsSupported()
    && localStorage.getItem('admin_notif') === 'on'
    && Notification.permission === 'granted';
}

async function toggleNotifications() {
  if (!notificationsSupported()) {
    alert('Ваш браузер не поддерживает уведомления');
    return false;
  }

  const cur = localStorage.getItem('admin_notif') === 'on';
  if (cur) {
    localStorage.setItem('admin_notif', 'off');
    return false;
  }

  if (Notification.permission === 'default') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') {
      alert('Уведомления запрещены в настройках браузера');
      return false;
    }
  }
  if (Notification.permission !== 'granted') {
    alert('Уведомления запрещены. Разрешите их в настройках сайта в браузере.');
    return false;
  }

  localStorage.setItem('admin_notif', 'on');
  return true;
}

function updateNotifButton() {
  const btn = document.getElementById('btn-notif');
  if (!btn) return;
  const on = notificationsEnabled();
  btn.textContent = on ? '🔔' : '🔕';
  btn.title = on ? 'Уведомления включены' : 'Уведомления выключены';
}

function initNotifications() {
  updateNotifButton();
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btn-notif');
    if (btn) {
      btn.addEventListener('click', async () => {
        const wasOn = notificationsEnabled();
        await toggleNotifications();
        updateNotifButton();
        if (!wasOn && notificationsEnabled()) {
          showNotification('Уведомления включены', 'Вы будете получать оповещения об изменениях в канбане.');
        }
      });
    }
  });
}

function showNotification(title, body) {
  if (!notificationsEnabled()) return;
  try {
    const n = new Notification(title, {
      body: body,
      icon: '/icon-192.png',
      tag: 'kanban-change',
      renotify: true,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch (e) {
    console.error('Notification error:', e);
  }
}

// ===== SVG иконки (для канбана) =====
const ICONS = {
  people: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>`,
  longterm: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>`,
  month: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
  week: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><text x="12" y="19" font-size="8" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">7</text></svg>`,
  day: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
  done: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
};

// ===== Константы =====
const HORIZONS = [
  { key: 'people',   label: 'Ответственный' },
  { key: 'longterm', label: 'Долгосрок' },
  { key: 'month',    label: 'Месяц' },
  { key: 'week',     label: 'Неделя' },
  { key: 'day',      label: 'День' },
  { key: 'done',     label: 'Готово' },
];
