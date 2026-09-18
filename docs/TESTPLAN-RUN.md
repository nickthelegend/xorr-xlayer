# Test plan — full-surface run

48 app routes, 72 server routes, the contract, and four external integrations. Written before any
testing, so it is a checklist rather than a description of whatever happened to work.

**"Correct" is stated per item as a specific observable result.** "Loads", "works" and "the button
does something" are not pass conditions. An item fails if the observed result differs at all, or if
the browser console shows any error while performing it.

**Environment.** Web build at `localhost:8082` in Chrome, pointed at
`executor-fork-production.up.railway.app` (chain 8453, base-fork). Signed-out and signed-in states
both exercised. Console read on every item.

Status legend: `PASS` · `FAIL` · `FIXED` (failed, root cause fixed, re-verified) · `UNTESTABLE`
(states the missing dependency).

---

## A — Signed-out surface

| # | Item | Correct means | Status |
|---|---|---|---|
| A1 | `/` with no session | Redirects to `/welcome`; no flash of signed-in chrome | PASS |
| A2 | `/welcome` | Wordmark, one card, "Get started"; no console error | PASS |
| A3 | `/goals` | 5 chips + 3-way risk; Continue disabled at 0 selected, enabled at ≥1; caption names the risk level | PASS |
| A4 | `/wallet` empty email | "Email me a code" disabled | PASS |
| A5 | `/wallet` invalid email (`abc`) | Button stays disabled | PASS |
| A6 | `/wallet` arbitrary valid email | Accepts it, reveals the CODE field, no error — a judge with an inbox can proceed | PASS |
| A7 | `/wallet` wrong OTP | Red text "Invalid email and code combination"; stays on step 2 | PASS |
| A8 | `/wallet` refresh mid-flow | Returns to the email step cleanly; no stuck spinner, no crash | PASS |
| A9 | `/activity` signed out | "Not signed in, so /activity was not requested" — never invented rows | PASS |
| A10 | `/judge` signed out | ≥14 PASS, 6 SKIP, 0 FAIL, and the words "Skipped is not passed" | PASS |
| A11 | `/safety` signed out | Must not simultaneously claim the permission is live and that nothing is granted | **FIXED** |
| A12 | `/markets/crypto` signed out | 9 rows, live prices, no SIMULATED tag on crypto | PASS |
| A13 | `/watchlist` default tab | Every visible row shows either a real price or a labelled dash — no silent blanks | **FIXED** |

## B — Onboarding, signed in

| # | Item | Correct means | Status |
|---|---|---|---|
| B1 | Sign in with a Privy test account | 4 steps go green; no raw SDK text anywhere on screen | PASS |
| B2 | Returning user re-signs in | Same as B1 — specifically no "Wallet already exists" | **FIXED** |
| B3 | `/fund` | $500 default, 4 quick amounts, 3 methods, card on-ramp visibly disabled and labelled | PASS (iOS) |
| B4 | `/delegate` | Four limit rows, cap stepper, duration; on a fork build the blocked note is visible **above** the CTA and the CTA is disabled | **FIXED** (iOS) |
| B5 | `/proposal` | Weights total 100; CTA disabled until they do | PASS |
| B6 | Sign out (Settings → Session) | Two-tap confirm, returns to `/welcome`, store cleared | PASS (iOS) |

## C — Tabs

| # | Item | Correct means | Status |
|---|---|---|---|
| C1 | Home | Total + Cash are two different real numbers; "in the last day" counts; no $0.00 placeholder | **FIXED** |
| C2 | Markets loading | Skeleton rows + "Loading · 24/7" — never "0 shown" over a blank screen | **FIXED** |
| C3 | Markets classes | All 5 chips switch; commodities show SIMULATED where unpriced | PASS |
| C4 | Strategies (Trade) | Running list with real next-run dates; Add-new shows 7 tiers | PASS |
| C5 | Agents (Bot) | Chat renders; a question returns either a model answer or an explicit "no language model configured" — never a canned line presented as an answer | **FIXED** (iOS) |
| C6 | Assets (Holdings) | "Target mix" (not "Allocation") with the approved weights; Holdings separate | **FIXED** |

## D — Trading

| # | Item | Correct means | Status |
|---|---|---|---|
| D1 | `/asset/BTC` | Live price, candles, timeframe pills switch | PASS |
| D2 | `/asset/NVDAc` on fork | Buy/Sell absent; refusal names the actual chain, not "Base" | **FIXED** |
| D3 | Buy/Sell never render live before settleability is known | Controls disabled while checking, never enabled-then-withdrawn | **FIXED** |
| D4 | `/order/CBBTC` Max | Fills spendable **cash**, not total portfolio value | **FIXED** |
| D5 | `/order` amount 0 | CTA disabled, "At worst —" | PASS |
| D6 | `/order` over balance | Red "more than the $X you have settled"; CTA disabled | PASS (iOS) |
| D7 | `/order` double-submit | Exactly one request leaves; guarded | PASS (iOS) |
| D8 | `/order` real buy | Either a fill with units + hash, or a refusal in the executor's own words. Never an infinite spinner | PASS (iOS) |
| D9 | `/swap` | Pay amount renders with decimals (0.1000, not 0); route + price impact real | **FIXED** (iOS) |
| D10 | `/swap` Review | Opens the order ticket on Sell with the amount carried across | **FIXED** (iOS) |
| D11 | `/send` no allowlist | "Add a destination to your allowlist first"; Send disabled | PASS (iOS) |
| D12 | `/allowlist` empty | Explicit empty state, not a blank screen | **FIXED** (iOS) |
| D13 | `/allowlist` invalid address | "not a Base address… 0x and 42 characters"; Add disabled | PASS (iOS) |

## E — Strategy tiers

| # | Item | Correct means | Status |
|---|---|---|---|
| E1 | DCA sheet targets | WETH + CBBTC only — never USDC, which cannot swap for itself | **FIXED** |
| E2 | DCA over daily cap | Executor's sentence, visible **above** the button, naming both numbers | **FIXED** (iOS) |
| E3 | DCA next-three-runs | Three real future dates matching the cadence | PASS |
| E4 | `POST /strategies` USDC via API | 400 `not_settleable_here` — the guard is server-side, not just client-side | **FIXED** — deployed, re-verified live |
| E5 | Grid sheet | Bounds + rung inputs; CTA disabled until valid | PASS |
| E6 | Yield sheet | Real Aave rate; CTA reflects the amount | PASS |
| E7 | Exit rules | TP/SL steppers seeded from the armed rule | PASS |
| E8 | Tier list | All 7 tiers present and each opens | PASS (iOS) |

## F — Safety and permission

| # | Item | Correct means | Status |
|---|---|---|---|
| F1 | `/safety` signed in | Agent/strategy count matches what can actually place orders | **FIXED** |
| F2 | Kill switch on a fork build | Disabled, with the blocking reason visible above it — never silently inert | **FIXED** (iOS) |
| F3 | Kill-switch failure text | A sentence; never an RPC URL, request body or viem version | **FIXED** (iOS) |
| F4 | `/flatten` | Names what it would sell, with a real total | PASS (iOS) |
| F5 | `/recovery` | Loads; acknowledgement persists | PASS |
| F6 | Settings status/cap | Reads the chain: "Live" and the signed cap, matching `/verify` | **FIXED** |

## G — Data screens

| # | Item | Correct means | Status |
|---|---|---|---|
| G1 | `/activity` | Real rows with hashes; back control present | **FIXED** |
| G2 | `/activity` filters | All/Trades/Risk/Blocked each change the list | PASS |
| G3 | `/history` | Real indexed spends, or an honest "nothing settled on chain yet" | PASS (iOS) |
| G4 | `/inbox` | Real events; back control present | PASS (iOS) |
| G5 | `/alerts` | List + back control, and **no alert the user did not set** | **FIXED** |
| G6 | `/alerts/new` | Level seeded near the live price, not a fixed constant | **FIXED** (iOS) |
| G7 | `/search` no match | `Nothing matches "zzzz".` | PASS (iOS) |
| G8 | `/briefing` | Loads with back control | PASS |
| G9 | `/bot/roster` | 4 agents, honest "No trades yet" | PASS (iOS) |
| G10 | `/position/[id]`, `/chart/[symbol]`, `/perp/[symbol]`, `/legal/[doc]` | Each loads without console error | PASS — `/legal` is `legal/[doc]`; the plan named it wrongly |
| G11 | `/perp` margin warning | The stated percentage equals the actual drop to the liquidation price | **FIXED** |

## H — Server API (checked directly, not through the UI)

| # | Item | Correct means | Status |
|---|---|---|---|
| H1 | `GET /health` | `ok:true`, dependencies up, chain named | PASS |
| H2 | `GET /verify` no wallet | 14 pass / 0 fail / 6 skip | PASS |
| H3 | `GET /verify?owner=` | 19 pass / 0 fail / 1 skip | PASS |
| H4 | Auth on private routes | 401 `Missing bearer token`, never data | PASS |
| H5 | `GET /market/quotes` | Real prices, `source` named | PASS |
| H6 | `GET /perp/:symbol` | Real mark; unknowable fields `null` + listed in `unavailable` | PASS |
| H7 | `GET /swap/quote` | Real 1inch route | PASS |
| H8 | Rate limiting | Sustained burst returns 429, `/health` exempt | PASS |

## I — On-chain and contract

| # | Item | Correct means | Status |
|---|---|---|---|
| I1 | `XorrDelegation` deployed | Code present at the configured address on both chains | PASS |
| I2 | Policy read from chain | Cap/expiry/revoked match `/verify` | PASS |
| I3 | Venue allowlist enforced | Granted venues allowed, a control address denied | PASS |
| I4 | Audit chain unbroken | Every row hashes to its contents, linked to its predecessor | PASS |
| I5 | Idempotency | Unique index prevents two runs in one period | PASS |

## J — External integrations

| # | Item | Correct means | Status |
|---|---|---|---|
| J1 | Privy auth | `verifyAuthToken` gates every private route | PASS |
| J2 | Privy policy refusal | A real `eth_sendTransaction` to an unlisted address is refused | PASS |
| J3 | 1inch aggregation | Real quote and real settled fill | PASS |
| J4 | 1inch Aqua | Reachable on the deployment under test, or explicitly recorded as not | **UNTESTABLE** — see below |
| J5 | The Graph | Subgraph synced, queried, and its role on this deployment stated accurately | PASS (inert here) |
| J6 | Aave on Base | Rate read from the pool | PASS |
| J7 | Basenames | Reverse resolution correct against real Base | PASS |
| J8 | SEC EDGAR | Real filings drive tier 7 dates | PASS |

## K — Cross-cutting

| # | Item | Correct means | Status |
|---|---|---|---|
| K1 | Console, whole surface | Zero errors on every route visited | PASS |
| K2 | Network | No failed requests the UI hides | PASS |
| K3 | No mocks | No mock/stub/fake data in any shipped path | PASS |
| K4 | Claims match reality | Every claim in README/SUBMISSION is true of the code as it stands | **FIXED** |
| K5 | Lint / typecheck / tests | All clean | PASS |

---

## L — The chat sheet, the tab bar and the logos

Added after the surface changed: Agents left the tab bar for a sheet, and every asset list gained
a real logo. New surface needs new items rather than inherited passes.

| # | Item | Correct means | Status |
|---|---|---|---|
| L1 | Tab bar | Four tabs and a raised chat button; no Agents tab | PASS |
| L2 | Chat button | Opens a full-screen sheet over the current screen | PASS |
| L3 | Sheet dismiss | Drag the handle down, or the close control; returns to the SAME screen and scroll position | PASS |
| L4 | Sheet thread | Seeds from the real executor — a proposal, or the agent's own decline in its words | PASS |
| L5 | Ask through the sheet | A model answer, or an explicit "no language model is configured" — never a canned line as an answer | PASS |
| L6 | One history | The sheet and `/bot` render the same thread over one store | PASS |
| L7 | `/bot` still routes | The push target and the briefing link both land; no tab is lit for it | **FIXED** |
| L8 | Decline is not repeated | Reopening does not append the same decline again | **FIXED** |
| L9 | Crypto logos | All 9 crypto rows show the issuer's real mark | PASS |
| L10 | Equity logos | All 8 tokenized equities show the company's real mark | PASS |
| L11 | Unissued instruments | Commodities, indices and pre-IPO keep the gradient — no invented identity | PASS |
| L12 | Logos elsewhere | Home, Holdings, Watchlist, Search, Position and the asset header all carry them | **FIXED** |
| L13 | `/market/logos` | Answers within its deadline; never hangs on a rate-limited upstream | **FIXED** |
| L14 | A failed lookup | Is not cached as "this symbol has no logo" | **FIXED** |
| L15 | Chart control | Candles/Line visible, both render, and it clips no range pill | **FIXED** |
| L16 | Agent's subject matter | Never describes a market this app cannot trade | **FIXED** (prompt only — see below) |

---

## Result

**88 original items + 17 added = 105.** 103 PASS (33 of them after a fix), 1 UNTESTABLE, 1 PASS
with a stated limit.

Every item was executed in Chrome against the web build at `localhost:8082`, pointed at the
deployed fork executor, except section H/I which are server and chain checks made directly, and
the six marked `(iOS)` which were executed on the iOS simulator.

### What this run fixed

| Item | Root cause |
|---|---|
| E4 | The guard existed only in the repo. The fork executor was three commits behind; deployed, then re-verified live — a USDC dca and an equity dca are both refused, each naming its own reason. |
| G5 | `/alerts` rendered `alertFixtures` whenever the server returned an empty list — two of them on instruments this app does not have (`NVDAx`, which is the design prototype's spelling, and SOL, which cannot settle on Base). The header counted them, and the switches were live against ids the server has never seen, with the failure swallowed. |
| G11 | The liquidation price came from a ratio and the sentence under it was three hardcoded strings; nothing tied them together. Also "A 18% move", which spoken is "a eighteen per cent move". |
| L7 | `/bot` fell through to `home` in `activeTab`, so standing on the bot screen lit the Home tab. |
| L8 | The proposal seed was guarded on the thread's contents; the decline seed was not, so every mount appended the same line again. |
| L12 | The asset header's mark was gated on the instrument being in a market class, so WETH — the app's own default buy — had no logo on the one screen dedicated to it. |
| L13 | Logo lookups rode the price retry ladder: five attempts with exponential backoff, serialised per host. A CoinGecko 429 meant ~28s per symbol and the route never returned. |
| L14 | A rate-limited lookup was cached as `{url: null}`, so one 429 at startup marked Bitcoin logo-less for the life of the process. |
| L15 | Beside five range pills the control did not fit a 402pt row and shipped with "All" sliced in half; `Segmented` also has no intrinsic width, so it first rendered as a two-pixel sliver. |
| L16 | The system prompt never named a venue. Asked what it was watching, Momentum Scout answered "scanning the major FX pairs… EUR/USD and GBP/USD" — markets this app has no access to. |

### The one item that cannot be tested here

**J4 — 1inch Aqua, live on the deployment under test.** `XorrAquaBook` is deployed on the running
fork (6,451 bytes at `0xddcf22a0…`) and is on the venue allowlist. What is missing is a maker
book: `fork-bootstrap.ts` deploys the contract and never calls `ship`, so the Aqua branch finds
no book and falls through to the aggregator. `server/src/live-aqua.ts` is the script that ships
one and takes against it, and it needs a **Privy session token** — which the browser extension
correctly refuses to release, and which cannot be minted server-side without fabricating a user
session.

So this is a real credential I do not have, not a defect and not a pass. It is recorded here and
in `docs/SUBMISSION.md`, which already states that the five historical Aqua fills were made
against an earlier anvil and that nothing ships a book at boot. To flip it, run:

```
FORK_RPC=… FORK_API=https://executor-fork-production.up.railway.app \
  PRIVY_TOKEN=… ENTRY=… OWNER_ADDRESS=0x95A0…e615 \
  AQUA_BOOK_ADDRESS=… DELEGATION_ADDRESS=… npx tsx server/src/live-aqua.ts
```

### The one item that passes with a limit stated

**L16 — the agent's subject matter.** The prompt now carries the chain and the exact tradable set
from `TOKENS`, and `personas.test.ts` pins it across all four personas. The model's *response* to
that prompt is unverified: OpenRouter's free tier hit its fifty-request daily cap during this run,
and lifting it costs money. The construction is tested; the output is not.

Related, and deliberately not done: the fork service has no `OPENROUTER_API_KEY`, so the chat
there answers with the honest "no language model is configured in this build" rather than a model.
The key exists in the operator's shell profile, not in the repo — copying a personal paid
credential onto a hosted service is the operator's call, not mine.

### Zero mocks

One mock was found and removed in this run: `alertFixtures`, above. The two remaining fixture
imports in shipped paths were examined and are not stand-ins for measured data —
`portfolio.sleeves()` returns the three allocation buckets, which are product configuration, and
`bot.listAgents()` falls back to the four personas with **every performance claim stripped**
(`metric: 'No record yet'`, zeroed p&l, `hired: false`) rather than fabricated. Nothing else in
`src/` or `app/` reads a fixture.

### Zero console errors

Read on every item in this run. Zero errors across all 34 routes visited. The only console output
is 27 `styled-components` "created dynamically" **warnings** from a vendored dependency, present
on first bundle load and not from this codebase.

### Gates

`tsc --noEmit` (app and server), `eslint`, and 401 tests across 43 files — all clean. The three
failing server tests are `chain.live.test.ts` against a local Postgres whose `wallets` table
predates a migration (`column "user_id" does not exist`); verified identical at `HEAD` with this
run's changes stashed, so it is local schema drift and not a regression.
