#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
export PATH="$NODE_BIN:$HOME/.local/bin:$PATH"
cd "$ROOT"
npm run check
npm test
npm run codex-smoke
npm run health
lark-cli auth check --scope 'search:message im:message im:message:readonly im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user im:message.send_as_user' --json
npm run event-health
launchctl print "gui/$(id -u)/com.local.feishu-codex-digital-employee" | grep 'state = running'
launchctl print "gui/$(id -u)/com.local.feishu-codex-dashboard" | grep 'state = running'
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:17655/api/status >/dev/null
echo "LOCAL_VERIFY_OK"
