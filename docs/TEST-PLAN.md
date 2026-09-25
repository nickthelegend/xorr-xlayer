# xorr on X Layer — master test plan

**Baseline written 2026-09-20.** This is the immutable definition of *correct* for the X Layer build. Results live in
[`docs/qa/RESULTS.md`](qa/RESULTS.md); a test is PASS only when the observed behaviour matches the criteria here, run
against the real product (hosted executors, hosted fork, X Layer testnet, the web build, the iOS simulator). Code that
exists, a button that responds or a build that compiles is not a PASS. Anything that cannot be exercised for want of an
external dependency is BLOCKED, never PASS.

Decisions this plan rests on: `PLAN.md` §6.1 (D1–D20), D21 (phone clip on the iOS simulator), D22 (one autonomous entry
per symbol). Nothing below is open.

**The hosted fork was rebuilt on 2026-09-20 00:22 UTC.** Giving the fork node a block time (so its clock keeps up with
the real one) restarted it onto an empty volume, and anvil forked X Layer afresh: the old chain, its contracts and every
balance on it were gone. Rebuilt in the documented order — `fork-bootstrap` for the contracts, `fork-grant` for the
permissions, `reconcile:orphans` to take the fills the new chain does not have back out of the book, and the web build
re-pinned. The addresses below are the ones now live.

**Deployments under test**

| | |
|---|---|
| Web | `https://xorr-xlayer.vercel.app` (pins delegation `0xba23…c93a`, names its commit) |
| Executor, fork | `https://executor-fork-production-2db8.up.railway.app` (`XORR_CHAIN=xlayer-fork`) |
| Fork node | `https://xlayer-fork-production.up.railway.app` (anvil, chain 196) |
| Executor, testnet | `https://executor-testnet-production.up.railway.app` (`XORR_CHAIN=xlayer-testnet`) |
| Contracts, testnet | XorrDelegation `0x0b8363E351588c4De2c5CeD667b7a2ef53F9E6B2` (per-agent budgets; `0x156DCE9E…cA22` before 2026-09-25), XorrAuditAnchor `0x36d503D1893CAB30B5D68DC9A96e8B91bfcBe196` |
| Native app | iOS simulator, debug build `finance.xorr.app`, JS from `npm run start:fork` |
| Test identities | Privy test accounts `test-9907@privy.io` (`0xe609…d16b`), `test-8958@privy.io` (`0x95A0…e615`), a fresh one for F-tests |

---

## G — Gates (every run)

| ID | Target | Steps | Expected exact result | PASS |
|---|---|---|---|---|
| G01 | App typecheck | `npx tsc --noEmit -p .` | 0 errors | exit 0 |
| G02 | Executor typecheck | `npx tsc --noEmit -p server/tsconfig.json` | 0 errors | exit 0 |
| G03 | Lint | `npm run lint` | 0 errors, 0 warnings | exit 0, no output |
| G04 | Unit + integration suites | `npm test` | every file passes | 0 failed |
| G05 | Contract suites | `cd contracts && forge test` with `XLAYER_RPC` | unit + X Layer fork suites pass | 0 failed |
| G06 | CI on `main` | GitHub Actions `ci` | `checks`, `contracts`, `fork-e2e` all success on the head commit | 3/3 success |
| G07 | iOS bundle | Metro serves `index.bundle?platform=ios` | 200; env names the fork executor, fork RPC and delegation | all three present |

## C — Contract (`XorrDelegation`, `XorrAuditAnchor`)

Each is a Foundry test (`contracts/test/`) or an `eth_call`/transaction on a real X Layer network.

| ID | Target | Expected exact result | Evidence required |
|---|---|---|---|
| C01 | `grant` stores delegate, cap, expiry, venues | `policyOf` returns exactly what was granted | forge + testnet tx |
| C02 | `spend` within cap buys into the OWNER's wallet | owner's `tokenOut` rises by ≥ `minOut`; delegation holds 0 of both tokens; allowance to router 0 | fork suite |
| C03 | USDG hop path | NVDAx bought via USDC→USDG→NVDAx | fork suite |
| C04 | Cap | a spend past today's remainder reverts `DailyCapExceeded(requested, remaining)` | fork suite + `prove:fork` |
| C05 | Venue allowlist | a venue not granted reverts `VenueNotAllowed(venue)` | fork suite + testnet `eth_call` |
| C06 | Delegate only | any other caller reverts `NotDelegate` | testnet `eth_call` |
| C07 | `closePosition` | sells back to USDC without spending the cap | fork suite + `prove:fork` |
| C08 | `revoke` | owner-only, one signature; every later spend reverts `PolicyRevoked` | fork suite + testnet tx |
| C09 | `spendVia`/`closePositionVia` | spender must be allowlisted; approval exact and reset to 0 | `XorrDelegationVia.t.sol` |
| C10 | Output floor | a fill delivering < `minOut` reverts `OutputNotReceived` | unit suite |
| C11 | Cancun `tstore` on X Layer | spends succeed on X Layer state | fork suite |
| C12 | Anchor | `XorrAuditAnchor` stores a head; a count going backwards reverts | unit suite / `/verify audit-anchor` |
| C13 | Deployed source | both testnet contracts Sourcify `exact_match` | Sourcify API |

## J — End-to-end journeys (real product, real chain)

| ID | Target | Steps | Expected exact result | Required state effect | PASS |
|---|---|---|---|---|---|
| J01 | Executor order path, fork | `npm run prove:fork` on an anvil fork | ALL CHECKS PASSED | buy fill, cap refusal, close, revoke refusal; run/position/audit rows | exit 0 |
| J02 | Yield, fork | `server/src/fork/prove-yield.ts` | swap USDC→USDT0, supply, owner holds aUSDT0, owner withdraws | aUSDT0 in owner wallet; delegation holds nothing | exit 0 |
| J03 | Withdraw everything, fork | `server/src/fork/prove-withdrawal.ts` | Aave exit then transfer of all USDC to an allowlisted address | tx receipts status 1 | exit 0 |
| J04 | Permission on a public chain | `npm run prove:testnet` | grant, read-back, `VenueNotAllowed`, `NotDelegate`, revoke, `PolicyRevoked` | every step an OKLink tx | exit 0 |
| J05 | In-app grant (native) | simulator, signed-in owner: set $100/day × 7 days, "Sign this permission" | onboarding continues; Safety shows LIVE | `policyOf` = (hosted delegate, 100e6, now+7d, false), txs from the owner | on-chain read matches |
| J06 | In-app Stop all (native) | Safety → hold "Stop all trading" | "Trading stopped · confirmed on-chain" + hash | revoke tx from the owner, status 1; `revoked` true | on-chain read matches |
| J07 | In-app sell (native) | order ticket → Sell $20 TSLAx | ticket closes; Activity "Sold … TSLAx for $…" | `closePosition` tx status 1; position units fall | receipt + activity + position |
| J08 | In-app buy (native) | order ticket → Buy $50 TSLAx (inside today's allowance) | ticket closes; Activity "Bought … TSLAx on Uniswap v3" | `spend` tx status 1 from the delegate; position units rise; cap remaining falls by 50 | receipt + activity + position + `/limits` |
| J09 | Autonomous agent trades | granted, funded wallet; wait for the scheduler | a `momentum`/`dca`/`event-driven` fill attributed to the persona | run `filled`, venue `uniswap-v3`, proposal `approve`, Activity row names the agent | observed on hosted fork |
| J10 | One entry per symbol (D22) | agent sweep on a wallet holding the best setup's symbol | no second entry in that symbol | no new run for a held symbol | runs list shows no repeat after deploy |
| J11 | Ticket guards | order ticket: amount > cash; > today's allowance; sale > holding; typing a new amount | "You have $X." / "Your permission allows $X more today." / "You hold $X of SYM." / rows "…" and button disabled until the quote is for the typed amount | nothing sent | all four observed |
| J12 | API order, hosted fork | `POST /orders {symbol:TSLAx, usd:20}` with a Privy test token | `{status:"filled", signature, units, price}` | owner holds more TSLAx; run row | 200 filled |
| J13 | Deposit screen | `/deposit` signed in | address + QR, USDC/USDT0/OKB balances, test-funds button on a fork | faucet sends 1,000 USDC from the fork reserve | balances reflect the faucet |

## F — Fresh user and edges

| ID | Target | Steps | Expected exact result | PASS |
|---|---|---|---|---|
| F01 | First sign-in creates the wallet row | fresh Privy test account: `POST /wallet/create` | 200 with its embedded address, `cluster: xlayer-fork`; second call returns the same row | persisted, idempotent |
| F02 | Fresh account has no permission | `/limits`, `/delegation` | `granted:false` / `null`; Home Permit step "todo" | no false "granted" |
| F03 | Fresh account faucet | `POST /faucet` | 1,000 USDC sent from the fork reserve, OKB raised for gas; second ask refused with `nextAt` | on-chain balance 1,000 |
| F04 | Unauthorized | every wallet route with no token and with a forged token | 401 | qa-full "401" rows |
| F05 | Invalid input | malformed bodies, out-of-range amounts, unknown symbols | named 400/404 codes, nothing written | qa-full refusal rows |
| F06 | Re-entry / double submit | same `Idempotency-Key` twice | second answer is a replay, no second fill | qa-full idempotency rows |
| F07 | Failure of an upstream | OKX not configured; X Layer RPC range limit | `/route/compare` names OKX as unavailable; `/history` answers inside its bound | qa-full E146, E074 |
| F08 | Chain mismatch | app signs on one chain, server on another | full-screen "different chains" refusal, nothing signed | observed on simulator 2026-09-20 |

## W — Money out (added 2026-09-20, run against the hosted fork on a wallet created that day)

The guards that stand between an agent-held wallet and an address someone else chose. Every one was exercised over
HTTP against the deployed executor; nothing here signs, because the executor has no transfer-out path at all.

| ID | Target | Steps | Expected exact result | PASS |
|---|---|---|---|---|
| W1 | Unknown destination | `POST /withdrawal-addresses/check` for an address never added | 409 `not_allowlisted` | observed |
| W2 | Cooling-off starts on add | add it, then check immediately | add 201; check 409 `cooling_off` | observed |
| W3 | The clock cannot be nudged | add the same address again, check again | second add 409; `usableAt` unchanged | observed |
| W4 | Prepare refuses a cooling address | `POST /withdrawals/prepare-all {to, token:'USDC'}` | 409 `cooling_off`, no calldata built | observed |
| W5 | Prepare refuses an unknown address | same, for an address never added | 409 `not_allowlisted` | observed |
| W6 | Removal is immediate | remove, then check | 200, then 409 `not_allowlisted` at once | observed |
| W7 | Panic preview tells the truth without acting | `GET /panic/preview` | the legs it would sell, their USD, dust floor and slippage; nothing sold | observed |
| W8 | None of it is public | the four money-out routes with no token | 401 each | 4/4 |

## F2 — The fresh user, end to end (added 2026-09-20)

Run on `test-4668@privy.io`, a Privy identity that had never had a wallet on this deployment, against the deployed web
app and executor. Every effect was read back from the chain or the database, not from the response alone.

| ID | Target | Expected exact result | PASS |
|---|---|---|---|
| F2.1 | `POST /wallet/create` | 200, an embedded address, `cluster: xlayer-fork`; the second call returns the identical row | observed |
| F2.2 | Nothing granted yet | `/delegation` null, `/limits` `granted:false`; `POST /orders` → 409 `no_delegation` | observed |
| F2.3 | Faucet | $1,000 USDC on chain, OKB raised to 0.05; the second ask 409 `claimed_recently` with `nextAt` | on-chain balance |
| F2.4 | Grant, through the real app | 17 Privy signatures (16 approvals + the grant); executor reads back $100/day, 7 days | chain read |
| F2.5 | First trade | `POST /orders {TSLAx, $20}` → filled; TSLAx lands in the OWNER's wallet; cap $100 → $80 | chain + `/limits` |
| F2.6 | Idempotent replay | the same `Idempotency-Key` again returns the same signature; units unchanged | chain |
| F2.7 | Position, activity, trail | position booked; "Bought 0.0547 TSLAx on Uniswap v3"; `/activity/verify` 0 link breaks | observed |
| F2.8 | The cap holds | `POST /orders {TSLAx, $500}` → 409 `daily_cap` | observed |
| F2.9 | Sell it back | `POST /positions/close {TSLAx, fraction:1}` → $19.98 back, units 0 on chain, cap still $80 | chain + `/limits` |
| F2.10 | Hire an agent | before: every agent "No trades yet"; after: Momentum Scout hired and idle until a setup qualifies | observed |
| F2.11 | `/judge` on that wallet | 20 pass, 0 fail, 0 skip | live |

## E — Executor endpoints (202)

Every endpoint check in `tools/qa-full.mjs`, run against the hosted fork executor with a Privy test token. Each check's
exact contract is its `correct` field (method, path, auth, status, body shape, side effects, refusals); the report
(`docs/qa/endpoints-xlayer.json`) records `correct`, `status` and `observed` per check. PASS = `status: "pass"` for all
202.

## S — Screens (101)

Every route in `tools/shoot.mjs`, captured on the live web build signed in as a test account; each has `must`/`never`
text assertions plus zero console errors and zero failed requests (Hyperliquid's own missing coin icons excepted). The
report is `docs/screens/qa-report.json`. PASS = every screen `ok`.

## V — Self-verification (`/verify`)

| ID | Target | PASS |
|---|---|---|
| V01 | Fork executor, owner with a live grant | 20/20 pass |
| V02 | Testnet executor, no owner | 0 fail; every skip names its reason |
| V03 | Web `/judge` renders V01 live | page lists the same checks |

## A — The agent (AI) capability

| ID | Target | Expected | PASS |
|---|---|---|---|
| A01 | Setup scoring on real data | on a fork, observations track the live X Layer pools | latest `/market/stocks/history` point equals a live mainnet quote within 0.5% |
| A02 | Sizing against the on-chain cap | entry ≤ min(maxTradeUsd, allowanceShare × remaining) | runs' `usd` follow the rule |
| A03 | Fail closed | rules engine error, unreadable policy, unreadable holdings → no order | unit suite |
| A04 | Explain | `/activity/:seq/explain` for an agent fill returns the decision record | 200 `status: explained` |
| A05 | Prose explanation (LLM) | persona sentence written by the model | BLOCKED without `OPENROUTER_API_KEY` |

## I — Infrastructure and deployment

| ID | Target | PASS |
|---|---|---|
| I01 | Fork executor `/health` | `ok`, chain `xlayer-fork`, version = deployed commit, postgres/rpc/delegation/gas up |
| I02 | Testnet executor `/health` | `ok`, chain `xlayer-testnet`, delegation `0x156D…cA22` |
| I03 | Fork node | answers `eth_chainId` 0xc4, `web3_clientVersion` anvil |
| I04 | Web bundle | points at the fork executor + RPC, pins the delegation, names the commit (`deploy:web` check) |
| I05 | CORS | executors answer only `https://xorr-xlayer.vercel.app` in `Access-Control-Allow-Origin` |
| I06 | Migrations on deploy | `/verify idempotence` passes on both executors |
| I07 | Secrets | no key in git history; deployer/delegate/faucet keys only in gitignored files and Railway variables |
| I08 | Privy policy | wallet policy owned by the key quorum; Privy refuses an out-of-policy send |

## H — Hackathon (OKX Dev Day, X Layer track)

| ID | Requirement | PASS |
|---|---|---|
| H01 | Built on X Layer | contracts on X Layer testnet + fork of mainnet; gas OKB; OKLink links |
| H02 | Tokenized stocks (track) | wrapped xStocks trade end to end (J01, J08, J09) |
| H03 | OKX DEX API | live quote + fill through `spendVia` — BLOCKED without the API key; code path proven by C09 and unit tests |
| H04 | OKX Wallet | web sign-in lists OKX Wallet first — live connection BLOCKED without the extension |
| H05 | Core claim (permission is on chain, revocable without the server) | J04, J06, C08 |
| H06 | Live link | web + executors green (I01–I04) |
| H07 | Public repo with README | owner action at submission (D14) |
| H08 | 2–4 min video | owner action (D13/D21) |
| H09 | Submission form | owner action |

## B — Driven in a browser (added 2026-09-20)

Run against the deployed web build with the console and the network watched on every item. Claude in Chrome for
everything reachable without a credential; `tools/flows.mjs` for the signed-in journeys, because a one-time code is not
typed into a page by a tool. A visible console error or a failed request fails the item, third-party wallet-SDK logs
excepted by name (Coinbase chain support, injected-provider detection).

| ID | Target | Steps | Expected exact result | PASS |
|---|---|---|---|---|
| B01 | Sign-in form | `/wallet`, type the test address, "Email me a code", enter the code | the code field appears, the wallet is created, `privy:token` is in storage | token present |
| B02 | Onboarding validation | `/welcome` → Get started → deselect every goal → Continue | "0 selected", the button is disabled and clicking it stays on `/goals` | still `/goals` |
| B03 | Search by name | `/search`, type "tesla" | exactly ONE TSLAx row, priced, opening `/asset/TSLAx` | one row |
| B04 | Search, no match | type "zzzz" | `Nothing matches "zzzz".` and no rows | exact sentence |
| B05 | Stock hero vs its own chart | `/asset/NVDAx` | the hero price equals the chart's marker to the cent, both from the live pools | equal |
| B06 | Change label | same screen | the direction word and the figure come from one rounded value; a change that rounds to 0.0% reads "flat", never "down 0.0%" | no contradiction |
| B07 | Chart windows | 1D / 1W / 1M / 1Y | each pill redraws from the recorded readings; the caption names the window actually covered ("since Sep 19") when the history is shorter | caption matches |
| B08 | Ticket, signed out | `/order/NVDAx` | "Sign in to trade", Max disabled, backspace reaches $0, no fabricated fee | as stated |
| B09 | Ticket, floor vs estimate | signed in, $250 | "Minimum received" ≤ the estimate above it, both from the same quote | floor ≤ estimate |
| B10 | Ticket, past the allowance | signed in, amount over what is left today | the refusal is a sentence naming the remaining allowance and the button cannot be pressed | disabled + sentence |
| B11 | Tapped buy | signed in with allowance, key $50, press Buy | a filled run with a transaction hash, the position grows on chain, the day's allowance falls by $50 | all three |
| B12 | Swap, signed out | `/swap`, enter 100 | "Sign in to see a quote" — never a claim that the market will not price it | exact sentence |
| B13 | Alerts, double submit | `/alerts/new`, press the button twice | exactly one alert exists afterwards | +1 |
| B14 | Alerts, validation | clear the price | "Enter a symbol and a price", button disabled | as stated |
| B15 | Alerts, reload mid-flow | reload `/alerts` | the alert is listed once | listed |
| B16 | Deposit, held USDT0 | `/deposit` holding USDT0 | the balance is shown and converting to USDC is offered | both |
| B17 | Convert, signed | Review conversion → Convert, confirm each signature | "Converted X USDT0 to USDC.", and the USDT0 is gone on chain | both |
| B18 | Kill switch | `/safety`, hold "Stop all trading" | `policyOf.revoked` is true on chain, signed by the owner | revoked |
| B19 | Grant | `/delegate` → Sign this permission | the screen states the count before you start; after the last one the chain holds the cap and expiry | cap on chain |
| B20 | Rate screen | `/rates` | names the asset the rate is actually paid on (USDT0) and repeats the executor's sentence | names USDT0 |
| B21 | Judge page | `/judge`, paste an owner address, Re-run | every claim verified; a wallet with no permission on that chain is a named skip, never a failure | 20/20, 0 fail |
| B22 | Executor unreachable | cut the network mid-session | the last price stays, "Can't reach xorr" names what is unaffected, retry restores and says "Back online" | all three |
| B23 | Session cleared | clear storage, open a gated screen | a sign-in prompt, no placeholder value, no error screen | prompt |
| B24 | Unknown symbol | `/asset/NOPE`, `/order/NOPE` | "No price feed." / "No live NOPE price" and "Not tradable here" — never a number | no number |
| B25 | Unknown route | `/no-such-screen-exists` | "There is nothing here", offering the wallet and the screen index | as stated |
| B26 | Dev screens in production | `/_dev/ui`, `/_dev/boom` | both redirect to `/welcome` | redirected |
| B27 | Phone width | 420px | no horizontal overflow, the tab bar renders, unpriced rows show "—" | no overflow |
| B28 | Welcome hero | `/welcome` | this product's own coin art — no other chain's mark on the first screen | no foreign mark |
| B29 | Agent gate | a wallet that hired nobody, with a live permission and allowance | no autonomous trade is placed for it, ever | no trade |
| B30 | Agent, hired | a wallet that hired an agent | its sweep may place ONE entry per symbol it does not already hold, attributed to that agent | ≤1 per symbol |
| B31 | An order bigger than the wallet | signed in, order for more USDC than is held | refused before anything is signed, naming both figures — never ERC20's own words through the contract | named refusal |
| B32 | The fork's clock | leave the fork untouched across a UTC midnight | blocks keep being mined, so `remainingToday(owner)` rolls over on its own | cap resets unattended |

## P — The strategy book (added 2026-09-23)

Added after the plan was written (`/playbook`, `/playbook/:slug`, the home sheet's Strategies tab). Correct means:

| ID | Target | Steps | Expected exact result | PASS |
|---|---|---|---|---|
| P01 | Reached the way a person reaches it | signed in: home → Strategies tab → a row → its report | the tab lists measured strategies; a row opens a report that names its window | `flows.mjs` §4 |
| P02 | Header counts | `/playbook` | the four counts in the header equal `/strategies/catalog` (`counts`), and "Showing N of 313" equals the rows with ≥30 unseen trades | exact equality |
| P03 | A strategy with no trades | any row with `trades: 0` | no return, no win rate, no verdict claimed as a result; never under a VERIFIED badge | 0 such rows claim a return; 0 verified with 0 trades |
| P04 | The replay agrees with the gauntlet | every row with gauntlet evidence | a strategy the gauntlet traded has trades in the book | `catalog.test.ts` |
| P05 | Unknown strategy | `/playbook/anything` | "There is no strategy called anything in the book." and a link to the book; no Retry | exact sentence |
| P06 | Money reconciles | any report | gross profit + gross loss + commission = net, to the cent | equality |

## R — Found and closed 2026-09-22/23 (each is now a standing check)

| ID | Target | Expected exact result | PASS |
|---|---|---|---|
| R01 | Banners never block the screen | executor cut off, then restored, on `/asset/:symbol` | "Can't reach xorr" / "Back online" are drawn inside the app column, and `elementFromPoint` at Buy's and Sell's centres returns the buttons; a real click on Buy opens the ticket | both, observed |
| R02 | `box-none` works on the web | source | every `pointerEvents: 'box-none'` is inside a `StyleSheet.create` | `audit.test.ts` |
| R03 | A fill records what it paid | `POST /orders` on the fork | response `price` = USDC spent ÷ units received, as read on chain | equal to 4 decimals |
| R04 | Exits judged on the settling chain | fork: market +10.8%, sale −0.1% | no take profit fires; one fires when the sale itself clears the level | `exit-mark.test.ts` |
| R05 | Live exits measured from their fill | every live `exit-rules` entry | within 0.5% of the opening fill's USDC ÷ units | migration `20260923T001500`, read back |
| R06 | The fork keeps real time | hosted fork node | newest block within one block time + 15s of UTC, across a restart; the contract's day rolls at 00:00 UTC | lag measured; `/limits` chain = executor at 00:00 |
| R07 | The deployed web build names its commit | `deploy:web` from a clean tree | the bundle contains HEAD's full SHA and says whether the executor runs the same server code | SHA in the served bundle |

## K — Each agent's own budget, and OKX DEX first (added 2026-09-25)

| ID | Target | Steps | Expected exact result | PASS |
|---|---|---|---|---|
| K01 | The contract | `forge test --match-contract XorrAgentBudgetTest -vv` | 19 pass, including the 256-run fuzz: no sequence of agent trades takes an agent past its budget | 19/19 |
| K02 | Set from the agent's page | signed in, a hired agent's page → a preset → "Set budget to $N" → one confirmation | the card shows the figure the chain answers; `GET /agents` reads the same off the contract; Activity has "Budget set" with the transaction | `flows.mjs` §3e |
| K03 | An agent's trade is charged to it | `tools/prove-agent-budget.mjs TSLAx 10` | the fill's receipt carries `AgentSpent` under that agent's key, and the budget read back fell by the amount | event + read-back |
| K04 | Past the budget | a strategy of an agent whose budget is under the run's size | refused before signing: "X has $B of its budget left on chain, and this asks for $U."; nothing sent | exact sentence |
| K05 | No budget yet | a made agent's live strategy before its owner sets a budget | skipped without claiming the period ("… waits. Give it one on its page, and it runs."), once in the trail; runs on the first tick after the budget lands | `agent-limits.test.ts`, observed |
| K06 | Only funded agents take setups | sweep with one agent budgeted, others not | the budgeted agent trades; with none budgeted nothing is scanned and one "Skipped a trade" is written | `autonomous.test.ts` |
| K07 | A sale credits only the agent's own lot | an agent's exit | sells min(lot, unclaimed) as the agent's (`closeForAgent`); every other sale settles as the owner's | `planners.test.ts`, `agent-limits.test.ts` |
| K08 | Firing keeps exits | `DELETE /agents/:id` | its strategies pause except `exit-rules` | `agent-budget.test.ts` |
| K09 | OKX DEX first | a buy OKX can route and the contract would fill | venue `okx-dex`; Uniswap v3 only when OKX has no route, would not fill here, or delivers >0.5% less | `settle.test.ts`, a fork fill naming `okx-dex` |
