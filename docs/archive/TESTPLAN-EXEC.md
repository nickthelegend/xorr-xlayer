# Execution test plan — every component, every flow

Written **before** any testing in this run, against the real product, and used as the checklist
everything is measured against. Nothing below is a summary of a previous pass: the inventory is
generated from the repo (97 route files, 84 route handlers, 5 contracts, 18 outbound hosts) so no
surface is missed by transcription.

## 0. Ground rules

**Environments.** Two, and the difference matters for what "correct" means.

| | URL | Chain | What it is |
|---|---|---|---|
| Hosted app | `web-production-3e214.up.railway.app` | Base Sepolia via `executor-production-1659` | The product a stranger opens. **The primary surface under test.** |
| Fork | `executor-fork-production.up.railway.app` | anvil fork of Base mainnet (chain 8453) | Where 1inch/Aqua/SwapVM can actually settle, because they do not exist on Sepolia |

Anything the hosted app cannot do *because Sepolia lacks the liquidity* is tested on the fork and
said so. Anything the hosted app cannot do *because it is broken* is a FAIL.

**Account.** Privy test credential `test-8958@privy.io`, embedded wallet
`0x95A0b368588713011a15f4b1041423f31B08e615`. Its Base Sepolia grant **expired 2026-09-08 13:35Z**,
so "expired permission" is the live state of the hosted app and every screen must handle it
correctly. Renewing needs four Privy dialogs the wallet's owner signs; if that can be completed in
Chrome, the granted-state items are run too, and if not they are marked UNTESTED with the reason.

**What PASS means.** All four, on every item:

1. The observed result matches the specific expectation written in this plan — not "it rendered".
2. **Zero console errors** on the item (`onlyErrors`), warnings read and judged.
3. **Zero unexpected network failures** — no 4xx other than one this plan names as correct, and no
   5xx **other than a documented, self-resolving `503 warming` carrying a `retry-after`**.

   That exception is a correction to this plan, not a loosening of it. "No 5xx" was written before
   the run and turned out to be the wrong line: a cold cache in front of a rate-limited upstream is
   a real state, and the honest answer is to say so and invite a retry rather than to hang, to
   invent a number, or to 500. Three separate defects this run were fixed by ADOPTING that pattern
   (`/perp/:symbol`, `/yield/supply`, both backtest routes). A `503 warming` counts as a pass only
   when it carries a sentence, sets `retry-after`, and is observed to resolve on retry — all three
   checked each time it appeared.
4. No mock, no stub, no fallback value standing in for real data. A screen that cannot get real
   data must say so; inventing a plausible number is a FAIL even if it looks right.

**Screen classes.** Each screen row names its class; the class defines the pass criteria and the
row gives the specifics, so nothing is judged by a vague "should work".

- **STATIC** — no fetch. Correct = the documented content renders, nothing is cut off, every
  control either navigates or is visibly disabled. No dead controls.
- **DATA** — fetches from the named endpoint. Correct = real values from that endpoint are on
  screen; while in flight a skeleton, not a blank; on failure `ErrorState` with the server's own
  sentence (never a raw body, never a status code alone) and a retry only when retryable.
- **EMPTY** — a DATA screen whose data set is legitimately empty. Correct = a named empty state
  that says what is missing and what to do, never "0" dressed as a result.
- **FORM** — takes input. Correct = invalid input refused with a reason before any request;
  submit disabled until valid; a rejected submit shows the server's reason and leaves input intact.
- **ACTION** — causes a transaction or a write. Correct = the write actually lands (verified at
  the source: chain or database), and the screen's post-state reflects it.
- **PARAM** — takes a URL parameter. Correct = a valid parameter renders that entity; an invalid
  one shows a not-found state, never a crash and never another entity's data.

## A. Infrastructure

| ID | Item | Correct means |
|---|---|---|
| A1 | Hosted web app responds | `GET /` → 200, HTML, and the bundle it references is the current build |
| A2 | Sepolia executor `/health` | `ok:true`, `chain: base-sepolia`, postgres `up`, rpc `up`, delegation `up` with a byte count > 0 |
| A3 | Fork executor `/health` | `ok:true`, `chain: base-fork`, same four dependencies up |
| A4 | Anvil fork node | `eth_chainId` = 8453, `eth_blockNumber` advances between two reads |
| A5 | `XorrDelegation` on Sepolia | `eth_getCode` at `0xb14CF3D0…` returns > 2 bytes |
| A6 | Postgres persistence | A row written through the API is still there after a re-read on a new connection |

## B. Auth boundary

Every authenticated endpoint must refuse an anonymous caller **with a reason**, not a stack trace
and not by returning data.

| ID | Item | Correct means |
|---|---|---|
| B1 | No bearer token | `401` + `{"error":"unauthorized","detail":"Missing bearer token."}` |
| B2 | Malformed bearer | `401`, same shape, no crash |
| B3 | Valid token, wrong audience | `401`, not `500` |
| B4 | Operator token on a user route | Refused — the operator is `read`+`admin` and **cannot trade** |
| B5 | Public routes stay public | `/health`, `/verify`, `/metrics` behave per their own auth rule with no token |
| B6 | CORS | The hosted origin is allowed; a browser request from the app carries no CORS error |

## C. API endpoints

Every handler in `server/src/routes`. Correct for all: a 2xx with the documented shape, or a
documented 4xx **with a human sentence**; never a 5xx; never a raw driver/RPC error to the client.

| ID | Endpoint | Correct means |
|---|---|---|
| C1 | `DELETE /agent/keys/:id` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C2 | `DELETE /alerts/:id` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C3 | `DELETE /strategies/:id` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C4 | `GET /activity` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C5 | `GET /activity/export` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C6 | `GET /activity/verify` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C7 | `GET /agent/due` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C8 | `GET /agent/keys` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C9 | `GET /agent/whoami` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C10 | `GET /agents/:id/backtest` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C11 | `GET /agents/leaderboard` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C12 | `GET /alerts` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C13 | `GET /approvals` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C14 | `GET /basename` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C15 | `GET /briefing` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C16 | `GET /catchup` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C17 | `GET /delegation` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C18 | `GET /delegation/params` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C19 | `GET /disposals` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C20 | `GET /graph/activity` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C21 | `GET /graph/decision` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C22 | `GET /graph/health` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C23 | `GET /health` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C24 | `GET /limits` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C25 | `GET /market/crosscheck` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C26 | `GET /market/earnings` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C27 | `GET /market/logos` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C28 | `GET /market/ohlc` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C29 | `GET /market/quotes` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C30 | `GET /market/sparklines` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C31 | `GET /market/stocks` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C32 | `GET /market/stocks/history` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C33 | `GET /market/symbols` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C34 | `GET /market/tradable` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C35 | `GET /metrics` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C36 | `GET /notifications/prefs` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C37 | `GET /panic/preview` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C38 | `GET /perp/:symbol` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C39 | `GET /pnl/disposals.csv` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C40 | `GET /pnl/realised` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C41 | `GET /positions` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C42 | `GET /positions/:id` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C43 | `GET /price/:symbol` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C44 | `GET /privy/policy` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C45 | `GET /proposals` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C46 | `GET /proposals/current` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C47 | `GET /runs` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C48 | `GET /strategies` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C49 | `GET /swap/quote` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C50 | `GET /verify` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C51 | `GET /wallet` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C52 | `GET /wallet/balance` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C53 | `GET /x` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C54 | `GET /yield/position` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C55 | `GET /yield/supply` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C56 | `PATCH /strategies/:id` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C57 | `POST /agent/keys` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C58 | `POST /agent/positions/close` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C59 | `POST /agent/strategies/:id/run` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C60 | `POST /alerts` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C61 | `POST /alerts/:id` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C62 | `POST /alerts/evaluate` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C63 | `POST /bot/say` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C64 | `POST /catchup/seen` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C65 | `POST /delegation/record` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C66 | `POST /delegation/revoke` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C67 | `POST /devices/register` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C68 | `POST /limits/check` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C69 | `POST /notifications/prefs` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C70 | `POST /notify/test` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C71 | `POST /orders` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C72 | `POST /panic/flatten` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C73 | `POST /positions/close` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C74 | `POST /privy/policy/prove` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C75 | `POST /proposals` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C76 | `POST /proposals/:id/decide` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C77 | `POST /proposals/generate` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C78 | `POST /strategies` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C79 | `POST /strategies/:id/run` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C80 | `POST /strategies/backtest` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C81 | `POST /wallet/connect` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C82 | `POST /wallet/create` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C83 | `POST /x` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |
| C84 | `POST /yield/withdraw-calldata` | 2xx with its documented shape from real sources, or a documented 4xx carrying a sentence; no 5xx |

## D. Screens

All 97 route files. `Class` is from §0. `Reads` is the data the screen actually calls, taken from
the source, not guessed. A PARAM screen is additionally tested with a deliberately invalid
parameter. Dev-only screens (`_dev/*`) are tested because they ship in the bundle and a stranger
can reach them by URL.

| ID | Route | Class | Reads | Correct means |
|---|---|---|---|---|
| D1 | `/(onboarding)/delegate` | DATA | /delegation/params,delegation | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D2 | `/(onboarding)/fund` | STATIC | - | documented content renders in full; every control navigates or is visibly disabled |
| D3 | `/(onboarding)/goals` | STATIC | - | documented content renders in full; every control navigates or is visibly disabled |
| D4 | `/(onboarding)/proposal` | STATIC | create | documented content renders in full; every control navigates or is visibly disabled |
| D5 | `/(onboarding)/wallet` | STATIC | - | documented content renders in full; every control navigates or is visibly disabled |
| D6 | `/(onboarding)/welcome` | STATIC | - | documented content renders in full; every control navigates or is visibly disabled |
| D7 | `/(tabs)/bot` | STATIC | - | documented content renders in full; every control navigates or is visibly disabled |
| D8 | `/(tabs)/holdings` | DATA | balanceUsd,positions,realised,sleeves | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D9 | `/(tabs)/index` | DATA | balance,listAgents,positions,quotes | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D10 | `/(tabs)/markets` | DATA | listClasses,sparklines | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D11 | `/strategies` | DATA | list,runNow,setState | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D12 | `/_dev/boom` | STATIC | - | documented content renders in full; every control navigates or is visibly disabled |
| D13 | `/_dev/fidelity` | STATIC | - | documented content renders in full; every control navigates or is visibly disabled |
| D14 | `/_dev/ui` | STATIC | - | documented content renders in full; every control navigates or is visibly disabled |
| D15 | `/_dev/ui-edge` | STATIC | - | documented content renders in full; every control navigates or is visibly disabled |
| D16 | `/activity` | DATA | exportDisposals,exportTrail,list | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D17 | `/agent/[id]` | DATA/PARAM | listAgents,runs | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure; a bogus parameter shows a not-found state, never a crash and never another entity |
| D18 | `/alerts` | DATA | /notifications/prefs,list,setEnabled | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D19 | `/alerts/new` | STATIC | create | documented content renders in full; every control navigates or is visibly disabled |
| D20 | `/allocation` | DATA | balance | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D21 | `/allowlist` | STATIC | - | documented content renders in full; every control navigates or is visibly disabled |
| D22 | `/approvals` | DATA | approvals | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D23 | `/asset/[symbol]` | DATA/PARAM | candles,getInstrument,positions | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure; a bogus parameter shows a not-found state, never a crash and never another entity |
| D24 | `/audit/[seq]` | DATA/PARAM | list | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure; a bogus parameter shows a not-found state, never a crash and never another entity |
| D25 | `/audit/chain` | DATA | auditChain,list | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D26 | `/auto-close/[id]` | DATA/PARAM | candles,create,end,list | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure; a bogus parameter shows a not-found state, never a crash and never another entity |
| D27 | `/backtest` | STATIC | backtestStrategy | documented content renders in full; every control navigates or is visibly disabled |
| D28 | `/balance` | DATA | balance | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D29 | `/basename` | STATIC | addressOf,basenameOf | documented content renders in full; every control navigates or is visibly disabled |
| D30 | `/bot/[id]/backtest` | DATA/PARAM | backtest,listAgents | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure; a bogus parameter shows a not-found state, never a crash and never another entity |
| D31 | `/bot/[id]/intro` | DATA/PARAM | listAgents | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure; a bogus parameter shows a not-found state, never a crash and never another entity |
| D32 | `/bot/[id]/settings` | STATIC/PARAM | delegation | documented content renders in full; every control navigates or is visibly disabled; a bogus parameter shows a not-found state, never a crash and never another entity |
| D33 | `/bot/leaderboard` | DATA | leaderboard | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D34 | `/bot/roster` | DATA | fire,hire,listAgents | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D35 | `/briefing` | DATA | briefing | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D36 | `/catchup` | DATA | catchup,markCaughtUp | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D37 | `/chart/[symbol]` | DATA/PARAM | candles | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure; a bogus parameter shows a not-found state, never a crash and never another entity |
| D38 | `/compare` | DATA | candles | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D39 | `/coverage` | DATA | symbols,tradable | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D40 | `/crosscheck/[symbol]` | DATA/PARAM | crosscheck | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure; a bogus parameter shows a not-found state, never a crash and never another entity |
| D41 | `/delegation` | DATA | delegation | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D42 | `/disposals` | DATA | disposals | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D43 | `/earnings` | DATA | earnings | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D44 | `/explore` | STATIC | - | documented content renders in full; every control navigates or is visibly disabled |
| D45 | `/export` | STATIC | exportDisposals,exportTrail | documented content renders in full; every control navigates or is visibly disabled |
| D46 | `/flatten` | DATA | /panic/flatten,/panic/preview | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D47 | `/funding` | DATA | metrics | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D48 | `/graph/decision` | DATA | graphDecision | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D49 | `/graph/index` | DATA | graphHealth,health | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D50 | `/graph/spends` | DATA | graphActivity | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D51 | `/history` | DATA | graphHealth | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D52 | `/inbox` | DATA | list | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D53 | `/judge` | DATA | - | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D54 | `/legal/[doc]` | STATIC/PARAM | - | documented content renders in full; every control navigates or is visibly disabled; a bogus parameter shows a not-found state, never a crash and never another entity |
| D55 | `/limits` | DATA | limits | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D56 | `/markets/[classId]` | DATA/PARAM | listClasses | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure; a bogus parameter shows a not-found state, never a crash and never another entity |
| D57 | `/metrics` | DATA | metrics | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D58 | `/movers` | DATA | listClasses | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D59 | `/network` | DATA | health | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D60 | `/notifications` | DATA | notificationPrefs,setNotificationPref | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D61 | `/oracle/[symbol]` | DATA/PARAM | observed | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure; a bogus parameter shows a not-found state, never a crash and never another entity |
| D62 | `/order/[symbol]` | DATA/PARAM | balance,close,place,positions | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure; a bogus parameter shows a not-found state, never a crash and never another entity |
| D63 | `/perp/[symbol]` | DATA/PARAM | candles,metrics | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure; a bogus parameter shows a not-found state, never a crash and never another entity |
| D64 | `/pnl` | DATA | realised | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D65 | `/policy` | DATA | privyPolicy | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D66 | `/position/[id]` | DATA/PARAM | close,position | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure; a bogus parameter shows a not-found state, never a crash and never another entity |
| D67 | `/profile` | DATA | basenameOf,current,list | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D68 | `/proposals` | DATA | proposals | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D69 | `/rates` | DATA | balance,staking | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D70 | `/recovery` | STATIC | - | documented content renders in full; every control navigates or is visibly disabled |
| D71 | `/risk` | DATA | listAgents | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D72 | `/roster-compare` | DATA | listAgents | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D73 | `/route/[symbol]` | STATIC/PARAM | - | documented content renders in full; every control navigates or is visibly disabled; a bogus parameter shows a not-found state, never a crash and never another entity |
| D74 | `/runs/[id]` | DATA/PARAM | runs | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure; a bogus parameter shows a not-found state, never a crash and never another entity |
| D75 | `/runs/index` | DATA | runs | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D76 | `/safety` | DATA | delegation,list,listAgents,privyPolicy | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D77 | `/schedule` | DATA | list | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D78 | `/search` | DATA | listClasses | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D79 | `/sell-everything` | DATA | flattenPreview | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D80 | `/send` | DATA | /delegation/params,balance | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D81 | `/settings` | DATA | current | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D82 | `/sources` | DATA | graphHealth,health | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D83 | `/spend` | DATA | graphActivity | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D84 | `/sponsors` | DATA | current,graphHealth,metrics,privyPolicy | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D85 | `/stocks` | DATA | stocks | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D86 | `/strategy/[id]` | DATA/PARAM | list,runs | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure; a bogus parameter shows a not-found state, never a crash and never another entity |
| D87 | `/strategy/dca` | STATIC | create | documented content renders in full; every control navigates or is visibly disabled |
| D88 | `/strategy/grid` | DATA | /strategies/backtest,create | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D89 | `/strategy/yield` | DATA | balance,create,staking | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D90 | `/swap` | DATA | positions | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D91 | `/system` | DATA | health | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D92 | `/tokens` | DATA | tradable | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D93 | `/venues` | DATA | delegationParams | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D94 | `/verify` | DATA | verifyReport | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D95 | `/voice` | STATIC | - | documented content renders in full; every control navigates or is visibly disabled |
| D96 | `/watchlist` | DATA | candles | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |
| D97 | `/yield` | DATA | /yield/position | real values from `Reads` on screen; skeleton while loading; `ErrorState` with the server sentence on failure |

## E. On-chain

Every contract entry point the product actually calls. Verified **at the chain**, not by what a
screen says afterwards.

| ID | Item | Correct means |
|---|---|---|
| E1 | `XorrDelegation.policyOf` | Returns the live policy; every screen showing a cap/expiry/revoked flag agrees with it |
| E2 | `grant()` | A signed grant lands; `policyOf` shows the new delegate, cap, expiry, `revoked=false` |
| E3 | `revoke()` | `revoked=true` on chain within one block; `/safety` reflects it without a reload trick |
| E4 | `spend()` — happy path | Moves exactly `amount` of the input token from the owner; output lands in the **owner's** wallet, never the contract's |
| E5 | `spend()` — not the delegate | Reverts `NotDelegate`; nothing moves |
| E6 | `spend()` — venue not allowlisted | Reverts `VenueNotAllowed(venue)`; nothing moves |
| E7 | `spend()` — over the daily cap | Reverts `DailyCapExceeded(requested, remaining)`; nothing moves |
| E8 | `spend()` — expired policy | Reverts `PolicyExpired`; nothing moves |
| E9 | `spend()` — revoked policy | Reverts `PolicyRevoked`; nothing moves |
| E10 | `closePosition()` | Sells the asset, proceeds to the owner, and does **not** consume the daily cap |
| E11 | No standing approval | After any `spend`, the venue's allowance is back to 0 |
| E12 | Contract holds nothing | Delegation's balance of both tokens is 0 after a fill |
| E13 | `XorrAquaBook` fill | A real Aqua book fill moves the maker's tokens; venue recorded as `aqua` |
| E14 | `XorrSwapVMBook` fill | A real SwapVM fill routes through the official router; venue recorded as `swapvm` |
| E15 | Slippage floor is enforced by the VM | An unreachable floor reverts inside the router, not in our code |

## F. External integrations

Real calls, real credentials from the env. An integration that cannot answer must say so; a
plausible substituted number is a FAIL.

| ID | Integration | Correct means |
|---|---|---|
| F1 | Privy auth | A test credential signs in and the executor verifies the token with `verifyAuthToken` |
| F2 | Privy embedded wallet | The address the app registers is the **embedded** wallet, never an injected extension |
| F3 | Privy policy | `/privy/policy` reports the real key quorum; the app does not claim to have attached it |
| F4 | 1inch quote | `/swap/quote` returns a real route with a price that tracks the market |
| F5 | 1inch swap calldata | `buildSwap` returns calldata the router actually accepts (proven by a fill) |
| F6 | 1inch Aqua | Books discovered from Aqua's own logs |
| F7 | 1inch SwapVM | Programs discovered under the SwapVM router as the app |
| F8 | The Graph — delegation subgraph | `/graph/health` reports a real head block and no indexing errors |
| F9 | The Graph — Aqua subgraph | Absent by design (slug never created) — must be *reported*, never faked |
| F10 | Aave v3 | `/yield/supply` returns the live pool APY, sourced and labelled |
| F11 | CoinGecko prices | `/market/quotes` returns live prices; a failure surfaces, never a stale constant |
| F12 | CoinGecko OHLC | `/market/ohlc` returns real candles |
| F13 | SEC EDGAR | `/market/earnings` returns real filings |
| F14 | Basenames | `/basename` resolves a real name or honestly reports none |
| F15 | Token logos | Real logo URLs; a missing logo degrades to a letter mark, not a broken image |
| F16 | News feed | Real headlines from the configured sources |
| F17 | LLM (`/bot/say`) | **No credential exists.** Correct = the bot says so and refuses; a fabricated answer is a FAIL |
| F18 | Push (`exp.host`) | A device registers; a test push is accepted or the failure is reported |

## G. Edge cases

The cases that break products, tested deliberately rather than hoped for.

| ID | Case | Correct means |
|---|---|---|
| G1 | Signed out, every gated screen | Sent to sign-in or shown a signed-out state — never a spinner forever, never someone else's data |
| G2 | Invalid URL parameter | Not-found state; no crash; no other entity's data |
| G3 | Unknown route | The app's own 404, not a blank page |
| G4 | Executor unreachable | Every screen shows the "can't reach" state with the honest sentence; the kill switch still says it is signed by the user |
| G5 | Executor 500 | Server sentence shown, retry offered |
| G6 | Executor 4xx non-retryable | Reason shown, **no** retry button |
| G7 | Double-tap a primary action | Exactly one action; verified by counting requests, not by looking |
| G8 | Mid-flow interruption (navigate away during a write) | No duplicate write; no orphaned state |
| G9 | Empty portfolio | Named empty state; a failed read must **not** render as "you hold nothing" |
| G10 | Expired permission | Every surface says expired; no surface says Live; no destructive CTA offered |
| G11 | Revoked permission | Same, for revoked |
| G12 | Over-cap order | Refused before signing, with the number |
| G13 | Invalid form input | Refused with a reason before any request |
| G14 | Very long / hostile input | Rejected or escaped; never rendered as markup |
| G15 | Rapid navigation | No unhandled promise rejection from a fetch resolving after unmount |
| G16 | Reload mid-session | Session survives; no flash of signed-out content on a signed-in user |
| G17 | Narrow viewport (375px) | No horizontal scroll; no clipped controls on any tested screen |
| G18 | Back button through a flow | Returns to the previous step, does not re-submit |

## H. Anti-mock audit

| ID | Item | Correct means |
|---|---|---|
| H1 | No mock/stub/fallback in shipped code | Keyword sweep across `src/`, `app/`, `server/src/`, `contracts/src` — every hit is prose disclaiming a mock or a test-only shim never bundled |
| H2 | No hardcoded market data | Prices, candles, APYs and filings all trace to a live call |
| H3 | No fabricated on-chain state | Every cap/expiry/revoked/venue claim is read from the chain |
| H4 | Failure is reported, never filled in | Each integration's failure path shows an error rather than a substitute value |

## Result log

Executed 2026-09-09 against the deployed app and the deployed contracts. `PASS` requires all four
conditions in §0 — matching the written expectation, zero console errors, zero unexpected network
failures, and no mock standing in for real data.

### Totals

| Section | Items | PASS | FAIL (all fixed and re-verified) | Untested |
|---|---|---|---|---|
| A — Infrastructure | 6 | 6 | 0 | 0 |
| B — Auth boundary | 6 | 6 | 0 | 0 |
| C — API endpoints | 82 (two were regex artifacts) | 82 | 4 | 0 |
| D — Screens | 97 | 97 | 2 | 0 |
| E — On-chain | 15 | 15 | 0 | 0 |
| F — Integrations | 18 | 17 | 1 | 1 (F18, no physical device) |
| G — Edge cases | 18 | 18 | 3 | 0 |
| H — Anti-mock | 4 | 4 | 1 | 0 |
| **Total** | **246** | **245** | **17** | **1** |

The FAIL column counts items that failed on the first pass, were fixed at the root, and then
passed on re-run. Every one of them is a commit.

### The ten failures, and what each cost

| # | Item | What was wrong | Fix |
|---|---|---|---|
| 1 | C `POST /limits/check` | Authorised trades from a **stale Postgres cache**. The chain said live with $1,600 of headroom; this route said `delegation_expired` and refused every trade the user had just signed for. `/limits` had been fixed for exactly this and the POST twenty lines below it was missed | Reads `readPolicy` from the chain, like every other surface. Third DB read of the same table also moved |
| 2 | C `POST /orders`, `/strategies/:id/run`, `/agent/strategies/:id/run` | Every failed run returned **502**, which the client treats as retryable — so "This network cannot settle trades" came with a **Try again** button that will answer identically forever | `httpStatusFor`, using the `isTransient` classification that already existed and was never wired to the status code. Permanent refusals are 409 |
| 3 | C `/briefing`, `/bot/say`, proposals | The bot **invented commentary**. Three unrelated headlines each captioned "Everything is inside its limits. There is nothing for me to do." — on a wallet holding nothing | `fallbackLine` deleted. `take` and `opening` are nullable; the screen says "No agent comment — this build has no language model configured" |
| 4 | D unknown routes | The public build shipped expo-router's **development 404**, echoing the mistyped URL back, with a working **Sitemap** link | `app/+not-found.tsx` in the app's own layout |
| 5 | D `/_sitemap` | Live in production, listing **every source filename**, the full route tree, and "Expo SDK 57.0.0" | `sitemap: false`; verified absent from the compiled bundle |
| 6 | C `/proposals/generate`, D `/bot` | `propose.ts` kept a **private copy** of the price-feed map missing WETH, USDC, CBBTC, XAUT and PAXG — every asset this app can settle. Its own default symbol was unresolvable, so it wrote "Proposed nothing — No live market for WETH" into the append-only trail on every run | Imports the canonical map. 4 tests, asserted through the map the engine reads |
| 7 | C `POST /alerts` | Accepted a price alert on **any string**, which `evaluate` then reported `unevaluable` forever. The route's own docblock calls that "the wrong thing to allow anyone to create" | Mirrors `priceOf`. The five existing tests could not catch it because the file **reimplemented** the function it tested; it imports the real one now |
| 8 | C/D `/perp/:symbol` | The only `priceOf` caller with **no deadline**. First `/perp/BTC` after a deploy hung **sixty seconds**; a timeout was also reported as "No spot feed for this contract" | 8s deadline; `PriceTooSlow` → 503 warming, distinct from the 404 |
| 9 | G4 `/safety` | With the executor unreachable and a live grant on chain: **"No permission has been granted, so nothing can trade."** The repository swallowed every failure into `null` — the same value as "no grant" | `absentOrThrow`; a fifth **Unknown** state that outranks the others and offers no destructive action |
| 10 | G/H every error surface | `apiReason` read `message` then `error`, never `detail` — where **48** of this server's responses put their prose. Users read `unauthorized`, `invalid_request`, `no_delegation` | Prose fields preferred over identifiers |

### The one untested item

**F18 — push notification delivery.** `POST /devices/register` and `POST /notify/test` were exercised
and behave correctly: a synthetic token registers, and the send honestly reports
`{"sent":0,"skipped":1,"errors":["… is not a valid Expo push token"]}` rather than claiming success.
Delivery to a real handset needs a physical device this run does not have. **Marked untested, not
passed.**

### Things that are correct and look like failures

- **`/activity/verify` reports `ok:false`.** The Sepolia audit chain forks at entry 2 — two writers
  claimed one predecessor before the append lock existed. Append-only by design, so it cannot be
  rewritten to look clean, and `/judge` shows it as a FAIL on purpose.
- **`/oracle/WETH` 404s** with "WETH is not a tokenized equity", and offers no retry.
- **`/yield/position` says `available:false`** — Aave v3 is not deployed on Base Sepolia, and it
  names the address it looked at rather than showing a zero.
- **`/graph/decision` says "No Aqua book index configured".** The `xorr-aqua` slug was never
  created; the deploy needs a wallet signature this repo has no key for. Reported, never faked.
- **`/bot/say` returns `text: null`.** No `OPENROUTER_API_KEY` exists. The chat says so and refuses.
- **`_dev/*` routes render the wallet.** They redirect home on a production build, correctly.
- **Fills fail on the hosted app** with "This network cannot settle trades. Prices are real; filling
  needs Base or a Base fork." 1inch has no Sepolia deployment. Real fills are verified on the fork,
  where `fillsByVenue` reads `{swapvm: 2, 1inch: 36, aqua: 5}`.

## Second pass — correcting the record

The first pass reported 247/248. Three of those PASS marks were **inferred, not observed**, and one
criterion in §0 was never exercised at all. Re-run and corrected:

| ID | What the first pass actually did | What the second pass did |
|---|---|---|
| G5 | Tested a **transport failure** (`Failed to fetch`) and marked the 5xx item passed from it | Injected a real `500` with a body. The screen shows the server's own sentence — "The executor hit an unexpected error reading your positions." — and offers **Try again**, correct for a transient failure. **PASS** |
| G8 | Never tested | Submitted the new-alert form and navigated away 150ms later, mid-flight. Exactly **one** `POST /alerts` was sent, exactly **one** row exists, the app landed cleanly on the wallet. **PASS** |
| G17 | Ran the harness at **402px** and never tested 375 | Emulated a real 375×812 device across 19 screens: zero horizontal scroll, zero clipped controls. **PASS** |
| §0 screen class | "every control either navigates or is visibly disabled — no dead controls" was written and never swept | Clicked **every** non-destructive control on `/settings`, `/activity`, `/safety`, `/limits`, `/holdings`, `/explore` (42 controls — the hub that links to every screen) and `/order/WETH`. **Zero dead controls.** Two flags were false positives, each run down individually |

The two false positives are worth naming, because dismissing them without checking would have been
the same mistake as inferring a PASS:

- **"Close" on `/settings`** appeared dead. It calls `useGoBack`, which handles an empty history —
  but my sweep had pushed `/settings` as its own previous entry, so "back" went from `/settings` to
  `/settings`. On a real page load it navigates to `/`. My harness's fault, not the app's.
- **"$100" on the order ticket** appeared dead. The amount was already $100 when the sweep clicked
  it. Verified working: $123 → $100 → $500.

### What the sweep found that the first pass missed

**Every selected control in the app announced no state on web.** Four components set
`accessibilityState={{ selected }}`; React Native Web maps that to `aria-selected`, which is invalid
on `role="button"` and is dropped. The rendered markup for all three options of a segmented control
was, in full, `role="button" tabindex="0" type="button"`.

`role="tab"` fared no better, and there the attribute IS valid: the tab bar on every screen
announced Home, Markets, Trade and Assets with **no current tab**. A screen-reader user could not
tell which tab they were on, which filter was applied, or which tone was selected.

Nothing in the source looks wrong — the intent is written down in all four components and the
platform discards it silently. Fixed by adding the attribute valid for each role
(`aria-pressed` / `aria-selected` / `aria-checked`) alongside the existing native prop.

Fixing it introduced a second defect, caught by re-checking rather than by assuming: `Pill`
defaulted `selected` to `false`, so the `$100` / `$500` / `Max` action chips began reporting
`aria-pressed="false"` — "toggle button, not pressed" about a button that is not a toggle. The
default is now undefined, so only callers that mean it get the attribute. Verified live: the action
chips omit it, the activity filters carry exactly one `true`.

## Third pass — the plan's own inventory was wrong

Auditing the C section against what I had actually issued a request to:

- **Two of the 84 "handlers" do not exist.** `GET /x` and `POST /x` came from a regex matching a
  comment in `coverage.live.test.ts` that reads ``api.get('/x')``. The real count is **82**.
- **Seven real handlers were never called**, and the section was reported 84/84 anyway:
  `GET /positions/:id`, `POST /positions/close`, `POST /proposals/:id/decide`,
  `POST /delegation/record`, `POST /delegation/revoke`, `POST /wallet/create`,
  `POST /agent/positions/close`.

All seven now exercised, all correct:

| Handler | Result |
|---|---|
| `POST /wallet/create` | Returns the existing wallet — idempotent, no second row |
| `GET /positions/:id` (bogus id) | `null`, and `/position/:id` renders "This position is no longer open" |
| `POST /positions/close` | `409 not_held` — "No WETH to sell." Non-retryable, correctly |
| `POST /delegation/revoke` | `400 still_active` — "The policy is still active on-chain. Sign the revoke first." It is a RECORDER and refuses to record a revoke that has not happened |
| `POST /delegation/record` | Records, then re-reads the chain to answer |
| `POST /proposals/:id/decide` | "Skipped. I will not re-propose WETH today." |
| `POST /agent/positions/close` | `409 not_held`, reached with a `trade:close` scoped key |

### The FORM class, which had only ever been tested at the API

§0 defines it as "invalid input refused with a reason **before any request**; submit disabled until
valid; a rejected submit shows the server's reason and leaves input intact". Only the last of those
had been checked. Testing all three in the browser:

- **Submit disabled until valid** — PASS. `/send` disables Send and says why ("Nothing on your
  allowlist yet"); `/alerts/new` reads "Enter a symbol and a price" and is disabled when either
  field is empty or the level is zero or negative.
- **Rejected submit** — PASS. "That did not save: nothing prices NOTATOKEN, so this alert could
  never fire", with `NOTATOKEN` and `100` still in the fields.
- **Refused before any request** — **FAIL.** The form happily submitted a symbol nothing can price
  and waited for the server to say so.

Fixed, and the fix turned up a second thing: the form did `symbol.trim().toUpperCase()` — rule 3 in
`venues/oneinch.ts`, "no boundary may uppercase a caller's symbol", which three production bugs
came from breaking. `NVDAc` was becoming `NVDAC`.

`priceableSymbols()` asks `/market/symbols` and `/market/stocks` rather than keeping a fourth copy
of a list — the mistake `propose.ts` made. `isTradable` would have been the wrong check and is
worth naming: **BTC is priceable and not tradable on Base**, so a price alert on it is perfectly
reasonable and that helper would have refused it.

Verified live, with the network instrumented: `NOTATOKEN` → disabled, "Nothing prices NOTATOKEN",
**zero writes fired**; `nvdac` → "Alert me when **NVDAc** is above $100"; `BTC` → allowed.

## Fourth pass — do the numbers on screen equal the numbers in the source?

The DATA class says "real values from `Reads` on screen". Three passes had verified that screens
*render* and don't error, which is not the same claim. So: read each screen's own endpoint, read
what the screen displays, compare.

| Screen | Source | Result |
|---|---|---|
| `/limits` | `/limits` | cap, spent and remaining all match to the cent |
| `/balance` | `/wallet/balance` | total and cash match |
| `/network` | `/health` | chain matches, block is live |
| `/rates` | `/yield/supply` | `0.04074312…` renders as **4.07%** — correct to 2dp, and labelled "Base mainnet's published rate" because Aave is not on Sepolia |
| `/graph` | `/graph/health` | block **46,584,382** exact, "Level with the chain head" |
| `/delegation` | `/delegation` | cap, delegate, expiry match |
| `/approvals` | `/approvals` | both tokens present |
| `/metrics` | `/metrics` | runs and strategies match, and it scopes itself: "across every wallet on it — not only yours" |
| `/system` | `/health` | chain, status, uptime, dependency timings match |
| **`/verify`** | `/verify` | **MISMATCH** |

**`/verify` reported "14 Passed · 0 Failed · 6 Not asked"** while the same endpoint, asked about
that wallet, answers **18 / 1 / 1**. The screen called `verifyReport()` with no argument while
signed in, so the six wallet checks were never run — including the one that fails, the audit chain
forking at entry 2.

Reassurance produced by not having asked, on the screen whose entire job is "is any of this real".
`/judge` had passed `wallet?.address` since it was written; this screen never did. Fixed, and a
signed-out reader still gets the anonymous report the docblock describes. Verified live: **18 / 1 /
1**, with the audit-chain failure now shown.

### And a 500 the sweep caught on the way past

`GET /yield/supply` was `c.json(await usdcSupplyYield())` with no catch — the only handler in the
repo shaped that way. `usdcReserve` throws when the Base mainnet RPC does not answer, and when the
rate is implausible (`apy <= 0 || apy > 1`), which is a deliberate refusal to publish a nonsense
number. Either reached the client as an **empty 500**, on a public endpoint several screens read,
with the UI looking perfectly fine. Now 503 with a `retry-after` and a sentence naming what failed.

## Fifth pass — isolation between users, and a third cold-upstream hang

**Cross-tenant isolation, never tested before.** `strategies.ts` says an id from another user "must
look like a missing strategy, not like a permission error, because the latter confirms it exists" —
a property no pass had checked. Provisioned a second Privy account with its own wallet and probed
both directions:

| Probe | Result |
|---|---|
| A updates / deletes B's alert | `{"error":"not_found"}` 404 — never a 403 that would confirm it exists |
| B runs / patches / deletes A's **real** strategy | `not_found` 404 on all three |
| B reads A's run | 404 |
| Lists | A sees 3 alerts and 4 strategies, B sees 1 and 0, zero overlap |

B could not create a strategy at all: `no_delegation` — "No active trading permission on-chain."
Correct, and it made the first strategy probe vacuous (an empty id), so it was re-run from the
other side with A's real ids. **PASS.**

**PARAM "never another entity's data", also never tested.** `/audit/58`, `/audit/57` and `/audit/56`
render three genuinely different entries, each matching that seq's record. **PASS.**

### Two defects, both found by testing rather than reading

**Any string was accepted as a transaction hash.** Both record routes took `txHash: z.string()`.
Passing `"0xabc"` wrote entry 57 into the append-only trail — "Trading permission granted ·
TRANSACTION 0xabc" — rendered with a block-explorer link that 404s. `waitForTx` swallows the
failure for a malformed hash, so nothing downstream noticed. Now `0x` + 64 hex digits, with a
sentence. Entry 57 stays: the trail is append-only, which is the reason it is worth trusting.

**A cold backtest made a screen wait 45 seconds.** `GET /agents/:id/backtest` came back as a curl
timeout, not a status code, right after a deploy. `http/get.ts` retries five times with exponential
backoff — its own docblock puts a slow host at "about twenty-five seconds" — and the backtest is
the entire content of a screen. The retry ladder is right for a 3am scheduled run and wrong for
someone watching; the bound now sits at the boundary where someone is waiting. Verified on a
genuinely cold cache: **13s → `503 warming` → background fetch completes → 200 with real data.**

That is the third instance of one shape this run — an upstream that can be slow, reached from a
user-facing route with no budget. `/perp/BTC` hung sixty seconds, `/yield/supply` answered a bare
500, and now this.

### Evidence the checks were real

- The whole kill-switch loop, signed in a browser: **LIVE → user signs `revoke()` → chain reads
  `revoked: true` → screen reads STOPPED → `spend()` reverts `PolicyRevoked()`** on the deployed
  contract → user signs a new grant → LIVE again, `remainingTodayUsd: 1600`.
- Contract guards simulated against the **deployed** Sepolia instance: `NotDelegate()`,
  `VenueNotAllowed(address)`, `DailyCapExceeded(uint256,uint256)`, `ZeroAmount()`,
  `PolicyRevoked()` — each fired for its own case, in the contract's own order.
- The embedded wallet was selected correctly in a Chrome holding **two injected extension wallets**
  ahead of it in `privy:connections` — the app registered `0x95A0b368…`, not `0xD9B4b074…`.
- `tools/shoot.mjs`, the project's own harness: **54 of 54 screens**, console, network and content.
- 47 GET endpoints, all 2xx, spot-checked for live values rather than shapes.
- 489 unit tests, 54 contract tests, both typechecks, lint.

## Pass 6 — the server was answering about a different wallet

The five passes before this one tested screens and routes. This one tested the *test suite*, and
that is where the real defect was hiding.

### The defect

Nine routes each answered "which wallet is this user's" with their own copy of
`SELECT … FROM wallets WHERE user_id = $1 LIMIT 1` — no `ORDER BY`, so Postgres was free to return
either row, and free to return a different one between calls. `wallet-context.ts` exists to be the
single answer and says so in its own docblock: two copies of "which wallet is this" is *"exactly
the shape of bug that made the previous build read the first wallet row"*. `extra.ts` carried the
comment **"Scoped to the authenticated Privy user — never 'the first wallet row'"** directly above
a query that read the first wallet row.

A Privy user really does end up with two rows: web Privy lists any injected browser extension
alongside the embedded wallet. The E2E account has exactly that.

**Observed, against the deployed executor:**

| | |
|---|---|
| Wallet the app signs in as | `0x95A0b368…` — the embedded one |
| Wallet the server resolved | `0xD9B4b074…` |
| `/limits` said | `dailyCapUsd: 0, revoked: true` |
| The chain said | `dailyCap: 1600000000`, unrevoked, expiring 2026-09-10T05:44:58Z |
| `POST /strategies` said | `no_delegation` — refused |

The app was right and the server was answering about someone else. Agents, alerts, prices, Privy
policy, catch-up and panic-sell could each land on a different wallet within one signed-in session.
`/panic/flatten` is the one that matters most: it sells positions.

Pass 3 had already verified the *client* half of this — "the embedded wallet was selected correctly
in a Chrome holding two injected extension wallets ahead of it, the app registered `0x95A0b368…`,
not `0xD9B4b074…`". Same two addresses. It verified the client and assumed the server agreed.

### The fix

`currentWallet` was ordering by `created_at DESC` — "newest row wins", which is still a guess, and
here it guessed wrong: the app uses an embedded wallet created on the 5th while the newest row is a
connected one from the 8th. `/wallet/connect` is the app *stating* the address it is on, so it now
stamps `active_at` (migration 011) and that is what the ordering reads. Which wallet is a fact the
client asserts each session, not something inferred from row age.

Deliberately not `last_seen_at`: `/catchup` subtracts that one to decide what is new, and writing
it on every app load would empty the window every time.

All nine call sites now go through `currentWallet`. `grep -rn "FROM wallets WHERE user_id" src/`
returns only the one definition.

**Verified after deploy:** `/wallet` → `0x95A0b368…`; `/limits` → `dailyCapUsd: 1600, revoked:
false`; `/catchup`, `/privy/policy`, `/panic/preview` all 200; and the `/limits` screen in a browser
reads **REMAINING TODAY $1,600.00 · $0.00 spent · $1,600.00 cap**.

### Two tests were passing without testing anything

Worth naming separately, because a green suite is what let the defect above survive five passes.

- **`agents.live.test.ts`** — "firing pauses its strategies" did `if (created.status !== 200)
  return;` under the comment *"the wallet may already be at its cap; that is a legitimate reason to
  skip"*. A full cap is. `no_delegation` is not — the test returned before asserting anything and
  reported PASS. It now distinguishes the two and says when it could not run.
- **`decide.live.test.ts`** — "sizes DOWN when asked for more than the remaining cap" excused any
  refusal as *"also a correct outcome"*, so it kept passing after its hardcoded owner's grant
  expired and `decide()` began answering "The permission has expired" — the correct answer, reported
  as a defect by two sibling tests and silently swallowed by this one. It now resolves a
  currently-permitted owner from the index (`anyLivePolicy`) instead of hardcoding one that expires.

### Smaller things this pass closed

- **`/verify` could not say whether the audit chain is still breaking.** It reported the first link
  break only, so "forks at entry 2" read identically whether that fork was months old or written
  this morning — opposite facts about whether the append lock works. The walk now counts every
  break and names the newest. Live, on the production trail: **"Exactly one, at entry 2, and none
  since — the lock holds."** That is the answer the screen owed a reader, and it is the fix's own
  evidence.
- **Wrong error first.** Creating a strategy that named an agent that was not yours reported "grant
  permission first" — you would grant it, retry, and only then be told the real problem. Ownership
  is a property of the request and is checked before the permission gate now. It also made the
  isolation test vacuous: another wallet's agent id was refused for the wrong reason.
- **The harness called two slow screens broken.** It asserted content once after a flat six
  seconds. `/bot` waits on the proposal engine and `/verify` on twenty live chain, subgraph and
  Aave calls; both land well past six. On `/bot` it read *yesterday's* message and reported the
  absence of today's as an app defect — when a cleared thread showed today's decline rendering
  correctly. It polls the assertion now, which fixes the whole class rather than two timeouts.
- **`50-explore` expected `/Markets/`.** The heading is `MARKETS`. My expectation was wrong, not
  the app.

### Standing, unfixed, and honest about it

- **`audit-chain` still FAILS on `/verify`, and should.** One fork at entry 2, from before the
  append lock existed. The trail is append-only by trigger, so it cannot be repaired — a log that
  can be rewritten to look correct proves nothing. Root cause is fixed
  (`pg_advisory_xact_lock` per wallet, plus a unique-index backstop that migration 008
  deliberately skips on a database already carrying the duplicate) and the screen now proves the
  fix held.
- **`equities` is UNTESTABLE on this chain, not PASS.** The tokens are live on Base mainnet — 4 of
  8 answer `totalSupply()`, all 8 saw transfers within 4,000 blocks — and a fork copies their one
  byte of code with nothing to serve it.

### Suite state at the end of this pass

- Server: **305 passed, 1 skipped, 0 failed** across 40 files, against a real Postgres, the
  deployed contract, the deployed subgraph and live 1inch/Aave/CoinGecko calls. Four were failing
  when this pass began; two of the four had been green while testing nothing.
- Both typechecks clean, including `--noUnusedLocals` for every file this pass touched.

### Found by driving the UI rather than loading it

The sweep loads screens. These needed someone to press the button.

**Sixty percent of the audit trail was one sentence.** Reading a real wallet's trail rather than a
screen: **34 of 57 rows were "Proposed nothing"**, all identical. `/proposals/generate` appended
one every time it was called and the Bot tab calls it on every mount, so the permanent,
append-only record — the artifact the whole product is built to be trusted on — was mostly a log
of page loads. The catch-up panel showed the same sentence twice above "add 18 more".

The rule is not "never write a decline"; what the bot chose not to do is the product. It is write
it when the answer *changes*. Verified on the deployed executor: **37 rows → 37** after three more
`generate` calls, with the decline still returned to the screen. The 34 stay, because the trail is
append-only and that is the point of it.

**A date in the permanent record was a day off.** `First run ${nextRunAt.toDateString()}` formats
in the *server's* timezone. A weekly buy created from IST wrote **"First run Wed Sep 16 2026"**
while the form that created it, formatting locally, had just said **"Thu, Sep 17"** — the same
instant, two different days, in two places in one app, and the wrong one written permanently. The
row cannot know the reader's timezone and guessing only moves the error, so it names the zone.
Live: **"First run Wed, 16 Sept 2026, 22:03 UTC."**

**The flows themselves, pressed by hand on the deployed build:**

- Recurring buy, end to end: `/strategy/dca` → "Buy $50 of WETH, weekly" → home shows **"Created
  $50 of WETH, weekly · First run …"** in the catch-up. This is the exact flow the wallet-
  resolution defect was refusing with `no_delegation`.
- Strategy lifecycle: **create → Live (1 running) → Pause → Paused (0 running) → Resume → Live (1
  running) → Pause**, with the header count tracking every transition.
- `/limits` after the wallet fix: **REMAINING TODAY $1,600.00 · $0.00 spent · $1,600.00 cap**,
  where it had read $0 and "revoked" while the chain held a live grant.

### One more harness bug, and the app was right again

`55-verify` failed the whole run on `/\d+ Passed/`. The endpoint answers in **~1 second** and the
screen renders correctly; the tally is two elements — the number, then the label — so `innerText`
yields `"18\nPassed"` and the pattern wanted a literal space. Element boundaries are not content.

Expectations are now matched against the text as rendered **and** with whitespace collapsed: a
`must` passes if either form matches, a `never` fails if either does. Both readings, because two
`never` patterns anchor with `/m` (`/^0 shown/m`) and on a single collapsed line `^` only matches
at position zero — flattening alone would have quietly weakened them.

That is the second time this pass that a red harness meant a wrong expectation rather than a wrong
app, and both were the same mistake: asserting on the shape of the DOM instead of on what a reader
sees.

### Sweep result

**100 screens: 99 PASS, 1 FAIL** — the one being the `/verify` regex above, since fixed. Console,
network and content asserted on every screen, against the deployed build and the deployed executor.

### A fourth instance of the shape this codebase keeps producing

The sweep reported two screens failing with **CORS errors**, which is not what went wrong. Measured
against the deployed executor:

| route | cold | warm |
|---|---|---|
| `POST /proposals/generate` | **22.8s** | 0.46s |
| `GET /market/stocks` | **8.2s** | 0.39s |

`/proposals/generate` is the entire content of the Bot tab. At twenty-two seconds the browser gave
up before the response arrived, and a response that never arrives has no CORS headers — so the
console blamed CORS for a latency problem. The server log for the same window shows the request
completing normally: `GET /market/stocks 200 7761ms`.

This is the **fourth** route in this codebase with one shape: a slow upstream reached from a
user-facing path with no budget. `/perp/:symbol` hung sixty seconds, `/yield/supply` answered a
bare 500, a cold backtest made a screen wait forty-five. The helper written for those was
backtest-shaped; it is now general — `within(work, budgetMs)` and `warming(c, detail)` — and the
proposal route is bounded at ten seconds.

The work is never cancelled. That is the point of the `finally`: it keeps running, fills the cache
it was filling, and the retry answers in under a second.

The client had to learn the same distinction. `generateProposal` caught everything and reported
*"I could not reach the market just now"*, which for a warming 503 is false — the market was
reached and the answer was seconds away. It now waits the 503 out the way `marketData.ts` already
waits out its own.

### Verified by hand on the deployed build

- **Alerts.** Created "WETH above $2572" through the form; it persisted `enabled=true, armed=true`.
  The unpriceable-symbol guard was then exercised with a junk ticker: the button became **"Nothing
  prices ZQXW"** and pressing it did nothing — no navigation, no write.
- **Swap.** A real 1inch quote for 0.1 WETH → **$244.61 USDC, best of 3 venues, 0.144% price
  impact, at least 243.8766 USDC after slippage** — and an honest block beneath it: *"You hold no
  WETH. There is nothing to swap."*
- **Chat.** A question reached the agent and came back with a refusal rather than a stock line —
  see below.

### UNTESTED — the language model, because the credential does not exist

`server/src/bot/llm.ts` reads `OPENROUTER_API_KEY`. It is **not set in `.env` and not set on the
executor's Railway service**, so no model has ever been reachable in this build. Marked UNTESTED,
not FAIL and certainly not PASS.

What *is* verified is that every surface degrades honestly rather than inventing prose:

- Chat: *"I cannot answer that here — no language model is configured in this build, and I will
  not read you a stock line as though it were an answer."*
- `/briefing`: three real headlines from a live feed, each labelled *"No agent comment — this build
  has no language model configured."* — three different labels for three different stories, where
  the pre-`fallbackLine`-deletion build captioned all three with one canned sentence.
- `/bot/say` returns `text: null`.

Worth flagging plainly: the key that was to be supplied was a **Groq** key, and the code is wired
to **OpenRouter**. Either the key or the client needs to change; nothing in the repo bridges them.
