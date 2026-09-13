#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" != 0 ]]; then
  echo 'Run as root on the intended Aliyun server.' >&2
  exit 1
fi
source_dir="$(cd "$(dirname "$0")" && pwd)"
if ! id aipro-wechat-relay >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/aipro-wechat-relay --shell /sbin/nologin aipro-wechat-relay
fi
install -d -m 0700 -o aipro-wechat-relay -g aipro-wechat-relay /var/lib/aipro-wechat-relay
install -d -m 0700 -o aipro-wechat-relay -g aipro-wechat-relay /var/lib/aipro-wechat-relay/artifacts
install -d -m 0755 -o root -g root /opt/aipro-wechat-relay
install -d -m 0755 -o root -g root /opt/aipro-wechat-relay/aliyun
install -d -m 0750 -o root -g aipro-wechat-relay /etc/aipro-wechat-relay
install -m 0644 "$source_dir/main.mjs" "$source_dir/server.mjs" "$source_dir/store.mjs" "$source_dir/parity-config.mjs" /opt/aipro-wechat-relay/aliyun/
install -m 0644 "$source_dir/../../src/qoder-managed-runtime.mjs" /opt/aipro-wechat-relay/aliyun/qoder-runtime.mjs
install -m 0644 "$source_dir/cloud-watchdog.mjs" /opt/aipro-wechat-relay/aliyun/cloud-watchdog.mjs
install -d -m 0755 /opt/aipro-wechat-relay/worker/src
install -m 0644 "$source_dir/../worker/src/contract.mjs" /opt/aipro-wechat-relay/worker/src/contract.mjs
install -m 0644 "$source_dir/aipro-wechat-relay.service" /etc/systemd/system/aipro-wechat-relay.service
install -m 0644 "$source_dir/aipro-wechat-cloud-watchdog.service" /etc/systemd/system/aipro-wechat-cloud-watchdog.service
install -m 0750 "$source_dir/backup.sh" /opt/aipro-wechat-relay/aliyun/backup.sh
install -m 0750 "$source_dir/monitor.sh" /opt/aipro-wechat-relay/aliyun/monitor.sh
install -m 0644 "$source_dir/aipro-wechat-relay-backup.service" /etc/systemd/system/aipro-wechat-relay-backup.service
install -m 0644 "$source_dir/aipro-wechat-relay-backup.timer" /etc/systemd/system/aipro-wechat-relay-backup.timer
install -m 0644 "$source_dir/aipro-wechat-relay-monitor.service" /etc/systemd/system/aipro-wechat-relay-monitor.service
install -m 0644 "$source_dir/aipro-wechat-relay-monitor.timer" /etc/systemd/system/aipro-wechat-relay-monitor.timer
systemctl daemon-reload
echo 'Staged. Add private config.json, then start service and enable backup and monitor timers. DNS and Nginx are not changed.'
