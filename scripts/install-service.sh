#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
test -x "$NODE" || NODE="$(command -v node)"
LABEL="com.local.feishu-codex-digital-employee"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVICE="gui/$(id -u)/$LABEL"
LAUNCHCTL="${ACHONG_LAUNCHCTL:-launchctl}"
RETRIES="${ACHONG_SERVICE_RETRIES:-10}"
WAIT_SECONDS="${ACHONG_SERVICE_WAIT_SECONDS:-1}"
LOCK_PATH="${JAMES_SERVICE_LOCK_PATH:-$ROOT/data/service.lock}"
mkdir -p "$HOME/Library/LaunchAgents"

/usr/bin/python3 - "$PLIST" "$ROOT" "$NODE" <<'PY'
import plistlib, sys
path, root, node = sys.argv[1:]
data = {
  'Label': 'com.local.feishu-codex-digital-employee',
  'ProgramArguments': [node, f'{root}/src/index.mjs'],
  'WorkingDirectory': root,
  'RunAtLoad': True,
  'KeepAlive': True,
  'ProcessType': 'Interactive',
  'ThrottleInterval': 10,
  'ExitTimeOut': 15,
  'StandardOutPath': f'{root}/bridge.log',
  'StandardErrorPath': f'{root}/bridge-error.log',
  'EnvironmentVariables': {'PATH': f'{root}:{root}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin'},
}
with open(path, 'wb') as f: plistlib.dump(data, f)
PY

"$LAUNCHCTL" bootout "$SERVICE" 2>/dev/null || true
stopped=0
for attempt in {1..20}; do
  if ! "$LAUNCHCTL" print "$SERVICE" >/dev/null 2>&1 && ! test -e "$LOCK_PATH"; then
    stopped=1
    break
  fi
  sleep "$WAIT_SECONDS"
done
test "$stopped" -eq 1
loaded=0
for attempt in $(seq 1 "$RETRIES"); do
  if "$LAUNCHCTL" bootstrap "gui/$(id -u)" "$PLIST"; then
    loaded=1
    break
  fi
  sleep "$WAIT_SECONDS"
done
test "$loaded" -eq 1
echo "SERVICE_STARTED $LABEL"
