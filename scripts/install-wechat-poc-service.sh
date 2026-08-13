#!/bin/zsh
set -euo pipefail

LABEL="com.local.aipro-wechat-poc"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if test -f "$PLIST"; then
  mv "$PLIST" "$PLIST.retired"
fi
echo "RETIRED $LABEL; personal WeChat now uses GeWe REST + Webhook."
