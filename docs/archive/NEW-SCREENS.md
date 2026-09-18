# New screens

Fifty screens, taking the app from 44 to 94. None of them redesign an existing one.

The rule that shaped the whole list: **a screen with no real data behind it is a mock**, so every
row below names the endpoint, table or contract call it renders. Nothing here invents a number, and
nothing here is a design study — if the data did not already exist, the screen is not on the list.

That constraint turned out to be the useful one. The app has ~70 endpoints and 19 tables behind 44
screens, and the gap is not evenly spread: the parts with no UI are almost entirely the parts that
make the product's central claim checkable. There is an on-chain approval surface, a hash-chained
audit trail, a policy engine, a subgraph and a verification harness — and until now, no way to look
at any of them from the phone.

## A · Trust, and how to check it

| Screen | Renders | Source |
|---|---|---|
| `/verify` | Every claim the README makes, run live, each green or red | `GET /verify` |
| `/audit/chain` | The hash chain, and whether it still verifies end to end | `GET /activity/verify` |
| `/audit/[seq]` | One entry: action, amount, prev-hash link, signature, explorer | `GET /activity` |
| `/approvals` | What the delegation may pull, per token, and which are unlimited | `GET /approvals` — on-chain `allowance()` |
| `/policy` | Whether Privy's policy engine is enforcing, and what it would allow | `GET /privy/policy` |
| `/keys` | Agent API keys, their scopes, and revocation | `GET/POST/DELETE /agent/keys` |
| `/delegation` | Contract, delegate, venues, every token it may touch, expiry | `GET /delegation` + `/delegation/params` |

## B · Money

| Screen | Renders | Source |
|---|---|---|
| `/pnl` | Realised profit and loss | `GET /pnl/realised` |
| `/disposals` | Every disposal, cost basis and gain, with CSV export | `disposals` + `GET /pnl/disposals.csv` |
| `/limits` | Daily cap, spent today, what is left | `GET /limits` |
| `/allocation` | Where the money actually sits, by class | `GET /positions` + `/market/quotes` |

## C · Markets

| Screen | Renders | Source |
|---|---|---|
| `/movers` | Today's largest moves, both directions | `GET /market/quotes` |
| `/compare` | Two instruments side by side over one range | `GET /market/ohlc` |
| `/crosscheck/[symbol]` | The same asset priced two ways, and the gap | `GET /market/crosscheck` |
| `/tokens` | Every token that settles here, with full addresses | `GET /market/tradable` |
| `/route/[symbol]` | The protocols a fill would actually route through | `GET /swap/quote` |
| `/venues` | Where a fill may go, and every token it may pull | `GET /delegation/params` |

## D · Agents and strategies

| Screen | Renders | Source |
|---|---|---|
| `/agent/[id]` | One agent: mandate, state, its own record | `GET /agents/:id` |
| `/runs` | Every strategy run, and what it did or refused | `strategy_runs` |
| `/runs/[id]` | One run: inputs, decision, fill or reason | `strategy_runs` |
| `/proposals` | Every proposal, approved, skipped or expired | `GET /proposals` |
| `/backtest` | What a weekly buy would have done, on real past prices | `POST /strategies/backtest` |
| `/audit/[seq]` | One trail entry in full, with its transaction | `GET /activity` |
| `/route/[symbol]` | The pools a fill would take, at a size you pick | `GET /swap/quote` |

## E · Infrastructure

| Screen | Renders | Source |
|---|---|---|
| `/graph` | Subgraph health and how far behind the head it is | `GET /graph/health` |
| `/graph/spends` | Spend events as the subgraph indexed them | `GET /graph/activity` |
| `/graph/decision` | Which venue the router picks for a size, and why | `GET /graph/decision` |
| `/network` | Chain, block, gas, RPC, contract | `GET /health` |
| `/status` | The executor and every dependency it needs | `GET /health` |

## F · Identity

| Screen | Renders | Source |
|---|---|---|
| `/basename` | Basename ↔ address, both directions | `GET /basename` |
| `/profile` | This wallet: address, basename, what it has done | `/wallet` + `/activity` |

## G · Everything else

| Screen | Renders | Source |
|---|---|---|
| `/catchup` | What happened since you last looked | `GET /catchup` |
| `/notifications` | Which events are worth waking you for | `GET/PATCH /notifications/prefs` |
| `/explore` | The index for all of the above | — |

## G2 · The rest

| Screen | Renders | Source |
|---|---|---|
| `/sources` | Every upstream a number can come from, three of them probed live | `/health` + `/graph/health` |
| `/metrics` | What this executor has done, counted | `GET /metrics` |
| `/coverage` | What is priced, what settles, and the gap between them | `/market/symbols` + `/market/tradable` |
| `/stocks` | The tokenized equities, priced by probing a real buy | `GET /market/stocks` |
| `/earnings` | Filing dates from EDGAR, and what the cadence implies | `GET /market/earnings` (new) |
| `/oracle/[symbol]` | Every price this deployment recorded for an equity | `GET /market/stocks/history` |
| `/funding` | Mark against oracle across the perps | `GET /perp/:symbol` |
| `/rates` | What idle cash earns at Aave, and who sets it | `repos.yield.staking` |
| `/balance` | Cash, held and supplied — three things a total hides | `GET /wallet/balance` |
| `/spend` | Day by day, from what the contract emitted | `GET /graph/activity` |
| `/schedule` | Every live strategy, ordered by when it next runs | `GET /strategies` |
| `/strategy/[id]` | One strategy: what it is set to, what it has done | `GET /strategies` + `/runs` |
| `/alert/[id]` | Armed or already fired, and how often | `GET /alerts` |
| `/risk` | What each agent holds itself to | `GET /agents` |
| `/roster-compare` | The four agents side by side, on the numbers | `GET /agents` |
| `/voice` | The three tones, with the model instruction shown | `src/bot/tone` |
| `/sell-everything` | What flattening would sell, before you ask | `GET /panic/preview` |
| `/export` | The audit trail and the disposals file, out of the app | `/activity/export` + `/pnl/disposals.csv` |

## Not built, and why

These were on the list and came off it, because there is no real source:

- **Social / copy-trading.** No other users exist. A leaderboard of one is a mock.
- **Order book depth.** 1inch is an aggregator; there is no book to show.
- **News sentiment.** The feed has headlines, not scored sentiment. Scoring them here would be
  inventing the number the screen exists to display.
- **Portfolio performance over time.** `price_observations` records what the executor priced, not a
  daily mark of the whole portfolio. Drawing a curve from it would imply a history nobody kept.
- **Momentum and event-driven strategy creators.** Both kinds run server-side and neither has a
  creator, so these were on the list. They came off it because a creator is a form that spends
  money, and shipping two of those without running them end to end against a funded wallet would be
  the opposite of what this set is for. Worth doing next, deliberately.

## What the screens found

Building them surfaced two facts that were true before and invisible:

- **`/verify` fails one of its twenty checks** on the local Sepolia deployment. `privy-refusal`
  tries to prove Privy blocks a transaction the policy omits; the request is refused for a
  *different* reason — a 401 for a missing `privy-authorization-signature` — so the claim is not
  proven. The check is right to call that a failure rather than a pass, and it needs a key-quorum
  signature to go green.
- **WETH is approved without a limit.** `/approvals` reads it straight off the chain: USDC is capped
  at 48,000 and WETH is MAX_UINT256. Nothing was wrong with the app; nothing had ever shown it.
