#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOURS="${1:-3}"
[[ "$HOURS" == <-> ]] && (( HOURS >= 1 && HOURS <= 24 ))

CONFIG_TARGET="$(readlink "$ROOT/config.local.json")"
test -n "$CONFIG_TARGET"
ACTIVE_ROOT="$(cd "$(dirname "$CONFIG_TARGET")" && pwd)"
test -x "$ACTIVE_ROOT/scripts/install-service.sh"

UID_VALUE="$(id -u)"
LOCAL_LABEL="com.local.feishu-codex-digital-employee"
SIDECAR_LABEL="com.local.aipros-cloud-failover-heartbeat"
RESTORE_LABEL="com.local.aipros-cloud-runtime-restore"
RESTORE_PLIST="$HOME/Library/LaunchAgents/$RESTORE_LABEL.plist"
STATE_DIR="$HOME/Library/Application Support/AIPR0S/cloud-runtime-window"
STATE_FILE="$STATE_DIR/state.json"
mkdir -p "$HOME/Library/LaunchAgents" "$STATE_DIR"

/usr/bin/python3 - "$RESTORE_PLIST" "$ROOT" "$ACTIVE_ROOT" "$STATE_FILE" "$HOURS" <<'PY'
import json, plistlib, sys
from datetime import datetime, timedelta, timezone

plist_path, sidecar_root, active_root, state_path, hours = sys.argv[1:]
restore_at = datetime.now().astimezone() + timedelta(hours=int(hours))
payload = {
    'Label': 'com.local.aipros-cloud-runtime-restore',
    'ProgramArguments': [
        '/bin/zsh',
        f'{sidecar_root}/scripts/restore-local-after-cloud-window.sh',
        active_root,
        sidecar_root,
        plist_path,
        state_path,
    ],
    'WorkingDirectory': sidecar_root,
    'RunAtLoad': False,
    'StartCalendarInterval': {
        'Month': restore_at.month,
        'Day': restore_at.day,
        'Hour': restore_at.hour,
        'Minute': restore_at.minute,
    },
    'ProcessType': 'Background',
    'StandardOutPath': f'{sidecar_root}/cloud-runtime-restore.log',
    'StandardErrorPath': f'{sidecar_root}/cloud-runtime-restore-error.log',
}
with open(plist_path, 'wb') as handle:
    plistlib.dump(payload, handle)
with open(state_path, 'w', encoding='utf-8') as handle:
    json.dump({
        'state': 'cloud_forced',
        'startedAt': datetime.now(timezone.utc).isoformat(),
        'restoreAt': restore_at.astimezone(timezone.utc).isoformat(),
        'hours': int(hours),
    }, handle)
PY

launchctl bootout "gui/$UID_VALUE/$RESTORE_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_VALUE" "$RESTORE_PLIST"

launchctl disable "gui/$UID_VALUE/$SIDECAR_LABEL"
launchctl bootout "gui/$UID_VALUE/$SIDECAR_LABEL" 2>/dev/null || true
launchctl disable "gui/$UID_VALUE/$LOCAL_LABEL"
launchctl bootout "gui/$UID_VALUE/$LOCAL_LABEL" 2>/dev/null || true

RESTORE_AT="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["restoreAt"])' "$STATE_FILE")"
echo "CLOUD_RUNTIME_WINDOW_STARTED restore_at=$RESTORE_AT"
