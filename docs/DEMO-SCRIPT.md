# Demo script — about 3:00 (OKX Dev Day)

Recorded on the **web app** against the hosted X Layer fork executor, plus a short **phone clip** (D13). Fills are
real EVM execution against X Layer mainnet state on the fork; say so once, plainly.

## Before recording

- Executor warm: `curl -s https://executor-fork-production-2db8.up.railway.app/verify` — chain, contract, Uniswap,
  prices, Aave and equities all `pass`.
- A demo account signed in on the web build, holding fork USDC (the in-app test-funds button) and a grant of
  **$100/day for 7 days** (D19).
- Viewport 402 × 874 for the web capture.

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
7. **Phone clip (2:50–3:00).** The same account on the phone: holdings and the activity trail.

## If something is off

Do not cut around a failure silently — re-record. Every number on screen must be one the app actually produced.
