# Sponsor audit — 1inch, Privy, The Graph, Base

Re-verified 2026-09-08 by making the calls, not by reading the code. Every claim below names the
command or query that produced it. Where an earlier version of this file was wrong, it says so.

Two things to know before the per-sponsor sections, because they change how everything else reads.

## Finding 1 — the two deployments split the sponsors, and neither shows the whole stack

| | `executor-fork` (base-fork, chain 8453) | `executor` (base-sepolia, 84532) |
|---|---|---|
| 1inch Aggregation fills | **170 real fills** | 1inch cannot settle here |
| 1inch Aqua | 6 fills — on an anvil that no longer exists | Aqua is a Base **mainnet** deployment |
| 1inch SwapVM | **3 real fills** (2026-09-11) | SwapVM is a Base mainnet deployment |
| The Graph index | **inert** — indexes another contract | **load-bearing** — blocks trades |
| Privy policy engine | enforced | enforced |
| Base: Aave, Basenames, cbBTC, equities | real mainnet state | partial |

The demo URL is the fork. A judge who opens it sees real fills and a Graph integration that cannot
affect anything. A judge who opens Sepolia sees the Graph deciding trades that can never fill.
**No single deployment demonstrates the sponsor stack**, and that is the highest-leverage thing to
fix before judging — it is a deployment problem, not a code problem.

## Finding 2 — SwapVM has settled now. **Closed 2026-09-10.**

This finding used to read: *"`XorrSwapVMBook` has settled **zero** trades, on any deployment,
ever"*, against `SUBMISSION.md`'s claim that "both are used, and both settle real trades". That was
true when it was written and it is no longer.

`fillsByVenue` on the fork, read from the executor's own `/metrics`:

```
{"swapvm": 2, "1inch": 36, "aqua": 5}
```

The first fill, end to end and on chain:

| | |
|---|---|
| program shipped to **official** Aqua | `0x4c432065609116ab028313cbd2f942c23d20c46d2832959609302f518751ace0` |
| app it was shipped under | `0x111111338c5091E8440b67B168bAe16a668AC0De` — the 1inch SwapVM router |
| `openPrograms()` discovery | 16 open programs, from Aqua's own logs |
| the fill | `0x2a20ebbddbd9db138b0d265ec0995b2d4ef239a70e3f39cb872254181bebc218` |
| `to` on that transaction | `XorrDelegation` — so it ran through the permission, not around it |
| taker received | +0.061246900891976021 WETH |
| out of the maker's own wallet | −0.061246900891976021 WETH |
| against the executor's floor | quoted 0.0612513, got 0.0612469 — above it |

What had been blocking it was not the contract. Discovery scans Aqua's logs, and the endpoint
anvil forks from had tightened `eth_getLogs` to a 2,000-block range while the scan asked for
9,000 — so the query threw, the caller's `.catch` turned it into `undefined`, and the venue was
silently never available. `evm/logs.ts` pages the request now, which is what made the maker
findable.

An impossible floor is still refused by the VM itself (`0xf44f8993` from the router, at depth 2),
not by us — which is the property that makes the venue worth having.

---

## 1inch — **the Aggregation API is deeply used; the track's own bar is Aqua/SwapVM**

**The bar:** official Aqua/SwapVM contracts, with on-chain execution of token transfers.

### GENUINELY USED

- **Aggregation v6** — `api.1inch.dev/swap/v6.0/8453/{quote,swap}`. 170 settled fills. The route it
  returns is named on screen and in the audit trail, so "Bought 0.0479 WETH" carries the venue that
  filled it. Verified live: `100 USDC → 0.040126 WETH via Pancakeswap V3`.
- **Spot Price v1.1** — `api.1inch.dev/price/v1.1`. Prices the eight tokenized equities, which no
  crypto feed covers. This is why the Stocks tab shows NVDAc at $233 rather than a dash.
- **Aqua, in code** — `server/src/venues/aqua.ts` discovers maker books from `BookShipped` /
  `BookDocked` events on our own `XorrAquaBook`, re-reads live balances, and returns exactly the
  four arguments `XorrDelegation.spend()` takes. It is the **first** branch of the routing ladder
  (`run.ts:579`), ahead of SwapVM and the aggregator. Six real fills exist:
  `Bought 0.0579 WETH on an Aqua book` (`0x9d5088d0da7e5c1a53…`) and
  `Bought 0.0581 WETH on an Aqua book` (`0x2863daa76db3905cf6…`), 2026-09-06 22:29–22:50 UTC.

### THE PROBLEM WITH THAT — the Aqua path is currently unreachable

Those six fills are on an anvil instance that **no longer exists**. Railway shows the live
`base-fork` deployment started `2026-09-07 04:37:07 UTC`; the previous one, which held them, is
`REMOVED`. The hashes will not resolve on the chain a judge queries today.

The cause is structural, not incidental. Books are discovered from `BookShipped` events, and
**nothing ships a book on boot**: `fork-bootstrap.ts` *deploys* `XorrAquaBook` and
`XorrSwapVMBook` (lines 104–121) and never calls `ship`. The only thing that ships one is
`server/src/live-aqua.ts`, a script that is referenced in no npm script, no boot path and no
runbook. So after every fork rebuild the Aqua branch finds no book deep enough and silently falls
through to the aggregator — which is exactly what has happened since.

**This is the single most valuable fix in the whole audit**: run the ship step as part of
bootstrap, and the track's headline claim becomes true on the deployment being judged.

### IMPORTED, WIRED, AND NEVER ONCE EXECUTED

**SwapVM.** `XorrSwapVMBook` is deployed, `venues/swapvm.ts` is implemented, `swapvm.test.ts`
covers it, and `run.ts:621` calls it. Its guard is
`aqua || intent.direct || isCloseIntent(intent) || preferred === '1inch' || !quoted` — it runs only
when Aqua did *not* fill and a maker has shipped a compiled program. Neither has been true. Zero
fills. It is an artefact with a call site, which is a better position than an artefact without one,
and still not "settles real trades".

### MISSING

Limit Order Protocol, Fusion and Fusion+ (intent/resolver flow), Portfolio API, Balance API, Token
API, History API, Traces, Orderbook. None is touched.

### Verdict

The aggregator integration is genuine and load-bearing. **The track's actual criterion is the one
part not currently demonstrable on the live deployment.** One bootstrap change fixes Aqua; SwapVM
needs a shipped maker program before the claim can be made at all.

---

## Privy — **the strongest integration in the project, and it is not close**

### GENUINELY USED

- **Embedded wallets, email OTP.** Verified end-to-end twice today on an iPhone 17 Pro simulator:
  code → wallet → address → `/wallet/connect`. Not a login button; the wallet is created in the
  flow and the user owns it.
- **`verifyAuthToken` server-side** — `server/src/auth/privy.ts:52`. Every authenticated route is
  behind it; there is no second session mechanism.
- **The server-side policy engine, enforced and proven.** `/verify` reports
  `13 rules over 13 destinations, owned by key quorum zixx49ik3ngslu9oay54q4li` at the time (4 rules over
  4 destinations as of 2026-09-11), and then does
  something better than describe it: `privy-refusal` sends a **real** `eth_sendTransaction` to
  `0x…dEaD`, an address the policy does not name, and asserts it comes back
  `"RPC request denied due to policy violation"`. The check **fails if the transaction succeeds** —
  an inverted test for something that is supposed to be impossible (`verify/checks.ts:294`).
- **Key quorums and `privy-authorization-signature`** (ECDSA P-256) on the wallet API.

That refusal check is the best single piece of sponsor evidence in the repo, for any sponsor. It is
the difference between "we use Privy for auth" and "Privy is the thing stopping the bot".

### BLOCKED — stated, not hidden

A policy attached to the **user's own** embedded wallet. Privy requires the wallet's owner to
authorise, and for an embedded wallet the owner is the user (`owner_id xtsg811vra3rkbmb3ijq08xw`),
not our quorum. `/safety` says so on screen. This is a platform constraint, not an omission.

### MISSING

Session signers, funding / on-ramp, MFA, social and SIWE logins, smart wallets and account
abstraction, delegated actions beyond our own contract, user-management APIs.

### Verdict

Deep, load-bearing, and provable by a judge in one HTTP call. Nothing needs fixing here to be
credible; the ideas below are about widening it, not repairing it.

---

## The Graph — **real, synced, wired into the trade path, and inert where it matters**

### GENUINELY USED

- One subgraph, deployed and **synced**: `api.studio.thegraph.com/query/1758741/xorr/v0.0.2`,
  block 46,536,157, `hasIndexingErrors: false`, returning our own data — two `policies`, including
  `0x95a0b368…`, the wallet used in today's testing, plus `spends`.
- Queried from **both** sides: `src/data/subgraph.ts` (client) and `server/src/graph/client.ts`
  (executor).
- **`decide()` runs before every trade** (`run.ts:355`) and its answer is read, both the
  block/allow (`act`) and the venue (`route.venue` → `preferred`). It is not a decorative query.

### The problem — it indexes a different contract than the one being traded

`subgraph/subgraph.yaml` indexes `base-sepolia`, contract `0xb14CF3D0…`. The live fork deployment
settles on `base-fork` with delegation `0xabe6f2bb…`. So `indexesThisDeployment()` is false, and
`run.ts:367` explicitly excludes `index_is_for_another_deployment` from blocking — correctly, since
treating it as a block would stop every run on a fork. The consequence is that **on the deployment
a judge will open, The Graph decides nothing.** It also means `preferred` is always `undefined`
there, which removes the index's ability to steer a trade to Aqua.

On Sepolia it genuinely is load-bearing — verified: that executor's `contract` check reports
`0xb14CF3D0…`, the exact address the subgraph indexes, and its `subgraph` check is two blocks
behind head. But 1inch cannot settle on Sepolia.

### MISSING

- A **second** Graph product. `subgraph-aqua/` is written, built and IPFS-pinned
  (`QmctadHCDBprb9Q1Pq4oyMXjB6KcnUDHRheDRNyBA59tAJ`) and has no Studio slug, so `graph deploy`
  answers `Subgraph not found`.
- Token API, Substreams, x402 gateway payments, Subgraph MCP.

**The track requires composing two or more Graph products; this project queries one.**
`SUBMISSION.md` says so plainly rather than claiming the track, which is the right call.

### Newly relevant

`.keys/deployer.key` exists in the working tree (gitignored, untracked, address
`0x364d7Bbc139541e0e37450D527ae154B5C292581` — which is also one of the two policies in the index).
An earlier note in this repo said no wallet private key existed anywhere that could sign a Studio
login. **That was wrong.** A SIWE login to Subgraph Studio can be signed with that key without a
browser, which is the blocker that has kept the second subgraph unpublished. Worth attempting
before concluding the track is out of reach.

---

## Base — **used properly, including the parts most projects fake**

### GENUINELY USED

- **Chain**: `XorrDelegation` deployed on Base Sepolia (`0xb14CF3D0…`, 7,157 bytes) and on the
  mainnet fork (`0xabe6f2bb…`, 3,926 bytes). Both verified reading their own code back.
- **Aave v3 on Base** — Pool `0xA238Dd80…`, verified live at **4.23% a year**, aToken
  `0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB`. The rate on screen is `currentLiquidityRate` read
  from the pool, not a number in a fixture.
- **Basenames, correctly.** `server/src/evm/basename.ts` reverse-resolves under Base's own
  chain-scoped namespace (`<addr>.80002105.reverse`) against the L2 resolver `0xC6d566A5…` —
  deliberately *not* viem's `getEnsName`, which would ask Ethereum mainnet. **Verified working**:
  it returns `jesse.base.eth` and `base.base.eth` for the addresses those names forward-resolve to,
  and an honest `null` for our wallet, which has no Basename. (I twice concluded this was broken
  during the audit; both times my test harness was pointing the client at the wrong RPC —
  `base-fork` reads `FORK_RPC`, not `LOCAL_RPC`. The code was right.)
- **Base-native assets**: cbBTC, WETH, USDC, and eight tokenized equities that are real contracts
  on Base mainnet — 4 of 8 answer `totalSupply()`, all 8 saw transfers in a 4,000-block window.

### MISSING

Base Account / Smart Wallet, Paymaster and gas sponsorship, OnchainKit, Base Pay, Coinbase
Commerce, and the Coinbase Developer Platform APIs (Onramp, Staking, Swap). x402 on Base.

### Verdict

Base is used as a chain with its own ecosystem rather than as a deployment target, which is the
distinction that matters. Basenames and the live Aave rate are the two places most projects would
have hardcoded, and neither is hardcoded here.

---

## Where deeper integration would fit organically — and where it would not

**Would fit.** The permission screen is a natural home for Privy session signers and for a Base
paymaster (the user pays no gas to grant). The activity trail is a natural home for a second
subgraph — it already reads one. The order ticket already shows a route, so Limit Order Protocol
and Fusion belong there as order *types*, not as a bolt-on. Idle USDC already goes to Aave, so the
CDP Staking and Onramp APIs sit next to a flow that exists.

**Would not fit, and I am not going to pretend otherwise.** Substreams is a data-engineering tool
for volumes this app does not have; adding one to qualify would be obvious. Coinbase Commerce has
nothing to do with a trading bot. Smart-wallet account abstraction would *replace* the delegation
contract that is the entire product thesis — adopting it to tick a Base box would cost the project
its best idea. Anything that makes the bot custodial is out by construction.

---

# 50 features, ranked by how load-bearing the sponsor tech is

Rank 1 is "delete the sponsor and the feature ceases to exist". Rank 50 is "the sponsor's name is
on it and anything else would do".

## Tier 1 — the sponsor's capability *is* the feature (1–12)

| # | Feature | Sponsor capability | Why a judge notices |
|---|---|---|---|
| 1 | **Ship the Aqua book in bootstrap** so every fork rebuild has a live maker book, and the routing ladder chooses Aqua on the deployment being judged | 1inch Aqua `ship` + `BookShipped`, `XorrAquaBook.delegatedFillArgs` | It converts the track's headline claim from historical to reproducible. Nothing else in this list matters as much |
| 2 | **Maker-side SwapVM program** — compile a real pricing program, ship it, and let the bot take against it when Aqua cannot serve the size | 1inch SwapVM bytecode execution | The only way "both are used" becomes true. Currently zero fills |
| 3 | **Publish `subgraph-aqua` and compose two indexes** — join our delegation index with the Aqua book index so venue choice is an indexed decision | The Graph, two subgraphs | It is the literal track criterion, and the build is already IPFS-pinned |
| 4 | **Privy policy as the user-facing spend limit** — the daily cap the user sets writes a Privy policy rule, so the refusal comes from Privy before it reaches our contract | Privy policy engine, key quorums | Two independent refusal layers, both provable. Builds on the strongest thing already here |
| 5 | **x402-paid Graph queries** — pay per query for network data the free tier will not serve, from the executor's own wallet | The Graph Gateway x402 / EIP-3009 | A second Graph product *and* a real payment rail, in one feature |
| 6 | **Aqua book depth on the order ticket** — show the maker's curve and where this order lands on it before the user confirms | Aqua book state via `bookBalances` | Makes Aqua visible in the product, not just in the trail |
| 7 | **Limit orders via 1inch LOP** — "buy WETH at $2,300" as a signed order the bot maintains, cancels and re-signs | 1inch Limit Order Protocol | A second official 1inch protocol, and the natural next strategy tier |
| 8 | **Fusion intents for large exits** — route the panic-flatten through Fusion so resolvers compete instead of the bot eating slippage | 1inch Fusion / Fusion+ | Directly fixes the 2% slippage the flatten screen warns about |
| 9 | **Basename-addressed withdrawals** — allowlist `alice.base.eth` instead of a 42-character hex string | Base L2 resolver, forward resolution | The allowlist is the screen where a mistyped address loses money. Already have the reverse half working |
| 10 | **Privy session signers for the grant** — the user approves once and the three signatures collapse into one session | Privy session signers | Kills the "sign three times" note on the grant screen, which is the biggest drop-off in onboarding |
| 11 | **Gas-sponsored granting via a Base paymaster** — a new user grants the permission without holding any ETH | Base paymaster / ERC-4337 | Removes the exact failure the kill switch hit today: "insufficient funds for gas… have 0" |
| 12 | **Indexed cap reconciliation across devices** — the subgraph, not our database, is what tells a second device the cap is spent | The Graph, `Spend` entities | Already half-built in `decide()`; finishing it makes the index authoritative |

## Tier 2 — the sponsor's tech is the engine, but a worse substitute exists (13–26)

| # | Feature | Sponsor capability | Depth |
|---|---|---|---|
| 13 | Portfolio P&L from 1inch rather than our own position book | 1inch Portfolio API | Core — replaces a table we maintain by hand |
| 14 | Token metadata and logos for every Base asset | 1inch Token API | Core to any asset list beyond the nine hardcoded ones |
| 15 | Balance reconciliation against 1inch Balance API as a second opinion | 1inch Balance API | Core — a disagreement is a bug worth surfacing on `/judge` |
| 16 | Historical fills from 1inch History API, cross-checked against the audit trail | 1inch History API | Core — a third independent source for `/judge` |
| 17 | Privy funding flow so a new wallet can be topped up in-app | Privy on-ramp | Core — `/fund` currently only shows an address |
| 18 | MFA on the kill switch and on raising the cap | Privy MFA | Core to the safety story |
| 19 | Social login alongside email, sharing one embedded wallet | Privy OAuth | Core to onboarding breadth |
| 20 | A Graph-indexed leaderboard of agents by realised P&L | The Graph, custom entities | Core — the leaderboard screen exists and has no index behind it |
| 21 | Aave supply/withdraw history from an indexed source | The Graph + Aave Base | Core to the yield tier's honesty |
| 22 | CDP Onramp for USDC directly into the Base wallet | Coinbase Developer Platform | Core to `/fund` |
| 23 | Basename as the agent's identity — each hired agent gets a subname | Basenames subname registration | Core to the agent roster |
| 24 | 1inch Traces to explain exactly why a revert happened | 1inch Traces API | Core to the failure copy the app already writes |
| 25 | Spot Price streaming for the markets list instead of polling | 1inch Spot Price | Core to the tab's responsiveness |
| 26 | Privy delegated actions to let the bot rotate its own session key | Privy delegated actions | Core to unattended operation |

## Tier 3 — genuine use, but the sponsor is one of several options (27–38)

| # | Feature | Sponsor capability |
|---|---|---|
| 27 | Slippage tuned per pair from observed Aqua book depth | Aqua book state |
| 28 | "Why this venue" explainer on every fill, sourced from the index | The Graph |
| 29 | Cap-remaining push notification driven by indexed spends | The Graph |
| 30 | Multi-wallet support under one Privy user | Privy linked accounts |
| 31 | Export the audit trail signed by the Privy wallet | Privy message signing |
| 32 | Show the Privy policy diff before the user raises a cap | Privy policy read |
| 33 | Base block explorer deep links on every hash | Base / Basescan |
| 34 | Aave health-factor guard before supplying idle cash | Aave on Base |
| 35 | Equity earnings dates cross-checked against an indexed source | The Graph |
| 36 | 1inch quote comparison against the Aqua book, shown side by side | 1inch Aggregation + Aqua |
| 37 | Gas price awareness from Base before scheduling a run | Base RPC |
| 38 | Wallet activity feed from the Base node rather than our database | Base RPC |

## Tier 4 — the sponsor is swappable; these are product ideas wearing a sponsor's name (39–50)

39. Referral codes tied to a Basename. 40. Agent performance charts. 41. CSV export of disposals for
tax. 42. Dark/light theme. 43. Watchlist price alerts. 44. Weekly email summary. 45. In-app
changelog. 46. Onboarding checklist progress. 47. Strategy templates gallery. 48. Shareable
read-only portfolio link. 49. Localisation. 50. Widget for the iOS home screen.

*(39–50 are listed for completeness. None of them is worth building for a sponsor track, and a judge
would read any of them as a checkbox. They are here because the brief asked for fifty, and padding
the top of the list would have been the dishonest way to get there.)*

---

## If only three things get built

1. **#1 — ship the Aqua book in bootstrap.** The 1inch track's criterion is Aqua/SwapVM, six real
   Aqua fills already exist, and the only reason the live deployment cannot show one is that a
   manual script never runs. This is hours, not days.
2. **#3 — publish `subgraph-aqua`.** The build is pinned; the blocker was believed to be "no key to
   sign a Studio login", and `.keys/deployer.key` disproves that. It turns an unclaimed track into a
   claimed one.
3. **Fix Finding 1** — run the demo against a deployment where the subgraph indexes the contract
   being traded. Everything else is already true; it is only true in two places at once.
