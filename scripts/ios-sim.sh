#!/usr/bin/env bash
# Build this app for the booted iOS simulator and install it — then `npm run start:fork` serves its JavaScript.
#
#   ./scripts/ios-sim.sh
#
# Why not `expo run:ios`: on this machine it resolved the booted simulator to its UDID and then treated it as a physical
# iPhone ("No code signing certificates are available"). xcodebuild, aimed at the simulator by id, does not.
#
# The three settings it needs, each learned the hard way (2026-09-25):
#   - DEVELOPER_DIR: `xcode-select` points at the Command Line Tools here, which have no `simctl`;
#   - LANG / LC_ALL UTF-8: CocoaPods crashes on the project path without a UTF-8 locale;
#   - ad-hoc signing (CODE_SIGN_IDENTITY=-), never CODE_SIGNING_ALLOWED=NO: an unsigned build has no keychain
#     entitlement, and Privy's session store (expo-secure-store) fails with "A required entitlement isn't present".
set -euo pipefail
cd "$(dirname "$0")/.."

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

SIM=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)
[ -n "$SIM" ] || { echo "No simulator is booted. Boot one: xcrun simctl boot \"iPhone 17 Pro\""; exit 1; }

[ -d ios ] || CI=1 npx expo prebuild -p ios --no-install
(cd ios && pod install)
(cd ios && xcodebuild -workspace xorr.xcworkspace -scheme xorr -configuration Debug -sdk iphonesimulator \
  -destination "platform=iOS Simulator,id=$SIM" -derivedDataPath build CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO \
  | grep -E "error:|BUILD (SUCCEEDED|FAILED)")

xcrun simctl terminate "$SIM" finance.xorr.app 2>/dev/null || true
xcrun simctl uninstall "$SIM" finance.xorr.app 2>/dev/null || true
xcrun simctl install "$SIM" ios/build/Build/Products/Debug-iphonesimulator/xorr.app
echo "installed on $SIM — now: npm run start:fork, then open the app"
