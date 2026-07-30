#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
export PATH="$NODE_BIN:$HOME/.local/bin:$PATH"

command -v codex >/dev/null 2>&1 || test -x /Applications/ChatGPT.app/Contents/Resources/codex || {
  echo "未找到 Codex CLI，请先安装并登录 Codex。"; exit 1;
}
command -v node >/dev/null 2>&1 || { echo "未找到 Node.js"; exit 1; }
command -v lark-cli >/dev/null 2>&1 || {
  echo "未找到 lark-cli。请先按 README 安装飞书官方 CLI。"; exit 1;
}

test -f "$ROOT/config.local.json" || cp "$ROOT/config.example.json" "$ROOT/config.local.json"
test -f "$ROOT/PERSONA.md" || cp "$ROOT/templates/PERSONA.example.md" "$ROOT/PERSONA.md"
test -f "$ROOT/BIBLE.md" || cp "$ROOT/templates/BIBLE.example.md" "$ROOT/BIBLE.md"
mkdir -p "$ROOT/data"

cd "$ROOT"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
else
  npm install
fi

echo "初始文件已生成。现在请填写 config.local.json、PERSONA.md 和 BIBLE.md。"
