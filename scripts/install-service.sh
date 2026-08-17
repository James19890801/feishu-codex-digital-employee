#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
test -x "$NODE" || NODE="$(command -v node)"
LABEL="com.local.feishu-codex-digital-employee"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVICE="gui/$(id -u)/$LABEL"
LAUNCHCTL="${ACHONG_LAUNCHCTL:-/bin/launchctl}"
SERVICE_RETRIES="${ACHONG_SERVICE_RETRIES:-10}"
SERVICE_WAIT_SECONDS="${ACHONG_SERVICE_WAIT_SECONDS:-1}"
RETIRED_WECHAT_SERVICE="gui/$(id -u)/com.local.aipro-wechat-poc"
RETIRED_WECHAT_PLIST="$HOME/Library/LaunchAgents/com.local.aipro-wechat-poc.plist"
LOCK_PATH="${AIPRO_SERVICE_LOCK_PATH:-$ROOT/data/service.lock}"
mkdir -p "$HOME/Library/LaunchAgents"

# GeWe REST + Webhook replaces the retired macOS UI automation bridge.
# Always unload the old service during install/upgrade so it cannot keep
# reading or sending personal WeChat messages in parallel.
"$LAUNCHCTL" bootout "$RETIRED_WECHAT_SERVICE" 2>/dev/null || true
if test -f "$RETIRED_WECHAT_PLIST"; then
  mv "$RETIRED_WECHAT_PLIST" "$RETIRED_WECHAT_PLIST.retired" 2>/dev/null || true
fi

/usr/bin/python3 - "$PLIST" "$ROOT" "$NODE" "$HOME" <<'PY'
import plistlib, sys
path, root, node, home = sys.argv[1:]
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
  'EnvironmentVariables': {
    'HOME': home,
    'PATH': f'{root}:{root}/node_modules/.bin:{home}/.npm-global/bin:{home}/.local/bin:/usr/local/bin:/usr/bin:/bin',
  },
}
with open(path, 'wb') as f: plistlib.dump(data, f)
PY

"$LAUNCHCTL" bootout "$SERVICE" 2>/dev/null || true
stopped=0
for attempt in $(seq 1 "$SERVICE_RETRIES"); do
  if ! "$LAUNCHCTL" print "$SERVICE" >/dev/null 2>&1 && ! test -e "$LOCK_PATH"; then
    stopped=1
    break
  fi
  sleep "$SERVICE_WAIT_SECONDS"
done
test "$stopped" -eq 1
loaded=0
for attempt in $(seq 1 "$SERVICE_RETRIES"); do
  if "$LAUNCHCTL" bootstrap "gui/$(id -u)" "$PLIST"; then
    loaded=1
    break
  fi
  sleep "$SERVICE_WAIT_SECONDS"
done
test "$loaded" -eq 1
echo "SERVICE_STARTED $LABEL"
