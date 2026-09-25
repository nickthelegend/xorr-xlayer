<p align="center">
  <img src="assets/brand/xorr-banner.png" width="820" alt="XORR. — A bot that trades your capital while you get on with your life." />
</p>

# xorr

**An autonomous agent that trades tokenized US stocks for you — inside a permission you can revoke in one tap.**

Non-custodial. Your wallet, your keys, and a **scoped on-chain permission** the agent trades inside: capped per day,
restricted to venues you approved, time-boxed, and revocable without our cooperation. Inside it, **every agent has a
budget of its own on chain**. You set it, and the contract charges that agent's trades to it and refuses any trade
past it.

Chain: **OKX X Layer** (chain 196). Assets: **xStocks** (Backed's tokenized equities — TSLAx, NVDAx, SPYx, …).
Venues: the **OKX DEX aggregator** first, **Uniswap v3** on X Layer as the fallback. Yield: **Aave v3 on X Layer**
(USDT0). Built for OKX Dev Day 2026.

<!-- MAINNET: fill after deploy -->

**[▶ Watch the demo](docs/demo/xorr-demo.mp4)** (2:43) — the permission, the agent's own fills, the cap refusing an order,
and `/judge` re-checking all 20 claims against the chain. Recorded against the live build by
[`tools/record-demo.mjs`](tools/record-demo.mjs); re-run it and you get a fresh one.

---

## The idea in one paragraph

Handing a bot your money is a trust problem, not a trading problem. So the permission is the product:
`XorrDelegation` is a contract you grant that caps what the agent can spend per day, restricts it to the venues you
allowlisted, expires on its own, and **cannot send funds to an address of the agent's choosing** — every fill must
land the bought asset in *your* wallet or the transaction reverts. Revoking needs one signature from you and nothing
from us. Each agent you hire or make spends from its own budget on the same contract, which only you can set. The
agents read the market (xStock pool prices, a Solana-listed reference for off-hours drift, SEC EDGAR earnings windows,
corporate-action multipliers) and trade wrapped xStocks on X Layer inside that permission, routed through OKX DEX
first.

## Verify it yourself — on a fork of X Layer mainnet, in about five minutes

Everything below runs against a local **anvil fork of X Layer mainnet**: Circle's real USDC, Backed's real wrapped
xStocks and the real Uniswap v3 pools they trade in, with no real money. X Layer's public RPC needs no key.

**Prerequisites:** Node 22+, [Foundry](https://book.getfoundry.sh/getting-started/installation), PostgreSQL 16.

```bash
git clone https://github.com/nickthelegend/xorr-xlayer && cd xorr-xlayer
npm ci --ignore-scripts && (cd server && npm ci --ignore-scripts)
```

**1. The contract, against real X Layer state** (no database, no server):

```bash
cd contracts && XLAYER_RPC=https://rpc.xlayer.tech forge test -vv
```

64 unit tests plus the fork suite: a delegated buy of wrapped TSLAx directly against USDC, NVDAx through the USDG
hop, the daily cap refusing a buy, a venue the owner never allowed refused, a position sold back through
`closePosition`, and `revoke()` stopping everything. Nineteen of them are the per-agent budgets
(`XorrAgentBudget.t.sol`): an agent's buy charged to its budget and its sale credited back, a trade past the budget and
one by an agent nobody budgeted both refused, one agent's spending never touching another's, nobody but the owner able
to set a budget, revoke and expiry stopping every agent, and a 256-run fuzz that no sequence of trades takes an agent
past its budget.

**2. The permission on a public chain** — X Layer testnet, the deployed contracts, every step an OKLink transaction
(needs the deployer's test OKB: `server/.env.deployer`):

```bash
cd server && set -a && . ./.env.deployer && set +a && npm run prove:testnet
```

A fresh owner grants the testnet delegate $100/day for 7 days, the chain reads it back, the contract refuses a venue
the owner never allowed (`VenueNotAllowed`) and anyone but the delegate (`NotDelegate`), the owner revokes with one
signature, and the delegate is refused from then on (`PolicyRevoked`).

**3. The whole product loop, through the executor's own code path:**

```bash
anvil --fork-url https://rpc.xlayer.tech --chain-id 196          # terminal 1
cd server
createdb xorr_xlayer && export DATABASE_URL=postgres://localhost/xorr_xlayer PRIVY_APP_ID=x PRIVY_APP_SECRET=x
npm run migrate
XORR_CHAIN=xlayer-fork npm run setup:fork                         # deploys XorrDelegation + XorrAuditAnchor on the fork
set -a && . ./.env.fork && set +a && npm run prove:fork
```

`prove:fork` (`server/src/prove-xlayer.ts`) creates a fresh owner key that signs its own approvals and grant
($100/day for 7 days), then drives `placeOrder` → `runStrategy` → settlement → `XorrDelegation.spend`:

```
1. $50 of TSLAx
  ✓ the executor filled it                    — 0xab74…1be9
  ✓ the owner holds wrapped TSLAx             — 0.137381752545180866 TSLAx
  ✓ exactly $50 of USDC left the owner
  ✓ the delegation holds nothing
  ✓ the run is recorded as filled             — venue uniswap-v3
2. $60 of NVDAx the same day — past the $100 cap
  ✓ the order is refused                      — daily_cap
3. sell the TSLAx back to USDC
  ✓ the proceeds reached the owner            — $49.950013 back for $50
  ✓ the close did not spend the cap           — $50 left today
4. the owner revokes
  ✓ the next order is refused before anything is signed — no_delegation
ALL CHECKS PASSED
```

The $0.05 is two 0.05% pool fees; nothing else is taken. CI runs both proofs on every push
(`.github/workflows/ci.yml`).

## The core primitive

`contracts/src/XorrDelegation.sol` — every constraint enforced **by the contract**, not by us:

- a daily cap in the settlement token (USDC), resetting on the UTC day boundary
- an expiry
- a venue allowlist — the agent can only call contracts the owner approved
- an **output floor bound to the owner**: `spend(owner, token, venue, amount, tokenOut, minOut, data)` measures the
  owner's `tokenOut` balance across the call and reverts unless it rose by at least `minOut`, so calldata that
  routes the proceeds anywhere else fails
- `spendVia` / `closePositionVia` for aggregators that pull through a separate approval contract (OKX DEX's approve
  spender): both addresses must be on the allowlist, and the approval is reset to zero in the same call
- `closePosition` sells a held asset back to USDC **without** touching the cap — a stop-loss a spending limit could
  silence is not a stop-loss
- **a budget per agent**: `setAgentBudget(agent, amount)` sets the budget of whoever sends it, so only the owner can set
  their agents' budgets. `spendForAgent` charges an agent's buy to its budget as well as the daily cap, and reverts
  with `AgentBudgetExceeded` past it; `closeForAgent` credits what a sale returns in USDC back to it. An agent's key is
  `keccak256("xorr-agent:" + its id)`, and `agentBudget(owner, agent)` is readable by anyone. A budget bounds the
  trades submitted as that agent's. It is not a limit on the delegate key itself: see Known limitations
- `revoke()` needs only the owner's signature: no server, no oracle, no cooperation from the agent

It never custodies: it pulls exactly the approved amount at the moment of a trade, forwards it, holds nothing
afterwards, and leaves no standing approval behind. The active owner is kept in transient storage (EIP-1153), so the
contract is built for Cancun — X Layer executes it (proven on the fork above).

## What trades, and where

| | |
|---|---|
| Stocks | 11 wrapped xStocks (ERC-4626 wrappers over Backed's rebasing tokens): TSLAx, NVDAx, AAPLx, MSFTx, AMZNx, GOOGLx, METAx, MSTRx, COINx, SPYx, QQQx |
| Crypto | XBTC, WOKB (OKB), USDG, USDT0, USDC — only assets with a real pool against a stablecoin |
| Venue 1 | OKX DEX aggregator API (v6, HMAC-signed) — settles every trade it can route, fills through `spendVia`. The executor first simulates the exact contract call, and keeps OKX's route unless the contract would refuse it here or its guaranteed output is more than 0.5% below Uniswap's |
| Venue 2 | Uniswap v3 on X Layer, the fallback — QuoterV2 prices, SwapRouter02 fills; TSLAx/QQQx/GOOGLx/COINx direct against USDC, the rest through the USDC/USDG 0.01% hop |
| Yield | Aave v3 on X Layer: idle USDC is swapped to USDT0 and supplied (USDT0 reserve ~3.5% APY read live from `currentLiquidityRate`; USDC's reserve pays ~0%) |
| Deposits | USDC or USDT0 on X Layer to your address (QR); OKX for buying; USDT0 → USDC is a swap **you** sign |

## What is actually real

**The rule that settles arguments:** every number on screen is real, or it is labelled. A confident wrong number is
the worst outcome available.

| | |
|---|---|
| xStock prices | A live Uniswap v3 quote at a real $1,000 size — what you would actually pay, not the Nasdaq print |
| Second opinion | Crypto: CoinGecko vs the X Layer pool. xStocks: xStocks' own share price for the same token on Solana (Jupiter's price API) × the wrapper's `convertToAssets` multiplier. `/market/crosscheck` compares the two and names which feed answered; `/market/xstocks` carries both prices per row. All eleven measured within 0.5% of the pools on 2026-09-20 |
| Off-hours guard | Outside Nasdaq hours the agent measures the pool against that reference and holds past 1.2–1.5% drift, or when there is no reference at all — "could not measure" is not "fine" |
| Corporate actions | The wrapper's multiplier and the raw token's scheduled `newMultiplier`/activation time, read on chain; holders are warned ahead of a split or dividend reinvestment |
| Backing | Backed's contracts read directly: owner and pauser are 2-of-3 Safes, the minter an ordinary wallet, and the burner **cannot** seize balances — plus Backed's proof-of-reserves feed |
| Logos | The issuer's own marks (Backed's xStocks API) and CoinGecko |
| Permission | On chain, signed by the user's embedded wallet |
| Agent budgets | Read from the contract (`agentBudget`) every time the app shows one; setting one is a transaction the owner signs, and the figure shown afterwards is the chain's answer, not what was typed |
| Venue | Every fill records the venue that filled it, and its receipt names it — OKX DEX or Uniswap v3 — beside the transaction |

## Architecture

```
app/ + src/        Expo (iOS, Android, web) — Privy embedded wallet signs grants, revokes, deposits' conversions
server/            the executor (Hono + Postgres): scheduler, strategies, autonomous + basket agents, settlement
  venues/          tokens.ts (registry) · uniswap.ts · okxdex.ts · stocks.ts/xstocks.ts · aave.ts · multiplier.ts
  executor/        run.ts (one strategy tick) · settle.ts (venue choice) · order.ts/swap.ts (one-shot orders)
  bot/             autonomous.ts (scores setups, sizes against the on-chain cap, fails closed) · basket.ts
contracts/         XorrDelegation (the permission) · XorrAuditAnchor (audit-trail head published on chain)
infra/xlayer-fork/ the hosted anvil fork of X Layer (Railway), state kept across restarts
```

The agent's loop: the scheduler ticks → each live strategy or the autonomous agent plans a trade → the executor
reads the owner's policy and that agent's budget **from the chain** (never from our database) → routes it through OKX
DEX, or Uniswap where OKX cannot fill it → the delegate key calls `spendForAgent` (or `spend`, for an order the owner
placed themselves) → the fill is measured from the owner's balance, booked, audited (hash-chained, anchored on chain)
and pushed to the phone.

## Deployment

Open **https://xorr-xlayer.vercel.app** and sign in; `/judge` re-runs every claim below against the live chain.

<!-- MAINNET: fill after deploy -->


| | |
|---|---|
| Executor (X Layer fork) | https://executor-fork-production-2db8.up.railway.app — `/health`, `/verify` (Railway `xorr-xlayer / executor-fork`, `node scripts/deploy-executor.mjs executor-fork`) |
| Fork node | Railway service `xlayer-fork` (anvil v1.7.1 forking chain 196, `/data` volume) — `https://xlayer-fork-production.up.railway.app` |
| Web app | **https://xorr-xlayer.vercel.app** (Vercel `xorr-xlayer`, `npm run deploy:web` — refuses anything but an X Layer fork or testnet executor) |
| Contracts, X Layer testnet | XorrDelegation [`0x156DCE9E9d523775AB51f882616A431EdBfBcA22`](https://www.oklink.com/xlayer-test/address/0x156DCE9E9d523775AB51f882616A431EdBfBcA22), XorrAuditAnchor [`0x36d503D1893CAB30B5D68DC9A96e8B91bfcBe196`](https://www.oklink.com/xlayer-test/address/0x36d503D1893CAB30B5D68DC9A96e8B91bfcBe196) — both Sourcify exact match (`contracts/deployments/xlayer-testnet.json`) |
| Executor (X Layer testnet) | https://executor-testnet-production.up.railway.app — serves the testnet contracts; nothing fills there (no DEX) |

Chain configuration lives in one place per side: `src/chain.ts` (app) and `server/src/evm/chains.ts` (executor), with
a test that holds the two to each other.

## Running it

```bash
cp .env.example .env               # PRIVY_APP_ID / PRIVY_APP_SECRET / EXPO_PUBLIC_PRIVY_APP_ID, DATABASE_URL
cd server && npm run migrate && npm run dev     # the executor (XORR_CHAIN=xlayer-fork with a fork running)
npm run web                        # the app, from the repo root
```

Optional: `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` turn on OKX DEX routing (without them Uniswap settles
everything); `OPENROUTER_API_KEY` lets the agent write its reasons in prose (without it, explanations are the
structured decision record only).

## Tests

```bash
npm test                                   # app + executor unit suites (live suites need LIVE=1 and a running executor)
npx tsc --noEmit && npx tsc --noEmit -p server/tsconfig.json
cd contracts && forge test                 # + XLAYER_RPC for the fork suite
```

## Known limitations — read these before you believe us

- **The X Layer testnet has no DEX.** Contracts and wallet flows run there; fills happen on the fork, where the
  pools are mainnet's. Nothing in this repo moves real money, and mainnet needs `ALLOW_MAINNET=yes` to start at all.
  <!-- MAINNET: fill after deploy -->
- **One key signs for every agent, and the budgets do not bind that key.** Agents are not separate wallets: the
  executor holds one delegate key, and it signs every agent's trades. The budgets bound what the executor submits as
  each agent's trade. Each such trade is charged to that agent's budget, a trade past it reverts, and only you can set
  a budget. The hard limits on the key itself are the ones that bind it no matter which function it calls: the
  daily cap, the venue allowlist, the expiry, the output floor that makes every fill pay you, and revoke. A stolen key
  could skip the budgets by trading as "no agent" (`spend`), inside the daily cap, and could credit a sale to any
  agent's budget. Future work: an owner opt-in on the contract so that every delegate spend must be charged to some
  budget.
- **Only an agent's own sales refill its budget.** An agent's exit sells its own lot as the agent's. Anything beyond
  that lot, and any sale you make yourself (the order ticket, "Sell everything"), is sold as yours and refills
  nothing.
- **A fork is pinned at a block.** Its pools stop moving while the market doesn't. So on a fork, prices, observations
  and the agent's signals read the live X Layer mainnet pools, while fills settle against the fork's own pools — the
  ticket shows both ("$362.38 each · mark $364.95"). Fill-vs-market figures on the fork therefore mix venue quality with
  fork drift; the app labels them.
- **OKX DEX routing needs an API key.** The deployed executor has one, so its trades go to OKX DEX first. A local
  run without `OKX_API_KEY` settles everything on Uniswap v3. On a fork, OKX quotes mainnet while the fork's pools are
  frozen at the fork block, so some OKX routes cannot fill there and those trades settle on Uniswap. The executor
  simulates the exact contract call before it chooses, so such a route is set aside before anything is signed.
- **Wrapped xStocks are not the underlying shares.** They track them through Backed's issuance; the backing screen
  shows exactly who can mint, pause and upgrade.

## Repo map

```
app/                     screens (Expo Router)
src/                     app libraries, UI kit (src/ui), chain config (src/chain.ts)
server/src/              the executor — see Architecture
contracts/               Foundry: src/, test/ (incl. XorrXLayer.fork.t.sol), script/, deploy-xlayer-testnet.sh
infra/xlayer-fork/       hosted fork node
scripts/                 build-web.mjs, deploy-executor.mjs
PLAN.md                  the X Layer migration plan, decisions and status
```
