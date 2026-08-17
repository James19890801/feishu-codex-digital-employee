#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

command -v node >/dev/null 2>&1 || { echo "未找到 Node.js"; exit 1; }
PYTHON_BIN="$(command -v python3 2>/dev/null || true)"
CONFIG_TEMPLATE="${JAMES_CONFIG_TEMPLATE:-$ROOT/config.distribution.json}"

test -f "$ROOT/config.local.json" || cp "$CONFIG_TEMPLATE" "$ROOT/config.local.json"
test -f "$ROOT/PERSONA.md" || cp "$ROOT/templates/PERSONA.example.md" "$ROOT/PERSONA.md"
test -f "$ROOT/BIBLE.md" || cp "$ROOT/templates/BIBLE.example.md" "$ROOT/BIBLE.md"
test -f "$ROOT/knowledge-catalog.json" || cp "$ROOT/templates/knowledge-catalog.example.json" "$ROOT/knowledge-catalog.json"
mkdir -p "$ROOT/data"

node --input-type=module -e "
  import { discoverAiRuntimes, selectAiRuntime } from '$ROOT/src/ai-runtime.mjs';
  const runtime = selectAiRuntime(discoverAiRuntimes(), 'auto');
  console.log('AI runtime detected:', runtime.label);
" || {
  echo "未找到可用的无界面 AI Coding 运行时。请在 WorkBuddy、Qoder Work、Qoder、CodeBuddy、Codex 或其他兼容工具中启用后台运行能力。"; exit 1;
}

cd "$ROOT"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
else
  npm install
fi
if test -x "$PYTHON_BIN"; then
  "$PYTHON_BIN" -m pip install --disable-pip-version-check -r "$ROOT/requirements.txt"
else
  echo "Python 3 未安装：核心服务可启动，文档解析能力暂不可用。"
fi

if command -v connector >/dev/null 2>&1; then
  echo "EnterpriseChat runtime detected: $(connector version | head -n 1)"
else
  echo "Optional enterprise connector not detected. Keep the channel disabled or configure a compatible adapter executable."
fi

echo "初始文件已生成。现在请填写 config.local.json、PERSONA.md 和 BIBLE.md。"
