#!/bin/zsh
set -euo pipefail

ACTIVE_ROOT="$1"
SIDECAR_ROOT="$2"
RESTORE_PLIST="$3"
STATE_FILE="$4"
UID_VALUE="$(id -u)"
RESTORE_LABEL="com.local.aipros-cloud-runtime-restore"

launchctl enable "gui/$UID_VALUE/com.local.feishu-codex-digital-employee"
"$ACTIVE_ROOT/scripts/install-service.sh"
launchctl enable "gui/$UID_VALUE/com.local.aipros-cloud-failover-heartbeat"
"$SIDECAR_ROOT/scripts/install-cloud-failover-heartbeat-sidecar.sh"

/usr/bin/python3 - "$STATE_FILE" <<'PY'
import json, sys
from datetime import datetime, timezone
path = sys.argv[1]
with open(path, 'w', encoding='utf-8') as handle:
    json.dump({'state': 'local_restored', 'completedAt': datetime.now(timezone.utc).isoformat()}, handle)
PY

(
  /bin/sleep 2
  launchctl bootout "gui/$UID_VALUE/$RESTORE_LABEL" 2>/dev/null || true
  /bin/rm -f "$RESTORE_PLIST"
) >/dev/null 2>&1 &

echo "LOCAL_RUNTIME_RESTORED"
