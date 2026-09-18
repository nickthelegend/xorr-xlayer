# Incident runbook — PLAN.md 14.8

The bot spends real money without a human present. This is what to do when it misbehaves.

## 0. The first move is always the same

**Stop the bot before you diagnose it.** Diagnosis takes minutes; a misbehaving strategy takes
seconds.

```bash
# Per user (their own kill switch, on chain):
curl -XPOST $API/delegation/revoke -d '{}'

# Global, independent of every per-user delegation:
railway variables set SCHEDULER=off && railway redeploy
```

The global kill and the per-user kill are deliberately separate. A bug in one user's strategy
should not require revoking everyone; a bug in the executor should not require asking every user
to press a button.

## 1. "The bot bought twice"

Almost certainly it did not — check before you believe it.

```sql
SELECT period_key, count(*) FROM strategy_runs GROUP BY 1 HAVING count(*) > 1;
```

`period_key` is `UNIQUE`, so this query returning rows means the constraint was dropped, not that
the executor raced. If it returns nothing, the second "buy" the user saw is a duplicate
NOTIFICATION or a duplicate audit row — look there instead.

## 2. "A strategy is stuck"

```sql
SELECT * FROM strategy_runs WHERE status='pending' AND started_at < now() - interval '10 minutes';
```

A pending run means the period was claimed and the transaction never resolved. Do NOT delete the
row to "let it retry" — that is exactly how a double-spend happens. Instead:

1. Look up the intended transfer on chain by the strategy's owner token account.
2. If it landed, mark the run `filled` with the real signature.
3. If it did not, mark it `failed`. The next tick claims the next period, not this one.

## 3. "The audit trail does not verify"

```bash
curl $API/activity/verify
```

`ok: false` with a `brokenAtSeq` means a row was altered or removed. The table has an append-only
trigger, so this should be impossible without superuser access. Treat it as a security incident,
not a data-quality one: preserve the database, take a dump, and investigate access.

## 4. "The bot said something wrong"

Check whether it was a NUMBER or a SENTENCE.

- A wrong **number** is a serious bug: every figure is rendered by `src/format` from a stored
  record, so a wrong number means a wrong record. Trace it via the run's signature.
- A wrong **sentence** is a model artifact. It cannot contain a number (`validateVoice` rejects
  those), so the blast radius is tone. Lower the tone dial or set `XORR_MODEL` to a stronger model.

## 5. "Someone's funds moved unexpectedly"

The delegate key CANNOT withdraw — its only power is a capped transfer from one token account
(see `docs/SECURITY.md` §1). So an unexpected movement means either:

1. The user's own key was used elsewhere. Check the transaction's signer.
2. The delegate key was stolen AND an approval was live. Revoke every delegation immediately:

```sql
SELECT wallet_id FROM delegations WHERE revoked = false;
```

then rotate the delegate keypair and re-approve nothing until the cause is found.

## 6. Health checks

```bash
curl $API/health                 # db + cluster
curl $API/limits                 # cap, spent today, remaining
curl $API/delegation             # includes onChainRemainingUsd, read from the chain
```

`onChainRemainingUsd` disagreeing with `dailyCapUsd − spentTodayUsd` means our books and the chain
have diverged. **The chain is right.** Reconcile our records to it, never the other way round.

## 7. What NOT to do

- Do not "just restart the executor" to clear a stuck run. Restarting is safe (the period claim
  survives), but it does not resolve the run, and it hides the evidence in the logs.
- Do not edit `audit_log`. The trigger will refuse, and working around it destroys the artifact
  the trail exists to be.
- Do not raise a user's cap to unblock them. The block is the feature.
- Do not delete the Railway project to take the frontend down. The frontend is on Vercel; the
  Railway project is the backend, and its variables are the only copy of the delegate key, the
  Privy authorization key and the operator token. A project scheduled for deletion stops every
  deployment at once and locks those variables, and deleting it for good loses them. Remove a single
  service instead. (It happened on 2026-09-11 — see section 9.)

## 8. The Base mainnet fork ages, and has to be re-forked

`base-fork` is anvil pinned at the mainnet block it started from. It does not follow mainnet, but
**1inch quotes against live mainnet** — so the longer the fork runs, the further the real pools
drift from its copy of them, until the router's `minReturn` no longer holds and every fill reverts.

It reports itself correctly rather than silently filling badly:

```
The price moved more than your slippage limit while this was in flight. Nothing was placed.
```

Measured: at **~8,700 blocks behind** (about five hours of real trading) every swap failed this
way. Under an hour it is fine.

Re-fork when you see that error on trades that should route — the steps are under **Rebuilding the
fork** below. A restart does **not** re-fork any more: the chain is saved on the service's `fork-state`
volume and a restart resumes it (PLAN.md 3.3), so ageing is the one reason to start over.

The database survives either way — agent keys, strategies and the audit trail are keyed by user, not by
contract address. Only the on-chain state is new after a re-fork, so the contracts, the makers and the
grant have to be rebuilt, which `npm run rebuild:fork` does in one go.

## Rebuilding the fork

`base-fork` runs `infra/base-fork`: anvil pinned at 1.7.1, forking Base at the head the first time it
starts and saving its chain to `/data` every 30 seconds and on shutdown. A restart or a redeploy resumes
that chain from the same Base block, with our contracts, the makers and every grant still on it. Live
Base keeps moving, though — the gap grows by roughly a block every two seconds — and it matters because
**1inch quotes against live state while execution happens against the fork's**: a swap built from a live
quote eventually cannot be satisfied by the frozen pools, and the aggregator reverts
`ReturnAmountIsNotEnough`.

Measured before an earlier rebuild: 13,110 blocks behind, about 7.3 hours, and every aggregator-routed
DCA failing on slippage. Aqua fills were unaffected, because a book is quoted from its own on-chain
state and there is nothing to drift against.

Rebuild when a DCA starts failing on slippage, or before a demo:

```bash
# 1. Re-fork. A new REFORKED_AT is the one thing that drops the saved chain; setting it redeploys
#    base-fork, which forks Base again at the head. (Any other change now resumes the old chain.)
railway variables --service base-fork --set "REFORKED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 2. Rebuild everything on it: our contracts and the audit anchor, gas for this machine's delegate and
#    the DEPLOYED executor's, 25,000 USDC for the owner, an Aqua book and a SwapVM program shipped from
#    their own makers, and the owner's grant to the deployed delegate over every venue the executor
#    settles through. Privy cannot sign for a fork of Base — chain 8453 is indistinguishable from real
#    Base to its RPC — so the grant impersonates the owner. Writes server/.env.fork.
cd server
set -a && . ../.env && set +a
FORK_RPC=https://base-fork-production.up.railway.app XORR_CHAIN=base-fork \
OWNER_ADDRESS=0xYourWallet XORR_DELEGATE_ADDRESS=0xC38f38f45463f77bD823FebE16b15714Eb98c8A5 \
FORK_GRANT_CAP_USD=2810 npm run rebuild:fork

# 3. Point the executor at the new addresses — Railway vars on `executor-fork`, from server/.env.fork:
#    DELEGATION_ADDRESS, AQUA_BOOK_ADDRESS, SWAPVM_BOOK_ADDRESS, ANCHOR_ADDRESS. Setting them redeploys it.

# 4. Confirm.
curl -s "$FORK_API/verify?owner=0xYourWallet" | jq '.passed, .failed'
```

A book or a program that has been traded dry, or has expired, is replaced without a rebuild:
`FORK_RPC=… XORR_CHAIN=base-fork AQUA_BOOK_ADDRESS=… SWAPVM_BOOK_ADDRESS=… npm run ship:makers [-- --aqua | --swapvm]`
from `server/`.

To change the fork's image or entrypoint, deploy the directory — it resumes the saved chain:
`railway up --service base-fork --ci` from `infra/base-fork`.

The database is untouched by all of this: the audit trail, strategies and positions live in
Postgres and survive. What a re-fork loses is on-chain state — the old contract addresses stop existing,
so anything holding a balance on the previous fork is gone with it.

## 9. Where it runs

| Piece | Host | Name |
|---|---|---|
| The app (static web export) | Vercel | project `xorr-eth` → `https://app.xorr.finance` (also `https://xorr-eth.vercel.app`), built against `executor-fork` and the `base-fork` RPC since PLAN.md 4.2 |
| Executor, Base Sepolia | Railway | `executor` → `https://api.xorr.finance`, i.e. `https://executor-production-1659.up.railway.app` (Postgres: `Postgres-gWN2`) |
| Executor, Base mainnet fork | Railway | `executor-fork` → `https://executor-fork-production.up.railway.app` (Postgres: `Postgres-WPy4`) |
| The fork itself (anvil) | Railway | `base-fork` → `https://base-fork-production.up.railway.app` — `infra/base-fork`, its chain on the `fork-state` volume, so a restart resumes it |

Redeploy the frontend with one command. It refuses to build against an executor that is down or
unreachable — and, for the fork, against an RPC that does not answer as anvil on chain 8453 — reads
the executor URL and the fork RPC back out of the bundle, and deploys `dist-web` with a
`vercel.json` that serves the hashed bundles as immutable and falls back to `index.html` for every
client-side route:

```bash
npm run deploy:web          # the fork; XORR_WEB_API=https://api.xorr.finance builds Base Sepolia
```

The executor's CORS is `ALLOWED_ORIGINS` on each Railway service — `*` today. If it is ever narrowed,
both app origins have to be in the list, or the app loads and every request fails.

**DNS.** `xorr.finance` is on Vercel's nameservers, in the same Vercel team as the project. `app` is a
project domain on `xorr-eth` — moving it between projects is a domain move, no DNS change. `api` is a
CNAME to the target Railway issued for the executor's custom domain, with Railway's
`_railway-verify.api` TXT record beside it; the certificate is Railway's. The bundle still calls the
`up.railway.app` address directly, so the app does not depend on that record.

**Recovering a project scheduled for deletion.** On 2026-09-11, during the move of the frontend to
Vercel, the whole Railway project was scheduled for deletion. Every
deployment stopped and the variables locked, but volumes and variables survive the 48-hour window.
Cancelling brought everything back — the services redeployed on their own, both databases intact —
except the fork, whose chain state had no volume then; it was rebuilt with section 8. The call is the
dashboard's restore, or the API's `projectScheduleDeleteCancel(id)`.

## 10. The MongoDB copy

Postgres is the executor's database. Each executor also copies every table of its database into
MongoDB Atlas — `executor` into `xorr_base_sepolia`, `executor-fork` into `xorr_base_fork` — on a
schedule, verified row by row (`server/src/db/mongo-mirror.ts`). The copy runs inside the executors
because `Postgres-gWN2` and `Postgres-WPy4` have no public address.

- **Settings**, on each executor service: `MONGODB_URI`, `MONGO_MIRROR_DB` (no default, on purpose: a
  local executor loads the same `.env`, and must not copy a laptop over a deployment's copy) and
  `MONGO_MIRROR_INTERVAL_MIN` (30 unless set; `0` stops the schedule). Without the first two nothing is
  copied.
- **How a copy works.** One REPEATABLE READ snapshot. Each table is written to `<table>__incoming`,
  read back and hashed on both sides, and replaces the previous collection only when the sorted row
  hashes agree; a table that disagrees keeps its last good copy and the run fails. `_mirror` holds each
  table's row count, columns and digest; `_mirror_runs` holds every run, failed ones included.
- **Copy now, or see the last copy:** `POST /ops/mirror` and `GET /ops/mirror` with the operator token.
- **Check a copy from here**, from MongoDB alone — every table's count and digest against what Postgres
  had:

  ```bash
  cd server && MONGO_MIRROR_DB=xorr_base_fork npm run mirror:mongo -- --verify-only
  ```

- **Copy the local database** into `xorr_local`: `cd server && npm run mirror:mongo`.
- **Precision.** A MongoDB date keeps milliseconds and Postgres keeps microseconds, so timestamp fields
  are dates to the millisecond while a primary key keeps the exact timestamp text. A numeric too wide
  for Decimal128's 34 digits — a uint256 — is kept as exact decimal text.
- **A copy failing with a server-selection timeout** is Atlas refusing the connection: its Network
  Access list has to admit the executors' outbound addresses.
