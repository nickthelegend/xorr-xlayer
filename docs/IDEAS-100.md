# 100 ideas, individually ranked — and what was actually built

Written after reading the repo, not from a template. The project is already large: **99 screens,
91 route handlers, 6 contracts, 14 external integrations, 912 tests.** So "add a feature" is
usually the wrong move — the marginal win is in closing the gaps the project's own audit names, in
making its claims checkable, and in the two or three moments a judge remembers.

Score = **impact × feasibility × fit**, each 1–5. Fit punishes anything that would crowd the pitch;
a hundred disconnected features hurt a demo as much as they help. Anything already in the repo is
excluded — this list contains nothing that existed before this run.

Three facts drive the ranking:

1. `SPONSOR-AUDIT.md`: **no single deployment demonstrates the sponsor stack.** The fork has real
   1inch fills and an inert Graph; Sepolia has a load-bearing Graph that can never fill.
2. The product's central claim is a **tamper-evident audit trail**, and every part of that claim
   used to live in our own database.
3. `ui/mobile-ui/animations.md` is a deliberate, argued motion policy: *"Never animate a price"*,
   *"no entrance animations"*, motion is *"confirmation, not decoration."* Several obvious
   design ideas are **fit 1** because building them would make the product worse.

---

## Tier 1 — built this run (score ≥ 60)

| # | Idea | I | F | Fit | Score | Status |
|---|---|---|---|---|---|---|
| 1 | **Anchor the audit trail's head hash to Base.** Its integrity stops resting on our own database. | 5 | 4 | 5 | 100 | ✅ BUILT |
| 2 | **`/verify` reads that anchor back off the chain** and reports whether the local trail still agrees. | 5 | 4 | 5 | 100 | ✅ BUILT |
| 3 | **Price every venue for the same trade** — Aqua, SwapVM and the aggregator, refusals included. | 4 | 4 | 5 | 80 | ✅ BUILT |
| 4 | **Settle the first real SwapVM fill.** `COMPLETION.md` #3, open since the contract was written. | 5 | 3 | 5 | 75 | ✅ BUILT |
| 5 | **Anchor history screen** — every commitment, its block, and whether the trail still hashes to it. | 4 | 4 | 4 | 64 | ✅ BUILT |
| 6 | **Page `eth_getLogs`** so venue discovery survives a provider tightening its range limit. | 4 | 4 | 4 | 64 | ✅ BUILT |
| 7 | **Compare venues net of gas**, not on quoted output alone. The winner can change. | 4 | 3 | 5 | 60 | ✅ BUILT |
| 8 | **Execution quality: each fill against the market price at decision time**, per venue, from the real trail. | 4 | 3 | 5 | 60 | ✅ BUILT |

## Tier 2 — ranked, not built (30–59)

| # | Idea | I | F | Fit | Score | Why not |
|---|---|---|---|---|---|---|
| 9 | Strategy dry-run: what the first run buys at today's price, before you create it | 4 | 4 | 3 | 48 | Time |
| 10 | Cap forecast — what live strategies commit against the on-chain cap | 3 | 4 | 4 | 48 | Time |
| 11 | The route drawn as a venue graph rather than a comma list | 4 | 3 | 4 | 48 | Time |
| 12 | Privy policy engine refusing a transaction, shown live on screen | 4 | 3 | 4 | 48 | `/verify` already proves it; screen is duplication |
| 13 | Concentration warning when one asset dominates the book | 3 | 4 | 4 | 48 | Time |
| 14 | Per-strategy P&L attribution | 3 | 3 | 5 | 45 | Time |
| 15 | Subgraph query latency vs the same read over RPC | 3 | 4 | 3 | 36 | Time |
| 16 | Reorg awareness — indexed block vs finalised | 3 | 3 | 4 | 36 | Time |
| 17 | Trailing stop tier | 3 | 3 | 4 | 36 | Time |
| 18 | Rebalance-to-target tier | 3 | 3 | 4 | 36 | Time |
| 19 | Agent A/B over one window, same capital | 3 | 3 | 4 | 36 | Time |
| 20 | Limit orders placed as Aqua books | 4 | 2 | 4 | 32 | Needs a maker loop; large |
| 21 | Basename shown wherever an address appears | 2 | 4 | 4 | 32 | Resolver works; wiring is cosmetic |
| 22 | 1inch Fusion intent quotes beside the classic quote | 4 | 2 | 4 | 32 | Different API surface; large |
| 23 | Aqua book depth chart | 3 | 3 | 3 | 27 | Fork-only; thin on Sepolia |
| 24 | Multi-wallet switching surfaced in the UI | 3 | 3 | 3 | 27 | Resolution fixed today; UI is separate |
| 25 | Stop-loss ladders | 3 | 3 | 3 | 27 | Time |

## Tier 3 — considered, ranked below the line (26–100)

Grouped by why they lost. Several are good ideas that would make the demo **worse**.

**Blocked on something that does not exist (26–30).** 26 second subgraph deployed and queried
*(`subgraph_create` is a Studio dashboard action, not in the deploy API)*; 27 LLM agent voice
*(`OPENROUTER_API_KEY` exists nowhere)*; 28 push notifications to a real device *(needs a device
token)*; 29 mainnet deployment *(spends real money)*; 30 Privy policy on the user's embedded wallet
*(Privy requires the owner to authorise; platform constraint)*.

**Would make the product worse — fit 1 or 2 (31–44).** 31 number roll-up on prices, 32 price-tick
flash, 33 chart draw-in, 34 staggered list entrance, 35 trail entries stamping in, 36 sparkline
morphing between timeframes, 37 parallax home header, 38 confetti on a first fill, 39 sound design
on fills, 40 agent avatar micro-expressions, 41 spring physics on the kill switch, 42 skeleton
shimmer, 43 animated hash-chain visualiser, 44 a "score" for each agent. The first twelve are all
refused by `animations.md` for one argued reason — *"a trading UI that animates while a number
changes makes the number untrustworthy"* — and 44 invents a metric the product would then have to
defend.

**Real but redundant with something already shipped (45–60).** 45 a second price cross-check
source *(`/crosscheck` exists)*, 46 an "explain this fill" page *(`/graph/decision` exists)*,
47 spend heatmap *(`/graph/spends` exists)*, 48 cap-utilisation history *(exists)*, 49 subgraph
freshness widget *(exists, with block lag)*, 50 venue allowlist screen *(`/allowlist`)*, 51 approval
audit *(`/approvals`)*, 52 tax lots *(`/disposals`)*, 53 CSV export *(`/export`)*, 54 audit entry
detail *(`/audit/[seq]`)*, 55 agent intro *(`/bot/[id]/intro`)*, 56 leaderboard *(`/bot/leaderboard`)*,
57 sponsor page *(`/sponsors`)*, 58 coverage map *(`/coverage`)*, 59 system health *(`/system`)*,
60 network honesty page *(`/network`)*.

**Core functional, ranked below Tier 2 (61–78).** 61 DCA pause-on-drawdown; 62 correlation view;
63 scheduled email reports; 64 paper-trading toggle; 65 strategy templates gallery; 66 import/export
a strategy as JSON; 67 venue scorecard by asset; 68 per-agent risk budget; 69 capital allocation
across agents; 70 realised/unrealised split; 71 tax-lot method selection; 72 position sizing by
volatility; 73 funding-rate-aware perp entry; 74 earnings-blackout guard; 75 weekend/holiday
scheduling; 76 partial-fill handling; 77 RFQ comparison; 78 multi-hop split display.

**Sponsor depth, ranked below (79–88).** 79 permit2 flow; 80 approval minimisation pass;
81 Base paymaster / sponsored gas; 82 EIP-7702 batching; 83 cbBTC-specific tier; 84 EAS attestation
of `/verify` results; 85 an on-chain receipt NFT per fill; 86 Graph-sourced allowlist history;
87 entity-level subgraph diffing; 88 Privy MFA state read live.

**Production readiness (89–100).** 89 per-screen error boundaries; 90 offline detection banner;
91 request-id surfaced in every error; 92 rate-limit surfacing with retry-after honoured;
93 idempotency keys on every write; 94 session-expiry silent refresh; 95 deep-link handling for
every route; 96 accessibility audit; 97 keyboard navigation on web; 98 focus management in modals;
99 colour-contrast pass; 100 optimistic-update rollback.

Several of 89–100 are **already true** — the executor has request ids, an idempotency index, a
circuit breaker and rate limiting, and this run verified `retry-after` is honoured — which is why
they sit here rather than in Tier 1.


---

# What was actually built, and verified

Eight of the hundred. Each one was run against a real deployment and confirmed with a real value
before the next was started; the evidence is quoted rather than asserted.

| # | Feature | Evidence it works |
|---|---|---|
| 1 | Anchor the audit head to Base | `XorrAuditAnchor` at `0xB58cB717…`, 1,523 bytes on Base Sepolia. Two anchors published: entry 64 @ block 46,613,782 and entry 65 @ 46,621,210 — the first unchanged, so append-only holds on chain. |
| 2 | `/verify` reads the anchor back | Live: *"0x7d6ec1d88d039614… for 64 entries, held by Base since block 46,613,782 (2026-09-09 23:17 UTC)"*. `/verify` went 20 checks → 21. |
| 3 | Price every venue for the same trade | On the fork, all three answered: `swapvm 0.040074`, `1inch 0.040194`, `aqua` refused with a reason. |
| 4 | First real SwapVM fill | `0x2a20ebbd…`, `to` = `XorrDelegation`, +0.061246900891976021 WETH out of the maker's own wallet. `fillsByVenue` now `{"swapvm": 3, "1inch": 36, "aqua": 5}` — it read `swapvm: 0` before. |
| 5 | Anchor history screen | `/audit/anchor` renders COMMITTED, the head, the block, and the contract and signing key so the read can be repeated without us. Linked from `/audit/chain`. |
| 6 | Page `eth_getLogs` | The provider had tightened to a 2,000-block range against a 9,000-block scan; discovery was silently returning nothing. Paging is what made #4 possible — `openPrograms()` found 16. |
| 7 | Compare venues net of gas | Live: `1inch 0.040194 · gas $0.5681 · net $99.02` beside `swapvm 0.040074 · gas $0.8075 · net $98.48`. SwapVM costs more gas because it routes through our book contract — measured, not assumed. |
| 8 | Measure how well each venue filled | Two real fills measured against the arrival price: `swapvm +71.1 bps` (tx `0x042ee2dc…`) and `aqua −307.8 bps` (tx `0x64de680f…`), `basis "forked"`. |

## Two of these are worth a sentence each

**#4 closed a gap the project's own audit had open.** `SPONSOR-AUDIT.md` Finding 2 read
*"`XorrSwapVMBook` has settled **zero** trades, on any deployment, ever"*, against a `SUBMISSION.md`
claim that both venues settle real trades. A judge checking the trail would have found the claim
and its refutation in the same table. It is now three fills, and the finding is rewritten with the
transaction hashes.

**#8 was described wrongly when it shipped, and the correction is worth reading.** It was reported
as "realised vs what the router quoted". It is not: `quoted_units` is `usd / priceOf(symbol)` — the
units the live **market price** implied when the run decided to trade. So it measures implementation
shortfall against the arrival price, which is the better metric (venue-neutral; the aggregator is not
grading its own quote) but a different claim from the one first made.

Its numbers are also not a ranking of venues. SwapVM came in at **+71 bps** and Aqua at **−308 bps**,
and on a fork both mostly measure other things: the price is the live market while the fill runs
against a pinned block, and the Aqua figure carries the pricing of the proof maker that shipped the
book. `basis: "forked"` is on the screen for that reason. What the −308 does show honestly is that
the metric reports bad fills too — which is the only reason to trust it when it reports good ones.

## Skipped, with the reason

- **Blocked by something that does not exist (5):** the second subgraph needs a Studio dashboard
  action that is not in the deploy API; the LLM voice needs `OPENROUTER_API_KEY`, which is set
  nowhere; push needs a real device token; mainnet spends real money; Privy policy on the user's
  own wallet needs the user's authorisation, by Privy's design.
- **Would make the product worse (14):** every price-animation idea. `animations.md` argues the
  case better than I could — *"a trading UI that animates while a number changes makes the number
  untrustworthy"* — and building them would trade the product's most distinctive quality for
  motion a judge has seen twenty times that day.
- **Already shipped (16):** ranked and then found in the repo. Listed so the list is honest about
  its own overlap rather than quietly dropping them.
- **Ranked below the line (57):** real ideas that lost to the eight above on impact × feasibility ×
  fit, and would have crowded the pitch more than they strengthened it.

## No regressions

Every suite after the last feature landed: **344 server · 532 client · 62 contract**, and the
100-screen sweep re-run against the deployed build.
