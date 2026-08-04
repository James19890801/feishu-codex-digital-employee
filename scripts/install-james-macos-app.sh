#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESTINATION="${JAMES_APP_DESTINATION:-$HOME/Applications/James.app}"
BUILD_ROOT="$(mktemp -d /tmp/james-macos-app.XXXXXX)"
BUNDLE="$BUILD_ROOT/James.app"
ICONSET="$BUILD_ROOT/AppIcon.iconset"

cleanup() {
  /bin/rm -rf "$BUILD_ROOT"
}
trap cleanup EXIT

mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
cp "$ROOT/macos/James/Info.plist" "$BUNDLE/Contents/Info.plist"

/usr/bin/xcrun swiftc -parse-as-library -O \
  "$ROOT/macos/James/James.swift" \
  -framework AppKit -framework WebKit \
  -o "$BUNDLE/Contents/MacOS/James"
chmod 755 "$BUNDLE/Contents/MacOS/James"

/usr/bin/xcrun swift "$ROOT/macos/James/GenerateIcon.swift" "$ICONSET"
/usr/bin/iconutil -c icns "$ICONSET" -o "$BUNDLE/Contents/Resources/AppIcon.icns"

/usr/bin/codesign --force --deep --sign - "$BUNDLE"
/usr/bin/codesign --verify --deep --strict "$BUNDLE"

mkdir -p "$(dirname "$DESTINATION")"
STAGED="${DESTINATION}.install-${$}"
/bin/rm -rf "$STAGED"
/usr/bin/ditto "$BUNDLE" "$STAGED"
if [[ -e "$DESTINATION" ]]; then
  BACKUP="${DESTINATION}.backup-$(/bin/date +%s)"
  /bin/mv "$DESTINATION" "$BACKUP"
  if ! /bin/mv "$STAGED" "$DESTINATION"; then
    /bin/mv "$BACKUP" "$DESTINATION"
    exit 1
  fi
  /bin/rm -rf "$BACKUP"
else
  /bin/mv "$STAGED" "$DESTINATION"
fi

/usr/bin/codesign --verify --deep --strict "$DESTINATION"
/usr/bin/touch "$DESTINATION"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[[ -x "$LSREGISTER" ]] && "$LSREGISTER" -f "$DESTINATION" >/dev/null 2>&1 || true
/usr/bin/mdimport "$DESTINATION" >/dev/null 2>&1 || true

echo "$DESTINATION"
if [[ "${JAMES_APP_OPEN:-1}" == "1" ]]; then
  /usr/bin/open "$DESTINATION"
fi
