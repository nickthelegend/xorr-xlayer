<p align="center">
  <img src="assets/brand/xorr-banner.png" width="820" alt="XORR. — A bot that trades your capital while you get on with your life." />
</p>

# xorr

**A bot that trades your capital while you get on with your life.**

Non-custodial. Your wallet, your keys, and a **scoped on-chain permission** the bot trades inside —
capped per day, venue-restricted, time-boxed, and revocable in one tap without our cooperation.

Chain: **Base**. ETH Online 2026 · Base Build Camp 2026.

<p align="center">
  <img src="docs/screens/07-home.png" width="240" alt="Home" />
  <img src="docs/screens/18-chart.png" width="240" alt="Chart" />
  <img src="docs/screens/05-delegate.png" width="240" alt="Delegate" />
</p>

---

## Verify it yourself — Solana mainnet fork (Stocklana judge quickstart)

The Stocklana claim is that an agent buys an xStock (a Token-2022 tokenized equity) **through a
real Jupiter route, on-chain**, inside a capped permission the owner can revoke. This section lets
you check that on your own machine in about ten minutes. You need no accounts and no API keys.
Each command below was run from a fresh `git clone` into an empty directory before it was written
here.

### 1. Prerequisites

| | version verified | why |
|---|---|---|
| Node.js | 26.5 (needs ≥ 20.11 for `import.meta.dirname`) | runs the tools through `tsx` |
| Solana CLI with `solana-test-validator` | 3.1.11 (Agave) | the fork, and `solana confirm` |
| PostgreSQL | 16 | only for step 4 (the executor's database) |
| Internet access | — | the fork clones accounts from mainnet, and prices come from Jupiter's live quote API |

Install the Solana CLI with `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`, then put
its `bin` directory on your `PATH`.

**Env var names.** The proofs below need **none** of these set; the defaults are shown in brackets.
You never have to paste in a secret.

- `FORK_RPC`: where the fork listens [`http://127.0.0.1:8899`]. Set it if 8899 is already taken; everything below follows it.
- `MAINNET_RPC`: upstream the fork clones from [`https://api.mainnet-beta.solana.com`]. Set it to your own RPC if the public one rate-limits you.
- `DATABASE_URL`: Postgres for step 4 [`postgres://$USER@localhost:5432/xorr`].
- `PROVE_USD`: dollar size of the proof buy [`100`].
- `XORR_KEY_DIR`, `XORR_KEY_PAYER`, `XORR_KEY_DELEGATE`, `XORR_KEY_DEV_OWNER`, `XORR_KEY_VENUE_VAULT`: optional. If none is set, the fork uses deterministic development keypairs, so your addresses will match the ones below.
- `ONEINCH_API_KEY`: not needed here. See the limitations below for what it unlocks.

### 2. Clone and install

```bash
git clone https://github.com/nickthelegend/xorr-solana.git && cd xorr-solana
npm install && (cd server && npm install)
export FORK_RPC=http://127.0.0.1:8899   # or any free port, e.g. :18899
```

### 3. Start the mainnet fork

```bash
npx tsx infra/solana-fork/fork-bootstrap.ts
```

This starts `solana-test-validator` on the port in `FORK_RPC`. The faucet and gossip ports shift
with it, so a second fork on the same machine does not collide. The validator clones these from
mainnet:

- the real **USDC** mint (`EPjFWdd…`) and **NVDAx** mint (`Xsc9qvG…`, Token-2022)
- the **Jupiter v6** program (`JUP6Lkb…`) and **Orca Whirlpool** program (`whirLb…`)
- the USDC/NVDAx Whirlpool pool, its vaults, tick arrays and oracle

The bootstrap then airdrops SOL and funds the dev owner with 25,000 USDC and 10 NVDAx. It writes
`.env.fork` and exits, and the validator keeps running in the background. A passing run ends with:

```
Wrote .env.fork successfully.
Fork bootstrap complete! Run tests with:
  FORK_RPC=http://127.0.0.1:8899 CHAIN=1 npx vitest run src/solana/fork.chain.test.ts
```

To stop the fork later, run `pkill -f "solana-test-validator.*--rpc-port ${FORK_RPC##*:}"`.

### 4. The database (optional for the proofs)

The two proof tools do not touch Postgres. The executor and the agent do, so you can bring the real
schema up with:

```bash
createdb xorr
(cd server && DATABASE_URL=postgres://$USER@localhost:5432/xorr npm run migrate)
```

On a fresh database it prints `applied <file>` for each migration in `server/src/db/migrations/`.
We got 35 rows in `schema_migrations` and 30 tables. It records what it applied, so running it again
is free.

### 5. Proof: a Jupiter-routed xStock buy

```bash
npx tsx tools/prove-solana-xstock-buy.ts
```

The tool makes a capped SPL approval, with the owner signing. It then sends a $100 USDC → NVDAx buy
through the executor's single spend path, `guardAndSpend`, with the delegate signing. Finally it
reads the transaction's own logs back from the ledger. A passing run prints the following. The
signatures, slots and prices are from our run and will differ in yours.

```
=== 1. Real mainnet state cloned onto the fork ===
  NVDAx mint                 Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh owner=TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
  Jupiter v6 (cloned)        JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 owner=BPFLoaderUpgradeab1e11111111111111111111111 (executable)
  NVDAx multiplier           1.001701196801074
=== 2. Capped SPL approval (owner signs) ===
  delegated cap              500 USDC
=== 4. guardAndSpend: BUY $100 NVDAx (delegate signs) ===
  BUY SIGNATURE              3aheLFM37WDnqkFtJo1HCvBuGmEN21PBGEXV2QgQdWbywb8B6nmpxwCwgs82gRczXKStF8XoGdtUW1fxvS3q64Se
  BUY SLOT                   34
  PRICE SOURCE               live Jupiter v6 quote API (off-chain HTTP; no program invoked)
  FILL PATH                  jupiter-route — Jupiter v6 invoked on-chain, CPI into the AMM
  jupiter invoked            true
  route + AMM swap           true / true
=== 6. After ===
  USDC                       24900 (-100.000000)
  delegated cap left         400 USDC
=== 7. Reported fill vs on-chain delta ===
  drift                      1.6653345369377348e-16

All proofs held. Verify independently with:
  solana confirm -v <signature> --url http://127.0.0.1:8899
```

Check two things. **`PRICE SOURCE`** is only ever a number fetched over HTTP. **`FILL PATH`** is
what happened on-chain, and it has two possible values:

- `jupiter-route`: the Jupiter program ran and swapped against the pool's reserves.
- `venue-vault`: a capped delegate transfer at the quoted price, filled from a maker account. It is legitimate, but it is **not** a Jupiter swap.

The tool **exits non-zero** on anything other than `jupiter-route`, and it prints
`PROOF FAILED: Filled through 'venue-vault'`. It also fails if the reported fill and the on-chain
balance change disagree after applying the Token-2022 Scaled-UI multiplier (step 7).

### 6. Check the signature yourself, without our code

```bash
solana confirm -v <BUY SIGNATURE> --url $FORK_RPC
```

```
  Status: Ok
  Log Messages:
    Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]
    Program log: Instruction: Route
    Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke [2]
    Program log: Instruction: SwapV2
    Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [3]     ← USDC in  (SPL Token)
    Program log: Instruction: TransferChecked
    Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [3]     ← NVDAx out (Token-2022)
    Program log: Instruction: TransferChecked
    Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc success
    ...
    Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success
```

**`JUP6Lkb… invoke [1]` followed by `Instruction: Route`** means the transaction's top-level
instruction is Jupiter v6's `Route`. It is the real mainnet program bytecode, cloned onto the fork.
**`whirLb… invoke [2]` followed by `Instruction: SwapV2`** means Jupiter then made a cross-program
call into Orca Whirlpool, and Whirlpool swapped against the cloned USDC/NVDAx pool. The `[3]` lines
are the pool moving USDC in and NVDAx out. If a fill had gone through the venue vault instead, you
would see no `JUP6Lkb…` line at all, only a token `TransferChecked`.

### 7. More on-chain proofs: the cap, the kill switch, and a sell

```bash
(cd server && CHAIN=1 npx vitest run src/solana/fork.chain.test.ts)   # 4 passed
```

- Proof 2: the SPL cap rejects an over-cap transfer **on chain**.
- Proof 3: revoking the permission (the kill switch) stops new orders while resting exits stay live.
- Proof 4: a buy, then a sell back.

### 8. Proof: deposit handoff, and a withdrawal that settles

```bash
npx tsx tools/prove-solana-deposit-withdraw.ts
```

The tool runs four parts:

- **Part 1: the MoonPay sandbox handoff.** This is a signed checkout URL, not arrival of funds; see the limitations.
- **Part 2: the ATA addresses.** It derives the associated token accounts for the user and the destination.
- **Part 3: the address rules.** It applies the withdrawal allowlist's address rules.
- **Part 4: a real withdrawal on the fork.** A fresh user wallet is funded with SOL for its own fee
  and with 200 USDC. The destination's token account is created. Then the **user** signs a 50 USDC
  SPL transfer against a real blockhash, and the tool broadcasts and confirms it. It reads both
  balances back from the chain. Your addresses and signature will differ from these, which are from
  our run; the balances will match:

```
--- 4. USER-SIGNED SPL TOKEN TRANSFER & AUDIT RECORDING ---
  ✔ User funded with SOL on the fork to pay its own fee
  ✔ Funded account is the ATA the app derives, not a second account
  ✔ Destination ATA exists and matches the derived address
  Before — user: 200 USDC, dest: 0 USDC
  ✔ Created SPL Token transfer instruction
  ✔ Signer matches user wallet (non-custodial: user signs, not executor)
  ✔ Transaction is in the ledger, read back by signature
  ✔ Ledger records no error for the withdrawal
  ✔ Destination balance rose by exactly 50 USDC
  ✔ Source balance fell by exactly 50 USDC
  ✔ What left the source is what arrived at the destination
  WITHDRAW SIGNATURE: 5zTaos5EAAkQPfzbvzZ3uAHL4c8AmcDfofzRSoD7nhPbj1qC5cvaR2YL14469GcTWRGNbifVFAtiLvUziPM6Ce2N
  SLOT:               31
  Amount:             50 USDC (50000000 raw units)
  From:               CvQHdBAL4rb7xXA8PE4K7xhk4bzbAydGsF7TF7FhNGZT
  To:                 FF9XTb4fRDzWqL8aUL1KdSA4FLPTVo5oHd63Qsfdty35
  After — user: 150 USDC, dest: 50 USDC
  Verify:             solana confirm -v <signature> --url http://127.0.0.1:8899

================================================================
  ALL DEMO PROOFS PASSED (MoonPay Dev Sandbox + Solana Fork)
================================================================
```

Any failed check prints `✖ FAIL` and the tool exits 1. Confirm the withdrawal the same way as in
step 6:

```
$ solana confirm -v <WITHDRAW SIGNATURE> --url $FORK_RPC
  Account 0: srw- CvQHdBAL4rb7xXA8PE4K7xhk4bzbAydGsF7TF7FhNGZT (fee payer)
  Status: Ok
    Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]
    Program log: Instruction: Transfer
```

Account 0 is both the fee payer and the only signer, and it is the **user's** address from `From:`
above, not the executor's. That is the non-custodial property, read straight off the transaction.

### Known limitations — read these before you believe us

- **The MoonPay sandbox proves a signed checkout URL, not arrival of funds.** The deposit proof
  shows the checkout URL is strictly sandbox and targets `usdc_sol` at the user's own address. It
  also shows the URL is HMAC-SHA256 signed. Completing a sandbox purchase needs a human to enter a
  card on MoonPay's site, so no USDC arrives in any run you can script.
- **The withdrawal proof's 24-hour cooling-off is computed in-process.** It checks the constant and
  the rule, not the database clock. The database-backed allowlist is in `server/src/withdrawals/`,
  and its tests are in the same directory. The withdrawal itself does settle on-chain (step 8).
- **The agent cannot choose a trade outside Nasdaq regular hours without a `ONEINCH_API_KEY`.** It
  can still execute one. Outside regular hours, the off-hours guard compares the Jupiter price with
  a second venue's price. With no key there is no second venue, so the guard holds and the agent
  reports `no_setup`. That is the guard working as designed. Execution downstream of the choice is
  proven regardless: the proofs above, plus the agent path in `docs/E2E-RUN-2026-09-17.md` §3.
- **Pool accounts are cloned at a fixed slot, so off-mainnet slippage is floored at 200 bps.** The
  quote is live mainnet, but the fork's pool is frozen at the slot it was cloned from, and the two
  drift apart. At the default 50 bps, Jupiter's own output check rejects the route (`0x1771`,
  `SlippageToleranceExceeded`). `FORK_MIN_SLIPPAGE_BPS` in `server/src/venues/jupiter.ts` applies
  **only off mainnet**. On mainnet the quote and the pool read the same moment, and 50 bps stands.
- **Only the USDC → NVDAx route is cloned.** The pool accounts are route-specific
  (`ROUTE_ACCOUNTS` in `server/src/solana/fork-bootstrap.ts`). The sell back in Proof 4 reverts
  inside Jupiter on the fork (`custom program error: 0x1789`). It settles through `venue-vault`
  instead and logs `this fill is NOT a Jupiter swap`. Other xStocks and the sell side would need
  their own route accounts cloned.
- **The Docker image in `infra/solana-fork/`** runs the hosted fork. It clones USDC with Circle's
  real mint authority, so it cannot be funded locally the way the bootstrap funds it. The steps
  above were verified against `fork-bootstrap.ts`, not against that image.

## Watch it work

<p align="center">
  <img src="docs/demo/demo.gif" width="300" alt="Sign in, the permission, live markets, a recurring buy, the activity trail, /judge, the kill switch" />
</p>

91 seconds, recorded against **the hosted app, not a local dev server** — on Base Sepolia, against
the same public executor a stranger's session talks to. The frontend has since moved to Vercel, where
you can open it yourself: [`app.xorr.finance`](https://app.xorr.finance). Full quality:
[`docs/demo/demo.mp4`](docs/demo/demo.mp4). The path it walks, and the words to say over it, are in
[`docs/DEMO-SCRIPT.md`](docs/DEMO-SCRIPT.md); it was produced by
[`tools/demo.mjs`](tools/demo.mjs), which drives a real signed-in Privy session rather than a
mockup, so re-recording it after a change is one command.

It closes on `/safety` reading **EXPIRED**, because the demo wallet's permission had lapsed when it
was recorded. That was the screen behaving correctly — the previous recording showed a green
**Live** badge on the same expired permission, which was a defect, not a better take. The live app
has since been renewed through its own grant flow, three Privy signatures by the wallet's owner, and
on Base Sepolia reads **LIVE** until 2026-10-13.

A second recording, 99 seconds on the Android build against the Base mainnet fork where fills settle:
[`docs/demo/android-fork-demo.mp4`](docs/demo/android-fork-demo.mp4). A recurring buy is created and
run, and fills 0.0200 WETH for $50 through a maker's SwapVM program; the activity trail shows it with
its transaction; `/judge` re-runs the claims with one row failing, 1inch's own API not answering at
the time; and Stop all trading ends on **STOPPED**.

Fills are the one thing Sepolia cannot show — 1inch has no liquidity there, and the app says so on
`/network` rather than pretending. Those are real on the Base mainnet fork, counted by the executor
that made them: **93 through the aggregator, 21 through SwapVM, 9 through Aqua and 1 limit order**,
with 2 supplies to Aave beside them, at 02:24 UTC on 2026-09-15
(`curl -s https://executor-fork-production.up.railway.app/metrics | jq .fillsByVenue`). The fork
itself was rebuilt on 2026-09-11: the counts live in Postgres and survived it, the older receipts
did not, so every fork hash quoted in this repo's submission is from the rebuilt fork.

Note the `/judge` beat leaves a failing check on screen. That is deliberate — a console that goes
green when something is broken is worth nothing, and the break it shows is a real one this project
cannot repair without rewriting an append-only log.

## Check it yourself

Everything below is a claim. `/judge` in the app — and `GET /verify` behind it, which needs no
account — re-runs **21** of them live: the contract read from the chain, the subgraph queried, the
venue allowlist tested against a control address, the Privy policy made to refuse a transaction, the
audit chain re-hashed and compared against the copy Base holds, the price feeds cross-checked. Each
row shows what was observed and the call that produced it, so it can be repeated somewhere this code
cannot reach.

```bash
curl -s "https://executor-production-1659.up.railway.app/verify?owner=0x95A0b368588713011a15f4b1041423f31B08e615" \
  | jq '{passed, failed, skipped}'      # 19 · 1 · 1 — the failure is explained below, on purpose
```

## The trail you do not have to trust us about

Every action the bot takes, and every one it chose not to take, is a row that commits to the hash of
the row before it — so editing history breaks the chain and `/verify` says where. That property has
one honest limit: all of it lives in our database, and a reader who does not trust us has no reason
to trust our report that our own log is intact.

So the head of the chain is published to Base. [`XorrAuditAnchor`](https://sepolia.basescan.org/address/0xB58cB717867988582DcCB7f3155DeD3fC7A76caf)
holds it, signed by the same key `/safety` names as the bot's, and the executor publishes on an
hourly sweep with nobody pressing anything. Rewriting history stays possible; producing a rewrite
that hashes to a value Base has been holding since before the rewrite does not. `/audit/anchor`
shows the commitment, the block, and the two addresses needed to repeat the read without us.

<p align="center">
  <img src="docs/screens/96-audit-anchor.png" width="240" alt="What Base holds: the trail's head, the block, and every commitment" />
  <img src="docs/screens/95-route.png" width="240" alt="Every venue priced for the same trade, with gas and net" />
</p>

The one check that fails is here too, and stays failing. Two writers raced before the append lock
existed and forked the Sepolia trail at entry 2. It is append-only, so it cannot be straightened
without destroying what it proves — and `/verify` reports *"Exactly one, at entry 2, and none since —
the lock holds. All rows are individually unaltered."*

<p align="center">
  <img src="docs/screens/32f-judge.png" width="240" alt="The verification console" />
  <img src="docs/screens/32c-strategy-grid.png" width="240" alt="Range accumulation" />
  <img src="docs/screens/32e-flatten.png" width="240" alt="Sell everything" />
</p>

## Two locks, and you can watch one of them say no

`XorrDelegation` bounds what the **bot** may do. It says nothing about what your own wallet can be
asked to sign — a compromised bundle or a bug in our code could put a transfer to an attacker in
front of you, and the delegation would not care, because it governs the delegate.

So there is a second lock at the layer above, enforced by the party that holds the key. Both are
re-checked live by `/verify`:

```
PASS  privy-policy    4 rules over 4 destinations, owned by key quorum zixx49ik3ngslu9oay54q4li
PASS  privy-refusal   refused: "RPC request denied due to policy violation"
```

The second line is a transaction actually being turned down. Holding the app id, the app secret
and the wallet id, an `eth_sendTransaction` to an address the policy does not name comes back

```
RPC request denied due to policy violation
```

while the same call to `XorrDelegation` passes the policy and reverts on chain for its own
reasons. And because a key quorum owns the policy, an unsigned attempt to add a rule allowing
`0x…dead` is refused outright:

```
401 Missing `privy-authorization-signature` header
```

Compromising this server does not widen what your wallet may do. `/safety` names both locks side
by side, and says plainly that where the policy is not attached to a user's embedded wallet it is
because Privy makes the wallet's **owner** authorise that — and the owner is the user, not us.

## The idea in one paragraph

Handing a bot your money is a trust problem, not a trading problem. So the permission is the
product: `XorrDelegation` is a contract you grant, that caps what the bot can spend per day,
restricts it to venues you allowlisted, expires on its own, and **cannot move funds to an address
of the bot's choosing**. Revoking needs one signature from you and nothing from us. Everything the
bot does is then readable back off the chain through The Graph, and the audit trail's head is
published to Base, so the history you check is not a history we hold.

## Live deployment

| | |
|---|---|
| **The app** | **[`app.xorr.finance`](https://app.xorr.finance)** — open it and sign in: it is a build of the Base mainnet fork below, where fills settle. Frontend on Vercel; executors, fork and Postgres on Railway |
| `XorrDelegation` | [`0x6c5528Fd8E74a047A85bAb413856A9239E73540e`](https://sepolia.basescan.org/address/0x6c5528Fd8E74a047A85bAb413856A9239E73540e) on Base Sepolia — source verified on [Sourcify](https://repo.sourcify.dev/84532/0x6c5528Fd8E74a047A85bAb413856A9239E73540e) (exact match), deployed from `47b1296` ([record](contracts/deployments/base-sepolia.json)). Swap output is bound to the owner on chain; it supersedes `0xb14C…0a4e`, which predated `closePosition` |
| `XorrAuditAnchor` | [`0xB58cB717867988582DcCB7f3155DeD3fC7A76caf`](https://sepolia.basescan.org/address/0xB58cB717867988582DcCB7f3155DeD3fC7A76caf) on Base Sepolia — holds the audit trail's head, published hourly |
| Delegation subgraph | [`api.studio.thegraph.com/query/1758741/xorr/v0.0.3`](https://api.studio.thegraph.com/query/1758741/xorr/v0.0.3) — indexes the contract above, closes as well as spends; synced, no indexing errors |
| Aqua venue subgraph | built + pinned `QmctadHCDBprb9Q1Pq4oyMXjB6KcnUDHRheDRNyBA59tAJ` |
| Bot delegate key | `0xC38f38f45463f77bD823FebE16b15714Eb98c8A5` — the key the deployed executor signs with, funded for its own gas |
| Executor (Base Sepolia) | [`api.xorr.finance`](https://api.xorr.finance/verify), which is [`executor-production-1659.up.railway.app`](https://executor-production-1659.up.railway.app/verify) — the public, explorer-checkable deployment |
| Executor (Base mainnet fork) | [`executor-fork-production.up.railway.app`](https://executor-fork-production.up.railway.app/verify) — where fills actually execute |

The hosted app is a build of the fork. A fork of Base is chain 8453, which Privy takes for real Base,
so a wallet that broadcast its own transactions would simulate them against mainnet, where it holds
nothing. On a fork build the wallet only signs, and the app sends the signed transaction to the fork
itself (`src/wallet/userSigning.ts`) — which is how the Android build of this code granted, bought,
sold and swapped there on 2026-09-15. Sepolia stays the explorer-checkable deployment: the verified
contract, the audit anchor, and the grant below, signed when the hosted app ran there. Fills are the
half Sepolia cannot show, because 1inch has no liquidity on it, and its network screen says so.

A real grant signed by a real Privy embedded wallet is queryable right now:
[`0xce90642d…`](https://sepolia.basescan.org/tx/0xce90642d65cd970bd17984a06b51791ceaf51997b1ace72cb4c25a6bec6b6a1f)
— $1,600/day cap for 30 days, sent from the user's own wallet to `XorrDelegation`, signed through
the hosted app's permission screen on 2026-09-13.

## Two environments, and why there are two

### Why the tokenized equities do not fill on the fork

They are real and they are busy — on **Base mainnet**. Measured there, read-only, by
`server/src/equity-mainnet-proof.ts`: four of the eight answer `totalSupply()` and **all eight saw
transfers inside 4,000 blocks**, while 1inch quotes `100 USDC → 0.4297 NVDAc` on chain 8453 right
now.

On an anvil fork of the same block, that same `totalSupply()` call **reverts**. Every one of these
tokens carries a single byte of code, so whatever serves them lives below the bytecode and a fork
copies the byte and nothing else. No routing choice can fill a token that is not functional, which
is why widening the venue allowlist did not help and why `/verify` calls the contract instead of
measuring `eth_getCode` — one byte passes a length check.

So the app does not offer them here. `/market/tradable` filters them out, `POST /strategies` refuses
one at creation rather than scheduling a run that can only fail, and the order ticket says so. The
markets screen still lists them with their real prices, because the price is genuine and a market
list is not an order form.

Aqua, 1inch and the tokenized equities exist only on Base **mainnet**. `XorrDelegation` is deployed
to Base **Sepolia**, where anyone can grant and revoke for real without spending money.

- **Base Sepolia** proves the permission layer: a real embedded wallet signs a real `grant`, the cap
  is enforced on-chain, revoke stops the bot, the subgraph indexes all of it. It **cannot fill a
  trade** — there is no 1inch there — and the executor says so rather than trying.
- **Base mainnet fork** proves settlement: real router, real USDC, real Aave, real equity tokens,
  real fills. Everything genuine except that the chain is a local copy.

Nothing in this repo is claimed to work in an environment where it was not run.

## Sponsor integrations

| Sponsor | What it does here | Status |
|---|---|---|
| **Privy — auth + wallets** | The identity and the wallet that signs are one object, so there is no second account system — and the wallet Privy creates is the `owner` in the on-chain policy. | **Done.** Real login → real embedded wallet → real signed grant, revoke and approval |
| **Privy — policies + key quorums** | The second lock, one layer above the contract. A Privy **policy** limits where the wallet may send at all — the delegation contract, the tokens it may pull, the lending pool, nothing else — and Privy enforces it before a signature exists. The policy is owned by a Privy **key quorum**, so widening it needs a signature this server can produce and its app secret cannot. | **Done, and checkable.** `/verify` runs both live — see below |
| **Privy — business treasury** | A company's treasury the bot trades and nobody can send out of. Business creates a Privy **server wallet** owned by the key quorum, with the policy attached; the treasury itself signs a capped, expiring grant to the bot, the operator stops it, and a transfer out is refused by Privy before a signature exists. | **Done.** From the Android app on the fork: grant `0x1a6e66a6…`, a SwapVM fill `0xceb3abb6…`, revoke `0x049c6963…`, and Privy's refusal — [SUBMISSION](docs/SUBMISSION.md#privy--best-b2b-financial-product) |
| **1inch — Aqua** | `XorrAquaBook` is an Aqua app on the official deployment. A market maker keeps shares and USDC in their own wallet and quotes anyway — which is what makes an illiquid tokenized equity tradable at all. **The executor settles through it**: books are discovered from Aqua's own logs, quoted, and filled via `delegatedFillArgs` through the same delegation as every other trade. | **Done.** 15 fork tests, plus `live-aqua.ts` — 12 of 12 checks against the deployed executor on 2026-09-11, tx `0xe4875211…`: filled against the book not the router, 0.0565 WETH out of the maker's own wallet for 150 USDC |
| **1inch — Aggregator** | Swap routing and execution. The Route row names the protocols actually routed through. | **Done.** Real fills on a Base mainnet fork |
| **1inch — SwapVM** | `XorrSwapVMBook` compiles the terms of a trade into SwapVM program bytecode — a deadline, a slippage floor, a fee, a salt — so the *rules* of the fill are enforced inside the VM rather than trusted to whoever submits it. | **Done.** 4 fills through `XorrDelegation.spend()` → `XorrSwapVMBook` → the official SwapVM router `0x111111338c…`, including the executor's own strategy run `0x72ef8613…` (no explorer — the fork is a private node). An impossible floor is refused by the router itself, at call depth 2, not by us. `server/src/live-swapvm.ts` is the maker that makes it possible |
| **The Graph** | Two independent subgraphs, joined. One indexes our delegation contract (what you permitted); one indexes 1inch Aqua on Base mainnet (what liquidity exists). The **join picks the venue** — neither index can see the other's half. | Delegation index **deployed + synced** and read before every spend; Aqua index **built and pinned**, awaiting a Studio slug — see [The one thing that is not done](#the-one-thing-that-is-not-done) |
| **Aave v3** | Tier 4's venue. Idle USDC is supplied through the same delegation, under the same daily cap and the same venue allowlist — and the aToken goes straight to the user, because `supply()` names the recipient. | **Done.** 18 fork assertions, including that the bot *cannot* withdraw |
| **Base** | Everything settles here. Tokenized equities, cbBTC, Aave, 1inch — all Base-native. | **Done** |
| **Basenames** | Base's own naming, resolved against the L2 resolver — not ENS, which answers on the wrong chain. The safety screen names both parties to the permission rather than showing two truncated hexes that look identical in the middle. | **Done.** `jesse.base.eth` ⇄ `0x2211d1D0…` both directions |

## The core primitive

`contracts/src/XorrDelegation.sol` — every constraint enforced **by the contract**, not by us:

- daily cap, resetting on the UTC day boundary
- expiry (screen 5's "Run For")
- venue allowlist — the bot trades at approved venues and **cannot send funds anywhere it chooses**
- `revoke()` needs only the owner's signature: no server, no oracle, no cooperation from the bot

It never custodies. It pulls exactly the approved amount at the moment of a trade, forwards it, and
leaves no standing approval behind. Bought tokens go **straight to the user's wallet**, never to the
contract.

## What is actually real

| | |
|---|---|
| Prices | CoinGecko for crypto; a live 1inch route for the tokenized equities, because what you pay is what routes — not the NYSE print |
| Yield | `currentLiquidityRate` read from the Aave v3 Pool on Base |
| Fills | 1inch Aggregation Router v6, `XorrAquaBook` on official Aqua, and `XorrSwapVMBook` through the official SwapVM router |
| History | The Graph, indexed from the contract's own events |
| Permission | On-chain, signed by the user's embedded wallet |
| Markets | Of 44 instruments, 18 have a real feed — crypto, the tokenized equities, and gold, which CoinGecko prices as `tether-gold`. **The other 26 — the rest of commodities, every index, every pre-IPO name — are listed with no price**, because nothing prices them. They used to show the design prototype's numbers under a SIMULATED tag, including prices for private companies; those were removed from the data, and a test keeps them out. |

**The rule that settles arguments:** every price on screen is real, or it is labelled. A confident
wrong number is the worst outcome available — that rule has caught eight bugs in this repo, most
recently a cross-check that fell back to WETH's address and priced BTC as ether.

Prices are checked against a second, independent source: 1inch's spot API, derived from the pools a
fill would actually touch. Measured live, the two agree within 0.03% on ETH and 0.02% on cbBTC. The
asset screen mentions it only when they disagree — a line saying "two sources agree" on every asset
every day is noise that trains people to stop reading.

## The strategy ladder

Ordered by how much the bot has to be right about the future, not by how impressive it sounds. All
seven rungs are built and registered in `PLANNERS`; the fork's run log carries fills from tiers 1
through 6. Tier 7 trades tokenized equities around earnings, and equities do not function on a fork, so
it has run there without a fill.

| | What it does | Why it sits here |
|---|---|---|
| **1 · Recurring buy** | A fixed amount into one asset on a schedule. | No forecast. You can check every run against a calendar. |
| **2 · Rebalance** | Holds your sleeves at the weights you approved, trading only the drift. | Deterministic. The only input is your own target. |
| **3 · Take profit, stop loss, trailing stop** | Closes a position at levels you set. It never opens one. | Risk-reducing only. The trailing stop follows the high-water mark, updated on every run — including the ones where it does nothing, which is when trailing has to happen. |
| **4 · Idle cash to yield** | Supplies spare USDC to Aave v3. | Every move is a published rate you can check. The bot can supply and deliberately **cannot withdraw** — burning your own aTokens needs nobody's permission, so that power was never granted. |
| **5 · Range accumulation** | Buys a rung lower and sells a rung higher inside a band you draw. | The first tier that assumes something — that the range holds. So the setup screen backtests exactly that against real history before you commit. |
| **6 · Momentum** | A Donchian breakout with a trend filter and a stop attached to every entry. | The first tier that needs the bot to be right about the future, so it proposes rather than executes unless you turn that off. Its backtest replays this exact rule — see `momentumReplay`. |
| **7 · Events and earnings** | Trades tokenized equities around EDGAR filing dates. | Most judgement, most ways to be wrong, last. The dates come from the regulator and a projection says it is one. |

Every tier runs through the same `spend()` or `closePosition()` — one set of gates, checked once.
A tier with a screen and no executor is worse than no tier, so `available` is flipped only after
the executor has actually run it.

## When it goes wrong

| | |
|---|---|
| A trade is blocked | The cap, expiry or allowlist refused it. Said in plain language, pushed to your phone, and written to the trail — silence there looks identical to the bot not trying. |
| The bot runs out of gas | Caught before anything is signed, so the run blocks with the true reason instead of failing inside the venue call as "the venue rejected the order". |
| The price moves mid-flight | The delegation bubbles the venue's own revert instead of replacing it, so 1inch's `ReturnAmountIsNotEnough` becomes "the price moved more than your slippage limit". |
| A dependency goes down | Four consecutive failures open a per-host circuit breaker for 30s. Every screen already handles a failed read; they now get there in milliseconds instead of twenty-five seconds. |
| A screen throws | Contained to that screen. The tab bar keeps working and the kill switch stays one tap away. |
| The executor is killed mid-run | It drains first. Anything it could not finish is reconciled at the next boot and **not retried** — a run that may have signed and lost its receipt must never be repeated. |
| You want out entirely | "Sell everything" closes every position into USDC through `closePosition`, so a spending cap can never block an exit. Withdrawing the USDC is then a transaction **you** sign to an address you allowlisted a day earlier — the executor has no transfer-out path at all, which is what makes it not a custodian. |

## Every screen

A curated set below, from the 103 routes the sweep captures at the design canvas (402×874) against a
signed-in session. The same sweep checks content, the console and the network on every one of them,
and fails a screen on any console error or failed request. Regenerate with `node tools/shoot.mjs`.

### Onboarding
| | | | |
|---|---|---|---|
| **Welcome** `/welcome`<br/><img src="docs/screens/01-welcome.png" width="180"/> | **Goals** `/goals`<br/><img src="docs/screens/02-goals.png" width="180"/> | **Wallet** `/wallet`<br/><img src="docs/screens/03-wallet.png" width="180"/> | **Fund** `/fund`<br/><img src="docs/screens/04-fund.png" width="180"/> |
| **Delegate** `/delegate`<br/><img src="docs/screens/05-delegate.png" width="180"/> | **Proposal** `/proposal`<br/><img src="docs/screens/06-proposal.png" width="180"/> | | |

### Home and markets
| | | | |
|---|---|---|---|
| **Home** `/`<br/><img src="docs/screens/07-home.png" width="180"/> | **Markets** `/markets`<br/><img src="docs/screens/08-markets.png" width="180"/> | **Crypto** `/markets/crypto`<br/><img src="docs/screens/09-markets-crypto.png" width="180"/> | **Stocks** `/markets/stocks`<br/><img src="docs/screens/10-markets-stocks.png" width="180"/> |
| **Commodities**<br/><img src="docs/screens/11-markets-commodities.png" width="180"/> | **Indices**<br/><img src="docs/screens/12-markets-indices.png" width="180"/> | **Pre-IPO**<br/><img src="docs/screens/13-markets-preipo.png" width="180"/> | **Watchlist** `/watchlist`<br/><img src="docs/screens/14-watchlist.png" width="180"/> |
| **Search** `/search`<br/><img src="docs/screens/15-search.png" width="180"/> | **Asset** `/asset/BTC`<br/><img src="docs/screens/16-asset.png" width="180"/> | **Asset — stock**<br/><img src="docs/screens/17-asset-stock.png" width="180"/> | **Chart** `/chart/BTC`<br/><img src="docs/screens/18-chart.png" width="180"/> |

### Trading
| | | | |
|---|---|---|---|
| **Order** `/order/WETH`<br/><img src="docs/screens/19-order.png" width="180"/> | **Order — stock**<br/><img src="docs/screens/20-order-stock.png" width="180"/> | **Swap** `/swap`<br/><img src="docs/screens/21-swap.png" width="180"/> | **Perp** `/perp/BTC`<br/><img src="docs/screens/22-perp.png" width="180"/> |
| **Position** `/position/:id`<br/><img src="docs/screens/23-position.png" width="180"/> | **Auto Close**<br/><img src="docs/screens/24-auto-close.png" width="180"/> | | |

### Agents
| | | | |
|---|---|---|---|
| **Bot** `/bot`<br/><img src="docs/screens/25-bot.png" width="180"/> | **Roster** `/bot/roster`<br/><img src="docs/screens/26-bot-roster.png" width="180"/> | **Leaderboard**<br/><img src="docs/screens/27-bot-leaderboard.png" width="180"/> | **Agent intro**<br/><img src="docs/screens/28-bot-intro.png" width="180"/> |
| **Agent settings**<br/><img src="docs/screens/29-bot-settings.png" width="180"/> | **Backtest**<br/><img src="docs/screens/30-bot-backtest.png" width="180"/> | | |

### Strategies and portfolio
| | | | |
|---|---|---|---|
| **Strategies** `/strategies`<br/><img src="docs/screens/31-strategies.png" width="180"/> | **Recurring buy**<br/><img src="docs/screens/32-strategy-dca.png" width="180"/> | **Assets** `/holdings`<br/><img src="docs/screens/33-holdings.png" width="180"/> | **Activity** `/activity`<br/><img src="docs/screens/34-activity.png" width="180"/> |
| **Idle cash to yield** `/strategy/yield`<br/><img src="docs/screens/32b-strategy-yield.png" width="180"/> | **Range accumulation** `/strategy/grid`<br/><img src="docs/screens/32c-strategy-grid.png" width="180"/> | **Earning at Aave** `/yield`<br/><img src="docs/screens/32d-yield-position.png" width="180"/> | **Sell everything** `/flatten`<br/><img src="docs/screens/32e-flatten.png" width="180"/> |
| **Check it yourself** `/judge`<br/><img src="docs/screens/32f-judge.png" width="180"/> | **History** `/history`<br/><img src="docs/screens/35-history.png" width="180"/> | **Briefing** `/briefing`<br/><img src="docs/screens/36-briefing.png" width="180"/> | **Inbox** `/inbox`<br/><img src="docs/screens/37-inbox.png" width="180"/> |

### Safety and settings
| | | | |
|---|---|---|---|
| **Safety** `/safety`<br/><img src="docs/screens/38-safety.png" width="180"/> | **Settings** `/settings`<br/><img src="docs/screens/39-settings.png" width="180"/> | **Alerts** `/alerts`<br/><img src="docs/screens/40-alerts.png" width="180"/> | **New alert**<br/><img src="docs/screens/41-alerts-new.png" width="180"/> |
| **Allowlist** `/allowlist`<br/><img src="docs/screens/42-allowlist.png" width="180"/> | **Send** `/send`<br/><img src="docs/screens/43-send.png" width="180"/> | **Recovery** `/recovery`<br/><img src="docs/screens/44-recovery.png" width="180"/> | **Legal** `/legal/:doc`<br/><img src="docs/screens/45-legal.png" width="180"/> |

### Design harness
| | | |
|---|---|---|
| **Design system** `/_dev/ui`<br/><img src="docs/screens/46-dev-ui.png" width="180"/> | **Edge cases** `/_dev/ui-edge`<br/><img src="docs/screens/46b-dev-ui-edge.png" width="180"/> | **Fidelity** `/_dev/fidelity`<br/><img src="docs/screens/47-dev-fidelity.png" width="180"/> |

### The one thing that is not done

The **Aqua venue subgraph** is built, compiled to WASM and pinned to IPFS at
`QmctadHCDBprb9Q1Pq4oyMXjB6KcnUDHRheDRNyBA59tAJ`, and `decide()` already joins it into the routing
decision. It is not deployed: `graph deploy` answers `Subgraph not found`, because the `xorr-aqua`
slug has never been created in Subgraph Studio and creating one is a wallet-signed action in the
Studio dashboard that no API exposes. It cannot be folded into the existing `xorr` subgraph either
— that one indexes `base-sepolia` and this one indexes `base`.

The consequence is stated rather than hidden: with no endpoint configured, `decide()` routes to the
1inch aggregator and **says** it could not see the Aqua index, because treating "cannot see" as
"nothing there" would hide an outage behind a worse fill. One dashboard click and
`AQUA_SUBGRAPH_URL` finishes it.

### On a real Android build

The shots above are the web build. These are the same app compiled to a native APK and running on
an emulator — same routes, same code, and a genuine Privy embedded wallet created on the device.
It is worth showing separately because three bugs existed **only** here: `jose` resolving its Node
build under React Native, Privy's polyfills never being installed, and `motionDuration` being
called across the worklet boundary. None of them can happen on web.

| | | | |
|---|---|---|---|
| **Welcome**<br/><img src="docs/screens/android/01-launch.png" width="150"/> | **Sign in**<br/><img src="docs/screens/android/07-otp.png" width="150"/> | **Wallet created**<br/><img src="docs/screens/android/08-wallet.png" width="150"/> | **Home**<br/><img src="docs/screens/android/10-home.png" width="150"/> |
| **Ladder**<br/><img src="docs/screens/android/12-tier4.png" width="150"/> | **Idle cash to yield**<br/><img src="docs/screens/android/13-yield-setup.png" width="150"/> | | |

The last one is worth reading closely: the wallet is brand new, so spendable cash is $0.00 and the
preview says **"would move: nothing"** rather than showing the configured $250. That is the screen
telling the truth about a wallet it cannot sweep.

## Running it

```bash
cp .env.example .env        # fill in Privy, 1inch, Graph keys
createdb xorr_eth && psql xorr_eth -f server/src/db/schema.sql
npm install && (cd server && npm install)

npx tsx server/src/index.ts  # executor on :8788
npx expo start --web         # app on :8082
```

For fills, run against a Base mainnet fork — the only environment where every piece is real at once:

```bash
anvil --fork-url https://mainnet.base.org --port 8545 --chain-id 8453
XORR_CHAIN=base-fork FORK_RPC=http://127.0.0.1:8545 npx tsx server/src/fork-e2e.ts WETH
```

## Tests

```bash
npm test                                       # 2,490 — 1,603 app and 887 executor units
(cd server && npm test)                        # 268 executor on its own
(cd server && npm run test:live)               # 77 against real APIs, a real chain and the running executor
(cd contracts && forge test)                   # 62 contract: 30 unit (22 delegation, 8 anchor) + 32 fork
(cd contracts && forge test --match-contract Fork \
   --fork-url $BASE_RPC)                       # 32 fork: 15 Aqua, 10 SwapVM, 7 equities
node tools/shoot.mjs                           # 103 screens, content + console + network
```

Two scripts drive the DEPLOYED executor rather than a local one, because "it works on my machine"
is the claim this repo exists to avoid making:

```bash
npx tsx server/src/live-agents.ts    # grant, fill, close, scopes, idempotency, cap, revoke — 20 checks
npx tsx server/src/live-ladder.ts    # every ladder tier marked available, actually run — 11 checks
```

`docs/BASE-BUILD-CAMP.md` is the same work framed for that submission.
`docs/TESTPLAN.md` is the executed plan — every item PASS/FAIL with its evidence.
`PLAN.md` is what is left to build, with every gap tied to the task it blocks.

## Repo map

```
app/           99 expo-router screens
src/           design system, charts, data layer, state
server/        Hono executor — auth, scheduler, venues, Graph clients
contracts/     XorrDelegation, XorrAuditAnchor, XorrAquaBook, XorrSwapVMBook (Foundry)
subgraph/      delegation index      → deployed
subgraph-aqua/ Aqua venue index      → built
docs/          TESTPLAN, SECURITY, RUNBOOK, screens
ui/            the original design handoff, kept as the reference
```
