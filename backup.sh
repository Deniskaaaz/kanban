#!/bin/bash
# Ежедневный бэкап базы канбана.
# Копирует data.db в /var/backups/kanban/ с датой и удаляет копии старше 30 дней.

BACKUP_DIR="/var/backups/kanban"
DB_FILE="/var/www/kanban/data.db"
DATE=$(date +%Y-%m-%d_%H-%M-%S)
KEEP_DAYS=30

# Проверка, что база существует
if [ ! -f "$DB_FILE" ]; then
  echo "[$(date)] ERROR: $DB_FILE not found" >> "$BACKUP_DIR/backup.log"
  exit 1
fi

# Создаём бэкап
cp "$DB_FILE" "$BACKUP_DIR/kanban-$DATE.db"

# Удаляем старые бэкапы (> 30 дней)
find "$BACKUP_DIR" -name "kanban-*.db" -type f -mtime +$KEEP_DAYS -delete

# Лог
echo "[$(date)] Backup created: kanban-$DATE.db" >> "$BACKUP_DIR/backup.log"
