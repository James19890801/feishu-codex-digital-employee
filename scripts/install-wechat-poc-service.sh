#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${AIPRO_NODE_BIN:-$(command -v node)}"
LABEL="com.local.aipro-wechat-poc"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$ROOT/data/wechat-poc/bin"

xcrun swiftc "$ROOT/scripts/wechat-poc-vision.swift" \
  -framework Vision -framework ImageIO -framework CoreGraphics \
  -o "$ROOT/data/wechat-poc/bin/wechat-poc-vision"
chmod 700 "$ROOT/data/wechat-poc/bin/wechat-poc-vision"

/usr/bin/python3 - "$PLIST" "$ROOT" "$NODE" <<'PY'
import plistlib
import sys

plist, root, node = sys.argv[1:]
payload = {
    'Label': 'com.local.aipro-wechat-poc',
    'ProgramArguments': [node, f'{root}/src/wechat-poc/worker.mjs'],
    'WorkingDirectory': root,
    'RunAtLoad': True,
    'KeepAlive': True,
    'ProcessType': 'Background',
    'StandardOutPath': f'{root}/wechat-poc.log',
    'StandardErrorPath': f'{root}/wechat-poc-error.log',
    'EnvironmentVariables': {
        'PATH': f'{root}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
    },
}
with open(plist, 'wb') as handle:
    plistlib.dump(payload, handle)
PY

chmod 600 "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart "gui/$(id -u)/$LABEL"
echo "Installed $LABEL (first install auto-connects; emergency-stop state persists)."
