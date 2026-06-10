#!/usr/bin/env bash
# pi-gui - machine-specific one-shot updater (Mingeon's Mac only).
#
# Builds the universal release and replaces /Applications/pi.app in one go.
# Absolute paths on purpose: this is a personal convenience script, not portable.
#
#   ./scripts/update.sh   (or: pnpm update:app)
#
# What it does:
#   1) pnpm tauri:build  (fetch node + bundle backend + universal build + finalize)
#   2) quit a running pi.app
#   3) swap /Applications/pi.app with the freshly built bundle
#   4) relaunch
#
# ASCII-only on purpose: under a C locale, a multibyte char right after a $VAR
# (e.g. "...$INSTALLED_APP...") gets parsed into the variable name and breaks
# with `set -u`. Keep the echoes plain ASCII.
#
# Skip the rebuild and only (re)install the already-built bundle:
#   ./scripts/update.sh --install-only

set -euo pipefail

REPO="/Users/mingeon/projects/pi-gui"
BUILT_APP="$REPO/src-tauri/target/universal-apple-darwin/release/bundle/macos/pi.app"
INSTALLED_APP="/Applications/pi.app"
PNPM="/Users/mingeon/.nvm/versions/node/v24.14.0/bin/pnpm"

cd "$REPO"

if [[ "${1:-}" != "--install-only" ]]; then
  echo "==> building pi-gui release (this takes a few minutes)..."
  "$PNPM" tauri:build
fi

if [[ ! -d "$BUILT_APP" ]]; then
  echo "ERROR: build did not produce ${BUILT_APP}" >&2
  exit 1
fi

VERSION="$(/usr/bin/defaults read "$BUILT_APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo '?')"
echo "==> built pi.app v${VERSION}"

echo "==> quitting running pi.app (if any)..."
/usr/bin/osascript -e 'quit app "pi"' 2>/dev/null || true
# give it a moment to release the bundle / port
sleep 1

echo "==> installing to ${INSTALLED_APP} ..."
/bin/rm -rf "${INSTALLED_APP}"
/bin/cp -R "${BUILT_APP}" "${INSTALLED_APP}"
# clear the quarantine attr so Gatekeeper does not nag on a locally-built app
/usr/bin/xattr -dr com.apple.quarantine "${INSTALLED_APP}" 2>/dev/null || true

echo "==> relaunching..."
/usr/bin/open "${INSTALLED_APP}"

echo "OK: pi-gui updated to v${VERSION} and relaunched."
