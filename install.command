#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_VERSION="${JAMES_NODE_BOOTSTRAP_VERSION:-22.23.2}"
RUNTIME_ROOT="${ACHONG_INSTALL_HOME:-$HOME}/.james-runtimes"

valid_node() {
  local candidate="$1"
  [[ -x "$candidate" ]] || return 1
  "$candidate" -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<13))process.exit(1)" >/dev/null 2>&1 \
    && "$candidate" --input-type=module -e "await import('node:sqlite')" >/dev/null 2>&1
}

NODE="$(command -v node 2>/dev/null || true)"
for candidate in \
  "$NODE" \
  "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
  "$RUNTIME_ROOT/node-v$NODE_VERSION/bin/node"; do
  if valid_node "$candidate"; then
    NODE="$candidate"
    break
  fi
  NODE=""
done

if [[ -z "$NODE" ]]; then
  case "$(uname -s)" in
    Darwin) PLATFORM="darwin" ;;
    Linux) PLATFORM="linux" ;;
    *) echo "INSTALL_ERROR Use install.ps1 on Windows" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64) ARCH="x64" ;;
    *) echo "INSTALL_ERROR Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  FILE_NAME="node-v$NODE_VERSION-$PLATFORM-$ARCH.tar.gz"
  DIST_URL="https://nodejs.org/dist/v$NODE_VERSION"
  TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/james-node-bootstrap.XXXXXX")"
  trap 'rm -rf "$TEMP_ROOT"' EXIT
  command -v curl >/dev/null 2>&1 || { echo "INSTALL_ERROR curl is required to download the verified portable Node runtime" >&2; exit 1; }
  curl --fail --location --proto '=https' --tlsv1.2 "$DIST_URL/SHASUMS256.txt" -o "$TEMP_ROOT/SHASUMS256.txt"
  curl --fail --location --proto '=https' --tlsv1.2 "$DIST_URL/$FILE_NAME" -o "$TEMP_ROOT/$FILE_NAME"
  EXPECTED="$(awk -v file="$FILE_NAME" '$2 == file { print $1 }' "$TEMP_ROOT/SHASUMS256.txt")"
  [[ "$EXPECTED" =~ ^[a-f0-9]{64}$ ]] || { echo "INSTALL_ERROR Node checksum is missing from the official manifest" >&2; exit 1; }
  if command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$TEMP_ROOT/$FILE_NAME" | awk '{ print $1 }')"
  else
    ACTUAL="$(sha256sum "$TEMP_ROOT/$FILE_NAME" | awk '{ print $1 }')"
  fi
  [[ "$ACTUAL" == "$EXPECTED" ]] || { echo "INSTALL_ERROR Portable Node checksum mismatch" >&2; exit 1; }
  tar -xzf "$TEMP_ROOT/$FILE_NAME" -C "$TEMP_ROOT"
  mkdir -p "$RUNTIME_ROOT"
  rm -rf "$RUNTIME_ROOT/node-v$NODE_VERSION.new"
  mv "$TEMP_ROOT/node-v$NODE_VERSION-$PLATFORM-$ARCH" "$RUNTIME_ROOT/node-v$NODE_VERSION.new"
  rm -rf "$RUNTIME_ROOT/node-v$NODE_VERSION"
  mv "$RUNTIME_ROOT/node-v$NODE_VERSION.new" "$RUNTIME_ROOT/node-v$NODE_VERSION"
  NODE="$RUNTIME_ROOT/node-v$NODE_VERSION/bin/node"
  valid_node "$NODE" || { echo "INSTALL_ERROR Downloaded Node runtime failed its capability check" >&2; exit 1; }
fi

export PATH="$(dirname "$NODE"):$PATH"
exec "$NODE" "$SCRIPT_DIR/install.mjs" "$@"
