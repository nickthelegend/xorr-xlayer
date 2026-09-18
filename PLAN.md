# xorr-solana — full migration plan: chain-agnostic reference → Solana-native

**The first xorr-solana plan — 2026-09-16.** xorr-solana is a clone of **xorr-dev** (the full-featured
reference build of xorr, itself a copy of the xorr-eth/Base implementation). The reference app ships the
complete feature surface — 85 screens, the full executor, venues, contracts layer, subgraphs, and
29-doc audit trail — with chain-specific code structured behind clean seams (`server/src/evm/`,
`contracts/`, `subgraph/`, `src/networks/`, `src/wallet/`, `app/network.tsx`) so that a chain can be
swapped in file-by-file.

This plan migrates the reference to a **Solana-native** xorr:

- Non-custody via **SPL Token delegation** (`approve` / `revoke`) instead of an ERC-20 allowance +
  `XorrDelegation` contract. The SPL Token program is the final, authoritative cap and the kill switch.
- Settlement in **USDC on Solana** (mainnet mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, 6 decimals).
- Every EVM module is mapped to a Solana equivalent in section 8 (the module-by-module table). Nothing is
  dropped; everything is repointed at a Solana primitive, a Solana venue, or a neutral market feed.

Written for an agent to pick up cold: each task names its files and what "done" means. Status tags:
**DONE** · **IN PROGRESS** · **NOT STARTED** · **BLOCKED — reason**.

---

## 0. How to work this plan

### 0.1 Owner rules (unchanged from the reference)

- **No mocks, no fallbacks, no stubs.** Real database, real (or localnet) chain, real signatures, real API
  calls. Pause only for real money, a mainnet action, or a credential that does not exist.
- **Never print a secret value — names only.** `.keys` and `.env*` stay git-ignored and are never pasted
  into logs, tests, or commits.
- **Never delete a Railway service, a Postgres, or their env vars.** Existing executors from the reference
  stay up while xorr-solana ships its own named services (`xorr-solana-executor`).
- **One path to spending.** Every entry (DCA, agent, manual order) funnels through the spend chokepoint;
  `strategy_runs.period_key` and `position_closes.claim_key` stay UNIQUE for idempotency. Proved
  adversarially on-chain in the reference — re-prove it on Solana.
- **Kill switch = on-chain revoke.** New orders stop, resting exits/TPs stay live, open positions stay
  untouched. Three behaviors tested independently (keep the reference's tests, port the chain assertions).

### 0.2 Environments

| Environment | Cluster (`XORR_CHAIN`) | RPC | Money class | Notes |
|---|---|---|---|---|
| `localnet` | `solana-localnet` | `http://127.0.0.1:8899` | copy | `solana-test-validator`, no network deps |
| `solana-dev` | `solana-devnet` | `https://api.devnet.solana.com` | test | Faucet mints SOL/USDC; CI + integration |
| `solana-fork` | `solana-mainnet` (validator `--clone`) | local `FORK_RPC` | copy | Real USDC mint + real venue programs cloned |
| `solana-mainnet` | `solana-mainnet` | `https://api.mainnet-beta.solana.com` | real | Refused by faucet; requires `ALLOW_MAINNET=yes` |

**Chain-agreement invariant (unchanged):** `XORR_CHAIN` (server) and `EXPO_PUBLIC_XORR_CHAIN` (app) must
agree at all times. The app switches the wallet to the build's cluster before asking for signatures.

### 0.3 Deploy (delta from reference)

- Executors = CLI uploads: `cd server && railway up --service xorr-solana-executor`. Migrations run as the
  preDeploy step (`npm run migrate`). Web = `npm run deploy:web` (Vercel project to be created,
  domain `app.xorr-solana.finance` unless the owner says otherwise).
- **Never deploy against mainnet-beta without `ALLOW_MAINNET=yes`** — the server refuses to boot otherwise.

### 0.4 Verify

- App: `npm test` · `npx tsc --noEmit` · `npm run lint`
- Server: `cd server && npm test` · `npm run test:chain` (spins `solana-test-validator`) · `npm run test:live`
- Chain: `npm run setup:devnet`, `npm run test:chain`, fork scripts under `server/src/fork/`
- E2E: Maestro flows in `e2e/` (5 flows, assert outcomes not renders)
- Live: curl against the deployed executor (`GET /health`, `/api/status`, `/api/wallet/balance`)

---

## 1. Why this migration is not find-and-replace

Solana and EVM differ in five ways that force structural decisions, not renamed files:

1. **Execution model.** EVM `approve` + `transferFrom` lets any contract spend an allowance with a single
   signed tx. SPL Token's `approve` gives a **delegate authority** a capped `delegated_amount`; the delegate
   signs `Transfer` instructions up to the cap. Routed swaps (Jupiter etc.) spend from the **signer's
   authority**, not a delegate's, so the executor cannot silently fill a multi-hop swap the way 1inch does.
   → Section 6 ("executor signing model on Solana") chooses the fill path.
2. **Accounts vs addresses.** Token balances live in token accounts owned by wallets (ATAs). "Send USDC to a
   venue" = transfer into the venue's ATA, which must exist (rent-funded). Every account touch costs rent.
3. **Transactions are singles.** No try/catch, no reentrancy guards, no gas estimation then submit; one
   failed instruction fails the tx and the payer loses the fee+priority fee. `humanFailure()` must map
   blockhash/priority-fee/simulation errors.
4. **No private RPC as the user's wallet.** The reference used Privy's embedded EVM wallet for signing. On
   Solana the app signs via a wallet adapter or a local keypair; the executor never holds user keys.
5. **Indexing.** There is no The Graph on Solana mainnet for arbitrary programs. Event streams must be
   replaced by RPC polling, Helius/webhook DAS APIs, or Geyser gRPC (Section 9).

---

## 2. Target architecture (end state)

```
app/ (Expo, RN)                    server/ (Hono + Postgres + Solana)
────────────────────────          ─────────────────────────────────────
app/network.tsx ── XORR_CHAIN ──► server/src/solana/clusters.ts (master switch)
src/networks ───────────────────► solana/connection.ts (RPC + explorer + guard)
src/wallet/* (sign via adapter)  solana/keys.ts (delegate/payer/dev-owner keypairs)
                                 solana/delegation.ts (SPL approve/revoke/transfer)
   │                                    │
   │ REST /api/*                        │ reads + writes
   ▼                                    ▼
executor/place.ts ──guardAndSpend────►  Postgres (rules engine + audit log + chain-scope)
  rule check → chain check (SPL) →     ▲
  real mark (markets/*) → spend        │ signals
  (SPL transfer signed by delegate) ───┤ scheduler.ts (tick: exits → strategies → entries)
venues/ (Jupiter, Phoenix/OpenBook,     │
  Marinade/Kamino, Hyperliquid, ...) ───┘
blockchain: Solana (USDC EPjFWdd5…) + SPL Token program + optional Xorr programs (Phase F)
indexer: RPC poller / Helius webhook → Postgres (replaces subgraph/)
audit: hash-chained Postgres log + on-chain anchor via SPL Memo (replaces XorrAuditAnchor)
```

Non-custody invariant: user USDC sits in the user's own ATA. The bot holds an SPL delegation with a
**capped `delegated_amount`**, spendable only on behalf of the user's account, revocable in one tx. The
withdrawal allowlist (24 h cooling-off) stays server-side and is the only path back to an external wallet.

---

## 3. Env layering (first task — everything hangs off this)

### 3.1 Values of `XORR_CHAIN`

Server `server/src/solana/clusters.ts` and app `src/chain.ts` must both accept exactly:

| `XORR_CHAIN` | Cluster | RPC source | Money class |
|---|---|---|---|
| `solana-localnet` | localnet | `SOLANA_RPC_URL` or `http://127.0.0.1:8899` | copy |
| `solana-devnet` | devnet | `SOLANA_RPC_URL` or `clusterApiUrl('devnet')` | test |
| `solana-fork` | mainnet | `FORK_RPC` | copy |
| `solana-mainnet` | mainnet-beta | `SOLANA_RPC_URL` or `clusterApiUrl('mainnet-beta')` | real |

If `XORR_CHAIN` is unset or unknown, **refuse to start** (same as reference `server/src/index.ts`).

### 3.2 Server env vars

**Keep (chain-agnostic):** `DATABASE_URL`, `PORT`, `SCHEDULER`, `SCHEDULER_TICK_MS`, `EXECUTOR_TOKEN`,
`OPERATOR_TOKEN`, `ALLOWED_ORIGINS`, `OPENROUTER_API_KEY`, `XORR_MODEL`, `ONEINCH_API_KEY` (unused after
jeeter cut), `SUBGRAPH_URL` (replaced, see 3.3), `ANCHOR_EVERY_MS`.

**Add (Solana):**

| Var | Meaning |
|---|---|
| `XORR_CHAIN` | master switch (3.1) |
| `SOLANA_RPC_URL` | override RPC (devnet/fork/mainnet) |
| `SOLANA_MAINNET_RPC` | JSON-RPC for mainnet-native reads (staking inflation, etc.) |
| `FORK_RPC` | local `solana-test-validator` URL for `solana-fork` |
| `ALLOW_MAINNET` | `yes` only to run against real mainnet-beta |
| `XORR_KEY_DIR` | dir holding delegate/payer/dev-owner keypair files |
| `XORR_KEY_DELEGATE`, `XORR_KEY_PAYER`, `XORR_KEY_DEV_OWNER` | base58 secret per key (or file fallback) |
| `XORR_DEVNET_STATE` | path to devnet-state.json (token accounts) |
| `SOLANA_USDC_MINT`, `SOLANA_USDT_MINT`, `SOLANA_WSOL_MINT` | mint overrides (defaults in 8.4) |
| `HELIUS_API_KEY` | optional mainnet webhook/price indexer |

**Remove (EVM-only):** `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY`,
`PRIVY_KEY_QUORUM_ID`, `BASE_RPC`, `BASE_SEPOLIA_RPC`, `LOCAL_RPC`, `DELEGATION_ADDRESS`, `AQUA_BOOK_ADDRESS`,
`SWAPVM_BOOK_ADDRESS`, `ANCHOR_ADDRESS`, `SUBGRAPH_DELEGATION_ADDRESS`, `FAUCET_PRIVATE_KEY`,
`MONGODB_URI`/`MONGO_*` (keep if mirror desired), `DELEGATE_PRIVATE_KEY` (replaced by `XORR_KEY_*`).

### 3.3 App env vars

**Add:** `EXPO_PUBLIC_XORR_CHAIN` (must equal server), `EXPO_PUBLIC_API_URL`, plus `EXPO_PUBLIC_SOLANA_RPC`
for the wallet adapter.

---

## 4. App-side chain config (swap EVM → Solana)

| File (reference) | Replace with | Task |
|---|---|---|
| `src/chain.ts` (`MONEY`, `CHAINS`, `ChainKey`) | `src/chain.ts` → `MONEY`/`CLUSTERS` for the 4 clusters; export `ClusterKey` | Rewrite |
| `src/networks/deployments.ts` (Deployment[]: key/name/chainId/api/explorer/test) | same shape but `cluster` field instead of `chainId`; api = xorr-solana executor URLs; explorer = `explorer.solana.com?cluster=` | Rewrite |
| `app/network.tsx` (network picker) | list the 4 clusters, badge money class, warn on mainnet | Rewrite |
| `app/networks.tsx` | per-cluster RPC/explorer/faucet status screen | Rewrite |
| `src/wallet/` * | Solana signing model (Section 5) | Rewrite |
| `app/basename.tsx` | optional: `.sol` names via SNS/Bonfida instead of Basenames | Optional |
| `app/recovery.tsx` | devnet owner-key copy (from reference `server/src/solana/keys.ts`) | Edit copy |

**Done =** switching `EXPO_PUBLIC_XORR_CHAIN` in the app and `XORR_CHAIN` on the server changes endpoints,
explorer links, wallet cluster, and money-class behavior — and a mismatch is surfaced as a hard error.

---

## 5. Wallet & signing (app-side)

### 5.1 Signer choice — pick ONE for MVP, then production path

1. **MVP (recommended): local keypair in `expo-secure-store`.** Key generation via `@solana/web3.js`
   `Keypair.generate()` + bs58; export `react-native-get-random-values` already installed. Good enough for
   devnet/e2e; NOT a mainnet wallet.
2. **Mobile Wallet Adapter (production):** `@solana-mobile/mobile-wallet-adapter-protocol-web3js` +
   `@solana-mobile/wallet-adapter-mobile` to let Phantom/Solfare sign on-device. `WrongChainError` becomes a
   "switch to <cluster>" prompt; the RPC is the wallet's.
3. **Privy Solana (if enabled in the Privy dashboard):** keep Privy auth + embedded Solana wallet — smallest
   rework of `src/auth/`. Verify Solana support before relying on it.

**Decision to record here when chosen** (owner gate): whatever we pick, the executor must see a
**public key + signature**, never a private key.

### 5.2 Module-by-module port

| Reference `src/wallet/` | Solana version |
|---|---|
| `userSigning.ts` (Privy `eth_signTransaction` + app broadcast hack, `WrongChainError`) | `userSigning.ts`: build `Transaction`/`VersionedTransaction`, sign via adapter, verify signatures, broadcast via connection; cluster-match guard |
| `grant.ts` (ERC-20 approve → delegation grant flow) | `grant.ts`: build `createApproveInstruction({ owner→delegate, delegated_amount })`, user signs, broadcast, POST to `/api/delegation/grant` |
| `withdraw.ts` (withdraw flow) | `withdraw.ts`: `createTransferInstruction` user-signed to allowlisted address; cooling-off UI unchanged |
| `approve.ts` (ERC-20 approve UX) | folded into grant/withdraw UI (the delegation IS the approve); keep screen + texts |
| `signing.ts` | bs58/`Keypair` helpers, `signMessage`, tx serialization (legacy + v0) |

## 6. Executor signing model on Solana (the critical design section)

> Read before writing `server/src/solana/delegation.ts`.

### 6.1 The constraint

SPL `approve` gives `delegate` the right to sign `Transfer` up to `delegated_amount`. Jupiter-style
aggregator swaps sign from the wallet's **authority**, not a delegate. So a filled multi-hop swap cannot be
signed by the delegate key alone. The reference solved this with a contract + `transferFrom`; Solana forces
a choice.

### 6.2 Options (in build order)

- **A — Delegate transfer into venue vault (MVP, matches the former xorr-dev prototype).**
  `spendAsDelegate()` transfers capped USDC user-ATA → **venue ATA** (maker/vault account the executor also
  controls with the payer key). The venue order is then placed from the vault by the executor key.
  Non-custody preserved because the vault is itself under a bounded, allowlisted, revocable policy, and the
  user's account only ever moves capped amounts. This is the default for Phase 1–4. **Never hold user funds
  in a Genesis-less vault; the vault is a venue account, and the SPL cap is the guard.**
- **B — User-signed per-trade fills (interactive).** For high-value trades, the app builds the full route
  instruction (Jupiter v6 `/swap`), the user signs it (5.1), the app relays and broadcasts. Executor only
  proposes (LLM `propose.ts` path), never signs. Used for manual / large orders while A is the bot default.
- **C — Xorr escrow/route program (later, production).** An Anchor program holding user USDC with
  on-chain policy (time, budget, venue), `XorrRoute` performing Jupiter CPI transfers as "itself", giving
  the closest analogue to `XorrDelegation` + `1inch` fills. Requires a funded `xorr-escrow` program deploy
  per cluster (Section 10).

Record the chosen mix in `docs/ARCHITECTURE.md` under "spending paths".

### 6.3 Spend chokepoint (`server/src/executor/place.ts`)

`guardAndSpend()` keeps its 5-step chain, Solana-flavored:

1. delegation row exists and not revoked/expired (DB)
2. rules engine passes (kill switch, daily cap, spread, venue/withdrawal allowlist) (`rules/engine.ts`)
3. on-chain check: `readDelegation(ownerAta)` → `delegate === delegateKeypair().publicKey` AND
   `delegatedAmount >= wanted` (SPL is authoritative)
4. real mark from `market/` (price guards, spread check)
5. `spendAsDelegate()` (SPL `Transfer`, signer = delegate) → venue ATA; record signature + units in the same
   DB tx.

`SpendReceipt` gains `{ signature, slot }` (base58 + slot from `confirmTransaction`).

---

## 7. DB schema

### 7.1 Kept as-is (already chain-agnostic)
`strategies`, `strategy_runs` (UNIQUE `period_key`), `proposals`, `daily_spend`, `messages`, `devices`,
`exit_rules`, `price_alerts`, `position_closes` (UNIQUE `claim_key`), plus the 27 reference migrations
(alert-firing, realised-pnl, idempotency, fill-quality, withdrawal allowlist, custom agents, treasuries…).

### 7.2 Change

- `wallets.cluster TEXT` — values become `solana-localnet | solana-devnet | solana-fork | solana-mainnet`
  (reference already has the column; keep `chain-scope.ts` setting `xorr.chain_key`).
- `delegations`: `owner_pubkey`, `delegate_pubkey`, `grant_signature`, `revoke_signature` — already base58;
  add `grant_slot`, `revoke_slot`, `delegated_units` (or keep USD). Keep `venue_allowlist`,
  `withdrawal_allowlist`.
- `strategy_runs.signature`, `position_closes.signature`, `audit_log.signature` — now `v0`-capable base58
  tx sigs + add `slot` columns.
- New migration `028-solana.sql`: add `slot` columns, a `token_mint` on `wallets`, and a
  `cluster` constraint against 3.1 + index on `(cluster, owner_pubkey)`.

**Done =** `current_setting('xorr.chain_key')` gates every multi-tenant query (mirror `chain-scope.ts`).

---

## 8. Module-by-module server mapping (the core of the work)

### 8.1 `server/src/solana/` — the new seam (replaces `server/src/evm/`)

| Reference `evm/` file | Solana replacement | Key contents |
|---|---|---|
| `chains.ts` (`RPCS`, `CHAINS`, `ADDRESSES`) | `solana/clusters.ts` | 3.1 table, `rpcUrl()`, `cluster`, `CLUSTER_KEY`, default mint addresses |
| `money.ts` (`FACTS`: real/test/copy) | `solana/money.ts` | `FACTS` per cluster: settlement token = USDC mint, decimals (USDC 6, SOL 9), faucet behavior, mainnet guard |
| `client.ts` (viem public/wallet client) | `solana/connection.ts` | `connection` (`Connection`, `confirmed`), `explorerTx(sig)`, mainnet guard at boot |
| `keys.ts` (delegate key persistence) | `solana/keys.ts` | `Keypair` load/generate: `delegateKeypair`, `payerKeypair`, `devOwnerKeypair`; `XORR_KEY_*` + `XORR_KEY_DIR` |
| `delegation.ts` (XorrDelegation ABI adapter) | `solana/delegation.ts` | `approveDelegate` (createApproveInstruction), `revokeDelegate` (createRevokeInstruction), `spendAsDelegate` (Transfer, delegate signer), `readDelegation` (getAccount → delegate/delegatedAmount/amount), `usdToBaseUnits`/`baseUnitsToUsd`, `returnToOwner` (venue→owner, payer signer), `DelegationState` |
| `balances.ts` (erc20 reads) | `solana/balances.ts` | `getTokenAccountBalance` (ATA), `getBalance` (SOL); `ataFor(owner, mint)` helper |
| `faucet.ts` (impersonate/Circle/refuse) | `solana/faucet.ts` + `solana/setup.ts` | localnet/devnet: `requestAirdrop` SOL + mint USDC (setup mints or devnet faucet); fork: pre-funded accounts; mainnet: refuse (money `real`) |
| `gas.ts`, `gasDrip.ts`, `gas-price.ts` | `solana/gas.ts` | rent-exemption funding for ATAs/vault, priority fee from `getRecentPrioritizationFees`, `computeUnitPrice`, payer-signing funding tx |
| `allowances.ts` | `solana/delegation.ts#readDelegation` | approved amount = `delegatedAmount` |
| `measure-route.ts` | `venues/jupiter.ts` quote | quote path + price impact + slippage bound |
| `logs.ts` | `solana/scan.ts` | `getSignaturesForAddress` + `getParsedTokenAccountsByOwner` polling; parse Trans/Memo logs |
| `wait-for-tx.ts` | `confirmTransaction(commitment='confirmed')` + `getTransaction(…, { maxSupportedTransactionVersion: 0 })` | confirmed-slot + log harvest |
| `basename.ts` | `solana/sns.ts` (optional) | `.sol` resolution via Bonfida |
| `throttle.ts`, http/`breaker.ts` | keep | chain-agnostic |

### 8.2 Executor (`server/src/executor/`)

| File | Change |
|---|---|
| `place.ts` | 6.3 — `guardAndSpend` on SPL delegation |
| `run.ts` | swap `explorerTx` import to `solana/connection`; `humanFailure()` → Solana error map (8.3); step 3 "execute on chain" = readDelegation → spendAsDelegate |
| `exit.ts` | settlement = `returnToOwner()`; orphan-close = payer-sign transfer; audit payloads carry `explorerTx(sig)` |
| `order.ts`, `entry.ts` | SPL spend via guardAndSpend; explorer links |
| `scheduler.ts` | unchanged |
| `schedule.ts`, `reconcile.ts`, `settle.ts`, `fill-quality.ts`, `fill-measure.ts`, `subcap-prove.ts`, `failure.ts` | keep, adapt tx refs → signature+slot |
| `kinds/` (event-driven, momentum, planners) | chain-agnostic; keep |

### 8.3 `humanFailure()` — Solana error map (in `run.ts`)

Map to the same user-facing buckets, parsing for:
- `Transaction simulation failed: Attempt to debit an account but found no record of a prior credit`
- `insufficient funds`, `insufficient lamports`, `account is not rent exempt`
- `blockhash not found`, `transaction too large`, `unknown signer`, `signature verification failure`
- SPL Token custom-program errors (partial; codes are stable per token program version):
  `custom program error: 0x0` (NotInitialized), `0x1` (AlreadyInUse), `0x4` (AuthorityTypeNotSupported),
  `0x6` (InvalidDelegate…), and the classic `0x1771`/mint-authority collisions captured by unit tests
- priority-fee / `Transaction simulation failed: Error processing instruction` → "network congestion — retry"

Keep a table-driven `solana/errors.ts` (pure, unit-tested) mirroring reference `run.ts` tests.

### 8.4 Venues (`server/src/venues/`)

| Reference | Solana target | Notes |
|---|---|---|
| `oneinch.ts` | **Jupiter** `venues/jupiter.ts` | `quote-api.jup.ag/v6/quote` + `/v6/swap` (also `lite-api.jup.ag/swap/v1` legacy). TOKENS map → mint map: USDC `EPjFWdd5…`, USDT `Es9vMFre…`, wSOL `So111111…`, SOL symbol; slippage cap `DEFAULT_SLIPPAGE_BPS=30` |
| `aqua.ts` (on-chain book) | **Phoenix** or **OpenBook v2** `venues/phoenix.ts` (or Jupiter Limit Order) | server places from venue vault (6.2-A); `delegatedFillArgs` equivalent = signed `PlaceOrder` via payer key |
| `swapvm.ts` (second maker) | OpenBook v2 / Meteora `venues/makers.ts` | same pattern |
| `aave.ts` (yield tier) | **Marinade** (SOL staking) `venues/marinade.ts` + **Kamino/Marginfi** `venues/kamino.ts` | yield rotation target; SOL inflation from `getInflationRate` (reference `staking.ts`) |
| `fusion-plus.ts` | Solana native staking/restaking venues (Jito) | keep concept |
| `limit-orders.ts` | Jupiter Limit Order / OpenBook | keep shape |
| `stocks.ts`, `edgar.ts`, `hyperliquid.ts`, `perp.ts`, `yield.ts`, `history.ts`, `compare.ts`, `balance.ts`, `slippage.ts`, `symbols.ts` | **mostly unchanged** (chain-agnostic market data); `balance.ts` → token account read; `synbench`/`symbols.ts` extend mint map + CoinGecko (SOL already present) | — |
| `staking.ts` (reference proto) | fold into `marinade.ts` + inflation read | — |

### 8.5 Routes

| Reference `routes/` group | Solana version |
|---|---|
| wallet | → `/api/wallet/balance` (token account balance + SOL), `/api/wallet/addresses` |
| grant | → `/api/delegation/approve` (build approve tx for user signing), `/api/delegation/grant` (record), `/api/delegation/revoke` (kill switch), `/api/delegation` (reconcile DB row vs SPL via readDelegation → `onChainRemainingUsd`) |
| portfolio / history / activity | unchanged shape; read DB + Solana signatures |
| trade | unchanged (goes through executor chokepoint) |
| strategy | unchanged |
| faucet | → airdrop (devnet) / local mint (localnet/fork) / refused (mainnet) |
| agent-keys | unchanged (scopes carry Solana base58 pubkeys) |
| privy | removed (wallet signing moved app-side; see 5.1) — delete group |
| status | unchanged + add `cluster`, `rpcUrl` |
| verify | audit chain + Solana memo anchors |
| market | unchanged (prices from CoinGecko; symbols SOL-aware) |
| anchor | → memo-anchor (Section 12) |
| migrate / params / revoke / extra / tokens / business / crosschain / limit-orders / withdrawal / panic / ops / mirror | keep; params exposes mints + decimals |

### 8.6 Bot / LLM / news / backtest
No chain code. `propose.ts` default symbol `SOL` already correct; `news/feed.ts` SOL mapping already present.
Keep unchanged.

---

## 9. Indexing (replaces `subgraph/` + `subgraph-aqua/`)

| Reference | Solana replacement |
|---|---|
| `subgraph/` (delegations, spends, daily rollups) | **Postgres-fed poller**: `graph/poller.ts` polls Token `Transfer`/`Approve` signatures for each user ATA (`getSignaturesForAddress` + `getTransaction` every `POLL_TICK_MS`), converts log diffs into delegation/spend rows; daily rollups via existing SQL |
| `subgraph-aqua/` (venue book index) | poll Phoenix/OpenBook program events the same way (or listen via their gRPC/websocket feeds) |
| `graph/decide.ts` (pre-flight routing decision) | now reads `graph/poller` state + Jupiter quote; keep the decision logic and tests |

**Mainnet later:** Helius DAS API + webhooks (`HELIUS_API_KEY`) or a Geyser gRPC stream; the write-side schema
must not change (indexer-output-agnostic). Keep `graph/` tests green with a stubbed poller.

---

## 10. Contracts → Solana programs

| Reference `contracts/` | Solana outcome |
|---|---|
| `XorrDelegation` | **No custom program for MVP** — SPL `approve`/`revoke` + server rules (6.2-A). Later: `xorr-escrow` Anchor program (6.2-C) to hold policy (time/budget/venue) on-chain |
| `XorrAquaBook` | Phoenix/OpenBook venue program (8.4) — no custom contract |
| `XorrSwapVMBook` | second maker program (OpenBook v2 / Meteora) |
| `XorrAuditAnchor` | **SPL Memo anchor** (Section 12) — no custom contract |
| `contracts/deployments/*.json` | `deployments/` per cluster holding program pubkeys + mints (keypairs under `.keys/`, never committed) |
| Foundry toolchain | **Anchor** (programs/) if/when `xorr-escrow` ships: `anchor build`, `anchor deploy`, tests via `solana-test-validator` |

**Deployment gate:** any program deploy requires owner approval and a mainnet `ALLOW_MAINNET` + verify step
(`solana program` addresses in docs).

---

## 11. Fork / local infra (replaces `infra/base-fork`)

`infra/solana-fork/`:
- `Dockerfile` + entrypoint booting `solana-test-validator` with:
  `--clone EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC), `--clone <jupiter>`, `--clone <phoenix>`,
  `--reset`, `--rpc-port 8899`, plus a **pre-funded dev owner** with real USDC (airdrop SOL + mint on fork).
- Scripts (`scripts/`): `fork-bootstrap.ts` (start + fund), `fork-grant.ts`, `fork-e2e.ts`,
  `fork-yield.ts`, `fork/ship-makers.ts`, `fork/orphans.ts`, `fork/guard.ts` — port each reference fork
  script, replacing anvil/RPC impersonation with validator `--clone` + airdrop.
- `.env.fork` → `XORR_CHAIN=solana-fork`, `FORK_RPC=http://127.0.0.1:8899`.

**Done =** a full demo runs locally against cloned real USDC with real signatures and real venue fills.

---

## 12. Audit & verify (replaces the EVM anchor)

- `audit/once.ts`, `anchor-limit.ts`, `anchor-sweep.ts` — keep (ALREADY generic).
- `audit/anchor.ts` → `solana/anchor.ts`: read `audit_log` chain-head hash → build a one-instruction tx using
  the **SPL Memo program** (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) containing the hash; broadcast with
  the payer key; record sig + slot. Verify reads it back via `getTransaction`.
- `verify/checks.ts` → verify the Postgres hash chain AND that each head memo exists on-chain for the anchor
  cadence (`ANCHOR_EVERY_MS`).
- Routes: keep `/api/verify` and the `app/audit/*` screens (explorer links now point at `explorer.solana.com`).

---

## 13. Dependencies

### 13.1 `server/package.json`

**Add:** `@solana/web3.js` (^1.x), `@solana/spl-token` (^0.4), `bs58` (^6). **Remove:** `viem`,
any foundry-only dep not used by the server, `@graphprotocol/*` only if the poller replaces it.
**Scripts:** `setup:devnet` = `tsx src/solana/setup.ts`; `test:chain` = `CHAIN=1 vitest run src/**/*.chain.test.ts`.

### 13.2 root `package.json`

**Add:** `@solana/web3.js`, `@solana/spl-token`, `bs58`, `react-native-get-random-values` (already present),
`@ethersproject/shims` (remove — EVM only), `viem` (remove), `react-native-passkeys`/Privy packages only if
5.1 keeps Privy; **or** `@solana-mobile/mobile-wallet-adapter-protocol-web3js` + `@solana-mobile/wallet-adapter-mobile`
if 5.1 uses MWA. **Polyfills:** ensure `Buffer`/`global.Buffer` exists in the RN entry (standard Solana RN
setup; `react-native-quick-crypto` optional).

---

## 14. Tests (mirror the reference's 271-check bar)

| Suite | Content | Command |
|---|---|---|
| App unit | `src/**/*.test.ts` (store, derived, format, strategies, wallet allowlist, bot voice/facts) | `npm test` |
| Server unit | rules engine, schedule/idempotency, delegation math (usd↔units), `humanFailure` map, audit log/once, venues compare/slippage, kind tests | `cd server && npm test` |
| **Chain** | `solana/delegation.chain.test.ts`, `executor/executor.chain.test.ts` — against a real `solana-test-validator`: real signatures, SPL-enforced cap, revoke semantics, kill switch, orphan close | `cd server && npm run test:chain` |
| Live | Jupiter quote, perps, staking inflation, airdrop | `npm run test:live` |
| E2E | 5 Maestro flows (onboarding, DCA, proposal, kill-switch, expiry) — assert outcomes | `maestro test e2e` |
| CI | `.github/workflows/ci.yml`: app job + server job (Postgres 16 service) + Solana job using `anza-xyz/setup-solana@v1` running `test:chain` | push |

**Non-negotiable on-chain proofs (port from reference):**
1. a transfer beyond `delegatedAmount` is rejected by the token program on-chain;
2. `revoke` stops new orders while resting exits/TPs stay live;
3. retrying a run with the same `period_key` collapses to one fill;
4. a close returns the user's own asset (daily cap does not block closes);
5. orphan detection settles a venue split.

---

## 15. Security (delta from `docs/SECURITY.md`)

- Keys: delegate/payer keypairs live only in `XORR_KEY_DIR` on the server; NEVER committed or logged.
  Production: KMS-backed signer (e.g., AWS KMS/Solana signing or a Deco/signing service) — owner gate.
- Non-custody blast radius: SPL cap is the authority; withdrawal allowlist + 24 h cooling-off; kill switch
  on-chain revoke (three behaviors tested, 6/14).
- Cluster guardrails: unknown `XORR_CHAIN` refuses boot; mainnet requires `ALLOW_MAINNET=yes`; faucet refuses
  on `real` money; app/server cluster mismatch is a hard error.
- Idempotency: `period_key`/`claim_key` UNIQUE; retries and concurrent runs collapse to one fill.
- Audit: append-only hash-chained `audit_log` + memo anchor (Section 12).
- Phishing: verify signed bytes client-side before broadcast where applicable; never broadcast on a cluster
  the wallet isn't on (wrong-cluster prompt).
- Certificate pinning, Sentry, quota/metrics dashboards: carry over as owner-approved hardening tasks.

---

## 16. Rollout order & task list

Status tags: **DONE** · **IN PROGRESS** · **NOT STARTED** · **BLOCKED — reason**.

### Phase 0 — Foundations
- [ ] 3.1–3.3 env layering; `server/src/solana/clusters.ts` + `money.ts`; app `src/chain.ts` + `networks/*`; unknown-chain refuses boot.
- [ ] 13 deps: server (web3.js, spl-token, bs58), app (adapter choice + polyfills); prune viem/Privy.
- [ ] `network.tsx` cluster picker + mismatch error.
- [ ] CI skeleton: setup-solana action + validator job.

### Phase 1 — `server/src/solana/` module
- [ ] `connection.ts`, `keys.ts`, `setup.ts`, `delegation.ts`, `balances.ts`, `faucet.ts`, `gas.ts`, `errors.ts`.
- [ ] `delegation.chain.test.ts` on `solana-test-validator`: approve/grant/revoke/kill-switch/cap.
- [ ] `npm run setup:devnet` mint + fund flow.

### Phase 2 — Routes
- [ ] wallet balance/addresses, delegation approve/grant/revoke/read, faucet, status, params, migrate, verify, anchor (memo).
- [ ] Remove privy route group + `src/auth/privy*`.

### Phase 3 — Executor
- [ ] `place.ts` guardAndSpend on SPL; `run.ts` + `humanFailure` map; `order.ts`/`entry.ts`; `values.ts` (atomic record+spend).
- [ ] `exit.ts` settlement + orphan closes; `positions/`, `reconcile.ts`, `settle.ts`, `fill-quality.ts`.
- [ ] `executor.chain.test.ts` (5 proofs in §14).

### Phase 4 — Venues
- [ ] `jupiter.ts` (quote/swap), `phoenix.ts`/OpenBook, `marinade.ts` + `kamino.ts`, fold `staking.ts` inflation; `compare.ts`, `limit-orders.ts`, `slippage.ts`.
- [ ] Venue live tests (Jupiter + perps + staking inflation).

### Phase 5 — App wallet & screens
- [ ] `src/wallet/*` (sign model from §5), onboarding fund (faucet/SOL+USDC), delegation screen, approvals, send/withdraw, audit screens → solana explorer, basename → SNS.
- [ ] Manual e2e on devnet: sign → grant → run DCA → kill switch.

### Phase 6 — Indexing & audit
- [ ] `graph/poller.ts` (subgraph replacement) + decide() rewire + tests.
- [ ] `solana/anchor.ts` memo anchor + `verify/checks.ts`.

### Phase 7 — Fork & E2E
- [ ] `infra/solana-fork/` (test-validator `--clone`), fork scripts port, `.env.fork`.
- [ ] 5 Maestro flows pass on fork; fork demo script runs end-to-end.

### Phase 8 — Mainnet hardening (owner-gated)
- [ ] KMS signer, mainnet `ALLOW_MAINNET` rehearsal on a cloned-mainnet fork, Sentry, certificate pinning, quotas.
- [ ] Helius webhook indexer (replace poller), docs (ARCHITECTURE/SECURITY/RUNBOOK/STORE), store listing.

---

## 17. Done definition (acceptance)

1. `XORR_CHAIN` switch works end-to-end and mismatch is a hard error.
2. All §14 suites green; the five on-chain proofs pass on a real validator; 271-check parity restored.
3. Localnet + devnet demo: onboarding → fund → grant (SPL approve signed by user wallet) → DCA fill on the
   book → position armed with exit rule → one-tap kill switch (on-chain revoke) with the three behaviors.
4. Settlement is USDC on Solana; audit head anchored via Memo and verifiable.
5. No EVM imports remain (`rg -n "viem|ethers|privy-io|eth_"` across `server/src`, `src`, `app` clean).
6. No secrets in git; `git status` clean except `.claude/`; `.keys`/`.env*` ignored.

---

## 18. Reading this plan

Read in this order: §0 (rules + env) → §1 (why it's not find/replace) → §6 (signing model, the crux) →
§8 (module map) → §3/§7 (env + DB) → §5/§9/§10/§12 (wallet, indexer, programs, audit) → §16 (tasks).
Supporting docs in `docs/` (ARCHITECTURE, SECURITY, RUNBOOK, ADDING-A-CHAIN.md) are the EVM-flavored
baseline; each must be rewritten for Solana as part of Phase 8.