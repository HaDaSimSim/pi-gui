#!/bin/bash
# Build a distributable .dmg containing pi.app.
# Long-term: codesign + notarize + Sparkle auto-update will hook in here (not App Store).
# For now this produces an ad-hoc-signed dmg suitable for local install.
set -euo pipefail

cd "$(dirname "$0")"
CONFIG="${1:-release}"
VERSION="$(grep -m1 CFBundleShortVersionString bundle.sh | sed -E 's/.*<string>([^<]+)<.*/\1/')"
APP="build/pi.app"
DMG="build/pi-$VERSION.dmg"
STAGE="build/dmg-stage"

# 1. Build + bundle the app (release config).
./bundle.sh "$CONFIG"

# 2. Stage a clean dmg root with the app + an /Applications symlink for drag-install.
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

# 3. Create a compressed dmg.
hdiutil create \
  -volname "pi $VERSION" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DMG"

rm -rf "$STAGE"
echo "Built: $DMG"
echo
echo "NOTE: ad-hoc signed only. For distribution you'll later add:"
echo "  codesign --deep --options runtime --sign \"Developer ID Application: ...\" $APP"
echo "  xcrun notarytool submit $DMG --keychain-profile ... --wait"
echo "  xcrun stapler staple $DMG"
