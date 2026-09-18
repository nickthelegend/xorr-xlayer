# The Graph — audit, and 50 ideas

The sponsor placeholder came through unfilled, so the target was chosen from the project. Of the
three sponsors, **1inch and Privy are both closed** — Aqua settles real fills, and Privy policies
plus a key quorum landed earlier today. The Graph is the only one where the project currently
**fails the track's own stated bar**, which makes it the audit worth doing.

Everything below was verified by running it: live GraphQL against the deployed subgraph, the
browser's own network log, and real HTTP against The Graph's gateway. Nothing here is inferred from
a package name.

---

## 1. What The Graph actually offers (researched, 2026-09-07)

| Product | What it is | Credential |
|---|---|---|
| **Subgraphs** | GraphQL indexes of contract events. Studio for deploying, Gateway for querying. | Deploy key to deploy; **gateway API key** to query the network |
| **Substreams** | Streaming ETL over Firehose data, packaged and composable | Substreams endpoint key |
| **Substreams / Subgraph SKILLs** | Agent guides for the ETL model and for GraphQL query and schema patterns | none |
| **Subgraph MCP** | Search, inspect and query 15,000+ subgraphs in natural language | none stated |
| **Token API** | Unified REST for balances, transfers, swaps, holders, prices, NFTs across ~9 chains incl. Base | Pinax JWT (`api.pinax.network/v1/`) |
| **x402 payments** | **Pay per query in USDC over HTTP from the Gateway — no API key, no account** | a funded USDC wallet |
| Graph Node / Firehose / sink services | Self-hosted indexing and delivery | infra |

**Track criteria — "Best Use of Composable or Standardized Graph Products" ($5,000):** compose
**two or more** Graph products, *or* build meaningfully on a **standardized schema** (e.g. Messari
Standardized Subgraphs), *or* compose reusable Substreams packages, *or* layer the **Subgraph MCP**
for cross-protocol analysis. A new composable Substreams module for an emerging standard (ERC-4626
vault flows is the example given) counts. Explicitly **disqualified**: mocked, local-only or static
datasets, and *"simply querying one Subgraph with no composition or standardization"*.

### The finding that changes everything

`GRAPH_DEPLOY_KEY` in this repo is a **deploy** key, not a gateway query key — probed and refused:
`{"errors":[{"message":"auth error: API key not found"}]}`. That has been the standing blocker.

**x402 removes it.** Probed live:

```
POST https://gateway.thegraph.com/api/x402/subgraphs/id/<id>   →   HTTP/2 402
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",                                    ← Base mainnet
    "amount": "10000",                                           ← 0.01 USDC per query
    "payTo": "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
    "asset":  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",      ← the exact USDC this app trades
    "extra": { "assetTransferMethod": "eip3009" }                ← signed off-chain, gasless
  }]
}
```

Any of 15,000+ subgraphs, priced in the same token on the same chain this product already moves,
paid with an EIP-3009 authorization the delegate key can already sign. `@graphprotocol/client-x402`
is real and published (v1.0.0). *(The testnet gateway returned nothing to the same probe.)*

---

## 2. Audit — what is real, right now

### GENUINELY USED — 5 places, all verified live

| # | Where | Evidence |
|---|---|---|
| 1 | [server/src/graph/client.ts:71](../server/src/graph/client.ts) — `health`, `policyFor`, `spendsFor`, `dailySpendFor` | `/graph/health` → `{"block":46494995,"healthy":true}` |
| 2 | [app/history.tsx](../app/history.tsx) → [src/data/subgraph.ts](../src/data/subgraph.ts) | Browser network log on `/history`: one POST to `api.studio.thegraph.com/query/1758741/xorr/v0.0.2`, **1,183 ms**, real response |
| 3 | `/verify` `subgraph` check | "synced to block 46492586, no indexing errors" — passes on **both** deployments |
| 4 | [server/src/graph/decide.ts](../server/src/graph/decide.ts), called by `runStrategy` before every spend | `/graph/decision` → `{"act":true,"observedRemainingUsd":1600,…}` — the remaining cap comes from the subgraph's `dailySpend`, not from Postgres |
| 5 | [subgraph/](../subgraph) — deployed, synced, indexing our own contract | Live query returns **2 policies** (incl. `0x95a0b368…` → delegate `0xc38f38f4…`, `revoked:false`, matching the chain), **1 spend**, **1 dailySpend** |

This is genuine and load-bearing. `decide()` refusing to act on a revoked policy is a fact Postgres
cannot know, and it is read from the index.

### BROKEN — found by calling it, fixed in this run

**`/agent/decision` was unreachable by any principal.** Registered on the user surface, but the
`/agent/` prefix is the machine surface: a Privy token got *"this surface needs an agent key"*, an
agent key got *"this route belongs to a signed-in user"*. Both refusals correct, route dead between
them — and it is precisely the surface that shows a subgraph driving a decision. It regressed
silently when the prefix guard was added; an older test plan records it passing. Moved to
`/graph/decision`, with a test that fails the build if a user route is written under `/agent/`
again.

### IMPORTED BUT UNUSED — the second product

[subgraph-aqua/](../subgraph-aqua) is written, built and pinned to IPFS
(`QmctadHCDBprb9Q1Pq4oyMXjB6KcnUDHRheDRNyBA59tAJ`). [server/src/graph/aqua.ts](../server/src/graph/aqua.ts)
is a complete client, imported by `decide()`. And `AQUA_SUBGRAPH_URL` is **unset on both deployed
services** — confirmed against Railway. So `aquaIndexConfigured()` is `false`, the Aqua branch never
runs, and `/graph/decision` says so in its own words: *"No Aqua book index configured for this
deployment."*

**One subgraph is ever queried. That is the exact thing the track disqualifies.** The cause is
mundane: the `xorr-aqua` slug was never created in Studio, and `graph deploy` answers
`Subgraph not found`.

### STRUCTURAL — the two halves do not meet

`indexesThisDeployment()` compares the running `DELEGATION_ADDRESS` to the indexed one:

```
fork executor delegation : 0xabe6f2bbe7471c4976128f0dc13a7f83499e9a23   ← where every fill happens
indexed by the subgraph  : 0xb14CF3D0b5269aCDE52322218adb6d5C1daE0a4e   ← Base Sepolia
```

On the fork — the only place trades settle — every Graph read is skipped. On Sepolia the subgraph
*is* consulted, but 1inch cannot settle there, so nothing ever reaches it: `/history` correctly and
permanently reads "Nothing has settled on chain yet". The one indexed spend belongs to an older
wallet (`0x364d7bbc…`, 25 USDC), which is why the current user's activity is empty — correct
scoping, empty result.

### FAKED — none

No mocked or hardcoded GraphQL response anywhere. Every Graph read is a real network call or an
honest failure.

### MISSING — never touched

Substreams · Substreams SKILLs · Subgraph SKILLs · Subgraph MCP · Token API · **x402 payments** ·
standardized schemas (Messari) · Graph Node · Firehose · sink services · the ERC-4626 module the
criteria name as an example.

---

## 3. Honest status

**Real, live, and load-bearing — on the deployment that cannot trade; and one product short of
qualifying.**

The subgraph is not a checkbox. It is deployed, synced, error-free, queried from both the client
and the executor, and it gates a real spending decision. A judge can watch a revoke on chain and
see `/graph/decision` flip to `act:false` seconds later.

But the track's bar is composition, and the project composes nothing: the second subgraph has no
endpoint, so exactly one is ever queried. As submitted today this is *"simply querying one
Subgraph"* — the sentence the criteria use to disqualify.

Two things fix it, neither large, and **neither needs a credential the project lacks**: create the
Studio slug for the Aqua index (a dashboard action), or reach the Gateway through x402 and pay in
the USDC this app already holds.

---

## 4. Where deeper integration genuinely fits

Four surfaces where The Graph belongs on the merits, not to qualify:

- **`decide()` before every spend.** Already there. It wants a second source — the venue's own book
  state — which is what the Aqua index is for.
- **`/history` and `/activity`.** The product's claim is "a history you check, not one we hold".
  Today one of those two screens reads the index and the other reads Postgres.
- **`/judge`.** Every claim re-checked live. A cross-protocol query is exactly the kind of claim
  that belongs there.
- **The bot's reasoning.** "What it chose not to do" is the stated product. Indexed history across
  protocols is the raw material for that, and it is currently CoinGecko and our own tables.

**Where it would be forced, and I am not proposing it:** price feeds (CoinGecko and 1inch already
cross-check, and a subgraph is the wrong shape for a spot price); the audit trail (hash-chained in
Postgres on purpose — the tamper-evidence argument depends on it being append-only, not indexed);
and anything that would replace a direct `eth_call` for a balance the app must not be wrong about.

---

## 5. Fifty ideas, ranked by how load-bearing The Graph is

Ranked hardest-to-fake first: the top items are impossible without The Graph, the bottom ones would
work with any data source and are listed to be honest about the difference.

### Tier 1 — impossible without The Graph, and they clear the track's bar

| # | Idea | Capability | Depth | Why a judge notices |
|---|---|---|---|---|
| 1 | **Pay-per-query Gateway access via x402.** Query any of 15,000+ subgraphs with an EIP-3009 USDC authorization signed by the delegate key. Removes the API-key blocker permanently. | x402 + Gateway | Core | It is The Graph's newest primitive, it needs no account, and this app already moves that exact token on that exact chain. Verified 402 in this audit. |
| 2 | **Compose the delegation index with the Aqua book index in one decision.** Ship the Studio slug, set `AQUA_SUBGRAPH_URL`, and let `decide()` join both — permission from one, liquidity from the other, and say which moved the answer. | Two subgraphs | Core | This is literally the track's definition of composition, and the code is already written. |
| 3 | **One query across every lending protocol via a standardized schema.** Adopt Messari's schema to ask "best USDC supply rate on Base" across Aave, Moonwell, Morpho, Seamless in a single query, and route tier 4 to the winner. | Standardized Subgraphs | Core | The criteria's own example of leverage: one query pattern spanning many protocols. Today the app hardcodes Aave. |
| 4 | **An ERC-4626 Substreams module, contributed upstream.** Index tokenized-vault deposits/withdrawals/share prices as a reusable package. | Substreams, composable module | Core | The criteria name ERC-4626 explicitly as a qualifying contribution. |
| 5 | **Subgraph MCP inside the bot's reasoning.** Let the agent search and query subgraphs in natural language when asked "why did you skip this?", and show the query it ran. | Subgraph MCP | Core | Cross-protocol analysis via MCP is a named qualifying path, and it fits "what it chose not to do". |
| 6 | **Cross-protocol venue scoring from indexed fills.** Rank venues by realised fill quality across DEX subgraphs rather than by a quoted price. | Multiple subgraphs | Core | Only an index can answer "where did trades like mine actually fill best". |
| 7 | **A real equity curve from indexed spends, not our database.** Rebuild portfolio value over time purely from `Spend` entities. | Subgraph | Core | The product's own claim, made checkable — the chart stops being ours. |
| 8 | **Substreams pipeline for the delegation contract, reused across both deployments.** One package, two chains, replacing the per-deployment subgraph mismatch. | Substreams | Core | "One pipeline reused across chains" is the criteria's phrasing. |
| 9 | **Whale-flow detection feeding the momentum tier.** Index large transfers of the assets the bot trades and use them as a gate. | Substreams / Token API | Core | A signal that cannot be computed from a price feed. |
| 10 | **Counterparty history before an Aqua fill.** Query the maker's past fills before taking their book. | Aqua subgraph | Core | Turns "a book exists" into "a maker with a record" — genuinely safer routing. |

### Tier 2 — The Graph does the real work

| # | Idea | Capability | Depth |
|---|---|---|---|
| 11 | Live "who else granted this delegation" — indexed policies as a trust signal | Subgraph | Core |
| 12 | Historical cap utilisation curve per wallet, from `DailySpend` | Subgraph | Core |
| 13 | Venue allowlist drift alert — indexed `Venue` entities vs what the user signed | Subgraph | Core |
| 14 | Token holder-concentration check before a first buy | Token API | Core |
| 15 | Indexed revoke-propagation timeline, proving the "under a second" claim | Subgraph | Core |
| 16 | Cross-chain position view from one standardized query | Standardized schema | Core |
| 17 | Aave rate history from the index, so the yield tier sees a trend not a tick | Subgraph | Core |
| 18 | "Similar wallets" — strategies of wallets with comparable indexed behaviour | Subgraph | Core |
| 19 | Gas-cost history per venue, to price the cheapest route honestly | Substreams | Core |
| 20 | MEV/sandwich detection on our own past fills | Substreams | Core |
| 21 | An indexed leaderboard of every xorr delegation, not just this user's | Subgraph | Core |
| 22 | Backtest against indexed on-chain fills instead of CoinGecko candles | Subgraph | Core |
| 23 | Liquidity-depth trend per pair, to size an order to the book | DEX subgraphs | Core |
| 24 | Stablecoin depeg watch across pools as a circuit breaker | Multiple subgraphs | Core |
| 25 | Indexed proof for every `/judge` claim, queried live | Subgraph | Core |
| 26 | Token-age and first-seen check before trading anything new | Token API | Core |
| 27 | An indexed audit cross-check: our hash chain vs the chain's own events | Subgraph | Core |
| 28 | Per-strategy attribution computed from indexed spends | Subgraph | Core |
| 29 | Failed-transaction history, to warn before a route that keeps reverting | Substreams | Core |
| 30 | Aqua maker inventory over time, not just right now | Aqua subgraph | Core |

### Tier 3 — real use, lighter weight

| # | Idea | Capability | Depth |
|---|---|---|---|
| 31 | Basename resolution from an index rather than an RPC call | Subgraph | Surface |
| 32 | An in-app GraphQL panel: type a query, see the response, beside the screen using it | Subgraph | Surface |
| 33 | Indexed ERC-20 approval history — everything this wallet has ever approved | Token API | Core |
| 34 | Tax-lot export built from indexed disposals | Subgraph | Core |
| 35 | "First trade on this venue" badge from indexed history | Subgraph | Surface |
| 36 | Subgraph sync-lag indicator on `/history`, so staleness is visible | `_meta` | Surface |
| 37 | Indexed notification triggers — fire on an event, not a poll | Substreams sink | Core |
| 38 | Portfolio drift computed from indexed balances | Token API | Core |
| 39 | A public read-only wallet page served entirely from the index | Subgraph | Core |
| 40 | Query-cost meter showing what the app spent on data via x402 | x402 | Surface |
| 41 | Indexed venue uptime — which venues actually filled, and when | Subgraph | Core |
| 42 | Historical slippage per pair, to set the limit from evidence | DEX subgraphs | Core |
| 43 | NFT holdings on the assets screen | Token API | Surface |
| 44 | Subgraph SKILLs used to generate the app's own queries at build time | Subgraph SKILLs | Surface |
| 45 | A second index of `strategy_runs` mirrored on chain | Subgraph | Core |

### Tier 4 — honest about the bottom: swappable for any data source

| # | Idea | Why it ranks last |
|---|---|---|
| 46 | Spot price from a DEX subgraph | CoinGecko and 1inch already cross-check; a subgraph is the wrong shape for a live price |
| 47 | Block-number display | An RPC call does this |
| 48 | Transaction receipt lookup | `eth_getTransactionReceipt` is direct and free |
| 49 | Current token balance from the index | Must be an `eth_call` — the app cannot be wrong about a balance, and an index lags |
| 50 | Storing app state in a subgraph | A subgraph indexes chain events; this is a database with extra steps |

---

## What I would build, in order

**#2 first** — the code exists, the blocker is a Studio slug, and it converts a disqualifying
submission into a qualifying one.

**#1 next** — x402 is verified working, needs no credential, and is the most defensible thing on
this list: paying for data in USDC on Base is the same primitive the product already runs on.

**#3 after that** — a standardized schema across lending protocols would make tier 4 genuinely
better rather than merely qualifying, which is the difference the criteria say they look for.

---

## Sources

- [The Graph docs](https://thegraph.com/docs/en/) · [About](https://thegraph.com/docs/en/about/)
- [Hackathon resources](https://thegraph.com/blog/hackathon-resources/)
- [x402 payments](https://thegraph.com/docs/en/subgraphs/tooling/x402-payments/)
- [Token API (Pinax)](https://app.pinax.network/docs/api/)
- [Subgraph MCP](https://thegraph.com/docs/en/ai-suite/subgraph-mcp/introduction/)
- [ETHOnline 2026 prizes](https://ethglobal.com/events/ethonline2026/prizes)
- [Technical roadmap](https://thegraph.com/blog/technical-roadmap/) · [Token API + Substreams case study](https://thegraph.com/blog/case-study-token-api-substreams/)
