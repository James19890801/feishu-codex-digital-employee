#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
export PATH="$NODE_BIN:$HOME/.local/bin:$PATH"
cd "$ROOT"
node --check src/multimodal-content.mjs
node --check src/web-reader.mjs
xcrun swiftc -parse-as-library -typecheck macos/AIPRO/AIPROTranscribe.swift
npm run test:multimodal
npm run check
npm test
npm run runtime-smoke
npm run health
npm run backup-smoke
FEISHU_ENABLED="$(node -e "const c=require('./config.local.json'); process.stdout.write(String(c.feishuEnabled !== false))")"
MULTICA_ENABLED="$(node -e "const c=require('./config.local.json'); process.stdout.write(String(c.multicaEnabled === true))")"
if [[ "$MULTICA_ENABLED" == "true" ]]; then
  npm run multica-smoke
fi
if [[ "$FEISHU_ENABLED" == "true" ]]; then
  lark-cli auth check --scope 'search:message im:message im:message:readonly im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user im:message.send_as_user' --json
  npm run event-health
fi
launchctl print "gui/$(id -u)/com.local.feishu-codex-digital-employee" | grep 'state = running'
launchctl print "gui/$(id -u)/com.local.feishu-codex-dashboard" | grep 'state = running'
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:17655/api/status >/dev/null
echo "LOCAL_VERIFY_OK"
