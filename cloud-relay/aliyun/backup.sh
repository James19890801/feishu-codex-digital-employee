#!/usr/bin/env bash
set -euo pipefail
umask 077

database=/var/lib/aipro-wechat-relay/events.sqlite
backup_dir=/var/backups/aipro-wechat-relay
install -d -m 700 "$backup_dir"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary=$(mktemp "$backup_dir/.events-${timestamp}.XXXXXX.sqlite")
trap 'rm -f "$temporary"' EXIT
sqlite3 "$database" ".backup '$temporary'"
test "$(sqlite3 "$temporary" 'PRAGMA quick_check;')" = ok
destination="$backup_dir/events-${timestamp}.sqlite"
test ! -e "$destination"
mv "$temporary" "$destination"
chmod 600 "$destination"
trap - EXIT
printf 'Verified SQLite backup: %s\n' "$destination"
