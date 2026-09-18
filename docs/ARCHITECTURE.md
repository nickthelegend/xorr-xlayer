# The backend, and why it is shaped this way

A bot trades your money without ever holding it. Every constraint below follows from that one
sentence.

## The shape

```
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ THE APP — Expo, web + native                                                  │
  │ Privy embedded wallet. The user signs the grant; nothing else asks them to.    │
  └────────────────────────────────┬─────────────────────────────────────────────┘
                                   │ Privy access token, verified per request
  ┌────────────────────────────────▼─────────────────────────────────────────────┐
  │ EXECUTOR — Hono on Railway                                                    │
  │                                                                               │
  │   rateLimit → auth → principal → requireScope                                 │
  │        │                                                                      │
  │        ├── user routes    session-scoped, one wallet                          │
  │        └── /agent/*       key-scoped, across every wallet it serves           │
  │                                                                               │
  │   ┌──────────────────── THE ONE SPEND PATH ───────────────────────────────┐  │
  │   │  runStrategy → PLANNERS[kind] → guardAndSpend                          │  │
  │   │    1 period claim   2 rules engine   3 CHAIN policy   4 price   5 send  │  │
  │   └────────────────────────────────────────────────────────────────────────┘  │
  │                                                                               │
  │   scheduler (in-process, or POST /agent/tick from a worker)                    │
  └───────┬─────────────────────────────────────┬────────────────────────────────┘
          │                                     │
   ┌──────▼────────┐                   ┌────────▼───────────────────────────────┐
   │ PostgreSQL    │                   │ BASE                                    │
   │ book, audit,  │                   │  XorrDelegation  — the permission        │
   │ runs, keys    │                   │  1inch Router v6 — the fill              │
   └───────────────┘                   │  Aqua / SwapVM   — the maker side        │
                                       │  Aave v3         — idle cash             │
          ┌────────────────────────────┴────────────────────────────────────────┐
          │ THE GRAPH — two subgraphs, joined before every spend                 │
          │   xorr       what this user permitted, and what they have spent      │
          │   xorr-aqua  which maker books are open, and how deep                │
          └──────────────────────────────────────────────────────────────────────┘
```

## Custody: the contract is the authority, not us

`XorrDelegation` holds no funds. The user approves it and grants a policy — a delegate, a daily
cap, an expiry, a venue allowlist. Every trade is `spend()` or `closePosition()`, and each one
does the same three things in the same order: pull exactly what this trade needs, call one
allowlisted venue, send the proceeds to the **user's** wallet. Between trades the contract's
balance of every token is zero, and `/verify` checks that live.

Our database cannot widen any of this. If our records said the cap was $10,000 and the chain said
$1,000, the chain wins — the enforcement is in the contract, and the executor re-reads it on every
run rather than trusting a row it wrote itself.

`revoke()` needs nothing but the owner's signature. No server, no oracle, no cooperation from us.

## The one spend path

There is exactly one place capital can leave a wallet: `guardAndSpend` inside `runStrategy`. Every
entry — a scheduled DCA, a rebalance, a grid level, a one-shot order from the ticket — arrives
there. Adding a second would mean two places to get the limits right.

Five gates, in this order:

1. **Period claim.** `strategy_runs.period_key` has a `UNIQUE` index. Two ticks in one period is a
   constraint violation, not a double buy. This is why the scheduler and a worker can both run.
2. **Rules engine.** Our own limits: per-trade size, spread, the day's tally.
3. **The chain.** `policyOf(owner)` — cap, expiry, revoked, delegate, venue allowlist. The
   stricter of our tally and the on-chain one governs.
4. **Price.** A real quote from the feed the screens use. No fill is priced from a stored number.
5. **Send.** The delegate signs. The contract enforces everything again, because it does not trust
   the caller either.

Exits do **not** pass through the cap. A cap limits putting capital *at* risk; a cap that can block
an exit is a cap that traps you. `closePosition` is a separate contract function with its own,
narrower authority — it can only reduce exposure.

## Entry and exit

**Taking a position** — `PLANNERS`, one per strategy kind:

| kind | what it decides |
|---|---|
| `dca` | a fixed dollar amount on a cadence |
| `buy` | one shot, no cadence — what `POST /orders` creates |
| `rebalance` | the difference toward target weights, never the whole position |
| `grid` | a level in a range the user set |
| `yield-rotation` | idle USDC into Aave v3, and back |

**Closing one** — `planExitRules`, tier 3. It maintains a peak price per position, so a trailing
stop ratchets up and never down, and fires take-profit, stop-loss or trailing against a live mark.
`POST /agent/positions/close` closes one holding by fraction; `POST /panic/flatten` closes
everything, per-asset, reporting each leg — a flatten that sells three of four and returns "ok" is
a lie about the fourth.

A fraction is applied to the **chain's** balance in integer maths, so a 100% close is exactly the
balance and never eight wei over it.

## Who may ask: three credentials, three jobs

Trading unattended means something other than a logged-in human can move money. That thing needs a
name.

| credential | scopes | may | may not |
|---|---|---|---|
| Privy access token | — | act on **that user's** wallet | reach `/agent/*` |
| `agent_keys` row | `trade:open` **or** `trade:close` | one side of the book, across every wallet | the other side, or minting |
| `OPERATOR_TOKEN` | `admin`, `read` | mint and revoke agent identities | **trade** |

The two trade scopes are separate because the two sides are separate risks: a leaked key costs you
one of them. `admin` does **not** imply either — a leaked operator key is not a leaked trading key.

`/agent/tick` needs **both**, because one pass can open a due DCA and close a due stop; a key
holding one side would either act outside its remit or half-run the book. That is why the
deployment has three identities and not two: `entry-agent`, `exit-agent`, and a `scheduler` that
holds both and does nothing else.

Tokens are stored as a sha256 digest and returned in plaintext exactly once. The operator token is
compared in constant time. A user token on an `/agent/*` route is 403 `wrong_principal`, and an
agent key on a user route is the same — not a 500, and not a quiet success.

Verified live against the deployment:

| route | none | entry | exit | scheduler | operator |
|---|---|---|---|---|---|
| `/health` | 200 | 200 | 200 | 200 | 200 |
| `/agent/whoami` | 401 | 200 | 200 | 200 | 200 |
| `/agent/strategies/:id/run` | 401 | **200** | 403 | 200 | 403 |
| `/agent/positions/close` | 401 | 403 | **200** | 200 | 403 |
| `/agent/tick` | 401 | 403 | 403 | **200** | 403 |
| `/agent/keys` | 401 | 403 | 403 | 403 | **200** |
| `/positions` (user route) | 401 | 403 | 403 | 403 | 403 |

## The Graph decides the route, it does not decorate the screen

Before any spend, `decide()` reads two independent subgraphs over two different protocols:

- **`xorr`** — our `XorrDelegation` contract. What this user permitted, what they have spent
  today, how their realised flow has run.
- **`xorr-aqua`** — the official 1inch Aqua deployment. Which maker books are open, and how deep.

Neither index can see the other's half, and the decision needs both: a permission with no venue and
a venue with no permission are equally dead. The join picks the route — an Aqua book when one can
fill the size, the aggregator when none can.

Three outcomes, all meaningful: a book deep enough, no book deep enough, or **the index is
unreachable** — which routes to the aggregator and says so, because silently treating "cannot see"
as "nothing there" hides an outage behind a worse fill.

## Failure

- A failed run is a **recorded** row, not a gap. `strategy_runs` keeps status, error and timing.
- A revert is translated. `NotDelegate()` becomes "That agent is not the one you gave permission
  to." The raw selector is kept alongside it for whoever has to debug.
- A SIGTERM drains for up to ten seconds so a run in flight finishes; the period key means an
  abandoned one can never be retried, so abandoning it silently skips a day.
- Anything the drain could not finish is reconciled at boot, before the scheduler starts.
- An upstream that fails four times in a row is skipped for thirty seconds, with a message naming
  the host and when it will be tried again — one dead dependency degrades the app instead of
  hanging it.

## Deployment

| service | what it is |
|---|---|
| `executor` | Base **Sepolia**. The public, explorer-checkable deployment: real contract, real subgraph, real gas. |
| `base-fork` | anvil forking Base **mainnet**. Real 1inch, Aqua, SwapVM, USDC, Aave, at real liquidity. |
| `executor-fork` | the same server on `base-fork`. Where fills actually execute. |
| Postgres ×2 | one per executor, so two chains never share a book. |

**Why two.** 1inch has no deployment on Base Sepolia, so a testnet fill is impossible — the honest
options are a mainnet fork or real money, and real money is out of scope. The fork is where the
whole thesis runs end to end; Sepolia is where the claims are publicly checkable. Neither
environment is asked to carry the other's evidence.

`/verify` re-checks every claim live, on both. It reports the observed value, not a boolean, and a
failing claim is a red row on a 200 — a console that goes blank when something is broken is worse
than no console.

## Sponsor integrations

| track | where it is, and what it decides |
|---|---|
| **1inch — Aggregator** | Every fill. Real v6 calldata aimed at Router v6, executed by the delegation. The Route row names what it actually routed through. |
| **1inch — Aqua** | `XorrAquaBook` — a self-custodial maker book run by the bot inside the user's own limits. Takers swap against the maker's virtual balance; the tokens never leave the maker's wallet. Constant-product with a bounded oracle band, because a 24/7 book on a 24/5 underlying is free money for an arbitrageur overnight. |
| **1inch — SwapVM** | `XorrSwapVMBook`, deployed alongside it. |
| **The Graph** | Two subgraphs, joined **before** a spend to pick the venue. Not a read for display — a branch that changes what the bot does. |
| **Privy** | Identity and wallet are one object. Every user route verifies a real access token; the embedded wallet signs the grant. The user's keys never touch the executor. |
| **Base** | Everything settles here. Basenames resolve both parties on the safety screen through the L2 resolver, because two addresses that differ only in the middle look identical truncated. |
| **Stocks** | Tokenized equities as real Base contracts, priced by the 1inch route that would actually fill them — never by a feed we do not have. On a chain where they do not exist the app says so instead of showing a number. |
| **Aave v3** | Idle USDC earns at `currentLiquidityRate`, read live from the Pool. Supply and withdraw build real calldata; the Pool is a second allowlisted venue on the grant. |
