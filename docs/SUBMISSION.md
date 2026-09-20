# Submission — OKX Dev Day 2026

**Deadline:** 2026-09-25 23:59 UTC. **Repo:** https://github.com/nickthelegend/xorr-xlayer (public at submission, after
a history secret scan — PLAN.md D14).

**Live:** **https://xorr-xlayer.vercel.app** (Vercel project `xorr-xlayer`), executor on Railway at
`https://executor-fork-production-2db8.up.railway.app` (`/health`, `/verify`), trading against a hosted fork of X Layer
mainnet (`https://xlayer-fork-production.up.railway.app`, chain 196). Contracts on X Layer testnet, source-verified:
XorrDelegation `0x156DCE9E9d523775AB51f882616A431EdBfBcA22`, XorrAuditAnchor `0x36d503D1893CAB30B5D68DC9A96e8B91bfcBe196`,
served by `https://executor-testnet-production.up.railway.app`.

**Video:** [`demo/xorr-demo.mp4`](demo/xorr-demo.mp4) — 2:43, recorded against the deployed build on 2026-09-20 by
[`tools/record-demo.mjs`](../tools/record-demo.mjs), which signs in, walks the beats in [`DEMO-SCRIPT.md`](DEMO-SCRIPT.md)
and captions them. Nothing in it is staged: every figure on screen is what the executor and the chain answered while it
was recording, and where a list is filtered the filter is the product's own, tapped on camera. Re-run the script to get
a fresh one against live data.

Every address and number below was read from the chain or produced by a command in this repo on 2026-09-19.

---

## One line

An autonomous agent that trades tokenized US stocks (xStocks) on X Layer for you, inside an on-chain permission that
caps it per day, limits it to venues you chose, expires on its own, can only pay *you*, and dies with one signature.

## The problem

Autonomous trading agents need to move money while you are asleep. Every way to give them that today is either
custody (hand over the funds) or a blank-cheque approval. Neither survives a bad model, a stolen key or a bug.

## What we built

- **`XorrDelegation`** — the permission as a contract: daily cap, expiry, venue allowlist, and an output floor bound to
  the owner (the owner's balance of the bought asset must rise, or the trade reverts). `spendVia` lets an aggregator
  that pulls through a separate approval contract (OKX DEX) fill under the same rules. `closePosition` sells back
  outside the cap so a stop-loss always fires; `revoke()` needs no server.
- **The agent** — scores setups on 11 wrapped xStocks and crypto on X Layer (momentum, mean reversion, earnings
  windows from SEC EDGAR), sizes against the cap it reads from the chain, holds outside Nasdaq hours when the pool
  drifts from xStocks' own reference price, warns ahead of splits read from the token's scheduled multiplier, and
  explains every trade from the decision record it wrote at the time.
- **The app** — iOS, Android and web (Expo): Privy embedded wallet (Google, X, email, and OKX Wallet on web), grant and
  revoke, deposits in USDC or USDT0 on X Layer, a user-signed USDT0→USDC convert, holdings, activity, and `/judge`,
  which re-runs the product's claims against the live chain.

## How it uses OKX and X Layer

| | |
|---|---|
| X Layer | Every contract, every fill, every grant. Cancun `tstore` proven on X Layer state. |
| OKX DEX API | v6 aggregator (HMAC-signed): quoted beside Uniswap, wins when its guaranteed output is higher, settles through `spendVia` to OKX's approve spender. Live quotes need the API key (the path is built and tested). |
| OKX Wallet | A sign-in option on web (Privy `okx_wallet`). |
| OKX on-ramp | "Open OKX" on the deposit screen to buy and withdraw USDC/USDT0 to X Layer. |
| xStocks | Backed's wrapped xStocks, their on-chain multipliers and roles, and their asset API for logos. |
| Uniswap v3 on X Layer | The default venue; USDG hop for the stocks without a USDC pool. |
| Aave v3 on X Layer | Idle cash earns on USDT0 (~3.5%, read live). |

## Proof

- `cd contracts && XLAYER_RPC=https://rpc.xlayer.tech forge test` — unit suites plus a fork suite on real X Layer
  state (TSLAx direct, NVDAx via USDG, cap, foreign venue, close, revoke).
- `cd server && npm run prove:testnet` — the permission on X Layer testnet: grant, read back, `VenueNotAllowed`,
  `NotDelegate`, revoke, `PolicyRevoked`, each an OKLink transaction.
- **A permission standing on the public chain, to check without running anything.** Owner
  `0xd747284963556832e22C6d63bAB0B82Da7d54d11`, granted 2026-09-20 ([the grant on
  OKLink](https://www.oklink.com/xlayer-test/tx/0x8b2586abfaa2bab08097d092b81cfccec26a94c7b66fefc962650bd32f4f438b)),
  $100/day to the delegate for 7 days. Paste it into `/judge` on the testnet deployment, or read it straight off the
  contract:
  [`/verify?owner=0xd747…4d11`](https://executor-testnet-production.up.railway.app/verify?owner=0xd747284963556832e22C6d63bAB0B82Da7d54d11)
  — 15 pass, 0 fail, 5 skip. The five skips are the things that genuinely are not on this chain: no xStock wrappers
  (they are X Layer mainnet contracts), and no wallet, strategies or audit trail, because nobody has signed in on the
  testnet deployment. It was left standing by `PROVE_KEEP=1`, expires on its own, holds no funds, and its owner key
  was never written down.
- `cd server && npm run setup:fork && npm run prove:fork` — the executor's own order path on a fork: $50 of TSLAx
  into the owner's wallet, a $60 NVDAx buy refused by the on-chain cap, the position sold back for $49.95, revoke
  refusing the next order. Both run in CI on every push.

## Honest limits

No real money moves: the X Layer testnet has no DEX, so fills are shown on a fork of mainnet. OKX DEX routing needs an
API key. Wrapped xStocks track shares through Backed's issuance and are not the shares themselves.
