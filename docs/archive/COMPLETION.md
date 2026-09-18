# xorr — honest completion

100% is defined by what this project itself claims: the design handoff's 26 screens
(`ui/mobile-ui/screens.md`), the strategy ladder's 7 tiers (`src/strategies/ladder.ts`, "do not
reorder this"), the four hackathon briefs, the README's own sponsor table, and the infrastructure
the product needs to exist at all.

Measured by running it, not by reading it. A feature that exists but is mocked, stubbed or
unreachable counts as NOT done.

## First measurement — 60 of 73 items · **82%**

### A. Design surface — 26 of 26 ✓
All 26 screens in `screens.md` are implemented across 41 routes, and all 47 routes passed a real
browser sweep with console and network checked on each: zero errors from this codebase, zero failed
requests.

### B. Strategy ladder — 3 of 7
| Tier | Kind | Available in UI | Executor |
|---|---|---|---|
| 1 Recurring buy | `dca` | yes | **yes** |
| 2 Rebalance | `rebalance` | yes | **yes** |
| 3 Take profit / stop loss | `exit-rules` | yes | **yes** |
| 4 Idle cash to yield | `yield-rotation` | no | no |
| 5 Range accumulation | `grid` | no | no |
| 6 Momentum | `momentum` | no | no |
| 7 Events and earnings | `event-driven` | no | no |

Tiers 4–7 are honestly marked unavailable, so nothing in the UI lies — but they are four sevenths
of the ladder the product is built around.

### C. Sponsor requirements — 9 of 10
Privy auth, Privy embedded wallet as on-chain owner, 1inch aggregator routing and execution, Aqua
official contracts, Aqua on-chain token movement, SwapVM, the delegation subgraph, and Base-native
settlement all verified. **The Aqua subgraph is built and pinned but not deployed.**

### D. Infrastructure — 4 of 10
| Item | Status |
|---|---|
| Real persisted Postgres | ✓ 12 tables, live rows |
| `XorrDelegation` on a public chain | ✓ Base Sepolia, 14,317 bytes |
| Delegation subgraph deployed and synced | ✓ |
| Scheduler runs unattended | ✓ `[scheduler] scheduler proof: filled` |
| `XorrAquaBook` on a public chain | ✗ fork only — Aqua is Base-mainnet-only |
| `XorrSwapVMBook` on a public chain | ✗ same |
| Aqua subgraph deployed | ✗ needs a Studio slug |
| Executor reachable off localhost | ✗ |
| Native iOS build runs | ✗ |
| Native Android build runs | ✗ never attempted |

### E. Integrations — 11 of 12
Privy, 1inch quote, 1inch execution, Aqua, SwapVM, the delegation index, CoinGecko, Aave v3, the
RSS briefing and the Ondo equities all verified live. **The Graph composition is partial**: the
join is written and exercised, but the second index is unreachable, so every route resolves to the
aggregator and says so.

### F. Core product claims — 7 of 8
Non-custodial, the on-chain daily cap, expiry, the venue allowlist, the kill switch working without
the server, every price real or labelled, and the scheduler trading unattended — all verified.

**"The bot interrupts you when it matters" is not wired.** `src/notifications/register()` exists
and is called by no screen, so no device ever registers; `server/src/notifications/push.ts::send()`
exists and fires only from `/notify/test`, never from a fill, a block or a stop. The Inbox screen
and the whole of the design's screen 18 are built around an event path that does not connect.

---

# Second measurement — 63 of 74 items · **85%**

Measured the same way: by running each item, on the same day, after closing the gaps below. The
denominator moved from 73 to 74 because one item split in two — the notification path being *wired*
and a notification actually *landing on a handset* turned out to be different questions with
different answers, and collapsing them would have let a credential gap hide inside a code claim.

## What changed

### Tier 4 shipped — the ladder is 4 of 7
`yield-rotation` now has a planner, an executor branch, a venue, a setup screen, and `available:
true` in the ladder — in that order, because the rule this project set for itself is that a tier
with a screen and no executor is worse than no tier at all.

Idle USDC is supplied to **real Aave v3 on Base** through the same `XorrDelegation.spend()` as every
other trade: same daily cap, same expiry, same venue allowlist. The aToken goes straight to the
user, because `supply()` takes the recipient as an argument — which is the only reason a lending
pool can live inside a non-custodial permission at all.

Proved by running it, at three levels:

| Level | Where | Result |
|---|---|---|
| Contract | `server/src/fork-yield.ts` | 18/18 on a Base mainnet fork, stable over 12 consecutive runs |
| Executor | `server/src/fork-tier4.ts` | 11/11 — real strategy row, real planner, real fill, real books |
| API | `tools/qa-api.mjs` B23–B28 | 6/6, and the whole B section is 28/28 |

The assertions that matter are the negative ones. A supply past the cap reverts. The identical
calldata to a venue the user did not grant is refused before any money moves. **The bot cannot
withdraw** — the first version of that test routed the exit through `closePosition` and reverted,
and the right fix was not to add an aToken approval but to notice what the revert was saying:
burning your own aTokens needs nobody's permission, so the exit is the user's alone and the bot's
tier-4 power is supply-only. The setup screen says so in its footer.

### The app runs natively on Android
Never attempted before this session, and it found three bugs that **cannot occur on web**:

- **`jose` resolved its Node build under React Native** — `Unable to resolve module zlib`. The
  package publishes a WebCrypto `browser` entry, but Metro's default export conditions are
  `require`/`import`, so it took the one that imports `zlib`. Fixed with the repo's first
  `metro.config.js`.
- **Privy's polyfills were never installed.** `Property 'crypto' doesn't exist`, thrown at import
  time before a screen mounted. `main` now points at an `index.js` that imports
  `react-native-get-random-values`, `fast-text-encoding` and `@ethersproject/shims` first.
- **`motionDuration` was called across the worklet boundary.** Every `useAnimatedStyle` in the
  design system called it, and its body runs on the UI runtime — a cross-runtime call
  react-native-worklets refuses outright. One `'worklet'` directive fixed all of them.

A real Privy embedded wallet is now created **on the device**, and the home screen shows live prices
and the live Aave rate. Screenshots are in the README.

### Notifications are wired end to end
`useRegisterDevice` is mounted in `app/_layout.tsx` and registers once per wallet per launch;
`send()` fires from the executor's fill path and from `finishBlocked`. Both branches reach Expo's
real push API with real content. On the emulator, registration fails with a precise, honest message
— *"Unable to get Firebase Messaging instance"* — and now says so in the log instead of dropping the
result into state nothing rendered.

### Bugs found and fixed along the way
| | |
|---|---|
| **Gas estimates were short by ~3% on lending calls** | An Aave withdraw estimated 172,488 and used 177,503: interest accrues between the estimate and the mine and writes a slot the estimate never priced. It failed one run in three while `eth_call` succeeded every time — the signature of running out of gas, not of reverting. `spendAsDelegate` and `closeAsDelegate` now carry 30% head-room. Unused gas is refunded; an out-of-gas revert looks exactly like a venue refusing a trade and tells the user nothing true. |
| **The venue allowlist was two literals that had already drifted** | The grant asked for one venue and the safety screen displayed a hardcoded list. `SETTLEMENT_VENUES` is now the single source for both, and `/delegation` asks the **chain** what the user actually allowed rather than reciting what we would have asked for. |
| **Supplied money vanished from the portfolio total** | `totalValueUsd` summed cash and holdings, and an aToken is neither — so a sweep read as a loss of exactly the amount swept. `suppliedUsd()` reads the aToken from the live reserve, and B24 now asserts the invariant: cash + supplied + holdings must equal the total. |
| **Unrunnable strategy kinds were accepted at creation** | `kind: 'grid'` created a strategy that looked live and was blocked at every single run. Now refused at the API boundary with the runnable kinds named, while someone is still there to read it. |
| **A test warped the shared fork clock a year into the future** | `evm_increaseTime` is not scoped to the script that calls it; every policy granted against wall-clock time instantly read as expired. Snapshot/revert now brackets the warp, and both fork scripts take their expiry from `block.timestamp` rather than `Date.now()` — the reference frame the contract actually compares against. |

## Where it stands — 63 of 74

| | Done | Total |
|---|---|---|
| A. Design surface — 26 screens, 48 routes, console and network clean on every one | 26 | 26 |
| B. Strategy ladder | **4** | 7 |
| C. Sponsor requirements | 9 | 10 |
| D. Infrastructure | **5** | 11 |
| E. Integrations | 11 | 12 |
| F. Core product claims | **8** | 8 |
| | **63** | **74** |

51 contract tests pass against a Base mainnet fork. 149 unit tests pass. 48/48 routes render with
zero console errors and zero failed requests. 28/28 API checks pass.

## The 11 that are not done, and why

**Three are the ladder's top rungs.** Tiers 5–7 (`grid`, `momentum`, `event-driven`) are not built.
They are honestly marked `available: false`, so nothing in the UI claims otherwise — but they are
three sevenths of the ladder the product is organised around. This is the largest remaining gap and
it is a build, not a blocker.

**Four need something that costs real money or a click I cannot make:**

| Item | Why |
|---|---|
| `XorrAquaBook` on a public chain | Aqua exists only on Base **mainnet**. Deploying means spending real ETH. |
| `XorrSwapVMBook` on a public chain | Same. |
| Aqua subgraph deployed | Builds and uploads to IPFS cleanly (`QmctadHCDBprb9Q1Pq4oyMXjB6KcnUDHRheDRNyBA59tAJ`), then fails with *"Subgraph not found"* — the Studio slug must be created in the dashboard, and no API exposes that to a deploy key. It cannot be folded into the existing `xorr` subgraph either: that one indexes `base-sepolia` and this one indexes `base`, and a subgraph indexes one network. |
| Executor reachable off localhost | Railway is billable. |

**Two need a credential that does not exist in this repo:**

| Item | Why |
|---|---|
| Push delivered to a real handset | Needs a Firebase `google-services.json`. The path above it is verified: registration runs, `send()` fires on fills and blocks, and Expo's API answers. |
| Native iOS build runs | No Xcode on this machine — `xcrun simctl` exits 72. The Android build proves the native path; iOS is unverified and is not claimed. |

**Two are partial and say so:**

| Item | Why |
|---|---|
| The Graph composition | The join is written and exercised, but the second index is unreachable, so every route resolves to the aggregator — and the decision says which index it could not consult rather than pretending it did. |
| Sponsor: Aqua index | The same missing slug, counted once here and once above. |

## What 85% means

The product works. A user signs in with Privy, gets an embedded wallet, grants a capped and expiring
on-chain permission, and a scheduler trades inside it unattended — four strategy tiers, real 1inch
routing, real Aave supply, real Aqua and SwapVM books, every price live or labelled, and a kill
switch that works without the server. That is the whole thesis, and it runs.

The missing 15% is three unbuilt strategy tiers and six deployment steps that need money, a
dashboard click, or hardware. None of it is mocked, stubbed, or hidden — which was the point of
counting this way.

---

# Re-measured 2026-09-07 (second pass)

100% is still defined by the project's own claims: the design handoff's 26 screens, the strategy
ladder's 7 tiers ("do not reorder this"), the README's sponsor table, and the infrastructure the
product needs to exist. Measured by running it. A feature that exists but is mocked, stubbed or
unreachable counts as NOT done.

**46 items. 40 verified. 87%.** (Before this pass: 39 of 46 — **85%**.)

## What moved

**Ladder tier 6 — momentum — built and verified on chain.** It was `available: false` with no
planner. It is now a Donchian breakout with a trend filter and a stop attached at entry, plus the
exit side that acts on that stop. Verified with real transactions on the rebuilt fork: bought
0.0238 WETH (`0xc4b42021…`), and the stop sold exactly that position (`0x6bfe5de2…`) with the
activity log reading *"WETH fell to 2509.76, through the 2600.00 stop set when this entry opened."*
The UI now offers it; tier 7 still correctly reads "Later".

## What was verified this pass, not assumed

All five previously-available tiers were re-run end to end on the fork, and three that answered
`nothing_to_do` were re-tested with conditions forced, so a polite decline could not hide a broken
planner:

| Tier | Kind | Transaction |
|---|---|---|
| 1 | dca | `0x2de21ca5…` 0.01596 WETH @ $2,507.64 |
| 2 | rebalance | `0x8f0f25b3…` 0.03176 WETH |
| 3 | exit-rules | `0x0148bcf5…` 0.07967 WETH, plus the trailing stop `0x47db5129…` |
| 4 | yield-rotation | `0x8c78a442…` 100 USDC supplied to Aave |
| 5 | grid | `0x9164bfe5…` 0.01198 WETH @ $2,507.79 |
| 6 | momentum | `0x6bfe5de2…` stop fired |

Tiers 6 and 7 were refused by the API before this pass with `"not runnable yet"` — honest, and now
only true of tier 7.

**Mock sweep:** 8 hits in shipped code, every one prose *disclaiming* a mock ("Not a mock: market
data is REAL…", "NOT a silent fallback to fake personality") plus one Node shim used only by unit
tests. Zero mocked data, zero stubbed logic, zero TODOs.

**Fixtures:** `local.ts` imports four. All are catalogues — instruments, personas, alert types,
portfolio sleeves — with live data merged over them and invented metrics explicitly stripped when
the server is unreachable. None stands in for saved state.

**Database:** Postgres, real and durable — it survived a full fork rebuild today with the audit
trail intact at 66 entries.

## The six that are not done

| # | Item | Why |
|---|---|---|
| 1 | **Ladder tier 7 — event-driven** | Not built. No planner. Honestly marked "Later" and refused by the API. The last tier by the ladder's own ordering: *"most judgement, most ways to be wrong."* |
| 2 | **Privy policy attached to the user's embedded wallet** | **Platform constraint.** Privy requires the wallet's *owner* to authorise it, and for an embedded wallet the owner is the user, not the app. The policy exists, is owned by a key quorum, and its refusal is proven — it simply cannot be attached server-side, and `/safety` says so. |
| 3 | **1inch SwapVM wired into the product** | Contract written, deployed, 10 fork tests — and the running executor never calls it. Aqua is the wired venue. The README's status now says "Contract only" rather than "Done", because "Done" reads as "the app uses it". |
| 4 | **The Graph — second subgraph queried** | **Blocked on a dashboard action.** `subgraph-aqua/` is built and IPFS-pinned; the `xorr-aqua` Studio slug was never created, and `subgraph_create` is not exposed by the deploy API (`Method not found`). Creating it needs Subgraph Studio in a browser with the deployer wallet. |
| 5 | **Audit chain unbroken on Base Sepolia** | **Permanent by design.** A fork at entry 2 from a race fixed before this run. The trail is append-only by trigger and cannot be rewritten to look clean — which is the property it exists for. The rebuilt fork's chain is unbroken across 66 entries. |
| 6 | **LLM agent voice** | **Missing credential.** `OPENROUTER_API_KEY` is not set anywhere in the repo. `/bot/say` answers honestly rather than pretending: `{"source":"fallback","reason":"no_key","detail":"OPENROUTER_API_KEY is not set."}` and the facts half of every message is rendered from real records by code regardless. |

Three of the six are blocked by something outside the code: a Privy platform rule, a Studio
dashboard action, and a credential that does not exist. Two are deliberate design outcomes. One —
tier 7 — is genuinely unbuilt.

## Re-measured after the change

| Check | Result |
|---|---|
| Screen sweep | 54/54 |
| Browser sweep, 47 routes | zero console errors, zero failed requests |
| Fork `/verify` | **18 pass / 0 fail / 0 skip** |
| Sepolia `/verify` | 15 pass / 1 fail / 2 skip |
| Client tests | 302 |
| Server tests | 119 |
| Typecheck | clean, both projects |

---

# Re-measured 2026-09-07 (third pass) — tier 7

**47 items. 41 verified. 87%.**

The checklist gained an item this pass rather than losing one, because building tier 7 exposed a
claim the project had been making and I had never measured. The prior number was optimistic on the
same basis: **40 of 47 — 85%**, not the 87% reported against a 46-item list.

## Tier 7 — events and earnings — built

The ladder is now 7 of 7. The design was settled against the project's own texts before any code:
*"positions around scheduled events, and flattens before the print"*, run by a persona that is
*"pedantic and calendar-driven… slightly weary of people who trade into prints."* So it buys the
run-up and is unconditionally flat when the print lands. The judgement the ladder warns about lives
in the entry; the exit is a promise, so it is uncapped, sells the **whole** holding in the symbol,
and fires even when the calendar has failed.

**The calendar is SEC EDGAR** — free, no key, and the authoritative record rather than a vendor's
copy. A company announcing results files an 8-K with Item 2.02 on the day it reports, so the filing
history is the past calendar, exactly dated. Two things the raw data does, both found by reading it:

- **Not every Item 2.02 is an earnings print.** Tesla files one for deliveries too, so its raw gaps
  read `[20, 71, 20, 64, 26, 72]` and a median of those projects six weeks wrong. Filings closer
  than 60 days are one quarter; TSLA then reads `[91, 84, 98, 91, 92]` like everyone else.
- **Not every filer is quarterly.** A median outside 80–100 days is a pattern this code does not
  understand, and it projects nothing rather than guessing.

Verified live against all eight equities: every one maps to a CIK from the SEC's own ticker file and
resolves to a 90–91 day median. The flatten margin is each company's **own** observed cadence error
— NVIDIA ±7 days, GOOGL ±11, Apple and Meta ±0 — so the number comes from the filings rather than
from me. A user who knows the real date pins it, and then there is no margin to add.

21 tests. Tier 7 proposes rather than executes, because `requiresApprovalByDefault` is already true
for tier ≥ 6.

## Three real bugs found by running it

1. **The executor could not price a single tokenized equity.** `priceOf` keys into CoinGecko's id
   table, which has no equities, so it threw `No price feed for NVDAc` — and with it went sizing,
   cap-checking and recording for every equity trade. `/market/stocks` had the number all along;
   the derivation lived inside a route handler where only the UI could reach it. Extracted.
2. **Two more places the lowercase `c` was normalised away.** `isStock` compared case-sensitively
   and `/price/:symbol` uppercased its parameter, so `/price/NVDAc` answered
   `{"error":"No price feed for NVDAC"}` for an asset on the app's own markets screen. The route
   also hardcoded `source: 'coingecko'`, false for eight symbols.
3. **An equity price quoted itself to death.** Mine, from fix 1: the probe quote computed its price
   impact, which prices both legs with `priceOf`, which came back to the probe. The deployed fork
   executor reached a 2GB heap and died fifty seconds after boot — `FATAL ERROR: Ineffective
   mark-compacts near heap limit` — and 502'd until rolled forward. Found by watching the deploy,
   not by the tests, which passed throughout.

## The new item: equity fills

`/price/NVDAc` now returns `{"price":232.99,"source":"1inch"}` and tier 7's entry reaches the venue
with a real route. The fill then reverts with `TF`.

A plain DCA into NVDAc **fails identically**, which is the control that matters: this is not a tier 7
defect, it is that no tokenized equity currently fills on the fork, for any strategy. Same family as
the aggregator drift — the route is computed against live Base state and executed against the fork's,
and a thin equity pool is far more sensitive to that than WETH. The README's claim that
*"Buy $250 of NVDA is the same code path as Buy $250 of WETH"* is true of the code and not yet true
of the outcome.

So tier 7 is counted as built — its logic verified by 21 tests, its calendar by live SEC data, its
entry by reaching the venue — and the equity fill is counted as its own open item rather than folded
into it.

## The six that remained — five now

| # | Item | Why |
|---|---|---|
| 1 | **Equity fills** | Quote and price are real; the fill reverts `TF` on the fork for every strategy, not just tier 7. Environmental, and newly measured rather than newly broken. |
| 2 | Privy policy on the user's embedded wallet | Platform constraint — Privy requires the wallet's owner to authorise, and that is the user. |
| 3 | ~~1inch SwapVM wired into the product~~ | **CLOSED 2026-09-10.** Two real fills. A maker's program shipped to official Aqua under the SwapVM router, discovered by `openPrograms()`, filled through `XorrDelegation.spend()` — `0x2a20ebbd…`. What blocked it was log-range paging, not the contract; see SPONSOR-AUDIT Finding 2. |
| 4 | The Graph — second subgraph queried | Blocked on a Studio dashboard action; `subgraph_create` is not in the deploy API. |
| 5 | Audit chain unbroken on Base Sepolia | Permanent by design — append-only, so it cannot be rewritten to look clean. |
| 6 | LLM agent voice | `OPENROUTER_API_KEY` exists nowhere. `/bot/say` reports `{"source":"none","reason":"no_key"}` and every surface refuses honestly rather than printing a canned line. Still UNTESTABLE, not failed. |

## Re-measured whole

| Check | Result |
|---|---|
| Fork `/verify` | **18 pass / 0 fail / 0 skip** |
| Sepolia `/verify` | 15 pass / 1 fail / 2 skip |
| Client tests | 330 |
| Server tests | 147 |
| Typecheck | clean, both projects |

---

# Re-measured 2026-09-15 — against what the project claims

A fresh definition of done, taken from what the project says about itself: the README (what is real, the sponsor
table, the strategy ladder, when it goes wrong), `docs/SUBMISSION.md`, PLAN.md §1's seven bars and sponsor tracks, and
the screens a person uses. An item counts only when it was verified live on 2026-09-15 — run against a deployment,
read from a chain, or driven on a screen — never because the code for it exists. Deployed while measuring: both
executors at `8ffa5cd`, the web at `75fa4a5` (executors moving to `75fa4a5`).

The keyword sweep (mock, stub, TODO, FIXME, fake, dummy, placeholder, simulated, hardcoded, not implemented) finds no
stand-in logic in shipped code: every hit is a comment about a removed mock, a word in another sense (`nothingToDo`, a
setup step's `todo` state, "Never mock the user"), the `Placeholder` loading skeleton, an input's placeholder text, or
test support. The design fixtures are imported by no production file. One dead branch remains: `app/rates.tsx` can
print "Simulated here" for a feed the executor never sends (it answers an unreadable rate with `503 rate_unavailable`).

## First measurement — 40 of 76 · **53%**

| # | Item | How it was verified | State |
|---|---|---|---|
| **A** | **The permission contract** | | **9 of 9** |
| A1 | `XorrDelegation` deployed on Base Sepolia | `eth_getCode`: 5,207 bytes at `0x6c55…540e` (`tools/prove-contract-refusals.ts`) | ✓ |
| A2 | Its source is verified | Sourcify v2: `exact_match` for creation and runtime | ✓ |
| A3 | The daily cap is enforced on chain | C04: `DailyCapExceeded(requested, remaining)` on both chains | ✓ |
| A4 | Only allowlisted venues | C05: `VenueNotAllowed(0x…dEaD)` on both chains | ✓ |
| A5 | The permission expires on its own | C06: `PolicyExpired` a minute past expiry, on copies of both chains | ✓ |
| A6 | Only the bot's delegate can spend | C07: `NotDelegate` on both chains | ✓ |
| A7 | The owner's revoke stops spends and closes, with no server | C06, C09: `PolicyRevoked` after `revoke()`; C08 without the executor | ✓ |
| A8 | Bought tokens can only reach the owner | `forge test` fork suites on the verified source (74/74), `OutputNotReceived` | ✓ |
| A9 | A real embedded wallet signed a grant on a public chain | Receipt of `0xce90642d…`: status 1, from the owner's wallet to the contract | ✓ |
| **B** | **The audit trail** | | **3 of 3** |
| B1 | Every row commits to the one before | `/activity/verify` on both executors: no new link break | ✓ |
| B2 | Its head is published to Base, unattended | Anchors at 23:20 UTC (fork, entry 655) and 23:27 UTC (Sepolia, entry 383) | ✓ |
| B3 | What Base holds is what `/audit/anchor` shows | C11: equal on both chains; a lower count reverts `CountWentBackwards` | ✓ |
| **C** | **Anyone can check it** | | **0 of 2** |
| C1 | `/verify` passes all but its one stated failure | Fork 19/1/1, Sepolia 18/2/1: the subgraph row fails on both (The Graph answers the executors 429) | ✗ |
| C2 | `/judge` runs on the web, signed out | Not run this pass | ✗ |
| **D** | **Privy** | | **2 of 5** |
| D1 | An embedded wallet signs real transactions | A9's grant; the signed-in simulator session | ✓ |
| D2 | A Privy policy owned by a key quorum refuses a forbidden send | `/verify` `privy-policy` and `privy-refusal` pass on both executors | ✓ |
| D3 | Approvals and revoke signed in Privy's dialogs, from the app | Not run this pass (the Mac's screen is locked, so no taps) | ✗ |
| D4 | A completed financial flow: a transfer or withdrawal the embedded wallet signs | None on record; SUBMISSION says the flow is built | ✗ |
| D5 | A written, working business workflow (Privy B2B track) | Not present (PLAN X52) | ✗ |
| **E** | **1inch** | | **7 of 7** |
| E1 | Aggregator quotes and fills through the permission | E187 on both; `/metrics` 53 fills under `1inch` | ✓ |
| E2 | `XorrAquaBook` fills on official Aqua | `/metrics` 8 fills under `aqua` | ✓ |
| E3 | `XorrSwapVMBook` fills through the SwapVM router | `/metrics` 12 fills under `swapvm` | ✓ |
| E4 | Every venue priced for one trade | E165 on both executors | ✓ |
| E5 | Limit orders | `/limit-orders` checks pass on both | ✓ |
| E6 | Cross-chain quotes | E061: 100 USDC → 99.900124 on Arbitrum | ✓ |
| E7 | Token list, balances and logos | E106 and the `/tokens` checks | ✓ |
| **F** | **The Graph** | | **1 of 3** |
| F1 | The delegation subgraph is deployed and synced | Direct query: block 46,829,712, no indexing errors | ✓ |
| F2 | The executor reads it before it acts | Both executors are refused with 429 and holding | ✗ |
| F3 | The Aqua subgraph is deployed and joined to it | Built and pinned, never deployed (no Studio slug) | ✗ |
| **G** | **Aave** | | **1 of 1** |
| G1 | Tier 4 supplies idle USDC through the permission | 2 filled `yield-rotation` runs on the fork | ✓ |
| **H** | **Base** | | **1 of 2** |
| H1 | Basenames resolve | `/basename` checks pass; a bad address is a named 400 | ✓ |
| H2 | Real transactions on Base mainnet (Base Build Camp) | None: mainnet is outside what this run may do | ✗ |
| **I** | **The strategy ladder, filled on the fork** | | **6 of 7** |
| I1 | 1 · Recurring buy | 37 fills | ✓ |
| I2 | 2 · Rebalance | 4 fills | ✓ |
| I3 | 3 · Take profit / stop loss | 2 fills | ✓ |
| I4 | 4 · Idle cash to yield | 2 fills | ✓ |
| I5 | 5 · Range accumulation | 1 fill | ✓ |
| I6 | 6 · Momentum | 1 fill | ✓ |
| I7 | 7 · Events and earnings | 0 fills in 134 runs: its five strategies trade NVDAc, which does not function on a fork | ✗ |
| **J** | **The app, as a person uses it — end to end on a screen** | | **1 of 18** |
| J1 | Sign in and get a wallet | Not run: a sign-in code is the owner's to type | ✗ |
| J2 | Fund: test funds arrive, the balance rises | Not run | ✗ |
| J3 | Grant the permission from the app | Not run | ✗ |
| J4 | Stop all trading, then resume | Not run | ✗ |
| J5 | Create a recurring buy that runs and fills | Not run on a screen | ✗ |
| J6 | Buy and sell from the order ticket | Not run on a screen (the ticket's quote loads, S031) | ✗ |
| J7 | Swap | Not run on a screen | ✗ |
| J8 | Sell everything | Not run | ✗ |
| J9 | Withdraw to an allowlisted address | Not run | ✗ |
| J10 | Alerts | Not run on a screen | ✗ |
| J11 | Proposals: approve, skip | Not run on a screen | ✗ |
| J12 | Agents: hire, backtest | Partly (F23 on the simulator) | ✗ |
| J13 | Markets, asset, chart ranges | Partly: loads on the web signed out; range pills not driven | ✗ |
| J14 | Portfolio: total and graph | F19: the graph dips to $0 once (the fork's rebuild, in its data) | ✗ |
| J15 | Messages drawer | Partly: picker, shortcuts and the drawer's return not driven | ✗ |
| J16 | Networks: every network and what works on it | Web controls driven in Chrome; native load | ✓ |
| J17 | Settings and version | Partly: web signed out shows the version | ✗ |
| J18 | Recovery and key export | Partly | ✗ |
| **K** | **Infrastructure** | | **6 of 10** |
| K1 | Postgres persists through a restart | 157 + 52 strategies unchanged across the 35556a1 restart | ✓ |
| K2 | Every table copied to MongoDB Atlas | 23 tables in each database, synced 23:34–23:35 UTC | ✓ |
| K3 | Both executors deployed, reporting their commit | `/health` version on both | ✓ |
| K4 | Web app on Vercel, every route 200, security headers | 103 routes loaded; the five headers | ✓ |
| K5 | Landing page correct | FAIL: only HSTS, and "Built on Base" copy (`landing/` is the owner's) | ✗ |
| K6 | CI green on every push | GitHub Actions: every push today `success` | ✓ |
| K7 | The iOS app runs | Simulator, Metro, fork executor | ✓ |
| K8 | The Android app builds and runs | Not run this pass | ✗ |
| K9 | Push notifications arrive | No EAS project id exists | ✗ |
| K10 | The agents speak through a language model | No `OPENROUTER_API_KEY` exists | ✗ |
| **L** | **Quality** | | **3 of 6** |
| L1 | Every endpoint check passes on both executors | 218/221 and 217/221 at 35556a1: the subgraph 429 | ✗ |
| L2 | Every web route with no console error or failed request | A chart's draw-in logged a negative width (fix shipping) | ✗ |
| L3 | Unit tests | App 1,588 · executor 886 | ✓ |
| L4 | Contract tests | `forge test` 74/74 | ✓ |
| L5 | Live tests pass against the deployments | `npm run test:live` not run against them | ✗ |
| L6 | No stand-in logic or data in shipped code | Keyword sweep and fixture imports, above | ✓ |
| **M** | **Documentation and submission** | | **0 of 3** |
| M1 | README and SUBMISSION figures match the deployments | Stale: fills 36/7/4 (now 53/8/12), `/verify` 19·1·1, 547 tests, 101 routes, "fills from tiers 1 through 7" | ✗ |
| M2 | The demo shows a real fill (bar 7) | 91 s, no fill | ✗ |
| M3 | SECURITY and RUNBOOK describe this design | `SECURITY.md` still cites `server/src/solana/delegation.ts` | ✗ |

---

## Final measurement — 65 of 76 · **86%**

Measured again from the top after closing gaps, every item the way the first pass measured it, on 2026-09-15 between
01:15 and 02:41 UTC. The executors ran `05bbad1` and, after the last ship, `b01c85b` — the same executor code, since
nothing under `server/` but a live test changed between them — and the web ran `b01c85b` for its final QA and sweep. The
Android and iOS apps ran from Metro on the tree that became `b01c85b`, the Android one signed in as a Privy test account
against the fork executor; every flow below was read back from the chain, not taken from the screen alone.

M2 was recorded afterwards, from 03:02 to 03:09 UTC, and the fork's clock was set to real time at 02:58 UTC; both are
in the rows below.

The keyword sweep finds the same classes as before and nothing new: the setup step's `todo` state, the `Placeholder`
loading component, comments saying a thing is not a mock or cannot be faked, "Never mock the user", and
`src/test/react-native-stub.ts`, which is test support. The dead "Simulated here" branch is gone (56a0836).

| # | Item | How it was verified | State |
|---|---|---|---|
| **A** | **The permission contract** | | **9 of 9** |
| A1 | `XorrDelegation` deployed on Base Sepolia | `eth_getCode`: 5,207 bytes at `0x6c55…540e` | ✓ |
| A2 | Its source is verified | Sourcify v2: `exact_match` for creation and runtime | ✓ |
| A3 | The daily cap is enforced on chain | `tools/prove-contract-refusals.ts`: one unit over what is left reverts `DailyCapExceeded(2131000001, 2131000000)` on the fork and `(1600000001, 1600000000)` on Sepolia | ✓ |
| A4 | Only allowlisted venues | `VenueNotAllowed(0x…dEaD)` on both chains | ✓ |
| A5 | The permission expires on its own | On fresh local copies of both chains a minute past expiry, a spend reverts `PolicyExpired()` with nothing revoked | ✓ |
| A6 | Only the bot's delegate can spend | `NotDelegate()` on both chains | ✓ |
| A7 | The owner's revoke stops spends and closes, with no server | On local copies of both chains, after `revoke()` a spend and a close both revert `PolicyRevoked()` and nothing is left of the day's cap; on a screen, Safety's held stop signed `revoke()` from the Android wallet and the contract read nothing left to spend | ✓ |
| A8 | Bought tokens can only reach the owner | `forge test`: 74 of 74, the fork suites included (`OutputNotReceived`) | ✓ |
| A9 | A real embedded wallet signed a grant on a public chain | Receipt of `0xce90642d…`: status 1, from the owner's wallet to the contract | ✓ |
| **B** | **The audit trail** | | **3 of 3** |
| B1 | Every row commits to the one before | `/verify`'s audit-chain row: intact on the fork; on Sepolia the stated break at entry 2 and none since | ✓ |
| B2 | Its head is published to Base, unattended | `/audit/anchor`: fork entry 799 at 01:37 UTC, Sepolia entry 433 at 01:43 UTC, both signed by the bot's key | ✓ |
| B3 | What Base holds is what `/audit/anchor` shows | The anchor on chain is the one `/audit/anchor` shows on both (fork entry 799 of 20 anchors, Sepolia 433 of 36); a lower count reverts `CountWentBackwards`, an empty head `EmptyHead` | ✓ |
| **C** | **Anyone can check it** | | **2 of 2** |
| C1 | `/verify` passes all but its one stated failure | `?owner=` the demo wallet: fork 20 pass · 0 fail · 1 skip (equities); Sepolia 19 · 1 · 1, the break at entry 2. At 02:32 UTC Sepolia's `oneinch` row failed as well — 1inch's API was answering 500, "gas price oracle failed", to this Mac too | ✓ |
| C2 | `/judge` runs on the web, signed out | Headless Chromium on `app.xorr.finance/judge`: "14/21 claims verified", the 7 wallet checks skipped with a reason each, no console errors | ✓ |
| **D** | **Privy** | | **4 of 5** |
| D1 | An embedded wallet signs real transactions | The Android build's Privy wallet signed six transactions on the fork, nonce 0 → 6: three approvals and a grant, a revoke, a new grant | ✓ |
| D2 | A Privy policy owned by a key quorum refuses a forbidden send | `/verify` `privy-policy` and `privy-refusal` among the passes on both executors | ✓ |
| D3 | Approvals and revoke signed in Privy's dialogs, from the app | From the Android app: the permission's four signatures, the stop's revoke and the resume's grant, each read back from the contract. The native SDK signs with no dialog on screen | ✓ |
| D4 | A completed financial flow: a transfer or withdrawal the embedded wallet signs | Read from the fork: a 5 USDC withdrawal to the owner, `0xe196391b…` (block 51,242,365), a type-2 transaction from the Privy wallet `0x7882…c36a` with its own signature (not an impersonated send), signed through the app's fork-signing path; status 1 | ✓ |
| D5 | A written, working business workflow (Privy B2B track) | Not built (PLAN.md X52, 4.14) | ✗ |
| **E** | **1inch** | | **7 of 7** |
| E1 | Aggregator quotes and fills through the permission | QA E187 on both, at 05bbad1 and at b01c85b (on Sepolia after a first run met 1inch answering 500); `/metrics` 93 fills under `1inch`; the Android order ticket, swap and approve filled through it | ✓ |
| E2 | `XorrAquaBook` fills on official Aqua | `/metrics` 9 fills under `aqua`, one of them today | ✓ |
| E3 | `XorrSwapVMBook` fills through the SwapVM router | `/metrics` 21 fills under `swapvm`; `swapvm-settle` live 3/3 against the fork: a buy settled through a fresh maker program shipped on official Aqua (tx `0x595e5703…`), and was sold back | ✓ |
| E4 | Every venue priced for one trade | QA E165 on both | ✓ |
| E5 | Limit orders | QA's `/limit-orders` checks on both; 1 fill under `lop` | ✓ |
| E6 | Cross-chain quotes | QA E061: 100 USDC → 99.88 on Arbitrum | ✓ |
| E7 | Token list, balances and logos | QA E106 and the `/tokens` checks | ✓ |
| **F** | **The Graph** | | **2 of 3** |
| F1 | The delegation subgraph is deployed and synced | Direct query: block 46,834,636 with the chain at 46,834,638, no indexing errors | ✓ |
| F2 | The executor reads it before it acts | Once The Graph lifted its 429: `/verify`'s subgraph row and QA's subgraph checks pass on both | ✓ |
| F3 | The Aqua subgraph is deployed and joined to it | Built and uploaded (`QmctadHC…`); Studio answered `Subgraph not found` to a deploy with the project's key, because the slug is created in Studio's dashboard by the wallet that owns the account | ✗ |
| **G** | **Aave** | | **1 of 1** |
| G1 | Tier 4 supplies idle USDC through the permission | `/metrics` 2 supplies under `aave` | ✓ |
| **H** | **Base** | | **1 of 2** |
| H1 | Basenames resolve | QA's `/basename` checks on both | ✓ |
| H2 | Real transactions on Base mainnet (Base Build Camp) | None: mainnet spends real money, outside what this run may do | ✗ |
| **I** | **The strategy ladder, filled on the fork** | | **6 of 7** |
| I1 | 1 · Recurring buy | 43 filled `dca` runs in the demo wallet's `/runs`, and the Android app's $20 | ✓ |
| I2 | 2 · Rebalance | 10 filled, a partial sale through the planner among them; and the Android onboarding rebalance's $275 | ✓ |
| I3 | 3 · Take profit / stop loss | 2 filled `exit-rules` runs: a ladder exit and a trailing 5% stop that breached | ✓ |
| I4 | 4 · Idle cash to yield | 2 filled `yield-rotation` supplies to Aave | ✓ |
| I5 | 5 · Range accumulation | 1 filled grid rung | ✓ |
| I6 | 6 · Momentum | 1 filled momentum entry | ✓ |
| I7 | 7 · Events and earnings | 0 fills in its 5 runs on the demo wallet: its strategies trade tokenized equities, which do not function on a fork | ✗ |
| **J** | **The app, as a person uses it — end to end on a screen** | | **15 of 18** |
| J1 | Sign in and get a wallet | Not run: a sign-in code is the owner's to type | ✗ |
| J2 | Fund: test funds arrive, the balance rises | Android: 1,000 USDC and 0.05 ETH arrived, read on chain | ✓ |
| J3 | Grant the permission from the app | Android: four signatures, nonce 0 → 4, $1,600 a day read back from the contract | ✓ |
| J4 | Stop all trading, then resume | Android: the held stop signed a revoke (nonce 5, nothing left to spend); the held resume, one grant (nonce 6) | ✓ |
| J5 | Create a recurring buy that runs and fills | Android: created $20 of WETH weekly; Run now filled 0.0079 WETH | ✓ |
| J6 | Buy and sell from the order ticket | Android: bought $10; sold 0.00398 WETH for $10.01; both on chain | ✓ |
| J7 | Swap | Android: 10 USDC for 0.0040 WETH, on chain | ✓ |
| J8 | Sell everything | Android: 0.126419 WETH sold for $317.48; WETH 0 on chain | ✓ |
| J9 | Withdraw to an allowlisted address | A destination added; the cooling-off holds it until 2026-09-16 01:52 UTC and Withdraw says none is unlocked | ✗ |
| J10 | Alerts | Android: two price alerts created and listed | ✓ |
| J11 | Proposals: approve, skip | Android: approve filled $5 and says so; skip recorded | ✓ |
| J12 | Agents: hire, backtest | Android: hired; a cold one-year cbBTC backtest rendered | ✓ |
| J13 | Markets, asset, chart ranges | Android: Crypto and Commodities; ETH at 1D, 1W, 1M and 1Y; BTC's candles and line | ✓ |
| J14 | Portfolio: total and graph | Android: $997.96, the graph since Sep 15, one position with its entry, stop and target | ✓ |
| J15 | Messages drawer | Android: a conversation, suggestions, the agent picker, a shortcut and back, close | ✓ |
| J16 | Networks: every network and what works on it | Android: the fork ("Trades settle here") and Sepolia ("Watch only"), both at live blocks | ✓ |
| J17 | Settings and version | Android: every section; the version reads "Development build" | ✓ |
| J18 | Recovery and key export | Recovery reviewed and marked done on Android; key export runs on the web, signed in with a code the owner types | ✗ |
| **K** | **Infrastructure** | | **7 of 10** |
| K1 | Postgres persists through a restart | Every strategy and run from before the `b01c85b` restart is still there: 3 paused and 13 live; 124 filled runs before it and 126 after, the two added being the SwapVM test's own | ✓ |
| K2 | Every table copied to MongoDB Atlas | mongo-mirror live 3/3 against the fork executor | ✓ |
| K3 | Both executors deployed, reporting their commit | `/health` on both names `b01c85b` | ✓ |
| K4 | Web app on Vercel, every route 200, security headers | 103 routes in the sweep; the hosted bundle names `b01c85b` and pins the fork's delegation; the five security headers | ✓ |
| K5 | Landing page correct | Not re-measured: `landing/` is the owner's | ✗ |
| K6 | CI green on every push | GitHub Actions: `success` on every push today, `b01c85b` included | ✓ |
| K7 | The iOS app runs | The iPhone 17 Pro Simulator launched the app from the same Metro bundle and rendered Networks against the fork, both networks at live blocks | ✓ |
| K8 | The Android app builds and runs | Built with Gradle, installed on an Android 15 emulator; every J flow above ran on it | ✓ |
| K9 | Push notifications arrive | No EAS project id exists | ✗ |
| K10 | The agents speak through a language model | No `OPENROUTER_API_KEY` exists; the conversation says the agent cannot reply | ✗ |
| **L** | **Quality** | | **5 of 6** |
| L1 | Every endpoint check passes on both executors | Final QA at `b01c85b`: Sepolia 221 of 221 — a first run at 02:28 UTC met 1inch's own API answering 500 on E187 and E190; run again at 02:35, once 1inch answered, it passed; fork 219 of 221 — E064 and E096 read $839 spent today by the executor's tally and $834 by the chain's — $5 apart, as they have been all day, because a $5 buy logged at 00:00:23 UTC landed in a block stamped 23:55:12 the day before: the fork's clock runs 13 minutes behind real time, and every spend since has been counted the same on both sides | ✗ |
| L2 | Every web route with no console error or failed request | Sweep at `b01c85b`: 103 routes, 0 with a console error, a page error or a failed or 4xx/5xx request, 0 with a console warning | ✓ |
| L3 | Unit tests | Gates at `b01c85b`: app 1,603 of 1,603 in 162 files, executor 887 of 887 in 98 files; lint and both typechecks clean | ✓ |
| L4 | Contract tests | `forge test` 74/74 | ✓ |
| L5 | Live tests pass against the deployments | Sepolia: 26 files passed and 4 skipped (they need a chain 1inch settles on), 121 tests, none failed. Fork: 21 files passed; the 9 that Privy's token endpoint refused with 429 were run one at a time and passed, but for SwapVM settlement, whose maker program earlier fills had priced out — it passed 3/3 once a fresh program was shipped | ✓ |
| L6 | No stand-in logic or data in shipped code | The keyword sweep, above | ✓ |
| **M** | **Documentation and submission** | | **3 of 3** |
| M1 | README and SUBMISSION figures match the deployments | Fills 93 · 21 · 9 · 1 and the fill-quality table from `/metrics`; `/verify` 19 · 1 · 1 on Sepolia; 103 routes; tier 7 without a fill; the hosted app described as the fork build it is; `npm test` 2,490 (1,603 app, 887 executor) | ✓ |
| M2 | The demo shows a real fill (bar 7) | `docs/demo/android-fork-demo.mp4`, 99 s on the Android build against the fork: a recurring buy created and run fills 0.0200 WETH for $50 through a maker's SwapVM program (`0x54ff6977…`), on Strategies and in the activity row; `/judge` with one row failing, 1inch's API not answering at the time; Stop all trading ending on STOPPED. Recorded without a sign-in: the emulator's session was already signed in | ✓ |
| M3 | SECURITY and RUNBOOK describe this design | `SECURITY.md` rewritten for `XorrDelegation` (56a0836); `RUNBOOK.md` names no Solana piece and describes the fork on Railway | ✓ |

### What moved, and why

- **C, 0 → 2.** The Graph lifted the 429 it had been answering Railway's egress with; the executors held off rather than ask again, and `/verify` then passed everything but its stated failure. `/judge` was run on the web, signed out.
- **D, 2 → 4.** D3: approvals, a revoke and a new grant were signed from the Android app by its Privy wallet, each read back from the contract. D4: the first pass looked for a withdrawal and found none on record; PLAN.md 4.1 names one, and the fork still holds it — a Privy-signed 5 USDC transfer to the owner.
- **F, 1 → 2.** F2: the subgraph row passes once The Graph answers.
- **J, 1 → 15.** Every signed-in flow but sign-in, the withdrawal and key export was driven on an Android emulator against the fork, and each outcome read from the chain. Driving them found five defects, each fixed and run again there: an approve that filled was told "That did not reach the executor, so nothing was decided" (132103f); Strategies and Alerts kept the list from before a setup closed over them (8aec6ad, 192c0b7); onboarding offered 30% in equities on a network that holds that weight as cash (e4dc41b); the backtest made the person retry through a cold history fetch (b0ab09d).
- **K, 6 → 7.** K8: the Android app was built and ran every flow; on the way, its charts were blank, because react-native-svg on Android keeps a clip's first shape (5b5d54d).
- **L, 3 → 5.** L2: the chart's negative-width console error is fixed (47359c0) and the sweep is clean. L5: both deployments' live suites pass, after their stale assumptions were corrected (a named 404, a limit's name, a shared account's balance, a rebalance's starting holding). Running them found a real executor defect: a partial sale reverted in 42% of cases on a one-wei split between the router's rounding and the delegation's (2899479). And the fork's grant approved WETH alone, so cbBTC could be bought and not sold (4a503ac).
- **M, 0 → 3.** M1: the README and SUBMISSION figures were brought to the deployments (f32dabb, b1a7051, the commit that records this measurement). M2: a second recording, on the Android build against the fork, shows a real fill and its transaction. M3: `SECURITY.md` was rewritten for this design (56a0836), and `RUNBOOK.md` checked.

### What is left, and why

- **J9 — a withdrawal on a screen.** The allowlist holds a new destination for 24 hours by design, on the database's clock. The one added from the Android app on 2026-09-15 unlocks at 2026-09-16 01:52 UTC; Withdraw everything can then send to it.
- **D5 — the Privy B2B workflow.** Not built. PLAN.md 4.14 describes it: an operator managing agent policy for a business wallet, shown in the app and written up.
- **F3 — the Aqua venue subgraph.** Built and uploaded; Studio refuses the deploy with `Subgraph not found` until the slug is created in its dashboard, which takes the wallet that owns the Studio account.
- **H2 — transactions on Base mainnet.** They spend real money, which this run may not do.
- **I7 — a tier-7 fill.** Its strategies trade tokenized equities, which do not function on a fork; they can fill only where the equities do, on Base mainnet.
- **J1, J18's key export.** Each needs a Privy sign-in code typed into the login form, which is the owner's to do.
- **K5 — the landing page.** `landing/` is the owner's.
- **K9 — push notifications.** No EAS project id exists.
- **K10 — the agents' language model.** No `OPENROUTER_API_KEY` exists; the conversation says the agent cannot reply.
- **L1 — the fork's two spend tallies.** On the fork alone, E064 and E096 read $839 spent today by the executor's tally and $834 by the chain's — $5 apart, as they have been all day, because a $5 buy logged at 00:00:23 UTC landed in a block stamped 23:55:12 the day before: the fork's clock runs 13 minutes behind real time, and every spend since has been counted the same on both sides. The Limits screen already shows the stricter of the two. The fork's clock was set to real time at 02:58 UTC (its new blocks had been stamped 313 s behind), so a spend near midnight no longer lands on different days in the two tallies; today's pair agrees again from the next UTC day.

## After the final measurement — 66 of 76 · **87%**

D5 was built after the final measurement and measured the way every other item was: on a screen, against a deployment,
and read back from the chain. The executors and the web ran `4e6f80a` from 04:31 UTC on 2026-09-15, and `bdb85d0` from 04:55 UTC; the Android app ran
from Metro on the same tree, signed in as a Privy test account against the fork executor. Nothing else moved, so the ten
items left are the ten the final measurement left, for the same reasons.

| # | Item | How it was verified | State |
|---|---|---|---|
| D5 | A written, working business workflow (Privy B2B track) | Business, on the Android app against the fork: a treasury created as a Privy server wallet owned by key quorum `zixx49…` under the quorum-owned policy (`0xE786…1469`); funded with 1,000 USDC; granted $50 a day by the treasury's own signatures through Privy — three approvals and `grant()` `0x1a6e66a6…`; traded by the bot, 0.0020 WETH through a maker's SwapVM program (`0xceb3abb6…`); stopped, `revoke()` `0x049c6963…`; and Privy refused to sign a transfer of its $995 out, with no transaction made. The fork holds exactly those five transactions from the treasury. `business-treasury.live.test.ts` 6/6 against the fork. Written up in SUBMISSION's B2B section | ✓ |

**D, 4 → 5.** Every other group stands as the final measurement found it.

### Found on the way

- **Privy refused the policy's new signing rules.** A treasury on a fork needs Privy to *sign* what Privy cannot send
  there, so `97ef98d` named every allowed call a second time for `eth_signTransaction`, as "…, signed for the executor
  to send". Privy refuses a rule name of 50 characters or more, and refuses the whole write with it: from 03:29 UTC both
  executors' `privy-policy` check failed, `rules.13.name: Rule name must be fewer than 50 characters` on the fork and
  `rules.5.name` on Sepolia. `0e193f1` names them "Sign: …", refuses a name Privy would refuse before Privy is asked,
  and tests the fork's full list. The fork's check passed from 03:40 UTC, and Sepolia's — after Railway failed its first
  upload with a 500 — from 03:44 UTC. `privy-refusal` passed throughout: the refused write changed nothing, so the policy
  in force never did.
- **A treasury's record raced the chain on Base Sepolia.** Privy broadcast a grant and a revoke a block apart. The
  executor, reading through a node a block behind, answered the grant "Could not read your permission from the chain
  just now" and refused the revoke as still active. `bdb85d0` records once its node is at the transaction's block and
  shows the permission as the transaction left it; on it, Privy's next `grant()` (`0x728bf11d…`) and `revoke()`
  (`0x88641cc4…`) on Sepolia were both recorded.

### What is left — ten

- **J9** — a withdrawal on a screen: the Android app's allowlisted destination unlocks at 2026-09-16 01:52 UTC.
- **F3** — the Aqua subgraph: Studio refuses the deploy until the slug is created in its dashboard by the account's wallet.
- **H2** — transactions on Base mainnet spend real money.
- **I7** — tier 7 trades tokenized equities, which fill only on Base mainnet.
- **J1, J18** — each needs a Privy sign-in code typed by the owner.
- **K5** — `landing/` is the owner's.
- **K9** — no EAS project id exists.
- **K10** — no `OPENROUTER_API_KEY` exists.
- **L1** — today's two spend tallies on the fork stay $5 apart until the UTC day turns; the fork's clock was set right at 02:58 UTC.
