#!/bin/bash
# Bundle the SwiftPM executable into a launchable macOS .app.
# A bare SPM executable can't be a proper GUI app (needs Info.plist + bundle layout).
set -euo pipefail

cd "$(dirname "$0")"
APP_NAME="pi"
BUNDLE_ID="me.mingeon.pi.swift"
CONFIG="${1:-debug}"

echo "Building ($CONFIG)…"
swift build -c "$CONFIG"

BIN=".build/$CONFIG/PiMac"
APP="build/$APP_NAME.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"

rm -rf "$APP"
mkdir -p "$MACOS" "$RES"
cp "$BIN" "$MACOS/$APP_NAME"
# App icon (serif π). Regenerate with: swift make-icon.swift Resources/AppIcon.iconset && iconutil -c icns ...
if [ -f Resources/AppIcon.icns ]; then cp Resources/AppIcon.icns "$RES/AppIcon.icns"; fi

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundleDisplayName</key><string>pi</string>
    <key>CFBundleExecutable</key><string>$APP_NAME</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key><string>2.0.0</string>
    <key>CFBundleShortVersionString</key><string>2.0.0</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSPrincipalClass</key><string>NSApplication</string>
    <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
</dict>
</plist>
PLIST

# Codesign: use Developer ID if available, otherwise ad-hoc for local dev.
IDENTITY="${CODESIGN_IDENTITY:-Developer ID Application: STAR BALLOON PAYMENTS SERVICE ASIA PACIFIC LIMITED (UTTXQZ2G2T)}"
if security find-identity -v -p codesigning | grep -q "$IDENTITY"; then
  codesign --force --deep --options runtime --sign "$IDENTITY" "$APP"
  echo "Signed with: $IDENTITY"
else
  codesign --force --deep --sign - "$APP" 2>/dev/null || echo "codesign skipped"
  echo "Ad-hoc signed (Developer ID not found)"
fi

echo "Bundled: $APP"
