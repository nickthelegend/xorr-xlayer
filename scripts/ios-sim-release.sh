#!/usr/bin/env bash
# A Release build of this app on a simulator of its own, with the network built in — no Metro, no port 8081.
#
#   ./scripts/ios-sim-release.sh mainnet      # X Layer mainnet (the default)
#   ./scripts/ios-sim-release.sh fork         # the hosted fork, test funds on Deposit
#
# Its own simulator ("xorr-xlayer iPhone 17 Pro"), created on first use: the Solana build of xorr ships the same bundle id
# (finance.xorr.app), so one device cannot hold both — installing either signs the other's user out (2026-09-25). And a
# Release build, because a debug build loads its JavaScript from whatever answers on localhost:8081, which may be the
# other project's Metro. The build settings are ios-sim.sh's: DEVELOPER_DIR, a UTF-8 locale, ad-hoc signing.
set -euo pipefail
cd "$(dirname "$0")/.."

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

case "${1:-mainnet}" in
  mainnet)
    export EXPO_PUBLIC_XORR_CHAIN=xlayer EXPO_PUBLIC_CHAIN_RPC= \
      EXPO_PUBLIC_PINNED_DELEGATION=0x156DCE9E9d523775AB51f882616A431EdBfBcA22 \
      EXPO_PUBLIC_API_URL=https://executor-mainnet-production.up.railway.app ;;
  fork)
    export EXPO_PUBLIC_XORR_CHAIN=xlayer-fork EXPO_PUBLIC_CHAIN_RPC=https://xlayer-fork-production.up.railway.app \
      EXPO_PUBLIC_PINNED_DELEGATION=0xAf70b1ee53B459f35A9dC29BE17b439d3ee27058 \
      EXPO_PUBLIC_API_URL=https://executor-fork-production-2db8.up.railway.app ;;
  *) echo "usage: $0 [mainnet|fork]"; exit 1 ;;
esac

NAME="xorr-xlayer iPhone 17 Pro"
SIM=$(xcrun simctl list devices | grep -F "$NAME (" | grep -oE '[0-9A-F-]{36}' | head -1 || true)
[ -n "$SIM" ] || SIM=$(xcrun simctl create "$NAME" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro)
xcrun simctl boot "$SIM" 2>/dev/null || true

[ -d ios ] || CI=1 npx expo prebuild -p ios --no-install
(cd ios && pod install)
(cd ios && xcodebuild -workspace xorr.xcworkspace -scheme xorr -configuration Release -sdk iphonesimulator \
  -destination "platform=iOS Simulator,id=$SIM" -derivedDataPath build CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO \
  | grep -E "error:|BUILD (SUCCEEDED|FAILED)")

xcrun simctl terminate "$SIM" finance.xorr.app 2>/dev/null || true
xcrun simctl install "$SIM" ios/build/Build/Products/Release-iphonesimulator/xorr.app
xcrun simctl launch "$SIM" finance.xorr.app
echo "installed on $NAME ($SIM), against ${1:-mainnet}. Record it with:"
echo "  xcrun simctl io $SIM recordVideo ~/Desktop/xorr-iphone.mov"
