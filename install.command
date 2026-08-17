#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE" ]]; then
  for candidate in \
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
    "/Applications/ChatGPT.app/Contents/Resources/codex"; do
    if [[ -x "$candidate" && "$(basename "$candidate")" == "node" ]]; then
      NODE="$candidate"
      break
    fi
  done
fi
[[ -x "$NODE" ]] || { echo "INSTALL_ERROR Node.js 22.5+ is required" >&2; exit 1; }
"$NODE" -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<5))process.exit(1)" \
  || { echo "INSTALL_ERROR Node.js 22.5+ is required" >&2; exit 1; }

exec "$NODE" "$SCRIPT_DIR/install.mjs"
