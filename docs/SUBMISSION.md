# Submission — OKX Dev Day 2026

**Deadline:** 2026-09-25 23:59 UTC. **Track:** Build a Market — build with X Layer. **Repo:**
https://github.com/nickthelegend/xorr-xlayer (public at submission, after a history secret scan — PLAN.md D14).

**Live on X Layer mainnet:** **https://xorr-xlayer.vercel.app** (Vercel `xorr-xlayer`), executor at
`https://executor-mainnet-production.up.railway.app` (`/health`, `/verify`), contracts on chain 196 and Sourcify exact
match: XorrDelegation `0x156DCE9E9d523775AB51f882616A431EdBfBcA22`, XorrAuditAnchor
`0x36d503D1893CAB30B5D68DC9A96e8B91bfcBe196` (`contracts/deployments/xlayer-mainnet.json`).

**Sandbox, no money:** **https://xorr-xlayer-demo.vercel.app** — the same app against a hosted fork of X Layer mainnet
(`https://xlayer-fork-production.up.railway.app`), executor `https://executor-fork-production-2db8.up.railway.app`,
with test funds on Deposit. **Testnet:** XorrDelegation `0x0b8363E351588c4De2c5CeD667b7a2ef53F9E6B2`, Sourcify exact,
served by `https://executor-testnet-production.up.railway.app`.

**Video:** [`demo/xorr-demo.mp4`](demo/xorr-demo.mp4) — 2:43, recorded against the deployed build on 2026-09-20 by
[`tools/record-demo.mjs`](../tools/record-demo.mjs), which signs in, walks the beats in [`DEMO-SCRIPT.md`](DEMO-SCRIPT.md)
and captions them. Nothing in it is staged: every figure on screen is what the executor and the chain answered while it
was recording, and where a list is filtered the filter is the product's own, tapped on camera. Re-run the script to get
a fresh one against live data.

Every address and number below was read from the chain or produced by a command in this repo between 2026-09-19 and
2026-09-25.

---

## One line

An autonomous agent that trades tokenized US stocks (xStocks) on X Layer for you, routing each trade through OKX DEX
first. It trades inside an on-chain permission that caps it per day, limits it to venues you chose, expires on its own,
can only pay *you*, and dies with one signature. Every agent spends from a budget of its own on chain, which only you
can set.

## The problem

Autonomous trading agents need to move money while you are asleep. Every way to give them that today is either
custody (hand over the funds) or a blank-cheque approval. Neither survives a bad model, a stolen key or a bug.

## What we built

- **`XorrDelegation`** — the permission as a contract: daily cap, expiry, venue allowlist, and an output floor bound to
  the owner (the owner's balance of the bought asset must rise, or the trade reverts). `spendVia` lets an aggregator
  that pulls through a separate approval contract (OKX DEX) fill under the same rules. `closePosition` sells back
  outside the cap so a stop-loss always fires; `revoke()` needs no server.
- **A budget per agent, in the same contract.** The owner sets each agent's budget with `setAgentBudget`, which only
  ever sets the sender's own, so only the owner can set one. `spendForAgent` charges an agent's buy to its budget as
  well as the daily cap, including a proposal from its strategy that the owner approves. `closeForAgent` credits back
  what the exit of an agent's own entry returns, and that exit sells only the lot the entry filled. A trade past the
  budget reverts
  (`AgentBudgetExceeded`), and an agent nobody budgeted cannot buy at all. The budgets bound what the executor submits
  as each agent's trade; the delegate key itself is bounded by the cap, the venues, the expiry, the output floor and
  revoke (see Honest limits). Nineteen contract tests, including a 256-run fuzz, hold this.
- **The agents** — score setups on 11 wrapped xStocks and crypto on X Layer (momentum, mean reversion, earnings
  windows from SEC EDGAR). They size against the cap and their own budget, both read from the chain, and hold outside
  Nasdaq hours when the pool drifts from xStocks' own reference price. They warn ahead of splits read from the token's
  scheduled multiplier, and explain every trade from the decision record written at the time. An agent with no budget
  says so in Activity instead of going quiet.
- **The app** — iOS, Android and web (Expo): Privy embedded wallet (Google, X, GitHub or email; on web also your own
  wallet — OKX Wallet, MetaMask, Rainbow, WalletConnect). It covers grant and revoke, each agent's on-chain budget set
  from its page with one signature, deposits in USDC or USDT0 on X Layer, a user-signed USDT0→USDC convert, holdings,
  activity, and `/judge`, which re-runs the product's claims against the live chain.

## How it uses OKX and X Layer

| | |
|---|---|
| X Layer | Every contract, every fill, every grant. Cancun `tstore` proven on X Layer state. |
| OKX DEX API | v6 aggregator (HMAC-signed), the first venue for every trade. It settles through `spendVia` / `spendForAgent` to OKX's approve spender. The executor simulates that exact call first, and settles through OKX unless the contract would refuse the route or it would deliver more than 0.5% less than Uniswap. Keyed and live on the deployed executor; each fill's receipt names the venue it used. |
| OKX Wallet | A sign-in option on web (Privy `okx_wallet`). |
| OKX on-ramp | "Open OKX" on the deposit screen to buy and withdraw USDC/USDT0 to X Layer. |
| xStocks | Backed's wrapped xStocks, their on-chain multipliers and roles, and their asset API for logos. |
| Uniswap v3 on X Layer | The fallback venue, for a trade OKX cannot route or fill; USDG hop for the stocks without a USDC pool. |
| Aave v3 on X Layer | Idle cash earns on USDT0 (~3.5%, read live). |

## Proof

- `cd contracts && XLAYER_RPC=https://rpc.xlayer.tech forge test` — unit suites plus a fork suite on real X Layer
  state (TSLAx direct, NVDAx via USDG, cap, foreign venue, close, revoke).
- `cd contracts && forge test --match-contract XorrAgentBudgetTest -vv` — the per-agent budgets: a buy charged to the
  agent's budget and its sale credited back, a trade past the budget and one by an unbudgeted agent refused, agents and
  owners kept apart, only the owner able to set a budget, revoke and expiry stopping every agent, and a 256-run fuzz.
- `cd server && npm run prove:testnet` — the permission on X Layer testnet: grant, read back, `VenueNotAllowed`,
  `NotDelegate`, revoke, `PolicyRevoked`, each an OKLink transaction.
- **A permission standing on the public chain, to check without running anything.** Owner
  `0xd747284963556832e22C6d63bAB0B82Da7d54d11`, granted 2026-09-20 ([the grant on
  OKLink](https://www.oklink.com/xlayer-test/tx/0x8b2586abfaa2bab08097d092b81cfccec26a94c7b66fefc962650bd32f4f438b)),
  $100/day to the delegate for 7 days. Paste it into `/judge` on the testnet deployment, or read it straight off the
  contract:
  [`/verify?owner=0xd747…4d11`](https://executor-testnet-production.up.railway.app/verify?owner=0xd747284963556832e22C6d63bAB0B82Da7d54d11)
  — 15 pass, 0 fail, 5 skip. The five skips are the things that genuinely are not on this chain: no xStock wrappers
  (they are X Layer mainnet contracts), and no wallet, strategies or audit trail, because nobody has signed in on the
  testnet deployment. It was left standing by `PROVE_KEEP=1`, expires on its own, holds no funds, and its owner key
  was never written down.
- `cd server && npm run setup:fork && npm run prove:fork` — the executor's own order path on a fork: $50 of TSLAx
  into the owner's wallet, a $60 NVDAx buy refused by the on-chain cap, the position sold back for $49.95, revoke
  refusing the next order. Both run in CI on every push.

## Honest limits

Real money moves on mainnet, and only inside the permission the owner signs; mainnet is new as of 2026-09-25, so its
history is short (its price bands start from readings the fork executor recorded from the live mainnet pools, and say
so). The X Layer testnet has no DEX, so the sandbox fills on a fork of mainnet instead.

OKX DEX routing needs an API key; the deployed executor has one. On the fork, OKX quotes mainnet while the fork's pools
are frozen at the fork block, so a route the fork cannot fill settles on Uniswap instead. The executor checks this by
simulating the call before anything is signed.

One delegate key signs every agent's trades, and the budgets do not bind that key. They bound what the executor
submits as each agent's trade: each such trade is charged to that agent's budget, and a trade past it reverts. The hard
limits on the key itself are the daily cap, the venue allowlist, the expiry, the output floor that makes every fill pay
the owner, and revoke. A stolen key could skip the budgets by trading as "no agent" (`spend`), inside the daily cap, and
could credit a sale to any agent's budget. Future work: an owner opt-in on the contract so that every delegate spend
must be charged to some budget.

Only an agent's exit of the lot it bought refills its budget. An agent's own entry arms an exit for exactly the units
it filled, never the rest of the holding. Every other sale settles as the owner's and refills no budget: an agent
strategy's own close (a momentum stop, an event-driven close), the order ticket, and "Sell everything". So a buy by an
agent's strategy is charged to that agent and is not paid back when the strategy sells. Firing an agent pauses its
strategies but leaves its exits armed.

Wrapped xStocks track shares through Backed's issuance and are not the shares themselves.
