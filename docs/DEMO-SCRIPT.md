# Demo script — about 3:00 (OKX Dev Day)

Recorded on the **web app** against the hosted X Layer fork executor, plus a clip of the **native app on the iOS
simulator** (D13, D21). Fills are real EVM execution against X Layer mainnet state on the fork; say so once, plainly.

## Before recording

- Executor warm: `curl -s https://executor-fork-production-2db8.up.railway.app/verify` — chain, contract, Uniswap,
  prices, Aave and equities all `pass`.
- A demo account signed in on the web build, holding fork USDC (the in-app test-funds button) and a grant of
  **$100/day for 7 days** (D19).
- Viewport 402 × 874 for the web capture.
- **iOS simulator** (Xcode at `/Applications/Xcode.app`):
  ```bash
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  xcrun simctl boot "iPhone 17 Pro"; open "$DEVELOPER_DIR/Applications/Simulator.app"
  npm run start:fork                      # Metro, pointed at the X Layer fork executor, RPC and delegation
  xcrun simctl spawn booted defaults write finance.xorr.app RCT_jsLocation localhost:8081
  xcrun simctl launch booted finance.xorr.app
  ```
  The installed debug build (`finance.xorr.app`) runs this repo's JS. `test-8958@privy.io` on the simulator is funded
  with fork USDC, granted $100/day for 7 days, and already holds a TSLAx position Momentum Scout bought on its own.

## Beats

1. **What it is (0:00–0:15).** "An agent that trades tokenized US stocks on X Layer for me — inside a permission I can
   read and take back." Home screen with holdings.
2. **The permission (0:15–0:50).** Grant screen: cap $100/day, 7 days, venues Uniswap v3 + OKX DEX. Sign. Show the
   Safety/approvals screen listing exactly what was approved.
3. **The agent trades (0:50–1:40).** Agent screen: it picks a setup on an xStock (e.g. TSLAx), explains why, and buys.
   Activity row → transaction; holdings show the wrapped xStock *in my wallet*, not the app's.
4. **It can't overspend (1:40–2:05).** Ask for more than today's cap → the contract refuses; the screen says which rule.
5. **It proves itself (2:05–2:30).** `/judge`: every claim re-checked against the chain, live.
6. **Take it back (2:30–2:50).** Stop all → one signature → the next run is refused. No server involved.
7. **iOS clip (2:50–3:00).** The native app on the simulator: Home (balance, Permit ✓, ARMED), a stock ticket, and the
   order screen refusing a buy past today's allowance ("Your permission allows $100.00 more today").

## What was actually recorded

`docs/demo/xorr-demo.mp4` (2:43, 2026-09-20) covers beats 1–5 and closes on 6's screen — the Safety page with "Stop all
trading" — without pressing it, because pressing it revokes the demo wallet's permission and re-granting is 17
signatures. Beat 7, the iOS-simulator clip, is not in it: the native app on the simulator is a dev build that needs
Metro and its own sign-in, and that is a separate recording. `tools/record-demo.mjs` is the script that made it.

## If something is off

Do not cut around a failure silently — re-record. Every number on screen must be one the app actually produced.
