#!/usr/bin/env bash
# pi-gui — machine-specific one-shot updater (Mingeon's Mac only).
#
# Builds the universal release and replaces /Applications/pi.app in one go.
# Absolute paths on purpose: this is a personal convenience script, not portable.
#
#   ./scripts/update.sh
#
# What it does:
#   1) pnpm tauri:build  (fetch node + bundle backend + universal build + finalize)
#   2) quit a running pi.app
#   3) swap /Applications/pi.app with the freshly built bundle
#   4) relaunch
#
# Safe-ish: the app swap is local and reversible (you can rebuild any tag), but
# it does replace the installed app, so it stops here if the build fails.

set -euo pipefail

REPO="/Users/mingeon/projects/pi-gui"
BUILT_APP="$REPO/src-tauri/target/universal-apple-darwin/release/bundle/macos/pi.app"
INSTALLED_APP="/Applications/pi.app"
PNPM="/Users/mingeon/.nvm/versions/node/v24.14.0/bin/pnpm"

cd "$REPO"

echo "▶ building pi-gui release (this takes a few minutes)…"
"$PNPM" tauri:build

if [[ ! -d "$BUILT_APP" ]]; then
  echo "✗ build did not produce $BUILT_APP" >&2
  exit 1
fi

VERSION="$(/usr/bin/defaults read "$BUILT_APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo '?')"
echo "▶ built pi.app v$VERSION"

echo "▶ quitting running pi.app (if any)…"
/usr/bin/osascript -e 'quit app "pi"' 2>/dev/null || true
# give it a moment to release the bundle / port
sleep 1

echo "▶ installing to $INSTALLED_APP…"
/bin/rm -rf "$INSTALLED_APP"
/bin/cp -R "$BUILT_APP" "$INSTALLED_APP"
# clear the quarantine attr so Gatekeeper doesn't nag on a locally-built app
/usr/bin/xattr -dr com.apple.quarantine "$INSTALLED_APP" 2>/dev/null || true

echo "▶ relaunching…"
/usr/bin/open "$INSTALLED_APP"

echo "✓ pi-gui updated to v$VERSION and relaunched."
