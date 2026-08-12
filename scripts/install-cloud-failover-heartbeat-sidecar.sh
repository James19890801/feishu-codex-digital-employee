#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
test -x "$NODE" || NODE="$(command -v node)"
LABEL="com.local.aipros-cloud-failover-heartbeat"
SERVICE="gui/$(id -u)/$LABEL"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/AIPR0S"
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

/usr/bin/python3 - "$PLIST" "$ROOT" "$NODE" "$LOG_DIR" <<'PY'
import plistlib, sys
path, root, node, log_dir = sys.argv[1:]
data = {
  'Label': 'com.local.aipros-cloud-failover-heartbeat',
  'ProgramArguments': [node, f'{root}/scripts/cloud-failover-heartbeat-sidecar.mjs'],
  'WorkingDirectory': root,
  'RunAtLoad': True,
  'KeepAlive': True,
  'ProcessType': 'Background',
  'ThrottleInterval': 10,
  'ExitTimeOut': 10,
  'StandardOutPath': f'{log_dir}/cloud-failover-heartbeat.log',
  'StandardErrorPath': f'{log_dir}/cloud-failover-heartbeat-error.log',
  'EnvironmentVariables': {
    'PATH': f'{root}:{root}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
  },
}
with open(path, 'wb') as handle:
  plistlib.dump(data, handle)
PY

launchctl bootout "$SERVICE" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "$SERVICE"
echo "CLOUD_FAILOVER_HEARTBEAT_SIDECAR_STARTED"
