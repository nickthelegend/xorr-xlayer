# 100 ideas, round two — ranked

The first hundred is in [IDEAS.md](IDEAS.md); 29 of those were built and are not repeated here.
Neither is anything shipped since — Aqua settlement, the grid strategy, the judge console, the
eight defects fixed in the 2026-09-07 audit.

Scored **impact × feasibility × fit**, each 1–5. Fit means: does it strengthen *this* pitch — "the
permission is the product, and you can check every claim yourself" — or is it a feature from
someone else's app?

What changed since round one, and what it does to the ranking:

- **1inch is satisfied.** `XorrAquaBook` settles real fills. The remaining 1inch ideas are depth,
  not qualification, so they score lower than they would have.
- **Privy has one explicit criterion still open**: *"at least one Privy control, such as policies,
  signers, key quorums, or intents."* The project uses none. Probed the API this session with the
  credentials already in `.env`: `POST /v1/policies` returns 200 and `GET /v1/wallets` shows
  `policy_ids: []` on every wallet. **It is buildable right now.** That is why the top of this list
  is almost entirely Privy.
- **The Graph is disqualified as it stands**: *"simply querying one Subgraph with no composition or
  standardization does not qualify."* The second subgraph is built and pinned but has no Studio
  slug. Probed this session: the Token API host resets the connection from here and
  `GRAPH_DEPLOY_KEY` is a deploy key, not a gateway query key — `{"errors":[{"message":"auth error:
  API key not found"}]}`. So the composability fix has to come from a direction that needs no new
  credential.

---

## What happened

**Fourteen built and verified working**: six of Tier S, five of Tier A, and three from Tier B that
turned out to matter more than their rank suggested — the token approvals in particular, which are
unlimited, survive a revoke, and had no way to be seen or withdrawn.

Three of my own Tier S proposals turned out to already exist — #7, #8, and half of #6 — which is a
research failure on my part and is marked in place rather than quietly dropped.

Everything marked BUILT below was exercised against the live system: the Privy controls against
Privy's own API on the deployed executor, the trailing stop by an on-chain fill, the sparklines by
a cold server warming, the offline banner by cutting `/health` in the running app.

## Tier S — build first

| # | Idea | I | F | Fit | Score | Outcome |
|---|---|---|---|---|---|---|
| 1 | **Privy wallet policies, real and enforced.** Create a Privy policy per embedded wallet that constrains `eth_sendTransaction` to the delegation contract and the tokens it may approve, and attach it to the wallet. Closes the one explicit criterion the B2B track names and the project scores zero on. | 5 | 5 | 5 | 125 | **✓ BUILT** — policy `xorr wallet policy (base-sepolia)`, 4 rules, live on both deployments |
| 2 | **Show both enforcement layers on `/safety`.** The screen names the two parties; it should name the two *policies* — Privy's, off the API, and the contract's, off the chain — each with what it forbids. Defence in depth you can read rather than be told about. | 5 | 5 | 5 | 125 | **✓ BUILT** — `/safety` names both locks and the quorum that owns the Privy one |
| 3 | **`/verify` checks the Privy policy too.** A claim about a control nobody can check is the thing this console exists to abolish. Re-read the policy from Privy's API and compare it to what the app says it is. | 5 | 5 | 5 | 125 | **✓ BUILT** — `privy-policy` and `privy-refusal`, both PASS on the deployed executor |
| 4 | **A deliberately-refused transaction, on camera.** A `/judge` action that asks the user's wallet to send somewhere the Privy policy forbids and shows the refusal. The kill switch proves you can stop the bot; this proves the wallet itself will not go where it must not. | 5 | 4 | 5 | 100 | **✓ BUILT** — `privy-refusal` performs the refused send; `POST /privy/policy/prove` does both halves |
| 5 | **Policy owner + quorum.** Privy policies carry an `owner_id`. Set one, so changing what the wallet may do is itself gated — the "key quorums" half of the same criterion. | 4 | 4 | 5 | 80 | **✓ BUILT** — key quorum `zixx49ik3ngslu9oay54q4li`; unsigned PATCH → 401, signed → 200 |
| 6 | **Compose a second Graph read into `decide()` without a new endpoint.** The Aqua book state is already read from chain logs in `venues/aqua.ts`. Make `decide()` join *both* sources — the subgraph's policy/spend history and the venue's own book state — and say which one moved the decision. Composition of two data products, not two queries against one. | 4 | 3 | 5 | 60 | not built — `decide()` already reads Aqua book state from chain logs; the missing half is the Studio slug |
| 7 | **The delegate's gas, watched and surfaced.** `/verify` reports the balance; nothing tells a *user* their bot is about to stop. A strategy that cannot pay gas fails silently, which is the failure mode this product is least able to afford. | 4 | 5 | 4 | 80 | **already existed** — `gasStatus()` blocks the run with the true reason |
| 8 | **"While you were away."** On open: what the bot did since you last looked, and what it declined. The product's entire premise is not watching, and nothing currently rewards coming back. | 4 | 5 | 5 | 100 | **already existed** — `/catchup` and `src/home/CatchUp.tsx` |
| 9 | **Portfolio value over time, from the audit trail.** A real equity curve out of the append-only log — the trail is already the source of truth, so the chart is a read of evidence rather than a second record. | 4 | 4 | 5 | 80 | not built |
| 10 | **Trailing stop.** Exit rules take profit and stop out; the trailing stop is the one people actually ask for, and `planExitRules` already keeps a high-water mark on every tick. | 4 | 4 | 4 | 64 | **✓ BUILT** — verified by a real fill, tx `0x47db5129…` |

## Tier A

| # | Idea | I | F | Fit | Score | Outcome |
|---|---|---|---|---|---|---|
| 11 | **Offline banner.** The app assumes the executor is reachable and says nothing when it is not. | 3 | 5 | 4 | 60 | **✓ BUILT** — verified by cutting `/health` in the running app |
| 12 | **Graceful 1inch outage.** A failed quote should state a reason, not render an empty route row. | 3 | 5 | 4 | 60 | **✓ BUILT** — `apiReason` surfaces the executor's own sentence |
| 13 | **Sparkline in every market row.** `Sparkline.tsx` exists and the rows do not use it. Skipped in round one for lack of a per-row series; `/market/ohlc` now serves one cheaply. | 3 | 4 | 4 | 48 | **✓ BUILT** — new batched `/market/sparklines`; 9 rendering |
| 14 | **Pull-to-refresh on every polling list.** | 3 | 4 | 4 | 48 | **✓ BUILT** — seven lists |
| 15 | **Receive screen with a QR of the address.** Funding is the first thing a judge does and the address is currently copy-only. | 3 | 4 | 3 | 36 | **✓ BUILT** — `AddressQR`, EIP-681, drawn without the library's console error |
| 16 | **Strategy sub-cap shown as a bar, not a number.** The sub-cap exists; the screen states it in prose. | 3 | 4 | 4 | 48 | not built |
| 17 | **Day-and-time scheduling, not just cadence.** "Weekly" currently means "whenever the tick lands". | 3 | 4 | 3 | 36 | not built |
| 18 | **Drift indicator on holdings.** The rebalance strategy computes drift; the holdings screen does not show it. | 3 | 4 | 4 | 48 | not built |
| 19 | **A visual before/after of a rebalance.** | 3 | 3 | 4 | 36 | not built |
| 20 | **Strategy templates — one tap to a working configuration.** | 3 | 4 | 3 | 36 | not built |
| 21 | **Copy a leaderboard agent's configuration.** | 3 | 3 | 3 | 27 | not built |
| 22 | **Buy-the-dip modifier on DCA.** Size up when the asset is below its own average. | 3 | 3 | 3 | 27 | not built |
| 23 | **Live subgraph query panel in-app.** Type a query, see the response, next to the screen that uses it. | 3 | 3 | 4 | 36 | not built |
| 24 | **Revoke-propagation latency, measured and shown.** The README claims "under a second"; measure it. | 3 | 3 | 5 | 45 | not built |
| 25 | **Backup / restore of the audit trail.** | 3 | 4 | 3 | 36 | not built |
| 26 | **Architecture diagram rendered in-app.** | 2 | 4 | 3 | 24 | not built |
| 27 | **Onboarding resume where you left off.** | 3 | 3 | 3 | 27 | not built |
| 28 | **Screen-reader labels audited across every control.** | 3 | 4 | 3 | 36 | not built |
| 29 | **Position-level notes.** | 2 | 4 | 3 | 24 | not built |
| 30 | **Weekly digest push.** | 3 | 3 | 3 | 27 | not built |
| 31 | **Pause/resume a strategy from the notification.** | 3 | 2 | 4 | 24 | not built |
| 32 | **Dockerfile and one-command up.** | 3 | 4 | 3 | 36 | not built |
| 33 | **A public status page.** | 2 | 4 | 3 | 24 | not built |
| 34 | **Connection-pool tuning under the scheduler's load.** | 2 | 4 | 3 | 24 | not built |
| 35 | **Secrets-never-logged audit, enforced by a test.** | 3 | 4 | 3 | 36 | not built |

## Tier B — real, ranked lower on fit or feasibility

| # | Idea | Note |
|---|---|---|
| 36 | EIP-5792 batch: grant + approvals in one signature | Removes the four-sheet dance the resume flow just demonstrated |
| 37 | Paymaster / sponsored gas for the first grant | Needs a paymaster |
| 38 | Passkey login through Privy | Privy supports it; competes with the OTP flow already demoed |
| 39 | A third subgraph indexing strategy runs | Same Studio-slug blocker as the second |
| 40 | EAS attestation per strategy run | Attractive, but duplicates the audit trail's job |
| 41 | 1inch Fusion / intent orders | Depth, not qualification, now that Aqua settles |
| 42 | 1inch Limit Order Protocol | Same |
| 43 | 1inch Portfolio API for the holdings screen | Would replace working code with an API call |
| 44 | 1inch Gas Price API for the fee estimate | Small, real |
| 45 | 1inch History API to cross-check the audit trail | Genuinely good fit — a third-party record of our own claims |
| 46 | Chainlink as an independent third price | Two sources already cross-check |
| 47 | SwapVM program enforcing a TWAP window | Contract written; needs a program |
| 48 | SwapVM program with an oracle price band | Same |
| 49 | xorr itself as an Aqua maker quoting idle inventory | Excellent story, days of work |
| 50 | Tier 6 — momentum, approve-before-execute by default | |
| 51 | Tier 7 — event-driven, flatten before earnings | |
| 52 | Multi-wallet switching | |
| 53 | Aave health factor | Only if borrowing is added |
| 54 | Corporate-action awareness on tokenized equities | |
| 55 | Coinbase onramp funding | |
| 56 | Share a position as an image | |
| 57 | Keyboard shortcuts on web | |
| 58 | Per-strategy performance attribution | Which strategy actually made the money |
| 59 | A "why did nothing happen today" explainer | The declines are the product; they need a home |
| 60 | Slippage budget per strategy, not per swap | |
| 61 | Simulate a strategy run without executing | Dry-run mode on the real planner |
| 62 | Show the exact calldata before any signature | Aligns with the "check it yourself" pitch |
| 63 | A diff view when a strategy's params change | |
| 64 | Retry a failed run, explicitly, from the UI | |
| 65 | Per-venue fill-quality history | Which venue actually gave the best price |
| 66 | Alert on delegation expiry approaching | **✓ BUILT** — `expiryState`/`expiryNote`, a day of warning, verified at 5h and silent at 71.7h |
| 67 | Alert when the daily cap is nearly spent | |
| 68 | Export the whole app state as a signed bundle | |
| 69 | A read-only share link for a portfolio | |
| 70 | Time-travel: the portfolio as of a past block | |
| 71 | Per-token approval revocation from the app | **✓ BUILT** — user-signed `approve(spender, 0)`; USDC allowance verified ZERO on chain afterwards |
| 72 | Show which tokens have live approvals, and their size | **✓ BUILT** — `GET /approvals` reads `allowance()` off the token contracts |
| 73 | A "panic test" — flatten in dry-run so you trust it | |
| 74 | Warn when a venue leaves the allowlist mid-strategy | |
| 75 | Detect and surface a stuck/pending transaction | |
| 76 | Nonce management for the delegate under concurrency | Real risk once two strategies fire at once |
| 77 | Per-request rate limiting on the executor | |
| 78 | Structured audit export straight to a spreadsheet format | |
| 79 | An "explain this run" panel reading the planner's own reasons | |
| 80 | Localised number and date formatting | |
| 81 | A first-run tour that points at the permission, not the chart | |
| 82 | Empty-state illustrations that state the next action | Partly done; not everywhere |
| 83 | Skeleton states that match the real layout | Prevents the reflow on every list |
| 84 | Optimistic UI on strategy pause/resume | |
| 85 | A single "system health" row on the home screen | |
| 86 | Consistent error taxonomy across every route | |
| 87 | Client-side request coalescing | The server now dedupes; the client does not |
| 88 | Persist the last-viewed tab across launches | |
| 89 | Haptics on the destructive confirmations only | |
| 90 | A monospace treatment for every hash and address | Partly done |
| 91 | Truncation that keeps both ends of an address | Done in places, not all |
| 92 | Relative timestamps that update without a re-render | |
| 93 | A proper 404 route | |
| 94 | Deep-link handling for every screen | |
| 95 | Web share targets for a transaction hash | |
| 96 | Reduced-motion respect on every transition | |
| 97 | Print stylesheet for the audit trail | An accountant will print it |
| 98 | Content-Security-Policy on the web build | |
| 99 | Subresource integrity on the bundle | |
| 100 | A load test proving the scheduler holds at N strategies | |

## Deliberately not proposed

Everything in round one's Tier C stands: social feeds, points, streaks, confetti, animated
counters, a theme toggle, AI that places trades without approval. `animations.md` still sanctions
no new animation, and the trust argument still loses more from gamification than the demo gains.
