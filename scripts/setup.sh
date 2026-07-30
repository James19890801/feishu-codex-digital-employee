#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
export PATH="$NODE_BIN:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

command -v node >/dev/null 2>&1 || { echo "未找到 Node.js"; exit 1; }
command -v lark-cli >/dev/null 2>&1 || {
  echo "未找到 lark-cli。请先按 README 安装飞书官方 CLI。"; exit 1;
}
PYTHON_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
test -x "$PYTHON_BIN" || PYTHON_BIN="$(command -v python3 2>/dev/null || true)"
test -x "$PYTHON_BIN" || { echo "未找到 Python 3"; exit 1; }

test -f "$ROOT/config.local.json" || cp "$ROOT/config.example.json" "$ROOT/config.local.json"
test -f "$ROOT/PERSONA.md" || cp "$ROOT/templates/PERSONA.example.md" "$ROOT/PERSONA.md"
test -f "$ROOT/BIBLE.md" || cp "$ROOT/templates/BIBLE.example.md" "$ROOT/BIBLE.md"
mkdir -p "$ROOT/data"

node --input-type=module -e "
  import { discoverAiRuntimes, selectAiRuntime } from '$ROOT/src/ai-runtime.mjs';
  const runtime = selectAiRuntime(discoverAiRuntimes(), 'auto');
  console.log('AI runtime detected:', runtime.label);
" || {
  echo "未找到可用的无界面 AI 编码运行时。请安装 Codex CLI、Qoder CLI 或 CodeBuddy CLI。"; exit 1;
}

cd "$ROOT"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
else
  npm install
fi
"$PYTHON_BIN" -m pip install --disable-pip-version-check -r "$ROOT/requirements.txt"

if command -v dws >/dev/null 2>&1; then
  echo "DingTalk runtime detected: $(dws version | head -n 1)"
else
  echo "DingTalk optional runtime not detected. Install dingtalk-workspace-cli@1.0.55 before enabling that channel."
fi

echo "初始文件已生成。现在请填写 config.local.json、PERSONA.md 和 BIBLE.md。"
