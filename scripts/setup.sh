#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
export PATH="$NODE_BIN:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
CONFIG_TEMPLATE="${JAMES_CONFIG_TEMPLATE:-$ROOT/config.example.json}"

command -v node >/dev/null 2>&1 || { echo "未找到 Node.js"; exit 1; }
test -f "$CONFIG_TEMPLATE" || { echo "配置模板不存在：$CONFIG_TEMPLATE"; exit 1; }
PYTHON_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
test -x "$PYTHON_BIN" || PYTHON_BIN="$(command -v python3 2>/dev/null || true)"
test -x "$PYTHON_BIN" || { echo "未找到 Python 3"; exit 1; }

test -f "$ROOT/config.local.json" || cp "$CONFIG_TEMPLATE" "$ROOT/config.local.json"
test -f "$ROOT/PERSONA.md" || cp "$ROOT/templates/PERSONA.example.md" "$ROOT/PERSONA.md"
test -f "$ROOT/BIBLE.md" || cp "$ROOT/templates/BIBLE.example.md" "$ROOT/BIBLE.md"
test -f "$ROOT/knowledge-catalog.json" || cp "$ROOT/templates/knowledge-catalog.example.json" "$ROOT/knowledge-catalog.json"
mkdir -p "$ROOT/data"

FEISHU_ENABLED="$(node -e "const c=require(process.argv[1]);process.stdout.write(String(c.feishuEnabled===true))" "$ROOT/config.local.json")"
if [[ "$FEISHU_ENABLED" == "true" ]]; then
  command -v lark-cli >/dev/null 2>&1 || {
    echo "飞书已启用，但未找到 lark-cli。"; exit 1;
  }
fi

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
if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  "$PYTHON_BIN" -m venv "$ROOT/.venv"
fi
VENV_PYTHON="$ROOT/.venv/bin/python"
test -x "$VENV_PYTHON" || VENV_PYTHON="$PYTHON_BIN"
"$VENV_PYTHON" -m pip install --disable-pip-version-check -r "$ROOT/requirements.txt"

if command -v dws >/dev/null 2>&1; then
  echo "DingTalk runtime detected: $(dws version | head -n 1)"
else
  echo "DingTalk optional runtime not detected. Install dingtalk-workspace-cli@1.0.55 before enabling that channel."
fi

echo "初始文件已生成。现在请填写 config.local.json、PERSONA.md 和 BIBLE.md。"
