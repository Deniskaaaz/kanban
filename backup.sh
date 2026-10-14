#!/bin/bash
# Ежедневный бэкап базы канбана.
# Использует sqlite3 .backup — WAL-safe, консистентный снимок с учётом -wal.
# Копии хранятся 30 дней в /var/backups/kanban/.
#
# Использование:
#   ./backup.sh              — обычный запуск (для cron)
#   /var/www/kanban/backup.sh

set -euo pipefail

BACKUP_DIR="/var/backups/kanban"
DB_FILE="/var/www/kanban/data.db"
DATE=$(date +%Y-%m-%d_%H-%M-%S)
KEEP_DAYS=30
LOG_FILE="$BACKUP_DIR/backup.log"
OUT="$BACKUP_DIR/kanban-$DATE.db"

mkdir -p "$BACKUP_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

# Проверка, что база существует
if [ ! -f "$DB_FILE" ]; then
  log "ERROR: $DB_FILE not found"
  exit 1
fi

# Консистентный снимок через sqlite3 .backup
if command -v sqlite3 >/dev/null 2>&1; then
  if ! sqlite3 "$DB_FILE" ".backup '$OUT'"; then
    log "ERROR: sqlite3 .backup failed"
    exit 1
  fi
else
  # Fallback: checkpoint WAL в основной файл, потом cp.
  # better-sqlite3 уже установлен вместе с проектом.
  if command -v node >/dev/null 2>&1; then
    node -e "
      const Database = require('better-sqlite3');
      const db = new Database('$DB_FILE');
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    " || log "WARN: node checkpoint failed, snapshot may be inconsistent"
  else
    log "WARN: sqlite3 and node not found — using plain cp (may be inconsistent)"
  fi
  cp "$DB_FILE" "$OUT"
fi

# Проверка целостности бэкапа (только если sqlite3 есть)
if command -v sqlite3 >/dev/null 2>&1; then
  if ! sqlite3 "$OUT" "PRAGMA integrity_check;" | grep -q '^ok$'; then
    log "ERROR: integrity_check failed for $(basename "$OUT")"
    rm -f "$OUT"
    exit 1
  fi
fi

# Удаляем старые бэкапы (> 30 дней)
find "$BACKUP_DIR" -name "kanban-*.db" -type f -mtime +$KEEP_DAYS -delete

SIZE=$(du -h "$OUT" | cut -f1)
log "Backup created: $(basename "$OUT") ($SIZE)"
