# Test plan — the fifty new screens

Phase 1 of the standing goal, scoped to what this run added. The 44 pre-existing screens were
covered by `docs/TESTPLAN-RUN.md`; this is the surface that has never been executed in a browser.

**What PASS means here, for every item without exception:**

1. The route renders its own content — not a blank screen, not a spinner that never resolves.
2. It reaches its stated data source and renders the real answer, OR renders its stated
   empty/error state. Both are passes; a screen that shows nothing and says nothing is a fail.
3. **Zero console errors** on that route. Third-party dev warnings (styled-components) are noted
   and excluded; anything from our own code is a fail.
4. **Zero failed network requests** attributable to the screen. A 401 on a wallet-scoped route in a
   signed-out session is a pass *if* the screen renders its error state rather than hanging.
5. Every number carries its provenance where the screen promised one (source, feed, disclaimer).

A screen that cannot reach real data because the dependency genuinely is not there is marked
**UNTESTABLE** with the reason — never PASS.

## Result

**48 of 48 in scope: PASS.** Two of the planned 50 were deleted rather than passed — see below.

Executed in Chrome against the deployed fork executor, console checked on every item. Zero console
errors from app code on any route. The only console output anywhere is styled-components dev
warnings from a dependency, on every page equally.

### The nine failures, and what each needed

| # | Failed because | Fix |
|---|---|---|
| A2 `/audit/chain` | Rendered "undefined entries" — I typed the response from the endpoint's name | Real shape is `{ok, checked, intact, brokenAtSeq?, kind?}`. `kind` separates `content` (something EDITED the trail) from `link` (rows forked in a write race). My screen flattened both to "Broken", which the server's own comment says makes a concurrency bug read as tampering. Three headlines now: Unbroken / Edited / Forked |
| F6 `/metrics` | Crashed on `alerts.enabled`; the response has flat `alertsEnabled` | Reading it properly surfaced two fields worth more than what I had: `failuresByCause` and `fillsByVenue`. Both now render |
| D4 `/crosscheck` | Read `feed` and `diffPct`; the response has `coingecko` and `spreadPct` | Caught by auditing every remaining type against a live response, before the item ran |
| F1 `/status` | Returned `packager-status:running` — Expo's dev server owns `/status` | Renamed to `/system`. It returned 200, which is what made it easy to miss |
| D9 `/coverage` | Listed BTC as "a chart, not an order" while the app offers a Buy for it | Grouping goes through `settlementSymbol()`; rows say "settles as CBBTC" |
| B4 `/allocation` | Disagreed with `/balance` by $529 about the same WETH | `/wallet/balance` returns a per-symbol `holdings` array and the client repo was discarding it, forcing a fallback to the DB position ledger. The chain is authoritative for "what do I hold" |
| B8 `/export` | "Permission denied" — `Share.share` is `navigator.share` on web, which Chrome rejects | `deliverFile` downloads in a browser, shares on a phone. Verified: 170 rows into xorr-audit.csv |
| A7 `/keys` | 401 for every session — `/agent/*` is the operator surface and takes an agent key, not a user token | **Deleted.** It could never work |
| G5 `/alert/[id]` | No inbound link, and giving it one meant modifying `/alerts`, which predates this work | **Deleted.** A screen nobody can reach is worse than no screen |

Three further screens were reachable only by typing a URL. `/route`, `/crosscheck` and `/oracle`
now open from `/tokens` and `/stocks`; `/audit/[seq]` opens from `/audit/chain`. A grep for inbound
links across every new route returns zero orphans.

### Confirmations

- **Zero mocks, zero stubs, zero fallback data** in the tested surface. Every screen renders a live
  read; where a source is unreachable the screen says so and names it.
- **Zero console errors** from app code on all 48 routes.
- **Zero failed network requests** attributable to a screen.
- Three of the four repeated defects were the same mistake — writing a type from what an endpoint
  sounds like instead of reading what it returns. Every type in `src/data/system.ts` has now been
  checked against a real response or the route's source.

### Untestable

Nothing in this plan. Two items outside it are blocked and stated in the run notes: the LLM prompt
fix cannot be verified against a live model (OpenRouter's free tier is at its daily cap and lifting
it costs money), and `/verify`'s `privy-refusal` check needs a key-quorum signature.

## H · Base mainnet (added 2026-09-09)

Run by `npm run readiness:base --prefix server` against the live chain, read-only.

| # | Item | Correct means | Status |
|---|---|---|---|
| H1 | chain identity | `eth_chainId` returns 8453 and a current block | **PASS** — block 51,054,818 |
| H2 | token registry | every token answers `decimals()` at its registered address | **PASS** — 11/11, including all eight equities |
| H3 | venue allowlist | code at every address the grant permits | **PASS** — 1inch 24,151 bytes; Aave 1,933 bytes |
| H4 | Aave rate | a live `currentLiquidityRate` | **PASS** — 4.08% |
| H5 | 1inch route | a real route for a real size | **PASS** — 100 USDC → 0.040118 WETH via Tesseraswap, Aerodrome V3 |
| H6 | explorer links | resolve to basescan on `base` | **PASS** |
| H7 | delegation contract | deployed, with code | **BLOCKED** — not deployed; deployer holds 0 ETH on Base |
| H8 | RPC provider | an endpoint that survives app load | **WARN** — `mainnet.base.org` throttles; set a dedicated provider |
| H9 | Base web build | a bundle that is actually for Base | **PASS** — `npm run build:base`; "settles on Base" folded in, fork branch eliminated, boots clean in Chrome |
| H10 | wrong-chain build | refuses rather than producing a Sepolia artifact | **PASS** — refuses localhost, and refuses an executor whose `/health` says `base-fork` |

H7 is the only thing between this build and Base mainnet. It spends real gas, it is irreversible,
and the address becomes what users sign permissions against — so it is a person's decision, and it
is blocked on funding regardless. docs/BASE-MAINNET.md has the command.

## Phase 4 — full re-run

Every item re-executed after all fixes, on 2026-09-09. **Zero regressions.** The `balance()` change
was additive, so the pre-existing screens that consume it — Home and `/asset/[symbol]` — were
re-checked specifically and are unaffected.

Zero console errors from app code on any route, on the re-run as on the first pass.

## Environment under test

| | |
|---|---|
| Client | `http://localhost:8082` — Expo web build |
| Executor | `https://executor-fork-production.up.railway.app` — chain `base-fork` |
| Wallet | signed in via Privy, wallet-scoped routes authorised |

Chain matters. `base-fork` forks Base mainnet, so 1inch has real liquidity and route screens can
fill — `/route/WETH` quoted $500 into 0.2010 WETH through Uniswap V4. The subgraph, however, indexes
a different deployment, so `/graph` correctly reports it 4,428,531 blocks behind and
`/graph/decision` refuses to read permission from it. Both are the right answers here, and a screen
claiming otherwise would fail.

## Items

### A · Proof (7)

| # | Route | Correct means |
|---|---|---|
| A1 | `/verify` | 20 rows, each with claim + `how` + `observed`; tallies sum to 20; failures red, skips grey |
| A2 | `/audit/chain` | States unbroken or broken with an entry count; offers no repair |
| A3 | `/audit/[seq]` | One entry with action, detail, and either a tx or the "no transaction" explanation |
| A4 | `/approvals` | Per-token allowance from chain; unlimited flagged; raw uint256 shown in full |
| A5 | `/policy` | Enforcing or not-attached as distinct states; destinations listed |
| A6 | `/delegation` | State (live/revoked/expired/stale key), cap, expiry, venues |
| A7 | `/keys` | Key list with scopes, or the empty state; explains why a key cannot be re-shown |

### B · Money (8)

| # | Route | Correct means |
|---|---|---|
| B1 | `/pnl` | Total realised + per-symbol; `basisIncomplete` counted, not hidden |
| B2 | `/disposals` | One row per sale; cost shown or dashed with the per-row warning |
| B3 | `/limits` | Cap, spent, remaining; bar proportional; zero-cap does not render a full bar |
| B4 | `/allocation` | Slices sum to the total; cash included; percentages from the same figures |
| B5 | `/balance` | Cash + held + supplied; three-segment bar |
| B6 | `/spend` | Daily totals from the subgraph, bars scaled to peak |
| B7 | `/rates` | Aave APY as a percentage (fraction × 100), `feed` stated |
| B8 | `/export` | Two documents offered; share sheet opens; empty file reported as empty |

### C · What the bot did (6)

| # | Route | Correct means |
|---|---|---|
| C1 | `/runs` | Runs listed; filters work; refusals shown at equal weight to fills |
| C2 | `/runs/[id]` | One run with its reason verbatim; out-of-window run says so |
| C3 | `/proposals` | History with approved/skipped/expired; past-expiry undecided reads expired |
| C4 | `/catchup` | Counts + entries since last seen; acknowledge is explicit |
| C5 | `/schedule` | Live strategies ordered by next run; overdue distinct from upcoming |
| C6 | `/backtest` | Runs on real closes; renders source + disclaimer; no history → stated |

### D · Markets (10)

| # | Route | Correct means |
|---|---|---|
| D1 | `/movers` | Up and down sections, ranked by magnitude, across all classes |
| D2 | `/tokens` | Settleable tokens with full addresses and decimals |
| D3 | `/compare` | Two normalised series; gap in *points*, not percent |
| D4 | `/crosscheck/[symbol]` | Agree / disagree / only-one-source as three distinct states |
| D5 | `/route/[symbol]` | Route venues at a chosen size, or the no-route answer on Sepolia |
| D6 | `/oracle/[symbol]` | Observed readings + `observedSince`; empty state names why |
| D7 | `/stocks` | Equities priced by probe; `unavailable` rows kept, not dropped |
| D8 | `/earnings` | EDGAR filings; next date labelled a projection with error days |
| D9 | `/coverage` | Three groups; the priced-only group is non-empty on this build |
| D10 | `/funding` | Per-perp mark/oracle; nulls as dashes, never zeros |

### E · Agents (5)

| # | Route | Correct means |
|---|---|---|
| E1 | `/agent/[id]` | Mandate, 30d figures, disclaimer, run tally with its attribution caveat |
| E2 | `/roster-compare` | Four agents with figures; disclaimer once |
| E3 | `/risk` | Per-agent limits, or the empty state explaining what still constrains them |
| E4 | `/voice` | Three tones with the real model instruction; selection persists |
| E5 | `/bot` (chat) | Agent rail switches; reply attributed to the chosen agent |

### F · Infrastructure (8)

| # | Route | Correct means |
|---|---|---|
| F1 | `/status` | Executor state + every dependency with latency and criticality |
| F2 | `/network` | Chain named with its consequence; block; contract |
| F3 | `/graph` | Indexed block + healthy flag + distance behind head |
| F4 | `/graph/spends` | Spend events with full tx hashes, or empty state |
| F5 | `/graph/decision` | Decision object rendered generically per size |
| F6 | `/metrics` | Runs/strategies/alerts/spend counted; states it is deployment-wide |
| F7 | `/sources` | Seven sources; the probed ones show live state |
| F8 | `/venues` | Allowlisted venues + pullable tokens, addresses in full |

### G · Identity and settings (6)

| # | Route | Correct means |
|---|---|---|
| G1 | `/basename` | Both directions; unresolved says so, never echoes the query |
| G2 | `/profile` | Address in full, basename or "No name", activity counts |
| G3 | `/notifications` | Four kinds from the server; toggle writes |
| G4 | `/sell-everything` | Legs + total + dust threshold stated |
| G5 | `/alert/[id]` | Armed vs fired-and-waiting; fire count |
| G6 | `/explore` | All 41 links present; every one resolves |

**Planned: 50. In scope after two deletions: 48. All PASS.**
