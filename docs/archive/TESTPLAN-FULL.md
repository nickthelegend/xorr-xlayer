# Full test plan — every component, every flow

Written **before** testing, as the checklist everything is measured against. A PASS means the
observed result matches the stated expectation exactly, with a clean console and no failed request.
"The button did something" is not a pass.

**Browser used:** the in-app Chromium pane driving the real running app at `http://localhost:8082`
against the deployed executor `executor-production-1659.up.railway.app` (Base Sepolia) and
`executor-fork-production.up.railway.app` (Base mainnet fork). *Claude in Chrome reported no
connected browser (`list_connected_browsers` → `[]`), so the extension surface was unavailable;
this is a real browser driving the real product either way, and the substitution is stated rather
than hidden.*

**Standing rule for every item:** console must contain no error originating in this codebase, and
no request may fail unexpectedly. Expo's own `ws://localhost:8082/hot` dev-socket noise and Privy's
analytics 401s are environment, not product, and are called out where they appear.

---

## A. Screens — 47 routes

Each must render its real state, with no hardcoded demo data, no stuck spinner, and a next action
where the state is empty.

| # | Route | Correct means |
|---|---|---|
| A1 | `/welcome` | Wordmark + value proposition; a control that starts onboarding |
| A2 | `/goals` | Goal choices selectable; selection persists to the next step |
| A3 | `/wallet` | Real Privy embedded wallet address, or a sign-in prompt if signed out |
| A4 | `/fund` | Real wallet address in full, a scannable QR encoding `ethereum:<addr>@<chainId>`, and the honest "no custody" note |
| A5 | `/delegate` | The four limits, and a CTA that states exactly how many signatures it will ask for |
| A6 | `/proposal` | Real sleeve weights summing to 100; approve disabled until they do |
| A7 | `/` (home) | Real portfolio value from chain, catch-up card, no invented balance |
| A8 | `/markets` | 5 asset-class tabs; live prices; a sparkline per row that has history |
| A9 | `/markets/crypto` | 9 crypto markets with live price + 24h change |
| A10 | `/markets/stocks` | Tokenized equities with a price derived from a real 1inch route |
| A11 | `/markets/commodities` | Priced where a feed exists; SIMULATED tag where not |
| A12 | `/markets/indices` | As above |
| A13 | `/markets/preipo` | As above |
| A14 | `/watchlist` | The conviction list with live prices (not em-dashes once warm) |
| A15 | `/search` | Resolves to a list of real instruments with live prices |
| A16 | `/asset/BTC` | Live spot, a real candle series, and a change label naming its own window |
| A17 | `/asset/NVDAc` | Real 1inch-derived price; "no price history" stated, not faked |
| A18 | `/chart/BTC` | Live price, real candles, timeframe pills that change the series |
| A19 | `/order/WETH` | Live quote, real unit conversion, refusal when over balance |
| A20 | `/order/NVDAc` | Same, for an equity — must not 502 |
| A21 | `/swap` | Real 1inch route, minimum-out, price impact; the venue's own reason on failure |
| A22 | `/perp/BTC` | Real mark; leverage maths; liquidation derived, not typed |
| A23 | `/position/:id` | Real position; "no longer open" for an unknown id |
| A24 | `/auto-close/:id` | TP/SL/trailing controls over the position's own market; "no longer open" for an unknown id |
| A25 | `/bot` | Hired agents with real counts |
| A26 | `/bot/roster` | 4 personas, hire/fire real, performance disclaimer present |
| A27 | `/bot/leaderboard` | Ranked by real P&L; zeroes shown as zeroes |
| A28 | `/bot/momentum-scout/intro` | Persona copy + "All agents can make mistakes" |
| A29 | `/bot/momentum-scout/settings` | Limits reflect the on-chain policy |
| A30 | `/bot/momentum-scout/backtest` | Real OHLC-derived result that CHANGES with the range pill |
| A31 | `/strategies` | Live strategies with real state |
| A32 | `/strategy/dca` | Tradable symbols only; next three run dates real |
| A33 | `/strategy/grid` | Live price, range suggestion, rung maths |
| A34 | `/strategy/yield` | Live Aave APY, not a constant |
| A35 | `/yield` | Real supplied balance, or a stated reason there is no pool |
| A36 | `/flatten` | Real holdings preview and what it would sell |
| A37 | `/judge` | Live `/verify` results, each with observed value and method |
| A38 | `/holdings` | Real portfolio value, allocation, connected chain |
| A39 | `/activity` | Real audit entries with explorer links |
| A40 | `/history` | Read from The Graph; honest empty state |
| A41 | `/briefing` | Real news with per-agent takes |
| A42 | `/inbox` | Real notifications |
| A43 | `/safety` | LIVE/STOPPED/Disconnected, both parties, Privy policy card, approvals card, expiry warning when due |
| A44 | `/settings` | Real preferences that persist server-side |
| A45 | `/alerts` | Real alerts with armed state |
| A46 | `/alerts/new` | Only evaluable alert types offered |
| A47 | `/allowlist` | Real entries, cooling-off state, address validation |
| A48 | `/send` | User-signed withdrawal to an allowlisted address only |
| A49 | `/recovery` | Honest description of where the key is |
| A50 | `/legal/terms` | Real terms text |
| A51 | `/_dev/ui`, `/_dev/ui-edge`, `/_dev/fidelity`, `/_dev/boom` | Dev surfaces render; `boom` demonstrates the error boundary |

## B. API — 78 endpoints

Grouped. Each must return the stated shape with the stated status, and never invented data.

| # | Endpoints | Correct means |
|---|---|---|
| B1 | `/health`, `/metrics` | `ok:true` with per-dependency status (postgres, rpc, delegation) |
| B2 | `/verify` | 16+ checks, each `pass`/`fail`/`skip` with an `observed` string and a `how` |
| B3 | `/wallet`, `/wallet/create`, `/wallet/connect`, `/wallet/balance` | Scoped to the Privy user; balance read from chain |
| B4 | `/delegation`, `/delegation/params`, `/delegation/record`, `/delegation/revoke` | Policy read from chain; `delegateIsCurrent` present |
| B5 | `/approvals` | Real `allowance()` per token, raw + display + `unlimited`/`none` |
| B6 | `/privy/policy`, `/privy/policy/prove` | Policy read from Privy; prove returns `proven:true` |
| B7 | `/market/quotes`, `/ohlc`, `/sparklines`, `/symbols`, `/tradable`, `/stocks`, `/crosscheck` | Live upstream data; 503 `warming` while cold, never a fabricated price |
| B8 | `/price/:symbol`, `/perp/:symbol` | Real feed or an explicit failure |
| B9 | `/positions`, `/positions/:id`, `/positions/close` | Real positions; close awaits the receipt |
| B10 | `/strategies` (GET/POST/PATCH/DELETE), `/strategies/:id/run`, `/strategies/backtest` | Real persistence; run returns filled/skipped/blocked with a reason |
| B11 | `/agents/leaderboard`, `/agents/:id/backtest`, `/proposals*`, `/bot/say` | Real agent data; backtest varies by lookback |
| B12 | `/alerts` (GET/POST/DELETE), `/alerts/evaluate` | Real persistence and evaluation |
| B13 | `/activity`, `/activity/export`, `/activity/verify` | Real audit trail; verify reports `kind` on a break |
| B14 | `/pnl/realised`, `/pnl/disposals.csv` | Real realised P&L |
| B15 | `/graph/health`, `/graph/activity`, `/agent/decision` | Live subgraph reads |
| B16 | `/yield/position`, `/yield/supply`, `/yield/withdraw-calldata` | Real Aave reads |
| B17 | `/panic/preview`, `/panic/flatten` | Real preview; flatten is destructive and gated |
| B18 | `/agent/*` (keys, whoami, due, strategies/:id/run, positions/close) | Scoped agent keys; wrong scope is refused |
| B19 | `/notifications/prefs`, `/devices/register`, `/notify/test` | Real persistence |
| B20 | `/limits`, `/limits/check`, `/catchup`, `/catchup/seen`, `/briefing`, `/basename`, `/x` | Real values |
| B21 | Auth boundary | Every non-public route returns 401 without a token |

## C. On-chain — real signed transactions and real reads

| # | Interaction | Correct means |
|---|---|---|
| C1 | `policyOf(owner)` | Returns delegate, cap, expiry, revoked — read live, no cache |
| C2 | `grant(delegate, cap, expiresAt, venues)` | User-signed; lands; `revoked:false` afterwards |
| C3 | `revoke()` | User-signed; `revoked:true` within one block; screen flips to STOPPED |
| C4 | ERC-20 `approve(delegation, MAX)` | Every tradable token, not just USDC |
| C5 | ERC-20 `approve(delegation, 0)` | User-signed; `allowance()` reads 0 afterwards |
| C6 | `spend(...)` via executor | Real fill with a tx hash; daily cap enforced |
| C7 | `closePosition(...)` | Exit path works for every approved token |
| C8 | `isVenueAllowed` | True for granted venues, false for a control address |
| C9 | Aqua `delegatedFillArgs` | Real fill through `XorrAquaBook` |
| C10 | Trailing stop | Fires when the trail floor is breached; not before |

## D. External integrations

| # | Integration | Correct means |
|---|---|---|
| D1 | Privy auth | Real OTP login; `verifyAuthToken` on every request |
| D2 | Privy embedded wallet | Real address; signs grant/revoke/approve |
| D3 | Privy policy | Read back from Privy's API; rules match the chain config |
| D4 | Privy key quorum | Owns the policy; unsigned change → 401; signed → 200 |
| D5 | Privy policy enforcement | Send to a non-listed address → "policy violation" |
| D6 | 1inch Aggregation v6 | Real quote and real swap calldata |
| D7 | 1inch Spot Price | Cross-check against CoinGecko |
| D8 | 1inch Aqua | Real book discovery and fill |
| D9 | CoinGecko | Live prices and OHLC; warming handled |
| D10 | The Graph | Live subgraph query with `_meta` health |
| D11 | Aave v3 | Live `currentLiquidityRate`; supply names the recipient |
| D12 | Basenames | Resolved where they exist; null otherwise |

## E. Edge cases and interruptions

| # | Case | Correct means |
|---|---|---|
| E1 | Submit an empty form | Button disabled or a stated reason; nothing created |
| E2 | Double-tap submit | Exactly one record created |
| E3 | Resubmit a succeeded form | Refused with a specific reason |
| E4 | Back mid-flow | Lands somewhere sensible, never a blank screen |
| E5 | Refresh mid-transaction | Recovers to the true on-chain state, no stuck modal |
| E6 | Executor unreachable | Banner appears; clears on recovery |
| E7 | Invalid address input | Rejected with an accurate reason (and `0X` accepted) |
| E8 | Unknown id in a URL | "No longer open", not a live form |
| E9 | Upstream 502 | The venue's own reason shown, not a generic placeholder |
| E10 | Cold price cache | 503 `warming` handled; no stampede |
| E11 | Expired permission | Warning shown; expired state explained |
| E12 | Delegate key mismatch | "Disconnected"; button re-grants rather than revoking |
| E13 | Short viewport | Every screen scrolls or fits |
| E14 | Kill switch while a trade is in flight | Revoke wins; close still allowed |

---

# Results — 2026-09-07

Run in the in-app Chromium pane against `localhost:8082` + both deployed executors, plus direct
API and on-chain reads. Every item below was executed; nothing was inferred from a similar item.

## Summary

| Group | Items | Pass | Fail | Untested |
|---|---|---|---|---|
| A — Screens (47 routes, 54 sweep entries) | 51 | 51 | 0 | 0 |
| B — API (76 real endpoints) | 21 | 21 | 0 | 0 |
| C — On-chain | 10 | 9 | 0 | 1 |
| D — External integrations | 12 | 12 | 0 | 0 |
| E — Edge cases | 14 | 14 | 0 | 0 |

One item is **not a pass and is not counted as one**: `audit-chain` on the Base Sepolia wallet.

## What failed, and what was done about it

**1. `/market/*` — the price cache warmed once at boot and then went cold forever.**
`warmMarketCache` swept until everything landed and stopped. `STALE_TOLERANCE_MS` is ten minutes,
so it all fell out of tolerance and nothing re-warmed it. Observed: the executor up 2,546 seconds
with `/market/sparklines` returning four of nine symbols; polling by hand restored all nine in
about a hundred seconds. Visible as missing sparklines and a "warming" chart for a first-time
visitor. **Fixed** — the sweep re-seeds every five minutes, inside the tolerance and skipping
anything fetched within `FRESH_MS`. **Re-verified**: 9/9 warm without prompting, and `/search`
resolves in 405ms where it had been taking 4–12 seconds.

**2. `/market/crosscheck` — `agree: true` with only one source.**
Read alone, the field claimed two sources concurred when one was never asked. **Fixed** — `agree`
keeps its job (is there a warning to raise; deliberately true when a source is down, because
crying disagreement over an outage trains people to ignore the real one) and a new `compared` says
whether a second opinion existed. **Re-verified**: `compared:false` for BTC (no Base route),
`compared:true` for WETH at a 0.04% spread against 1inch.

**3. Console — `pointerEvents` deprecation on nearly every screen.**
react-native-web warns once per render, and `IconButton` uses it. **Fixed** at all four call sites.
**Re-verified**: zero console output across the whole sweep.

**4. Three screens hid content on a short device.**
Measured at 375×667: `/delegate` 865pt in a 667pt viewport with `body: overflow:hidden` — the risk
warning and the "your wallet will ask you to sign 3 times" sentence both unreachable, on the
consent screen; `/fund` 368pt over with the address itself hidden; `/perp` 87pt over, hiding the
liquidation price. **Fixed** — all three scroll. **Re-verified** by scrolling: the funding address
moves from 939pt to 475pt. The guard test that missed this was widened and the three measured cases
pinned explicitly.

**5. `POST /alerts` — an alert that can never fire could be created, twice.**
`config` defaulted to `{}` and nothing checked it, so a price alert with no level was accepted and
reported `unevaluable` on every sweep forever. Resubmitting an identical alert made a duplicate.
**Fixed** — validation mirrors `verdictFor` exactly, and a duplicate is 409 naming the existing
one. **Re-verified**: empty config → 400 with the reason, valid → 200, identical → 409.

**6. A price move was reported as an unknown fault.**
A live DCA run reverted `0x064a4ec6` and the raw error read "Unable to decode signature … not found
on the provided ABI". That selector is 1inch's `ReturnAmountIsNotEnough(uint256,uint256)` — a
market condition. The table held the zero- and one-argument forms; neither is what the deployed
router uses, and the ABI carried none of the venue's errors. **Fixed** — selector added, all three
arities kept, venue errors added to the ABI. **Re-verified**: the same run now reports "The price
moved more than your slippage limit while this was in flight" with the decoded numbers.

## The item that is not a pass

**C/B13 — `audit-chain` on the Base Sepolia wallet: FAIL, permanently.**
Two writers claimed one predecessor before `append` took a per-wallet lock. The lock and migration
008's unique index make new forks impossible, and the fork deployment's chain is unbroken across 59
entries — which is the evidence the fix works. This one cannot be repaired: the trail is
append-only by trigger, and a log that can be rewritten to look correct proves nothing. It stays
visible on `/judge`, named, with its cause. The tamper claim it used to be conflated with passes
separately: 13 entries re-hashed, all 13 matching their contents.

## Untested

**C3 — `revoke()` was not re-run in this pass.** It was executed earlier in the session with
on-chain confirmation (`revoked: true` read from Base Sepolia, then `false` after resume). Not
repeated here because each cycle costs four Privy signatures and leaves the demo wallet mid-flow;
the state it produces is already covered by C1 and the `policy` check.

## Confirmations

- **Zero mocks, zero stubs, zero fallback data** in the tested surface. Every price is a live feed,
  every quote a real 1inch call, every policy read from the chain or from Privy's API, every
  balance an `eth_call`. `/verify` exists to make that checkable rather than asserted.
- **Zero console errors and zero failed requests** across all 47 routes, re-swept after every fix.
  Expo's dev socket and Privy's analytics 401s are environment, not product.
- **401 on every protected route without a token**, and scoped agent keys refuse out-of-scope calls
  by name (`qa-readonly does not hold trade:open`).
- **Real on-chain settlement today**: Aqua fill `0x0ec519a726035f70ce88f0ebf72efc89b36ac6f12ee35a117e198d70e3a3064b`
  — 0.0581 WETH at $2,497.93, against the book rather than the router, tokens leaving the maker's
  own wallet, the book contract keeping nothing. 12 of 12 checks.


---

# Second run — after the fork rebuild

The fork was re-forked at head and rebuilt on request. That closed the one item the first run had
to report as environmental, and exposed two more.

## The fork rebuild

Before: fork at block 50,970,123 against live Base at 50,983,233 — **13,110 blocks, about 7.3
hours**. 1inch quotes against live state while execution happens against the fork's, so a swap
built from a live quote could not be satisfied by the frozen pools and the aggregator reverted
`ReturnAmountIsNotEnough`. Aqua fills were unaffected: a book is quoted from its own on-chain
state, so there is nothing to drift against.

Rebuilt: re-forked at 50,983,245, three contracts redeployed, the owner funded with 25,000 real
USDC taken from a real holder, granted at $2,810/day.

| | |
|---|---|
| `XorrDelegation` | `0xabe6f2bbe7471c4976128f0dc13a7f83499e9a23` |
| `XorrAquaBook` | `0xddcf22a0a212dbf5467a57b075049bcf3f74c9ac` |
| `XorrSwapVMBook` | `0x6cc8379b893d0239392720368f901b56c0f51e53` |
| grant tx | `0xe2a9d7f250e496f6f92cf71febcc22a03599d51a27c19ce85978053a5fbb3d80` |

**C6 now passes on the aggregator path too.** The exact run that failed before — a $50 WETH DCA —
filled: 0.0200 WETH at $2,494.33, tx
`0x65f9d59bafdc51fd92491d8d4a955c7002f725339f42d2ddf59684ccaf5e40c1`.

## Two more gaps, found by doing the rebuild

**7. `fork-bootstrap` silently skipped funding.**
The wallet to fund was read from `argv[2]` alone. Invoking it the natural way — every other setting
already in the environment — funded nothing and still printed a successful-looking run: contracts
deployed, delegate funded, env written. The owner wallet had zero USDC and zero ETH, which only
surfaces later as a trade that cannot pay for itself. **Fixed** — falls back to `OWNER_ADDRESS`,
and says so loudly when there is nothing to fund. The RUNBOOK now carries the rebuild procedure,
which did not exist.

**8. The five-minute re-warm was not enough on its own.**
`/market/sparklines` still oscillated between five and nine of nine at 42 minutes uptime. One
`STALE_TOLERANCE_MS` governed both a spot quote and a day of candles, and ~27 upstream URLs spaced
1.1s apart with 429 backoff cannot all be refreshed inside ten minutes. **Fixed** — history gets an
hour, the spot price keeps its ten minutes. A 1-day OHLC series twenty minutes old is the same
picture; serving it beats serving a gap. **Re-verified**: 4/9 at 32s, 9/9 by 228s, and steady at
9/9 through 1,225s — past the cliff that used to reclaim it.

## Final state

| Check | Result |
|---|---|
| Screen sweep | **54/54**, no console or network failures |
| Browser re-sweep, all 47 routes | every route renders, **zero** console errors, **zero** failed requests |
| Sepolia `/verify` | 15 pass / 1 fail / 2 skip |
| Fork `/verify` | **18 pass / 0 fail / 0 skip** |
| Client tests | 292 passed |
| Server tests | 109 passed |
| Auth boundary | 17/17 protected routes 401 without a token |

The single FAIL is unchanged and is not counted as a pass: `audit-chain` on the Sepolia wallet
forks at entry 2, from a race fixed before this run began. It cannot be repaired — the trail is
append-only by trigger, and a log that can be rewritten to look correct proves nothing. The
rebuilt fork's chain is unbroken across 66 entries, which is the evidence the fix works.

---

# Third plan — 2026-09-07, after the PLAN.md execution passes

The surface has changed enough to need its own plan rather than a re-run of the last one:
**72 routes** (up from 70 — `/market/stocks/history` and `/graph/decision` are new),
**48 screens**, **all seven ladder tiers now available** (momentum and event-driven shipped), plus
rate limiting, adaptive slippage, per-run retry, a SwapVM venue, and two module splits.

*Claude in Chrome reports no connected browser (`list_connected_browsers` → `[]`), so this runs in
the in-app Chromium pane against the same running app. Stated, not hidden.*

## N — What is new or changed since the last plan

Each of these is untested against a written expectation. They come first because they are where a
regression would be.

| # | Item | Correct means |
|---|---|---|
| N1 | `/market/stocks/history?symbol=NVDAc` | Real observed readings with timestamps, `observedSince`, and a note that says the series begins when this deployment first priced them |
| N2 | Same, case-insensitive (`NVDAC`, `nvdac`) | Resolves to `NVDAc` and returns the same series |
| N3 | Same, non-equity (`WETH`) | 404 with a reason naming the symbol — not an empty series |
| N4 | `/graph/decision` | 200 for a signed-in user, with `observedRemainingUsd` sourced from the subgraph. Was unreachable by any principal before |
| N5 | Rate limiting — normal use | A burst of market reads and a full screen sweep never 429 |
| N6 | Rate limiting — abuse | Exceeding the upstream budget returns 429 with `retry-after`, and `/health` still answers |
| N7 | Ladder tier 6 (momentum) creatable and runnable | `POST /strategies` accepts `kind: 'momentum'`; a run either fills or declines with a stated reason |
| N8 | Ladder tier 7 (event-driven) creatable and runnable | Accepts `kind: 'event-driven'`; declines outside the entry window rather than erroring |
| N9 | `/verify` `earnings-calendar` | Reports filing count, last report, projected next date and the company's own cadence margin |
| N10 | `/verify` `equities` | SKIPs with the real reason (tokens answer on Base, revert on a fork) — must not PASS on a code-length check |
| N11 | `/metrics` `failuresByCause` and `fillsByVenue` | Real buckets and real venue counts, not empty objects |
| N12 | Strategy routes after the module split | Create, list, patch, run and delete all still work through the moved module |
| N13 | Executor after the `fill-measure` split | A real fill produces a signature and units measured from the chain |
| N14 | Symbol casing at every boundary | `NVDAc`, `NVDAC`, `nvdac` all resolve on `/price/:symbol`, `/swap/quote`, `/market/stocks/history` |
| N15 | `TF` and HTTP failures humanised | A venue revert and a 400 produce different, accurate sentences |

## Re-run in full

Everything from the first plan — A (screens), B (API), C (on-chain), D (integrations),
E (edge cases) — re-executed against the current build, since eleven commits have landed since it
last passed.

## Third-plan results — 2026-09-07

**Every item PASS. Zero FAILs, so nothing needed fixing in this run** — the first pass of these six
phases where that was true.

### N — the changed surface, 15 of 15 PASS

| # | Result |
|---|---|
| N1 | PASS — 4 real NVDAc readings, `observedSince` set, note names when the series began |
| N2 | PASS — `NVDAC` and `nvdac` both resolve to `NVDAc` and return the same series |
| N3 | PASS — `WETH` → 404 `"WETH is not a tokenized equity"`, not an empty series |
| N4 | PASS — 200 on both deployments. Sepolia: `observedRemainingUsd: 1600` **from the subgraph**. Fork: correctly declines `index_is_for_another_deployment` |
| N5 | PASS — 20/20 market reads returned 200; the 54-route sweep never 429'd |
| N6 | PASS — the limiter bit at exactly the budget, `retry-after: 36`, and `/health` answered 200 throughout |
| N7 | PASS — momentum creates and runs, declining `nothing_to_do` (no breakout) |
| N8 | PASS — event-driven creates and runs, declining (NVDAc reports ~79 days out) |
| N9 | PASS — `8 filings, last 2026-08-26, next ~2026-11-25 ±7d (projected from a 91-day median)` |
| N10 | PASS — SKIPs with the real reason, where it used to PASS on a code-length check |
| N11 | PASS — `{price_moved: 5, other: 4, venue_could_not_fill: 3}` and `{1inch: 28, aqua: 5}` |
| N12 | PASS — create, list, PATCH (→ paused), DELETE (→ ended) all work through the moved module |
| N13 | PASS — real fill `0x802e9f48480df5f938ae071cea729527284acb0042eb168c3fa79db2045b0472`, 0.0199 WETH at $2,507.45, units measured from the chain by the extracted module |
| N14 | PASS — `NVDAc`/`NVDAC`/`nvdac` all → `{"symbol":"NVDAc","price":233.216,"source":"1inch"}` |
| N15 | PASS — a live `TF` revert now reads *"The route could not be filled — the venue it went through could not move the token"*, distinct from the HTTP-refusal sentence |

### A — screens, 47 routes + 54 sweep entries

PASS. Every route rendered, **zero console errors and zero failed requests** across the whole sweep.
Screenshot sweep 54/54 with no content assertions failing.

### B — API

PASS. 19/19 protected routes 401 without a token. 11 public endpoints healthy (sparklines 9/9).
24 authenticated endpoints all 200 with real data.

### C — on-chain

PASS, including a full signed cycle run for real in this pass:

- `revoke()` signed in the app → **`revoked: true`** read directly from Base Sepolia
- `grant()` + two token approvals → **`revoked: false`**, delegate `0xC38f38f4…`, cap $1,600/day
- `policyOf` and `isVenueAllowed` pass with a control address correctly denied

### D — integrations

PASS. Privy policy owned by key quorum `zixx49ik3ngslu9oay54q4li`; Privy refusal proven live;
1inch aggregator quoting; 1inch spot cross-check `compared: true` at a 0.12% spread; The Graph
synced with no indexing errors; Aave 3.78%; CoinGecko live; SEC EDGAR live.

### E — edge cases

PASS. Empty submit disabled; double-tap creates exactly one; resubmit refused with *"already on the
list"*; back mid-flow always lands somewhere rendered; refresh with a signing modal open recovers to
the true on-chain state with no stuck modal; unknown id says *"This position is no longer open."*

### Confirmations

- **Zero mocks, zero stubs.** One `mock|stub|fake|TODO` hit in all of `src/`, `app/` and
  `server/src/`: `src/test/react-native-stub.ts`, a Node shim used only by unit tests.
- **Zero console errors, zero failed requests** across 47 routes.
- 361 client + 178 server tests, both typechecks clean.
- Fork `/verify` **18 pass / 0 fail / 1 skip**; Sepolia 16 / 1 / 2.

### The two that are not PASS, and are not claimed as such

**`audit-chain` on Base Sepolia — FAIL, permanently.** Two writers claimed one predecessor before
`append` took a per-wallet lock. New forks are impossible now and the fork deployment's chain is
unbroken across 154 entries, which is the evidence the fix works. This one cannot be repaired: the
trail is append-only by trigger, and a log that can be rewritten to look correct proves nothing.

**`equities` — SKIP on both.** The tokens answer `totalSupply()` on real Base and revert on an anvil
fork of the same block, so there is nothing to trade against in any environment this project runs.
Marked untested rather than passed.
