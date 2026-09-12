#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${AIPRO_PARITY_NODE:-$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node}"
test -x "$NODE" || NODE="$(command -v node)"
LABEL="com.local.aipro-cloud-parity-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/AIPR0S"
LAUNCHCTL="${ACHONG_LAUNCHCTL:-/bin/launchctl}"
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

/usr/bin/python3 - "$PLIST" "$ROOT" "$NODE" "$HOME" "$LOG_DIR" <<'PY'
import plistlib, sys
path, root, node, home, log_dir = sys.argv[1:]
data = {
  'Label': 'com.local.aipro-cloud-parity-sync',
  'ProgramArguments': [node, f'{root}/scripts/cloud-parity-sync.mjs'],
  'WorkingDirectory': root,
  'RunAtLoad': True,
  'StartCalendarInterval': {'Hour': 3, 'Minute': 30},
  'ProcessType': 'Background',
  'StandardOutPath': f'{log_dir}/cloud-parity-sync.log',
  'StandardErrorPath': f'{log_dir}/cloud-parity-sync-error.log',
  'EnvironmentVariables': {'HOME': home, 'PATH': f'{root}:{home}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin'},
}
with open(path, 'wb') as handle:
  plistlib.dump(data, handle, fmt=plistlib.FMT_XML)
PY

"$LAUNCHCTL" bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
"$LAUNCHCTL" bootstrap "gui/$(id -u)" "$PLIST"
"$LAUNCHCTL" kickstart -k "gui/$(id -u)/$LABEL"
echo "CLOUD_PARITY_DAILY_SYNC_INSTALLED"
