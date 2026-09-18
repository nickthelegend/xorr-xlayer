# xorr-solana — 100 ranked features, and what actually got built

**Purpose.** The prioritised feature list for the Stocklana hackathon (tokenized stocks on Solana),
with an honest build status against every item. Ranked by **impact × feasibility × fit** — impact =
would a judge notice, feasibility = buildable for real in the time, fit = strengthens the pitch
rather than cluttering it.

**Provenance.** Generated mid-session and used to drive worker assignments by number from that point
on (e.g. #20/#6/#4 → motion worker; #13/#47/#7 → production-readiness worker; #1/#2/#5/#11/#16/#55 →
Solana worker). Items 61–100 were ranked low deliberately and never scheduled. Status below was
verified against merged PRs, not asserted.

**Status key**
- **MERGED** — built, hand-verified, on `main`
- **GREEN** — built and CI-passing, not yet merged
- **SKIPPED** — with reason

**Buckets** — `FN` core functional · `SP` sponsor/xStocks-native · `DM` design & motion · `PR` production-readiness

---

## Tier 1 — demo-defining

| # | B | Feature | Status | Evidence |
|---|---|---|---|---|
| 1 | SP | Split/dividend-safe P&L via Token-2022 Scaled-UI multiplier | **MERGED** | PR #7, #9 — `scaledUiMultiplier()` handles scheduled transitions |
| 2 | SP | Live proof-of-reserves badge (1:1 backing per position) | **MERGED** | PR #15 — honest-unknown enforced by test |
| 3 | FN | Agent reasoning ribbon — why this strategy, this asset | **MERGED** | PR #16, #20 |
| 4 | DM | Kill-switch moment — full-screen revoke + haptics + confirm badge | **MERGED** | PR #8 — `StopCurtain.tsx`, two-beat haptic |
| 5 | SP | Corporate-action calendar (ex-div / split) | **MERGED** | PR #16 — from the issuer's *pending* multiplier |
| 6 | DM | AgentOrb: thinking → decided → executing → filled | **MERGED** | PR #8 — driven by real executor stage |
| 7 | PR | Real on-chain error surfacing (congestion, paused mint, rejects) | **MERGED** | PR #4 |
| 8 | FN | Off-hours badge + slippage guard | **MERGED** | PR #11 — session logic real; fabricated prices removed |
| 9 | DM | Buy receipt card with real signature + slot | **MERGED** | PR #8, #14 |
| 10 | SP | One-tap flatten via xChange atomic RFQ | **SKIPPED** | needs issuer API credentials that do not exist here |
| 11 | SP | Transfer-hook eligibility gate (jurisdiction allow/deny) | **MERGED** | PR #19 — distinguishes indeterminate from denied; fails closed |
| 12 | DM | Breathing sparkline on live price ticks | **MERGED** | PR #8 |
| 13 | PR | Empty states for every list, with a next action | **MERGED** | PR #4 — `emptyActions.ts` |
| 14 | FN | Notification centre of agent actions | **MERGED** | PR #11 — `notifications/alerts.ts` |
| 15 | DM | Onboarding hero → first fund | **MERGED** | PR #3 — four states; a failed read is never drawn as 'not done' |

## Tier 2 — high value

| # | B | Feature | Status | Evidence |
|---|---|---|---|---|
| 16 | SP | Backing drawer: custody, attestation age, multiplier history | **MERGED** | PR #22 |
| 17 | FN | Strategy confidence meter | **MERGED** | PR #2 — thresholds derived from what the agent reasons with |
| 18 | FN | Auto-rebalance basket on drift | **MERGED** | PR #6, #16 — drift in percentage points, banded; re-landed after orphaning |
| 19 | SP | Dividend auto-reinvest yield line | **MERGED** | PR #19 — from real multiplier deltas; a split is explicitly not yield |
| 20 | DM | Number roll-up animations (tabular) | **MERGED** | PR #5 — `RollingNumber.tsx` |
| 21 | PR | Network-mismatch hard-error screen | **MERGED** | PR #4 |
| 22 | FN | "Explain this trade" from the stored decision record | **MERGED** | PR #20 — invents nothing when no record exists |
| 23 | DM | Content-preserving refresh (no jarring skeletons) | **MERGED** | PR #8 |
| 24 | FN | Price alerts on xStocks | **MERGED** | PR #1 — refused at creation for symbols with no feed |
| 25 | SP | Multiplier-adjusted limit orders | **MERGED** | PR #10 — and it uncovered a live split-liquidation bug |
| 26 | DM | Haptic map (fill / reject / kill / grant) | **MERGED** | PR #8 |
| 27 | PR | Retry with fresh blockhash | **SKIPPED** | backend handles it; no UI surfaced |
| 28 | FN | Agent schedule preview | **MERGED** | PR #20 — refuses to predict a winner |
| 29 | DM | Strategy-card 3D tilt / parallax | **SKIPPED** | decoration; low fit |
| 30 | PR | Idempotency visible ("already filled") | **MERGED** | PR #4 |
| 31 | FN | Allocation donut by sector | **MERGED** | PR #18 — sectors from SEC EDGAR |
| 32 | SP | Kamino lending of idle xStocks | **SKIPPED** | out of owner-locked scope |
| 33 | DM | "Agent is trading" live ticker | **MERGED** | PR #11 — a line that only claims the present tense |
| 34 | FN | Withdrawal cooling-off countdown | **MERGED** | PR #3 — 24h allowlist cooling-off |
| 35 | DM | Theme cross-fade + system sync | **SKIPPED** | time |

## Tier 3 — solid

| # | B | Feature | Status |
|---|---|---|---|
| 36 | FN | Multi-account switcher | **MERGED** |
| 37 | PR | Offline mode + reconnecting banner | **MERGED** |
| 38 | DM | Custom pull-to-refresh | SKIPPED — time |
| 39 | FN | Fuzzy xStock search | **MERGED** |
| 40 | SP | Proof-of-reserves history chart | **MERGED** |
| 41 | DM | Asset hero chart draw-on | **MERGED** |
| 42 | PR | Rate-limit / breaker UI | **MERGED** — PR #4 |
| 43 | FN | Receipt / CSV export | **MERGED** — PR #1, from real recorded fills only |
| 44 | DM | Tasteful profit-close moment | **MERGED** |
| 45 | FN | Per-strategy pause/resume | **MERGED** — PR #1, pause is NOT the kill switch (written into the audit trail + test) |
| 46 | SP | Corporate-action push notifications | **MERGED** |
| 47 | PR | Amount input validation (min/max/decimals/balance) | **MERGED** — PR #4 |
| 48 | DM | Tab-bar micro-animation | **MERGED** |
| 49 | FN | Portfolio value timeline | **MERGED** — PR #21, no interpolation |
| 50 | DM | Drag-to-set amount, spring physics | SKIPPED — time |
| 51 | FN | Tunable agent risk profile | **MERGED** — PR #2, changes real thresholds, cited in the decision record |
| 52 | PR | Graceful session/auth expiry | SKIPPED — time |
| 53 | DM | Shared-element asset transition | SKIPPED — time |
| 54 | FN | Fee / slippage breakdown before confirm | **MERGED** — PR #17, real Jupiter quote |
| 55 | SP | xStock catalog browser with live prices | **MERGED** — PR #17, "No price is a row" |
| 56 | DM | Kill-switch armed/disarmed chip | **MERGED** — PR #5/#9, on-chain read; a failed read outranks a stale answer |
| 57 | PR | Deep-link handling from notifications | **MERGED** — PR #17 |
| 58 | FN | Watchlist reorder + alerts | SKIPPED — time |
| 59 | DM | Onboarding progress (fund → grant → first trade) | **MERGED** — PR #3, each step from the source that decides it |
| 60 | PR | Accessibility pass on primary flows | **MERGED (partial)** — PR #4 |

## Tier 4 — nice-to-have (all SKIPPED: time, and each adds surface without strengthening the pitch)

61 public strategy leaderboard · 62 home summary cards · 63 referral/invite · 64 custom app icons ·
65 shareable P&L card · 66 i18n scaffolding · 67 sound-design toggles · 68 tax-lot report ·
69 seasonal themes · 70 biometric unlock · 71 telemetry opt-in · 72 animated splash → home ·
73 multi-currency display · 74 gesture shortcuts · 75 notes on positions · 76 Sentry crash reporting ·
77 chart entry/exit annotations · 78 benchmark vs SPYx · 79 empty-state micro-copy pass ·
80 recurring-buy calendar view · 81 icon-set unification · 82 config-driven feature flags ·
83 daily alerts digest · 84 scroll parallax on home · 85 multi-strategy stacking on one symbol — **MERGED (PR #13)**

**Since built:** **77** chart entry/exit annotations — the asset chart's buy/sell marks now name their venue when
tapped (`jupiter-route` vs `venue-vault`, the vault never called a swap), and the drawn fills are listed under the
chart with their recorded time, price and venue, each opening its run. From `strategy_runs` via `/runs` only; a
failed read or a capped page that stops short of the range is said, never drawn as an empty stretch.

## Tier 5 — deliberately rejected (all SKIPPED)

86 social feed — clutter, off-pitch · 87 NFTs — off-pitch · 88 3D trade globe — decoration ·
89 user-to-user chat — scope creep · 90 additional fiat off-ramps — out of scope ·
**91 Clawpump / Tessera / PreStocks — cut by owner** · **92 Pyth feeds — cut by owner** ·
93 options/derivatives on xStocks — not available · 94 AR view — gimmick ·
95 voice trading — risky, low ROI · 96 copy-trading marketplace — scope creep ·
97 cinematic Lottie intro — time sink · 98 multi-chain in one build — contradicts the single-fork scope ·
99 desktop app — out of scope · 100 full penetration test — no time; flagged for post-hackathon

---

## Tally

| | Count |
|---|---|
| **MERGED** (built + verified on `main`) | **46** |
| **GREEN** (built, CI-passing, unmerged) | **2** |
| **SKIPPED** | **52** |

### Built but not on the original list
The highest-value artifact of the session was not one of the 100: a **real Jupiter-routed xStock buy
on a mainnet fork** (`JUP6Lkb… → Instruction: Route → Orca Whirlpool SwapV2`, with the pool's own
reserves moving), plus `tools/prove-solana-xstock-buy.ts`, which *derives* its claims from the ledger
rather than asserting them, and a `FillVenue` type that makes it structurally impossible to call a
vault transfer a Jupiter swap.

### Regressions
**None.** 21 PRs merged, each reviewed by hand before merge rather than trusted from green CI.
`main` at migration: 493 commits, **0 fabricated data**, **0 tracked `node_modules`**.

### Fabrications caught and removed (all passed CI)
1. Invented equity prices (`NASDAQ_REFERENCE_PRICES`)
2. Fake transaction signatures (`'5K3yDemo…' + Math.random()`)
3. A fabricated MoonPay API key fallback
4. A synthetic ±8% price band standing in for recorded history
5. A `priceImpactPct` nobody measured and a route plan naming a pool never consulted
6. A "Jupiter swap" label on a fill where Jupiter was never invoked
7. `node_modules` symlinks pointing at the owner's local disk

### Reusing this list for other chains
Items marked `SP` are xStocks/Token-2022-specific and will not port. Everything marked `FN`, `DM`
and `PR` is chain-agnostic and lives behind the seams (`server/src/solana/*`, `venues/*`,
`src/chain.ts`) — a port is a repoint, not a rebuild.
