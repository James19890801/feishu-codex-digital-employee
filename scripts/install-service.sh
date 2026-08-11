#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
test -x "$NODE" || NODE="$(command -v node)"
LABEL="com.local.feishu-codex-digital-employee"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
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

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
loaded=0
for attempt in {1..10}; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
    loaded=1
    break
  fi
  sleep 1
done
test "$loaded" -eq 1
launchctl kickstart "gui/$(id -u)/$LABEL"
echo "SERVICE_STARTED $LABEL"
