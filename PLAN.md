# xorr on X Layer — the plan

**Written 2026-09-19.** This file is the single source of truth for finishing **xorr-xlayer**: the goals, five end-to-end phases, every task (tagged `DONE` / `IN PROGRESS` / `NOT STARTED` / `BLOCKED`), and every gap found in the code. A builder agent should be able to pick any single task and execute it with no other context. The previous file here was xorr-solana's Solana plan; it is in git history (`git show b394cb1:PLAN.md`).

- Repo: `/Volumes/Extreme SSD/Projects/xorr-xlayer`, private `github.com/nickthelegend/xorr-xlayer`, branch `main`.
- Started from `github.com/nickthelegend/xorr-solana` main `4d44594` (commit `b394cb1`). Phase-1 checkpoint: `e307cfa` (WIP).
- History that matters: xorr-solana branched from **xorr-eth** (the Base build) at `f7be1b3` and **only added** Solana code. The whole EVM stack — `contracts/src/XorrDelegation.sol`, `server/src/evm/delegation.ts`, `server/src/executor/settle.ts`, the Privy EVM grant flow in the app — is intact and is what runs on X Layer.

---

## 0. How to work in this repo (read before any task)

- **Tests need the local `.env` set aside.** The copied `.env` sets a stale chain and makes ~9 server suites fail at import. Run exactly as the ship gates do:
  `mv .env .env.gate-aside; npx vitest run; (cd server && npx vitest run --exclude '**/*.live.test.ts'); mv .env.gate-aside .env`
  The root `vitest` run includes the server suites.
- **Gates for every task:** `npx tsc --noEmit -p .` (app), `cd server && npx tsc --noEmit -p .`, `npm run lint`, both test suites above. Baseline before any migration (untouched copy): app suite 2,586 pass / 2 fail, server suite 1,330 pass / 2 fail (the 2 are the Solana fork proofs). After `e307cfa`: 2,485 pass / 51 fail (listed in §5 G-TEST).
- **No fabrication.** This codebase refuses invented prices, balances, signatures and addresses everywhere; keep that rule. Every address in this plan was read on chain on 2026-09-18 and matched to its issuer. Do not add an address that has not been verified the same way.
- **Stage explicit paths.** Never commit `.env*` (except `.env.example`), `.keys/`, or `*.gate-aside`.
- **Commit per task** with a message that says what changed and why; end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Anvil fork of X Layer mainnet works as-is:** `anvil --fork-url https://rpc.xlayer.tech --chain-id 196` (impersonation, ERC-20 calls and Uniswap swaps verified). Public RPC limit is 100 req/s per IP.

---

## 1. Goals

### 1.1 What xorr is
A non-custodial AI trading agent. A person signs in (Privy embedded wallet), funds it with USDC, and signs **one on-chain permission** (`XorrDelegation`): a daily USDC cap that resets at the UTC day, an expiry, a venue allowlist, and a revoke the owner can send with no server. Inside that permission an agent buys and sells **tokenized US stocks (xStocks)** and crypto, proposes or auto-executes by strategy (DCA, rebalance, TP/SL, grid, momentum, earnings), and records every action in a hash-chained audit trail. The pitch: *the permission is the product, and every claim is checkable on chain.*

### 1.2 What "done" means (all must be true)
1. **The app and executor run on X Layer only.** No Solana code, no 1inch/Aave/Ondo/Basenames/MoonPay dependency at boot or in any user path; every screen names X Layer where it names a chain.
2. **The core journey works end to end on an X Layer mainnet fork** (real xStocks, real Uniswap v3 liquidity, no real money):
   sign in → fund (fork faucet) → grant `XorrDelegation` (cap, expiry, venues, token approvals incl. wrapped xStocks) → an agent **buys a wrapped xStock** through the delegation via Uniswap v3 (and OKX DEX when keyed) → the position and fill show in the app with the venue named → the cap and venue allowlist refuse an over-limit/foreign spend → **Stop all** revokes on chain without the server → **sell/close** and **withdraw** to an allowlisted address settle.
3. **The contracts are deployed on X Layer testnet (1952)** with verified source, addresses recorded in `contracts/deployments/xlayer-testnet.json`, and the testnet executor serves them.
4. **Proof is reproducible by a stranger:** one command stands up the X Layer fork demo; one proof script runs the journey in (2) and prints pass/fail per claim; `/judge` (`GET /verify`) checks are green on the deployed executor.
5. **Deployed and live:** an X Layer executor (testnet) + a fork executor + fork node on Railway, the web app on a public URL built for X Layer, health endpoints green.
6. **All gates green:** both typechecks, lint, both suites with **zero** known failures, `forge test` including an X Layer fork test.
7. **Docs are true:** README quickstart and proof section, DEMO-SCRIPT, SECURITY, ADDING-A-CHAIN, landing copy all describe X Layer and only what exists.

### 1.3 What "winning" means — OKX Dev Day 2026 (X Layer track: tokenized stocks & RWAs)
- **Deadline: 2026-09-25 23:59 UTC** (online build Sep 17–25; finalists notified by Sep 30; finale Singapore Oct 6/7; remote teams can win). Sources: https://luma.com/l4aq8vii · https://www.okx.com/en-us/learn/okx-dev-day-builder-kit · https://www.okx.com/en-us/learn/okx-dev-day-terms
- **Submission requirements:** public GitHub repo with README, **2–4 minute demo video** of the working product, **live product/deployment link**, team info and summary, via the official form. Applications were due Sep 11–15 (sources disagree) — registration status is an owner question (§6).
- **Judging criteria and what xorr must show for each:**
  | Criterion | What wins it here |
  |---|---|
  | Meaningful integration with X Layer / OKX | Contracts live on X Layer; trades wrapped **xStocks on X Layer**; venue = **OKX DEX API** (+ Uniswap v3); gas in OKB; explorer links to OKLink; ideally one OKX AI/Onchain OS touchpoint (§6 Q9) |
  | Product completeness | The full journey in §1.2(2) on a live link, no dead screens, no "coming soon" |
  | Technical execution | On-chain enforcement proven by a script + `/judge`; kill switch without server; audit anchor on X Layer |
  | User value | "Trade US stocks 24/7 with an agent you can switch off in one tap, and whose limits are on chain" |
  | Innovation | Scoped on-chain agent permission + verifiable audit + ERC-4626 xStock corporate-action awareness |
  | Growth / ecosystem | Brings xStocks volume to X Layer DEX liquidity; business-treasury mode on Privy key quorum |
- **Conflict to manage:** xorr-solana's Stocklana deadline is the same day (2026-09-25 16:00 ET). This plan assumes xorr-xlayer is the priority for the builder working it (owner question §6 Q1).

### 1.4 Non-goals (explicitly out)
Solana anything; 1inch (Aggregation, Limit Order Protocol, Fusion+, Aqua, SwapVM); Aave **on Base** (yield moves to an X Layer lender, P2.14); Ondo equities; Basenames; The Graph; MoonPay/Transak in-app card on-ramp; real-money mainnet trading (mainnet stays behind `ALLOW_MAINNET=yes` and an owner decision); native-app external-wallet login.

---

## 2. Verified X Layer facts (use these; do not re-derive)

| Item | Value |
|---|---|
| Mainnet | chain **196**, RPC `https://rpc.xlayer.tech` / `https://xlayerrpc.okx.com`, explorer `https://www.oklink.com/xlayer` (tx: `/tx/<hash>`), gas **OKB** |
| Testnet | chain **1952**, RPC `https://testrpc.xlayer.tech` / `https://xlayertestrpc.okx.com`, explorer `https://www.oklink.com/xlayer-test`, faucet `https://web3.okx.com/xlayer/faucet` (~0.2 OKB/claim) |
| viem | `xLayer` (196) and `xLayerTestnet` (1952) in viem 2.56 match; Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11` on both |
| Stack | OP Stack since 2025-10-27 (reth). `XorrDelegation` uses EIP-1153 `tstore` — **verify Cancun opcodes on first fork deploy** (P3.1) |
| USDC (native, Circle) | mainnet `0xB6CEceAB302E2E4948951eE7843FC24E92933061` (6) · testnet `0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3` (6). **Not** `0x74b7F16337b8972027F6196A17a631aC6dE26d22` (USDC.e, bridged, what OKX's token list calls "USDC") |
| Other mainnet tokens | USDG `0x4ae46a509F6b1D9056937BA4500cb143933D2dc8` (6) · WETH `0x5A77f1443D16ee5761d310e38b62f77f726bC71c` (18) · xBTC `0xb7C00000bcDEeF966b20B3D884B98E64d2b06b4f` (8) · WOKB `0xe538905cf8410324e03A5A23C1c177a474D59b2b` (18) · USD₮0 `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` (6) |
| Uniswap v3 (mainnet) | Factory `0x4B2ab38DBF28D31D467aA8993f6c2585981D6804` · **SwapRouter02 `0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA`** · **QuoterV2 `0xD1b797D92d87B688193A2B976eFc8D577D204343`** · UniversalRouter `0xDa00aE15d3A71466517129255255db7c0c0956d3` · Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| OKX DEX API | `https://web3.okx.com/api/v6/dex/aggregator/{quote,swap,approve-transaction,supported/chain,all-tokens}`, `chainIndex=196`. Auth headers `OK-ACCESS-KEY`, `OK-ACCESS-TIMESTAMP` (ISO, ±30 s), `OK-ACCESS-PASSPHRASE`, `OK-ACCESS-SIGN` = base64(HMAC-SHA256(secret, timestamp + METHOD + requestPath[+query] + body)). Router `0x7c5bee2a8091c3ef39072f64f18fac913060aeaf`, **approve spender `0x8b773D83bc66Be128c60e07E17C8901f7a64F000`** (differs from router — see P2.8). Trial tier 1 rps. Key: https://web3.okx.com/onchainos/dev-portal/project |
| Not on X Layer | 1inch (all products), MoonPay, Transak. Aave: unverified. The Graph: supports `xlayer-mainnet`; Goldsky supports X Layer |
| xStocks | Source of truth: `GET https://api.xstocks.fi/api/v2/public/assets/{SYMBOL}` → `deployments[]` entry `network:"XLayer"` (`address` = raw rebasing token, `wrapperAddressV2` = ERC-4626 wrapper). **Trade the wrapper.** All 18 decimals. Wrapper `convertToAssets(1e18)` == raw `multiplier()` → the corporate-action multiplier on EVM |

Wrapped xStocks (mainnet 196) and their deepest stable pool (Uniswap v3):

| Ticker | Wrapped (trade this) | Raw (rebasing) | Pool | Depth |
|---|---|---|---|---|
| TSLAx | `0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171` | `0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0` | USDC/wTSLAx 0.05% `0x6A58944EEd3d2074E137Eb4e94b302FE4AF247a6` | ~$214k |
| QQQx | `0x4c1ae29c159838fc1b224636e28e086eb69101f7` | `0xa753A7395cAe905Cd615Da0B82A53E0560f250af` | USDC 0.05% `0x2Bd90724ffc80ba22Ec7Af8CFd2B4b51Ff395b04` | ~$505k |
| GOOGLx | `0xf8c5308f80e459bb53d9ebe689854d9cbb2caa6f` | `0xe92f673Ca36C5E2Efd2DE7628f815f84807e803F` | USDC 0.05% `0x9F6273e2669cd812e76788b698374C43637c87c2` | ~$332k |
| COINx | `0x44c7ed7ffdf8465c9d27f60aec845eed3d49d56e` | `0x364f210f430eC2448Fc68A49203040F6124096F0` | USDC 0.05% `0x91db1a80bd51FcBD30c6BFa398EEe0De24eE2663` | ~$121k |
| SPYx | `0xe7e553cd128f0011777323a0b44a7b96ea1cb540` | `0x90A2a4c76b5D8c0bc892A69EA28Aa775a8f2dD48` | USDG 0.05% `0x07c40850D14064D20eB0AfDEf9574675392f2c11` | ~$961k |
| NVDAx | `0xa8ddb5cd96b5222afe198316e9a57caa642850d5` | `0xc845b2894dBddd03858fd2D643B4eF725fE0849d` | USDG 0.05% `0x2a2B11730C2b6d99a58034A869dd810D7300a7b2` | ~$305k |
| AAPLx | `0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f` | `0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a` | USDG 0.05% `0xc44bd9c8589026D28D1632d7b86b2Efb6cDc8fd2` | ~$270k |
| MSFTx | `0x166fbe68274b6a47e025f4ba17388c539f1fa1d0` | `0x5621737f42dAE558b81269FcB9E9E70c19Aa6b35` | USDG 0.05% `0x66187278490a70A8aC26a6E159EB045F82DbFb57` | ~$154k |
| METAx | `0xe840946ffebcd66b7c4e95095effafadfa0d0e56` | `0x96702be57Cd9777f835117a809C7124fe4ec989A` | USDG 0.05% `0xfAD9e3C7550768fd4f34Bc9CEFD365CC193C0fB0` | ~$118k |
| MSTRx | `0x30987adf0b11dc698438a99ba04ec3a1ab2c7eab` | `0xAE2f842EF90C0d5213259Ab82639D5BBF649b08E` | USDG 0.05% `0xB665A8Ed2c09Bd243aCfEE75A82EF3A8b3f63c67` | ~$109k |
| AMZNx | `0x910cabde3eba7fc1ce64fd14bd680b9f60fa0f90` | `0x3557Ba345B01EFa20A1bdDC61F573BFD87195081` | USDG 0.05% `0x8C1C0d559D1C7AE6ed921cC77abd0f26aC2FE59a` | ~$32k |

USDG-only tickers route **USDC → USDG → wXx** (two-hop `exactInput` path). Proven: on an anvil fork, 1,000 USDC → 2.754 wTSLAx through SwapRouter02 `exactInputSingle` fee 500, 176,900 gas.

---

## 3. Status snapshot (2026-09-19)

- **Done:** copy + `git init` + private GitHub repo; chain config for app and executor (`src/chain.ts`, `server/src/evm/{money,chains}.ts`) with verified addresses and tests; Solana-only files removed (wallet, validator container, proof scripts, E2E log, demo script, base58 allowlist tests); withdraw/send/allowlist/withdrawal & faucet routes/CI restored to EVM; Base chain keys mapped to X Layer keys; field renames (`usdc`, `weth`, `btc`, `IS_MAINNET_STATE`).
- **In progress:** removing the rest of the Solana layer (`server/src/solana/*` + 14 importers still present).
- **Not started:** every venue, xStocks, fork, deploy, app-copy, docs and submission task below.
- **Blocked on owner:** OKX DEX API key (coming 2026-09-19); testnet deployer key + faucet OKB; Privy dashboard (X Layer chains, Google/X logins); Dev Day registration; Railway/Vercel project choices (§6).

---

## 4. Phases and tasks

Order matters: each phase's tasks assume the previous phase is done. Tasks inside a phase can run in parallel unless a dependency is named. Effort: S < ½ day, M 1–2 days, L 3+ days.

### Phase 1 — Clean EVM core on X Layer (the executor boots with no Solana, no 1inch key, no Base assumptions)

**Exit criteria:** server boots with `XORR_CHAIN=xlayer-fork` and no `ONEINCH_API_KEY`; `grep -r "@solana/" src server/src app` returns nothing; both typechecks pass; known failures only in modules Phase 2 replaces.

- **P1.1 Chain config (app + executor)** — `DONE` (`e307cfa`). `src/chain.ts`, `server/src/evm/money.ts`, `server/src/evm/chains.ts`, tests `src/chain.test.ts`, `server/src/evm/{chains,money,chain-agreement}.test.ts` (15/15 pass).
- **P1.2 Remove Solana-only files** — `DONE` (`e307cfa`): `src/wallet/solanaWallet*`, `infra/solana-fork/`, `tools/prove-solana-*`, `docs/E2E-RUN-2026-09-17.md`, `server/scripts/demo-autonomous-agent.ts`, `server/src/withdrawals/allowlist-solana.test.ts`, three Solana npm scripts. Restored EVM: `src/wallet/{useWithdraw,allowlist}.ts`, `app/{send,allowlist}.tsx`, `server/src/withdrawals/allowlist.ts` (+ EVM-only `isValidAddress`/`formatAddress` for MoonPay), `server/src/routes/{withdrawals,faucet}.ts`, `.github/workflows/ci.yml`.
- **P1.3 Split the token registry out of 1inch** — `DONE` (`430cc4a`). `server/src/venues/tokens.ts` holds the registry (USDC, USDG, USDT0, XBTC, WOKB, WETH + 11 wrapped xStocks); `oneinch.ts` deleted; boot needs no 1inch key.. Create `server/src/venues/tokens.ts` holding `TOKENS`, `canonicalSymbol`, `SETTLEMENT_SYMBOL`, `SLIPPAGE`, `slippageFor`, `DEFAULT_SLIPPAGE_PCT`, `CAN_SETTLE` (moved verbatim from `server/src/venues/oneinch.ts`). Registry contents: USDC, USDG, WETH, `XBTC` (rename from `CBBTC`; CoinGecko id `bitcoin`), WOKB, and the 11 wrapped xStocks from §2 (symbol = ticker e.g. `TSLAx`, address = wrapper, 18 decimals). Repoint all 36 importers (`grep -rl "venues/oneinch" server/src`). Remove the import-time `ONEINCH_API_KEY` throw (oneinch.ts:22) so boot no longer needs it. Tests: move registry tests from `oneinch.test.ts` to `tokens.test.ts`.
- **P1.4 Unhook Solana from boot and routes** — `DONE` (`430cc4a`). `server/src/solana/`, `venues/jupiter.ts`, `executor/place.ts` and the `@solana/*`/`bs58` deps are gone; `grep -r "@solana/" src server/src app` is empty.. Remove Solana imports/branches from: `server/src/routes/index.ts` (the `/wallet/balance` Solana branch ~line 334, `readSolanaBalances`, `readDelegation`, `checkEligibility`, `/xstocks/:s/eligibility`), `server/src/bot/explain.ts` (`explorerTx` → `evm/chains.explorerTx`), `server/src/executor/scheduler.ts` (drop `autonomousAgentSweep`, `basketSweep`, `sweepCorporateActions` until P2.10/P2.11 re-add EVM versions), `server/src/executor/resting.ts` and `server/src/market/corporate-action.ts` (stub multiplier to "none" until P2.6), `server/src/venues/{backing-detail,corporate-actions,xstocks-quote}.ts`, `server/src/routes/xstocks.ts` (move `UnpricedError` to `server/src/venues/errors.ts`). Then delete `server/src/solana/`, `server/src/venues/jupiter.ts` (+ `jupiter-quote.test.ts`), `server/src/executor/place.ts`, and remove `@solana/web3.js`, `@solana/spl-token` from `server/package.json` and root `package.json`, and root `bs58`; `npm install` to refresh lockfiles.
- **P1.5 Remove the Base-only modules that have no X Layer equivalent** — `DONE` (`430cc4a`, `b0eace3`). Aqua/SwapVM/limit orders/Fusion+/1inch history+balance/Graph/Basename modules, routes, scripts, subgraphs and contracts deleted; `evm/measure-route.ts` (1inch-on-Base-fork) deleted. `aave.ts`/`yield.ts` kept and re-pointed by P2.14.. Delete (with their tests, routes and scripts): `server/src/venues/{aqua,swapvm,limit-orders,fusion-plus,aave,history,balance}.ts`, `server/src/graph/aqua.ts`, `server/src/routes/{crosschain,limit-orders}.ts`, `server/src/market/yield.ts`, `server/src/evm/basename.ts`, `server/src/live-{aqua,swapvm,ladder}.ts`, `server/src/fork-{yield,tier4}.ts`, `server/src/yield-withdraw-prove.ts`, `server/src/equity-mainnet-proof.ts`, `server/src/fork/{prove-limit-order,prove-measured-route,ship-makers,makers}.ts`, `subgraph-aqua/`, `contracts/src/{XorrAquaBook,XorrSwapVMBook}.sol` and their fork tests, `contracts/lib/swap-vm` submodule (`git submodule deinit` + `git rm`). Unmount their routes in `server/src/index.ts`; remove `planYieldRotation` from `server/src/executor/kinds/index.ts` and `yield-rotation` from strategy validation. Replace `evm/gas-price.ts` 1inch call with `eth_feeHistory`; `evm/allowances.ts` reads allowances from chain (spender = delegation, + OKX approve spender after P2.8).
- **P1.6 Remaining chain-literal and copy fixes in the executor** — `DONE` (`430cc4a`, `b0eace3`). privy chain ids from `chain.id`, fork guard 196, OKB copy, LLM/persona copy, `/verify` Uniswap check; `base-readiness.ts`, `fork-e2e.ts`, `live-agents.ts` retired (replaced by `prove-xlayer.ts`).. `server/src/routes/privy.ts:80-81` sends `eip155:8453/84532` → `196/1952`; `server/src/fork/guard.ts:42` asserts 8453 → 196; `server/src/evm/{gasDrip,faucet}.ts` say ETH → OKB; `server/src/bot/{llm,personas}.ts` prompt text names Base/1inch → X Layer; `server/src/verify/checks.ts` retarget to 196/1952, Uniswap router/quoter, wrapped xStocks; `server/src/base-readiness.ts` → `readiness.ts` for X Layer.
- **P1.7 Server tests green for Phase 1** — `IN PROGRESS`. Executor/evm/routes/bot suites repaired (99 + 143 + 86 tests); auth/market/venue suites in progress. Unit runs pin `XORR_CHAIN=xlayer-testnet`; live suites excluded without `LIVE=1`.. Fix or delete tests tied to removed modules; update tests pinning Base facts (`auth/privyPolicy*.test.ts`, `evm/delegation-read.test.ts`, `fork/orphans.test.ts`, `routes/{tokens,panic-preview,balance-bounded}.test.ts`, `src/networks/{status,deployments}.test.ts`). Target: zero failures except tests of modules Phase 2 rewrites, each marked `it.todo` with a P2 task id.

### Phase 2 — Trading on X Layer: venues, xStocks, strategies, agents

**Exit criteria:** on an X Layer fork, `placeOrder` for `TSLAx` $50 and `NVDAx` $50 (USDG hop) fill through `spend()` into the owner's wallet; `closePosition` sells back; prices, P&L and holdings read wrapped xStocks; the autonomous agent places a trade through the EVM path; all suites green.

- **P2.1 Uniswap v3 venue** — `DONE` (`430cc4a`). `server/src/venues/uniswap.ts` (QuoterV2 quote, SwapRouter02 `exactInput`, USDG hop). Verified by `forge test --match-path "*XLayer.fork*"` (6/6 on real X Layer state) and `npm run prove:fork`.. New `server/src/venues/uniswap.ts`: `quote({ tokenIn, tokenOut, amountIn })` via QuoterV2 `quoteExactInput` (path encode `tokenIn,fee,tokenMid?,fee,tokenOut`), returning `{ amountOut, path, gasEstimate, priceImpactPct }`; `buildSwap({ owner, tokenIn, tokenOut, amountIn, minOut })` → SwapRouter02 `exactInput({ path, recipient: owner, amountIn, amountOutMinimum: minOut })` calldata; route table per registry token (pool fee 500; USDG hop for SPYx/NVDAx/AAPLx/MSFTx/METAx/MSTRx/AMZNx; USDC pools for TSLAx/QQQx/GOOGLx/COINx; WETH/XBTC/WOKB pools — **find and verify** their USDC or USDG pools on chain via Factory `getPool` before adding). Unit tests with mocked `readContract`; one `*.fork.test.ts` that quotes and swaps on an anvil fork when `XLAYER_FORK_RPC` is set.
- **P2.2 Settlement collapses to X Layer venues** — `DONE` (`430cc4a`). `chooseSettlement`: direct → aave; else Uniswap, OKX only when configured and its floor is higher (carries `spender`). The Base fork dry-run is gone: on an X Layer fork the pools ARE mainnet's, so the quote floor is the real floor. `settle.test.ts` 12/12.. `server/src/executor/settle.ts`: `SettlementVenue = 'uniswap-v3' | 'okx-dex'`; `chooseSettlement` quotes Uniswap (and OKX when `OKX_API_KEY` set, P2.8) and picks best net of gas; keep the fork dry-run floor (`server/src/evm/measure-route.ts`, decode `exactInput` return or measure by balance). Remove Aqua/SwapVM/1inch/Aave branches.
- **P2.3 Executor trade path on the registry** — `DONE` (`430cc4a`, `b0eace3`). run/order/swap/panic on the registry; fork proof fills a $50 TSLAx buy and a sell-back through the executor (`prove-xlayer.ts`, all checks pass). `swap.ts` passes the OKX spender (bug found in test repair).. `server/src/executor/{run,order,swap,fill-measure,fill-quality,failure}.ts`, `server/src/routes/panic.ts`, `server/src/routes/strategies.ts`, `server/src/evm/balances.ts` (holdings over the registry via multicall), `server/src/positions/index.ts`. Failure copy: add Uniswap reasons (`STF`, `TF`, `Too little received`); venue labels `'uniswap-v3' | 'okx-dex'`.
- **P2.4 Wrapped-xStock registry, prices and catalog** — `IN PROGRESS`. Registry, Uniswap prices, catalog, quote route done and live-checked (TSLAx $364.27 vs Jupiter's xStocks reference $364.39); market ids for XBTC/WOKB/USDG/USDT0 in progress.. Rewrite `server/src/venues/stocks.ts` as the wrapped-xStock registry (ticker, name, sector from the xStocks API, wrapper, raw, pool route); `stockPriceUsd` = Uniswap quote of 1 share (fallback: underlying via CoinGecko × `convertToAssets(1e18)/1e18`, labelled as such); `equitiesFunctional` = wrapper `asset()` + `totalSupply()` probe. Rewrite `server/src/venues/xstocks.ts`/`xstocks-catalog.ts` on EVM (keep the catalog row shape and "unpriced rather than invented"), `server/src/routes/xstocks.ts` (`/market/xstocks`, quote route on Uniswap), `server/src/market/{prices,feeds}.ts` (one `equity` feed = wrapped xStock), `server/src/market/ids.ts` (XBTC → `bitcoin`, WOKB → `okb`, USDG → `global-dollar`). Delete `xstocks-quote.ts`'s Jupiter shape; the order ticket reads the Uniswap quote.
- **P2.5 Grant approvals include wrapped xStocks** — `DONE` (`b0eace3`). `/delegation/params` approvals include every wrapped xStock where they function; `fork-grant.ts` approves them; the fork proof sells TSLAx back through `closePosition`.. `server/src/routes/index.ts` `/delegation/params` (~line 559) and `server/src/auth/privyPolicy.ts` approve `APPROVABLE_TOKENS` + every wrapped xStock; `server/src/fork-grant.ts` the same. Without this, sells (`closePosition` pulls wXx) and panic close revert.
- **P2.6 Corporate actions on ERC-4626** — `DONE` (`430cc4a`). `venues/multiplier.ts` reads wrapper `convertToAssets` + raw `newMultiplier`/`newMultiplierActivationTime`; observations recorded; notices scheduled/observed; resting levels NOT scaled (the wrapper does not rebase — scaling would be a safety bug).. Multiplier = wrapper `convertToAssets(1e18)`; record observations (table from migration 033) on the observe sweep; `server/src/executor/resting.ts` scales exit levels on a change (`multiplier-adjust.ts` is pure, keep); `server/src/venues/{corporate-actions,dividend-yield}.ts` and `server/src/market/corporate-action.ts` read the EVM multiplier; re-add the sweep to `scheduler.ts`.
- **P2.7 Backing / proof of reserves on EVM** — `DONE` server (`430cc4a`): backing reads Backed's contracts (roles, Safe owners, supply) and the PoR API. App labels follow in P4.1.. `server/src/venues/proof-of-reserves.ts` (Backed PoR API, chain-agnostic, keep); `backing-detail.ts` reads raw token `totalSupply`, owner/pausable roles instead of Token-2022 authorities; app `src/ui/BackingDrawer.tsx`, `src/data/backingDetail.ts` field labels ("CAN MINT"/"CAN PAUSE" rather than "PERMANENT DELEGATE").
- **P2.8 OKX DEX venue + contract `spendVia`** — `DONE` in code (`9334e77`, `430cc4a`, `b0eace3`): `spendVia`/`closePositionVia` (Foundry tests 6/6), `venues/okxdex.ts` (HMAC signing tests), delegate calls route through Via when OKX wins, OKX router + approve spender on the grant (both verified to carry code). **Live OKX quote verification BLOCKED on the OKX API key** — without it Uniswap settles everything. on OKX API key (M–L). Contract: add `spendVia(owner, token, spender, venue, amount, tokenOut, minOut, data)` and `closePositionVia(...)` to `contracts/src/XorrDelegation.sol` that approve `spender` (must also be `_venueAllowed[owner]`) and call `venue`; reset approval to 0; Foundry tests for allowlist, cap, floor and zero-residual-approval. Server: `server/src/venues/okxdex.ts` (HMAC signing per §2, `quote`, `swap` with `userWalletAddress = DELEGATION_ADDRESS`, `swapReceiverAddress = owner`, `slippage`), `spendAsDelegate` variant in `server/src/evm/delegation.ts`; add router + approve spender to `SETTLEMENT_VENUES` in `server/src/evm/chains.ts`; `/venues` screen shows both. Verify OKX quotes wrapped xStocks on X Layer and whether it routes via pools (fork-fillable) or xChange RFQ (not fork-fillable) — record the finding in §5.
- **P2.9 Strategies on X Layer** — `NOT STARTED` (S). `server/src/executor/kinds/index.ts`: dca, rebalance, exit-rules, grid, momentum, event-driven work on the registry; event-driven maps `TSLAx` → `TSLA` for EDGAR (`server/src/market/edgar.ts`). Client presets `src/strategies/{agentStrategies,ladder}.ts`: `CBBTC` → `XBTC`, add wrapped xStock targets; remove the yield rung.
- **P2.10 Autonomous agent on the EVM path** — `DONE` (`430cc4a`). `readPolicy` + `placeOrder`, fail-closed rules engine, one audit row + one push per trade (explain reads the decision from the proposal by tx hash). 47 tests.. `server/src/bot/autonomous.ts`: replace `guardAndSpend`/SPL `readDelegation`/`readMintScale` with `readPolicy` (`server/src/evm/delegation.ts`) + `placeOrder` (`server/src/executor/order.ts`) + ERC-4626 multiplier; keep scoring, EDGAR windows, Nasdaq off-hours guard, refusals. Fix the fail-open `evaluate(...).catch(() => allowed:true)` (a rules-engine error must refuse). Re-add the sweep to `scheduler.ts`. Retarget its tests' mocks.
- **P2.11 Basket agent on the EVM path** — `DONE` (`430cc4a`). ERC-20 balances + `placeOrder`/`placeSwap`; no duplicate audit row.. `server/src/bot/basket.ts`: ERC-20 balances (`server/src/evm/balances.ts`) + `placeOrder`; keep band/one-leg/unpriceable logic; `app/agent/basket.tsx` unchanged.
- **P2.12 Market-data helpers without 1inch** — `DONE` (`b0eace3`). Logos from Backed's xStocks asset API + CoinGecko; crosscheck vs X Layer pool prices; history chain-only; `/approvals` lists Uniswap router + OKX approval contract; Nasdaq off-hours reference = xStocks' share price (Jupiter, same xStock on Solana) × wrapper multiplier, live within 0.1%.. `server/src/market/logos.ts` (CoinGecko + xStocks API logos), `server/src/market/crosscheck.ts` (Uniswap quote vs CoinGecko), `server/src/routes/tokens.ts` (registry `balanceOf` multicall), `server/src/routes/history.ts` (own audit trail only), `server/src/graph/decide.ts` (drop or Uniswap-vs-OKX).
- **P2.13 Phase-2 gates** — `NOT STARTED` (S). All suites green with zero failures; remove every `it.todo` added in P1.7.

- **P2.14 Yield on Aave v3 X Layer, supplying USDT0** — `IN PROGRESS`. Verified on chain 2026-09-19: Aave v3 Pool `0xE3F3Caefdd7180F884c01E57f65Df979Af84f116`; USDT0 reserve 3.48% APY (aToken `0xF356ae412dB5df43BD3a10746f7ad4e1C4De4297`, ~$72.9M supplied); USDC reserve 0.00%.. Same Aave v3 interface as the Base code (addresses in §5 U5). Add USDT0 (`0x779Ded0c9e1022225f8E0630b35a9b54bE713736`, 6 dec) to the registry (P1.3). `planYieldRotation` becomes two legs: (1) USDC → USDT0 via the best venue through `spend()`, (2) `supply(USDT0, amount, owner, 0)` on the Pool through `spend()` with the Pool on `SETTLEMENT_VENUES`; withdraw = Pool `withdraw` via `closePosition` then USDT0 → USDC. Read the USDT0 reserve's aToken from `getReserveData` on chain (do not hard-code before reading). Rate read from `getReserveData.currentLiquidityRate`. Fork test: both legs and the unwind on an X Layer fork. App: `app/{yield,rates}.tsx`, `app/strategy/yield.tsx`, withdraw-everything step name "Aave on X Layer (USDT0)" and state the USDC→USDT0 swap and USDT0 depeg risk. Port `server/src/venues/aave.ts`, `server/src/market/yield.ts` and `planYieldRotation` (`server/src/executor/kinds/index.ts`) to the verified X Layer lending market (pool/market address, supply/withdraw ABI, rate read, receipt token), add its pool to `SETTLEMENT_VENUES` in `server/src/evm/chains.ts` (only once verified on chain), and bring back `app/{yield,rates}.tsx`, `app/strategy/yield.tsx` and the withdraw-everything supply step with the lender's name. Fork test: supply and withdraw USDC through `spend`/`closePosition` on an X Layer fork.

### Phase 3 — Prove it on X Layer: fork, contracts, testnet, indexing

**Exit criteria:** `npm run setup:fork` stands up an X Layer fork demo in one command; `tools/prove-xlayer.ts` prints PASS for every claim in §1.2(2); contracts deployed and source-verified on X Layer testnet; `forge test` green including the X Layer fork suite.

- **P3.1 Contracts compile and run on X Layer** — `DONE` (`9334e77`). `evm_version = "cancun"`; `spend` (tstore) succeeds on an X Layer fork.. Set `evm_version = "cancun"` in `contracts/foundry.toml`; deploy `XorrDelegation` + `XorrAuditAnchor` on an anvil fork of 196 via `contracts/script/Deploy.s.sol` / `DeployAnchor.s.sol` with `SETTLEMENT_TOKEN=0xB6CE…3061`; confirm `tstore` works (a `spend` succeeds). Update comments that name 1inch.
- **P3.2 X Layer fork test in Foundry** — `DONE` (`9334e77`). `contracts/test/XorrXLayer.fork.t.sol` 6/6 on a live fork of 196 (TSLAx direct, NVDAx via USDG, cap, foreign venue, close, revoke); unit suites 45/45.. Replace `contracts/test/XorrStocks.fork.t.sol` with `XorrXLayer.fork.t.sol`: fork 196, deal USDC to an owner (`deal` or `anvil_setStorageAt` on the USDC balance slot), grant (cap, expiry, venue = SwapRouter02), `spend` buys wTSLAx via `exactInputSingle`, output floor enforced, over-cap and foreign-venue spends revert, `revoke` stops, `closePosition` sells back. CI job gated on `XLAYER_RPC`.
- **P3.3 One-command fork demo** — `DONE` (`430cc4a`). `npm run setup:fork` deploys delegation + anchor on an anvil fork of 196, funds the delegate with OKB and the owner from a fork-only USDC reserve, writes `.env.fork`.. Rewrite `server/src/fork-bootstrap.ts` for `xLayer` (it refuses non-Base today, lines 82–83): anvil `--fork-url https://rpc.xlayer.tech --chain-id 196`, deploy delegation + anchor, fund demo owner with USDC (storage slot or a verified large holder) and OKB (`anvil_setBalance`), fund delegate/faucet keys with OKB, write `.env.fork` with `XORR_CHAIN=xlayer-fork`, `DELEGATION_ADDRESS`, `ANCHOR_ADDRESS`, `EXPO_PUBLIC_*`. `server/src/evm/faucet.ts` fork funding without the Base aUSDC whale. Rename script entry `setup:fork` stays.
- **P3.4 End-to-end proof script** — `DONE` (`b0eace3`). `server/src/prove-xlayer.ts` (`npm run prove:fork`): owner key signs approvals/grant/revoke; executor buys $50 TSLAx, cap refuses $60 NVDAx, close returns $49.95, revoke refuses — ALL CHECKS PASSED. (Withdraw-to-allowlist is covered by the withdrawal route tests; not in this script.). `tools/prove-xlayer.ts` (model on the deleted `tools/prove-solana-xstock-buy.ts` and `server/src/fork-e2e.ts`): against a running fork executor, run grant → buy wTSLAx $50 via the executor → read position → over-cap refused → foreign venue refused → revoke without server (`tools/prove-stop-without-server.ts` logic) → sell back → withdraw to an allowlisted address after cooling-off (fork time travel). Print PASS/FAIL per claim with tx hashes; exit non-zero on any FAIL. Update `tools/prove-{contract-refusals,stop-without-server,user-signing}.ts` for chain 196.
- **P3.5 Testnet deployment** — `BLOCKED` on funding `0x1725a1B284D58dC9bb79DfB7B205d4d0D5d4E4eA` with test OKB. `contracts/deploy-xlayer-testnet.sh` is ready (key from `server/.env.deployer`, never on argv; refuses at 0 OKB — checked; writes `deployments/xlayer-testnet.json`). until `0x1725a1B284D58dC9bb79DfB7B205d4d0D5d4E4eA` holds test OKB (S). Load the key from `server/.env.deployer` (`DEPLOYER_PRIVATE_KEY`). Deploy `XorrDelegation` + `XorrAuditAnchor` to 1952 with `SETTLEMENT_TOKEN=0xDec9…b9B3`; verify source on OKLink; write `contracts/deployments/xlayer-testnet.json` (addresses, block, tx, commit). Testnet has no DEX: trades are refused honestly there; the fork is where fills happen.
- **P3.6 Remove The Graph** — `IN PROGRESS`. Server side done (`430cc4a`); app screens/data being removed.. **Owner decision 2026-09-19: no The Graph on X Layer** (not deferred — dropped). Delete `subgraph/`, `server/src/graph/*` (client, decide, aqua) and their routes/tests, the `app/graph/{index,spends,decision}.tsx` screens and nav entries, the `decide()` hint in `server/src/executor/run.ts` (settlement picks by quote alone), `SUBGRAPH_URL`/`EXPO_PUBLIC_SUBGRAPH_URL`/`AQUA_SUBGRAPH_URL`/`GRAPH_API_KEY`/`GRAPH_DEPLOY_KEY`/`SUBGRAPH_DELEGATION_ADDRESS` from code and `.env.example`, and any spend-history chart that reads the subgraph (replace with the executor's own audit trail where a screen needs history).
- **P3.7 Fork node service** — `NOT STARTED` (S). Copy `infra/base-fork/` → `infra/xlayer-fork/` (anvil v1.7.1, `/data` volume) with `--fork-url https://rpc.xlayer.tech --chain-id 196`.

### Phase 4 — The app on X Layer: screens, copy, data, deposits, OKX touchpoints

**Exit criteria:** every route renders on an X Layer build with no Base/Solana/1inch/Aave/MoonPay/Jupiter wording, no fixture-driven market list, no dead screen; the order ticket and xStock pages trade wrapped xStocks; `tools/shoot.mjs` sweep clean.

- **P4.1 Client token lists and tradability** — `NOT STARTED` (S–M). `src/data/{tradable,walletTokens,marketData,useLogos,useSettleable}.ts`, `src/state/derived.ts`, `src/data/{system,types}.ts` venue unions → `'uniswap-v3' | 'okx-dex'`; wrapped xStock symbols; `CBBTC` → `XBTC`.
- **P4.2 Replace the fixture market catalog** — `NOT STARTED` (M). `src/data/fixtures/markets.ts` (45 Base instruments, 27 unfed) is the only market list (`src/data/local.ts:12`, `app/markets/[classId].tsx:29`, `src/markets/{prices,useMarketPrices}.ts`). Serve the catalog from the executor (`/market/tradable` + `/market/xstocks`) and render that; keep only chain-neutral colours in `src/design/gradients.ts`. Delete dead fixtures (`src/data/fixtures/{news,backtest,agents,activity,alerts,series}.ts`, unused `kycSteps`/`fundingMethods` in `onboarding.ts`) and `tools/gen-fixtures.mjs`.
- **P4.3 Onboarding proposal on real assets** — `NOT STARTED` (S). `app/(onboarding)/proposal.tsx` + `src/data/fixtures/sleeves.ts` + `src/data/local.ts:463`: sleeves name X Layer assets (e.g. USDC cash, wrapped xStock basket, WETH/XBTC) and the stored rebalance targets use registry symbols.
- **P4.4 xStock screens trade** — `NOT STARTED` (S). `app/xstock/[symbol].tsx` (says it cannot be placed from the phone), `app/xstocks.tsx`, `app/explore.tsx`: catalog + ticket place through `/orders`; copy "on X Layer".
- **P4.5 Drop or hide screens with no X Layer backing** — `NOT STARTED` (S). Remove routes and nav entries: `app/{crosschain,limit-orders,sponsors,basename}.tsx`, `app/graph/*` (D4); `app/profile.tsx`/`app/explore.tsx` basename entries. Yield screens (`app/{yield,rates}.tsx`, `app/strategy/yield.tsx`) and the withdraw-everything supply step are **kept and re-pointed** by P2.14, hidden only until it lands.
- **P4.6 Copy sweep** — `NOT STARTED` (M). Every rendered string naming Base, Solana, Jupiter, 1inch, Aave, Aqua, SwapVM, Ondo, cbBTC, MoonPay, ETH-as-gas: `src/ui/fillVenue.ts` (+ test), `src/format/activity.ts`, `src/ui/FillReceipt.tsx`, `src/ui/charts/marks.ts`, `app/{sources,metrics,history,approvals,swap,strategies,stocks,watchlist,portfolio,network,compare,coverage,runs/[id],asset/[symbol],chart/[symbol],crosscheck/[symbol],route/[symbol],order/[symbol],graph/index,strategy/dca,strategy/grid}.tsx`, `src/chat/Chat.tsx`, `src/bot/*` copy. `src/legal/documents.ts` ("Trades go to 1inch…") must be rewritten before anything is published. Acceptance: `grep -rniE "solana|jupiter|1inch|oneinch|aave|aqua|swapvm|ondo|cbbtc|moonpay|base sepolia|basescan" app src --include='*.tsx' --include='*.ts' | grep -v test` returns only intentional history notes.
- **P4.7 Deposits: OKX on-ramp link, no MoonPay** — `NOT STARTED` (S, after U7). Remove `server/src/routes/moonpay.ts` (public, unsigned webhook — security gap G-SEC1), `src/deposit/moonpay.ts`, `@moonpay/moonpay-js`. In `app/deposit.tsx` and `app/(onboarding)/fund.tsx`, replace the card button with "Buy USDC on OKX" opening OKX's on-ramp (URL and whether it delivers USDC on X Layer to an external address: U7) — opened with the in-app browser, never an embedded card form; keep QR/address on X Layer and the fork/testnet faucet. Copy states plainly that the purchase happens on OKX.
- **P4.12 USDT0 deposits** — `NOT STARTED` (S–M, after U8, P2.1). Registry has USDT0 (P1.3); the wallet balance and Home show USDT0 when held; a one-tap **"Convert USDT0 to USDC"** that the **user signs** (Uniswap/OKX DEX swap from their own wallet, preview with rate and minimum received) — the delegation only spends USDC, so conversion is the owner's action, not the agent's. `app/deposit.tsx` says USDC or USDT0 on X Layer are accepted.
- **P4.8 Networks list and chain chips** — `NOT STARTED` (S, after P5.1). `src/networks/deployments.ts` rows for the deployed X Layer executors (key, name, chainId, api, explorer, test); tests `src/networks/{status,deployments}.test.ts`.
- **P4.9 Privy on X Layer** — `BLOCKED` on owner dashboard (S). Enable chains 196/1952 for embedded wallets; enable Google/X login (code shipped in xorr-eth `f7be1b3`, present here); verify grant/revoke signing on the fork via `walletSignsOnly` (`src/wallet/userSigning.ts`).
- **P4.10 OKX Wallet sign-in on web** — `NOT STARTED` (S, may slip per D3; D17). In `src/auth/PrivyProvider.web.tsx` add OKX Wallet to Privy's `appearance.walletList` / external wallet config so it appears first in "Continue with a wallet"; verify it connects on X Layer (196/1952) and that the grant is still signed by the Privy embedded wallet (the agent's owner), not the external one. Name it in the README integrations table.
- **P4.11 Screen sweep** — `NOT STARTED` (S). `tools/shoot.mjs` on the X Layer web build (every route, no "SIMULATED", no dead ends); fix what it finds.

### Phase 5 — Ship and submit

**Exit criteria:** live URL + deployed executors green; repo public with a true README; 2–4 min video; Dev Day form submitted before 2026-09-25 23:59 UTC.

- **P5.1 Railway services** — `BLOCKED` on owner choice of project/names (S–M). Create `executor-xlayer-testnet`, `executor-xlayer-fork`, `xlayer-fork` (from P3.7), new Postgres (36 migrations run in pre-deploy). Env (names): `XORR_CHAIN`, `XLAYER_RPC`/`XLAYER_TESTNET_RPC`/`FORK_RPC`, `DELEGATION_ADDRESS`, `ANCHOR_ADDRESS`, `DELEGATE_PRIVATE_KEY` (fund with OKB), `DATABASE_URL`, `PRIVY_*`, `OPENROUTER_API_KEY`, `OKX_API_KEY`/`OKX_SECRET_KEY`/`OKX_PASSPHRASE`, `ALLOWED_ORIGINS`. Add services to `SERVICES` in `scripts/deploy-executor.mjs`. Never delete existing Railway services/DBs.
- **P5.2 Web build for X Layer** — `NOT STARTED` (S). `scripts/build-web.mjs` assumes a fork answers 8453 → 196; `scripts/build-base.mjs` → `build-xlayer.mjs`; `EXPO_PUBLIC_XORR_CHAIN`, `XORR_WEB_API`, `XORR_WEB_CHAIN_RPC`, `XORR_WEB_DELEGATION`; deploy to a Vercel project (owner choice §6 Q7). Pin the delegation only after executor/record/chain agree (existing logic).
- **P5.3 CI for X Layer** — `NOT STARTED` (S). `.github/workflows/ci.yml`: drop `live-1inch`; fork job uses `XLAYER_RPC`, chain 196, runs P3.2 and P2.1 fork tests.
- **P5.4 `/judge` green on the deployed executor** — `NOT STARTED` (S). `server/src/verify/checks.ts` (after P1.6) — every check passes or skips honestly on testnet and fork.
- **P5.5 QA sweeps** — `NOT STARTED` (S). `tools/qa-full.mjs` (221 endpoint checks) against both X Layer executors; update `docs/qa/ENDPOINTS.md`, `docs/qa/SCREENS.md`; `e2e/` Maestro flows 01–05 on a simulator against the fork executor.
- **P5.6 Docs** — `NOT STARTED` (M). Rewrite `README.md` (top = X Layer; "Verify it yourself on an X Layer fork" quickstart with P3.3 + P3.4 commands; addresses table; sponsor/integration table: X Layer, xStocks, Uniswap v3, OKX DEX, Privy, OpenRouter), `docs/DEMO-SCRIPT.md`, `docs/SUBMISSION.md` (Dev Day), `docs/SECURITY.md` (X Layer deployment; note cert pinning gap), `docs/RUNBOOK.md`, `docs/ADDING-A-CHAIN.md`, `FEATURES.md` (X Layer). Delete or archive Base/Solana-only docs (`docs/BASE-*.md`, Stocklana sections). `.env.example`: add `XLAYER_RPC`, `XLAYER_TESTNET_RPC`, `OKX_*`, `EXPO_PUBLIC_PINNED_DELEGATION`, etc.; remove Solana/1inch/Aqua/MoonPay names.
- **P5.7 Landing** — `NOT STARTED` (S). `landing/src/components/ui/CtaPill.tsx` ("Built on Base"), `sections/Features.tsx` ("Anchored on Base"), `landing/src/lib/links.ts` (`GITHUB_URL` → xorr-xlayer). Deploy only on owner say-so (live on xorr.finance).
- **P5.8 Demo video (2–4 min)** — `NOT STARTED` (S). Follow `docs/DEMO-SCRIPT.md` beats on the X Layer web build against the fork executor: sign in → grant on X Layer → agent buys wTSLAx (show OKLink/fork tx + venue) → `/judge` → Stop all without server → sell/withdraw. Record with `tools/demo.mjs`; ≤4 min.
- **P5.9 Make the repo public and submit** — `BLOCKED` on owner (S). Repo is private today; Dev Day requires public. Owner registers/submits via the official form: repo URL, video, live link, team info, summary.

---

## 5. Gap list (honest audit, 2026-09-19)

Audit method: full-repo grep for mock/stub/TODO/FIXME/fake/dummy/placeholder/hardcoded/simulated/"coming soon"/"for now"/temporary/"not yet" (2,751 hits: 2,662 legitimate — tests, loading skeletons, "never faked" comments; **89 real gaps**) + a module-by-module chain-dependency read. Each gap names the task that closes it.

### G-CHAIN — dependencies that do not exist on X Layer
| # | Where | Gap | Blocks | Closed by |
|---|---|---|---|---|
| G1 | `server/src/venues/oneinch.ts:22` | Throws at import without `ONEINCH_API_KEY`; the executor cannot boot on X Layer without a 1inch key | everything | P1.3 |
| G2 | `server/src/venues/oneinch.ts` `TOKENS` | App token registry lives inside the 1inch client; built from Ondo `STOCKS`; `CBBTC` now points at xBTC with CoinGecko id `coinbase-wrapped-btc` | all trades, prices | P1.3, P2.4 |
| G3 | `server/src/executor/settle.ts`, `run.ts`, `order.ts`, `swap.ts`, `routes/panic.ts` | Calldata is built for 1inch/Aqua/SwapVM while `SETTLEMENT_VENUES` grants only Uniswap → every fill would revert `VenueNotAllowed` | every fill | P2.1–P2.3 |
| G4 | `server/src/venues/stocks.ts` | Ondo `…c` equities on Base; priced by 1inch | stocks | P2.4 |
| G5 | `server/src/routes/index.ts` ~559, `auth/privyPolicy.ts:211`, `fork-grant.ts` | Grant approves Ondo equities, not wrapped xStocks → sells/panic close revert | exits | P2.5 |
| G6 | `server/src/executor/place.ts`, `bot/autonomous.ts`, `bot/basket.ts` | Autonomous + basket agents run only on the Solana chokepoint | "agent trades" | P1.4, P2.10, P2.11 |
| G7 | `server/src/solana/*` (13 files) + 14 importers, `venues/jupiter.ts`, `xstocks*.ts`, `routes/xstocks.ts`, `backing-detail.ts`, `corporate-actions.ts`, `market/corporate-action.ts`, `executor/resting.ts`, `scheduler.ts` | Solana still imported at boot | boot | P1.4, P2.6, P2.7 |
| G8 | `server/src/venues/{aqua,swapvm,limit-orders,fusion-plus,history,balance}.ts`, `evm/{gas-price,allowances}.ts`, `market/{logos,crosscheck}.ts`, `graph/aqua.ts`, `subgraph-aqua/` | 1inch APIs (8453) — dead on X Layer | several screens | P1.5, P2.12 |
| G9 | `server/src/venues/aave.ts`, `market/yield.ts`, `planYieldRotation`, `src/defi/useAaveWithdraw.ts`, withdraw-everything Aave step | Aave on Base; X Layer unverified | Earn, withdraw-everything | P1.5, P4.5 |
| G10 | `server/src/evm/basename.ts`, `app/basename.tsx` | Base names resolver has no code on X Layer | profile/explore | P1.5, P4.5 |
| G11 | `server/src/routes/privy.ts:80-81` | Policy probe sends `eip155:8453/84532` — **bug** | `/privy` proof | P1.6 |
| G12 | `server/src/fork/guard.ts:42` | Asserts chain 8453 → refuses X Layer forks | fork scripts | P1.6 |
| G13 | `server/src/verify/checks.ts` | `/verify` checks 8453/84532, 1inch, Ondo, Aave | `/judge` | P1.6, P5.4 |
| G14 | `contracts/src/XorrDelegation.sol` | `_callVenue` approves the call target → OKX (separate spender) cannot fill | OKX venue | P2.8 |
| G15 | `contracts/foundry.toml` | No `evm_version`; `tstore` needs Cancun — unverified on X Layer | contract | P3.1 |
| G16 | `contracts/src/XorrSwapVMBook.sol:39` | Hard-coded 1inch SwapVM opcode indices | — | P1.5 (delete) |

### G-DEMO — the proof and deploy path
| # | Where | Gap | Closed by |
|---|---|---|---|
| G17 | `server/src/fork-bootstrap.ts:10,82-83` | Base-only; refuses non-Base; funds from Base aUSDC; writes `base-fork` | P3.3 |
| G18 | `server/src/fork-e2e.ts:4` | End-to-end "thesis" script runs on a Base fork | P3.4 |
| G19 | `server/src/evm/faucet.ts`, `fork/makers.ts` (`WHALE`) | Fork funding impersonates the Base aUSDC reserve | P3.3 |
| G20 | `scripts/build-web.mjs:10`, `scripts/build-base.mjs` | Web build assumes fork = 8453 / refuses non-Base | P5.2 |
| G21 | `src/networks/deployments.ts:34` | `DEPLOYMENTS = []` — no X Layer rows (blocks Networks screen) | P4.8 after P5.1 |
| G22 | `contracts/deployments/` | Only `base-sepolia.json`; nothing deployed on X Layer | P3.5 |
| G23 | `subgraph/`, `server/src/graph/*`, `app/graph/*` | Indexes Base Sepolia; default `SUBGRAPH_URL` is the old Base index — The Graph is dropped by owner decision | P3.6 (remove) |
| G24 | `.github/workflows/ci.yml` | `live-1inch` and Base fork jobs (`BASE_RPC`, 8453) | P5.3 |
| G25 | `docs/COMPLETION.md:329` | "No tokenized equity currently fills on the fork" (Base) — must become true on X Layer | P3.4 |
| G26 | README / docs | README top says Base; Stocklana quickstart cites deleted files; DEMO-SCRIPT/SUBMISSION/SECURITY/RUNBOOK/ADDING-A-CHAIN are Base | P5.6 |
| G27 | `landing/` | "Built on Base", "Anchored on Base", `GITHUB_URL` → xorr-eth | P5.7 |
| G28 | repo visibility | Private; Dev Day needs public | P5.9 |

### G-DATA — fixtures and hard-coded data in production paths
| # | Where | Gap | Closed by |
|---|---|---|---|
| G29 | `src/data/fixtures/markets.ts` (+ importers `src/data/local.ts:12`, `app/markets/[classId].tsx:29`, `src/markets/{prices,useMarketPrices}.ts`) | Static 45-instrument Base catalog, 27 unfed — the only market list | P4.2 |
| G30 | `src/data/fixtures/sleeves.ts`, `src/data/local.ts:463`, `app/(onboarding)/proposal.tsx:41,54,142,155,194,200` | Onboarding proposal = fixed 55/30/15 with Base assets, saved as the user's strategy | P4.3 |
| G31 | `src/data/fixtures/onboarding.ts`, `app/(onboarding)/goals.tsx:27` | Static goals copy; ships unused fake KYC phone "+1 ••• ••• 4417" | P4.2 |
| G32 | `src/data/fixtures/{news,backtest,agents,activity,alerts,series}.ts`, `tools/gen-fixtures.mjs` | Dead fixtures; generator silently reverts symbols | P4.2 |
| G33 | `README.md:485` | 26 of 44 listed instruments have no price feed | P4.2 |
| G34 | `app/xstock/[symbol].tsx:16` | xStock order sheet can only quote, not place | P4.4 |

### G-SEC — security
| # | Where | Gap | Closed by |
|---|---|---|---|
| G-SEC1 | `server/src/routes/moonpay.ts:150`, `auth/middleware.ts:65` | Public, **unsigned** webhook trusts body (status, wallet, amount default 100, `usdc_sol`) → anyone can write "Fiat deposit completed" to a trail; hard-coded `DEFAULT_SANDBOX_API_KEY` (line 17) | P4.7 |
| G-SEC2 | `server/src/bot/autonomous.ts` | `evaluate(...).catch(() => allowed:true)` — rules-engine error lets a trade through (fail-open) | P2.10 |
| G-SEC3 | `docs/SECURITY.md:164` | No certificate pinning (documented) | out of scope; keep documented (P5.6) |
| G-SEC4 | `docs/QA-PLAN.md:274` | Hot `DELEGATE_PRIVATE_KEY`; Privy session signers would remove it | out of scope; documented |
| G-SEC5 | `contracts/src/XorrDelegation.sol:279-280` vs app copy | `closePosition` reverts when revoked/expired, so "Stop all" also stops stop-losses/flatten while copy says they keep working | P4.6 (copy must say what the contract does) |
| G-SEC6 | `src/legal/documents.ts:23` | Legal docs are drafts "not reviewed by counsel" and name 1inch | P4.6 (copy); counsel out of scope |

### G-TEST — known failing tests at `e307cfa` (51 failures, 16 files)
`server/src/venues/oneinch.test.ts` (11), `routes/history.test.ts` (9), `auth/privyPolicy.test.ts` (8), `src/networks/status.test.ts` (4), `routes/balance-bounded.test.ts` (4), `routes/tokens.test.ts` (3), `src/networks/deployments.test.ts` (2), `server/src/solana/fork.chain.test.ts` (2), `routes/panic-preview.test.ts` (2), `auth/privyPolicy.names.test.ts` (2), `venues/limit-orders.test.ts`, `routes/limit-orders.test.ts`, `routes/moonpay.test.ts`, `fork/orphans.test.ts`, `evm/delegation-read.test.ts`, `evm/allowances.test.ts` (1 each). Closed by P1.7 / P2.13.

### G-UNVERIFIED — facts still to establish (each blocks the named task)
| # | Question | How to settle | Task |
|---|---|---|---|
| U1 | Does OKX DEX quote wrapped xStocks on 196, via pools (fork-fillable) or xChange RFQ? | Call `/quote` with the key | P2.8 |
| U2 | Cancun `tstore` on X Layer | Deploy + `spend` on fork | P3.1 |
| U3 | Uniswap pools for WETH/XBTC/WOKB vs USDC/USDG | Factory `getPool` + `liquidity()` | P2.1 |
| U4 | Circle testnet faucet for X Layer enabled? | Try https://faucet.circle.com | P3.5 |
| U5 | ~~Which lending market~~ **Settled 2026-09-19:** Aave v3 on X Layer (launched 2026-03-30; bgd-labs address book `AaveV3XLayer.sol`). Pool `0xE3F3Caefdd7180F884c01E57f65Df979Af84f116`, PoolAddressesProvider `0xdFf435BCcf782f11187D3a4454d96702eD78e092`, ProtocolDataProvider `0x6C505C31714f14e8af2A03633EB2Cdfb4959138F`, native-USDC aToken `aXlrUSDC` `0x7Da9B238CBd6A227ff054704Ec5cF7e700f03414` — verified on chain (revision 11, reserve active). **But the USDC reserve holds ~102.5 USDC → supply APY ≈ 0%**; USDT0 (`0x779D…3736`) holds ~$72.9M at ~3.4%. Which asset to supply: §6.2 | on-chain reads done | P2.14 |
| U8 | USDC↔USDT0 route on X Layer: Uniswap v3 pool (fee tier, liquidity) or OKX DEX only | Factory `getPool` + `liquidity()`; OKX `/quote` | P2.14, P4.12 |
| U7 | **Researched 2026-09-19:** no public OKX (or Transak/MoonPay/Ramp/Mercuryo) link buys with a card and delivers on X Layer to an external address; OKX "Buy crypto" delivers to the OKX account; **OKX suspended USDC deposit/withdrawal on X Layer from 2026-08-21** ("wallet maintenance", help-center notice). Verifiably working path: buy USDC on Base (Coinbase Onramp / MoonPay), bridge to X Layer with Circle CCTP (native USDC + CCTP live on X Layer since 2026-08-07). Deposit design: §6.2 | a small real OKX withdrawal would settle the suspension question | P4.7 |
| U6 | Dev Day: mainnet vs testnet requirement; late registration | Ask OKX Dev Day channel | P5.9 |

---

## 6. Owner decisions

### 6.1 Decided (2026-09-19)
- **D1 Priority:** xorr-xlayer first. xorr-solana gets only what the `ao` workers already have in flight.
- **D2 Dev Day:** the owner is **registered**. Build to the Sep 25 23:59 UTC submission.
- **D3 May slip past Sep 25 if time runs out:** P2.7 (backing/PoR), P2.11 (basket agent), P4.10 (extra OKX touchpoint). The core journey, deploy and submission never slip.
- **D4 The Graph:** dropped entirely (P3.6 becomes removal).
- **D5 OKX DEX API key:** the owner creates it today → P2.8 unblocks as soon as it lands in `.env`/Railway as `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`.
- **D6 Environments:** fork of mainnet for fills, testnet for deployed contracts; no real-money mainnet.
- **D7 Hosting:** the frontend is a **separate new Vercel project** (the Base app on app.xorr.finance stays untouched); **Railway hosts the backend only** — new services `executor-xlayer-testnet`, `executor-xlayer-fork`, `xlayer-fork` (anvil node) and a new Postgres. No frontend on Railway.
- **D8 Deposits:** no MoonPay. Deposit = **a link out to OKX's own on-ramp** (buy USDC delivered on X Layer — verify it delivers there, U7) + QR/address on X Layer + faucet on fork/testnet. P4.7 is revised accordingly.
- **D9 Yield:** keep the idle-cash yield strategy by **porting it to a verified lending market on X Layer** (U5 → P2.14). Not dropped.
- **D11 Testnet deployer:** **generated 2026-09-19 — address `0x1725a1B284D58dC9bb79DfB7B205d4d0D5d4E4eA`, key in `server/.env.deployer` (gitignored, mode 600); owner to fund with test OKB (balance 0 at generation).** The builder generated a fresh key locally (stored only in `server/.env` as `DEPLOYER_PRIVATE_KEY` and in Railway; never printed or committed), gives the owner its **address**, and the owner claims test OKB to it at https://web3.okx.com/xlayer/faucet. P3.5 unblocks when the balance shows on 1952.
- **D12 Web URL:** the live link is the new Vercel project's **vercel.app** URL (no custom domain).
- **D13 Video:** record the core journey on the **live web app** (repeatable with `tools/demo.mjs`) plus a **short iPhone-simulator clip** of the native app.
- **D14 Public repo:** stays private while building; before submission the builder runs a secret scan of **all history** (`gitleaks detect` or equivalent + a grep for key/secret/mnemonic/private patterns), then the owner flips it public on Sep 25.
- **D15 Yield asset:** the yield strategy **swaps idle USDC → USDT0 and supplies USDT0 to Aave v3 on X Layer** (~3.4% vs ≈0% for USDC), and swaps back to USDC on withdraw. The app states the swap and the depeg risk plainly.
- **D16 Deposits:** accept **USDT0** as a deposit (OKX withdraws it on X Layer) and convert it to USDC in the app, **plus** an "Open OKX" link (buy there, withdraw on the X Layer network). QR/address on X Layer and the fork/testnet faucet stay. No card on-ramp.
- **D17 Extra OKX touchpoint (may slip, D3):** **OKX Wallet in the web sign-in wallet list** (P4.10).
- **D18 Builder:** this Claude session executes the plan **phase by phase** — Phases 1–2 sequentially (they share executor files), then parallel subagents for independent Phase 4 copy/screen tasks. Commit per task with gates green.
- **D19 Demo limits:** the fork demo grants **$100/day for 7 days**; the agent buys ~$50 of a wrapped xStock, and a second buy past $100 is refused on chain (shown in the video and asserted by P3.4).
- **D20 Privy dashboard:** the **owner** enables Google + X login and allows the new vercel.app domain in dashboard.privy.io; the builder verifies from code afterwards (P4.9).
- **D10 Demo:** the video shows the **autonomous agent** (P2.10) buying a wrapped xStock inside the on-chain limits; the proposal → approve flow is the fallback.

### 6.2 Owner actions (nothing is undecided)
1. **Fund the deployer** `0x1725a1B284D58dC9bb79DfB7B205d4d0D5d4E4eA` with test OKB at https://web3.okx.com/xlayer/faucet → unblocks P3.5.
2. **Create the OKX DEX API key** (key, secret, passphrase) at https://web3.okx.com/onchainos/dev-portal/project and put them in `server/.env` as `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE` → unblocks P2.8.
3. **Privy dashboard** (D20): enable Google + X login; allow the new vercel.app domain → P4.9.
4. **Submission material** (P5.9): team info and the project summary for the Dev Day form; flip the repo public on Sep 25 after the history secret scan (D14).
5. **Optional:** a small real OKX withdrawal of USDC/USDT0 on the X Layer network to confirm whether OKX's X Layer USDC withdrawals are still paused (U7) — the deposit copy (P4.7) states whichever is true.
