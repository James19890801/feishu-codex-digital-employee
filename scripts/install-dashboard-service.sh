#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node 2>/dev/null || true)"
test -x "$NODE" || NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
test -x "$NODE"
LABEL="com.local.feishu-codex-dashboard"
LAUNCHCTL="${ACHONG_LAUNCHCTL:-launchctl}"
RETRIES="${ACHONG_SERVICE_RETRIES:-10}"
WAIT_SECONDS="${ACHONG_SERVICE_WAIT_SECONDS:-1}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"

/usr/bin/python3 - "$PLIST" "$ROOT" "$NODE" <<'PY'
import plistlib, sys
path, root, node = sys.argv[1:]
data = {
  'Label': 'com.local.feishu-codex-dashboard',
  'ProgramArguments': [node, f'{root}/src/dashboard-server.mjs'],
  'WorkingDirectory': root,
  'RunAtLoad': True,
  'KeepAlive': True,
  'ProcessType': 'Interactive',
  'ThrottleInterval': 10,
  'ExitTimeOut': 10,
  'StandardOutPath': f'{root}/dashboard.log',
  'StandardErrorPath': f'{root}/dashboard-error.log',
  'EnvironmentVariables': {
    'PATH': f'{root}:{root}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
  },
}
with open(path, 'wb') as f:
  plistlib.dump(data, f)
PY

"$LAUNCHCTL" bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
loaded=0
for attempt in $(seq 1 "$RETRIES"); do
  if "$LAUNCHCTL" bootstrap "gui/$(id -u)" "$PLIST"; then
    loaded=1
    break
  fi
  sleep "$WAIT_SECONDS"
done
test "$loaded" -eq 1
"$LAUNCHCTL" kickstart "gui/$(id -u)/$LABEL"
echo "DASHBOARD_STARTED http://127.0.0.1:17655"
