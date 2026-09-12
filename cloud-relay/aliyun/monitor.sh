#!/usr/bin/env bash
set -euo pipefail

database=/var/lib/aipro-wechat-relay/events.sqlite
certificate=/etc/letsencrypt/live/wxrelay.e2eskill.cn/fullchain.pem
backup_dir=/var/backups/aipro-wechat-relay
issues=()

systemctl is-active --quiet aipro-wechat-relay || issues+=(relay_inactive)
systemctl is-active --quiet nginx || issues+=(nginx_inactive)

if queue_count=$(sqlite3 "$database" 'SELECT count(*) FROM events;' 2>/dev/null); then
  (( queue_count < 500 )) || issues+=(queue_backlog)
else
  issues+=(database_unreadable)
fi

free_kb=$(df -Pk /var/lib/aipro-wechat-relay | awk 'END { print $4 }')
(( free_kb >= 3 * 1024 * 1024 )) || issues+=(disk_low)

openssl x509 -checkend 1209600 -noout -in "$certificate" >/dev/null 2>&1 || issues+=(certificate_expires_soon)

recent_backup=false
for backup in "$backup_dir"/events-*.sqlite; do
  [[ -f "$backup" ]] || continue
  if (( $(date +%s) - $(stat -c %Y "$backup") < 172800 )); then
    recent_backup=true
    break
  fi
done
[[ "$recent_backup" == true ]] || issues+=(backup_stale)

if (( ${#issues[@]} )); then
  printf 'WeChat relay monitor WARN: %s\n' "${issues[*]}" >&2
  exit 1
fi
printf 'WeChat relay monitor OK: queue=%s free_kb=%s\n' "$queue_count" "$free_kb"
