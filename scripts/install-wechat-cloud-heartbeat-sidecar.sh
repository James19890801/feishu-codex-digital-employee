#!/bin/zsh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
node_bin="$(command -v node)"
label="com.local.aipro-wechat-cloud-heartbeat"
plist="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$HOME/Library/Logs/AIPRO"
mkdir -p "$HOME/Library/LaunchAgents" "$log_dir"

/usr/bin/python3 - "$plist" "$root" "$node_bin" "$log_dir" <<'PY'
import plistlib, sys
path, root, node, log_dir = sys.argv[1:]
data = {
  'Label': 'com.local.aipro-wechat-cloud-heartbeat',
  'ProgramArguments': [node, f'{root}/scripts/wechat-cloud-heartbeat-sidecar.mjs'],
  'WorkingDirectory': root, 'RunAtLoad': True, 'KeepAlive': True,
  'ThrottleInterval': 10, 'ProcessType': 'Background',
  'StandardOutPath': f'{log_dir}/wechat-cloud-heartbeat.log',
  'StandardErrorPath': f'{log_dir}/wechat-cloud-heartbeat-error.log',
}
with open(path, 'wb') as handle: plistlib.dump(data, handle)
PY

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart -k "gui/$(id -u)/$label"
echo WECHAT_CLOUD_HEARTBEAT_SIDECAR_STARTED
