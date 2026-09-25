# Security review — PLAN.md 13.11

Scope: the delegation primitive, key storage, the executor's blast radius, and the client/server
trust boundary. Written against the code as it stands, not against intentions.

## 1. The delegation primitive — the thing standing between a bug and someone's capital

**What it is.** `XorrDelegation` (`contracts/src/XorrDelegation.sol`), deployed on the hosted fork of X Layer
mainnet (`0xAf70b1ee53B459f35A9dC29BE17b439d3ee27058`, chain 196) and on X Layer testnet
(`0x0b8363E351588c4De2c5CeD667b7a2ef53F9E6B2`, chain 1952, Sourcify exact match — `contracts/deployments/xlayer-testnet.json`). The owner calls
`grant(delegate, dailyCap, expiresAt, venues)` from their own wallet; the bot's key may then call `spend()`,
`spendVia()`, `closePosition()` and `closePositionVia()` for that owner, and nothing else.

**`spendVia` / `closePositionVia`.** OKX DEX's router pulls its input through a separate approval contract, so the
contract approves `spender` rather than `venue`. Both must be on the owner's allowlist (`VenueNotAllowed` otherwise),
every other check below applies unchanged, and the approval is set for exactly `amount` and reset to zero in the same
call (`contracts/test/XorrDelegationVia.t.sol`).

**Each agent's own budget (2026-09-25).** Inside the owner's daily cap, every agent the owner hired or made has a
budget of its own on the contract, filed under `keccak256("xorr-agent:" + agent id)`. The OWNER sets it —
`setAgentBudget(agent, budget)` sets the budget of whoever sends it, so the bot's key can only ever set its own, which
nothing reads. An agent's trade goes through `spendForAgent` / `closeForAgent`: a buy is charged to that agent's budget
and refused past it (`AgentBudgetExceeded(agent, requested, remaining)`), and a sale credits what it returned in the
settlement token back to it. An agent's exit sells only the
lot its buy filled, so a budget is credited only for what it paid for; any other sale is the owner's and credits nobody.
The one delegate key still signs every trade — as the Solana build's bot key does. What the budgets bind is the trades
the executor submits AS an agent's (`contracts/test/XorrAgentBudget.t.sol`, 19 tests including a fuzz of the running
balance). They are not a limit on the key itself: a stolen delegate key could trade as "no agent" (`spend`) and skip
every budget, or credit a sale to any agent's budget — inside the daily cap, the venue allowlist, the expiry and the
output floor, which remain the hard limits on the key. An owner opt-in that makes every delegate spend chargeable to
some budget is the next step, and would need a redeploy.

**What the delegate CAN do**
- Spend the settlement token (USDC) at a venue the owner allowlisted, up to what is left of today's cap, for a
  named output token that must reach the owner.
- Sell another token the owner holds back to the settlement token (`closePosition`), under the same delegate,
  expiry, revocation and venue checks, without drawing on the cap.

**What the delegate CANNOT do — enforced by the contract, not by our code**
- Spend from any address but the delegate's own call: `NotDelegate`.
- Exceed the day's cap (UTC day): `DailyCapExceeded(requested, remaining)`, checked before anything moves.
- Spend past an agent's own budget on a trade submitted as that agent's: `AgentBudgetExceeded`, after the day's cap is
  checked — or set any agent's budget, which only the owner's own transaction can do. (It can still submit a trade as
  nobody's, or credit a sale to an agent: see "Each agent's own budget" above.)
- Reach a venue the owner did not allow: `VenueNotAllowed(venue)`.
- Trade after expiry or after the owner revokes: `PolicyExpired`, `PolicyRevoked` — for spends and closes alike, so
  a stop ends stop-losses too.
- Send the output anywhere but the owner: the owner's balance of the named output must rise by `minOut`
  (`OutputNotReceived`), and a close cannot sell the settlement token (`SettlementTokenNotClosable`).
- Prevent a revoke: `revoke()` needs one owner signature and no server.

**How it is proven.** `forge test` (unit and fork suites); `tools/prove-contract-refusals.ts`, which on 2026-09-15 read
both deployed contracts at one block and got every refusal above from `eth_call`, and the revoke and expiry cases from
local anvil copies of both chains; `tools/prove-stop-without-server.ts` for a stop confirmed from the chain alone.

**Residual risk**
- A stolen delegate key trades badly inside the owner's limits until the owner revokes. It chooses the venue calldata,
  bounded by the allowlist and by the output check.
- The cap is in settlement-token units, and `closePosition` is deliberately uncapped: de-risking is not spending.

## 2. Key storage

| Key | Where it lives | Blast radius if stolen |
|---|---|---|
| Owner (user) | Privy's embedded wallet. xorr never holds it. | That user's wallet. `app/recovery.tsx` says plainly that xorr cannot recover it. |
| Delegate (bot) | `DELEGATE_PRIVATE_KEY` on Railway; locally `server/.keys/delegate.key` (0600, gitignored). | Bounded by §1: trades inside each owner's permission until they revoke. No transfer-out path exists. |
| Faucet | `FAUCET_PRIVATE_KEY` on Railway. | Test funds. The executor refuses to drip on any chain whose money is real (`server/src/evm/money.ts`). |
| Privy app secret, authorization key | Railway variables. | The app's server-side Privy calls. The wallet policy is owned by a key quorum, so the app secret alone cannot widen it. |
| Deployer | `server/.env.deployer` (mode 600, gitignored), X Layer testnet only. | Test OKB. |

**Before any deployment carrying real value, the delegate key must move to a KMS or an HSM** — a variable on a host
is adequate for a testnet and a fork and is not adequate beyond that. Recorded as a gap, not as done.

## 3. Client/server trust boundary

**No limit is enforced client-side.** Verified three ways:
- `src/data/repositories.test.ts` fails the build if any screen or component calls `fetch`.
- `server/src/rules/engine.ts` re-evaluates every limit on the server. `rules/engine.test.ts` proves a spend that would
  breach the cap is refused and says by how much, the kill switch refuses before anything else, a revoked or expired
  permission refuses, and a used-up cap does not silence an exit.
- The contract refuses the same things again on chain (§1), whatever the executor decided.

The client's stepper sets a *requested* cap; the server decides. A tampered client can ask for
anything and gets the same answer.

## 4. Replay and double-spend

`strategy_runs.period_key` is `UNIQUE` (`server/src/db/schema.sql`). Claiming a run is an INSERT, so there is no
window between "check" and "act"; a run that obtained no answer releases its period rather than leaving it claimed
(`executor/failure.test.ts`).

Money writes carry an `Idempotency-Key` (FEATURES.md #29). `http/idempotency.test.ts` proves the same key with the
same body replays the stored answer and runs nothing, a concurrent duplicate is refused with 409, and a claim that
already broadcast a transaction is never run again.

Proposal decisions use the same shape — the `UPDATE` matches only an undecided, unexpired row, so
a double-approve cannot double-fill.

## 5. The audit trail

Append-only via a database trigger (an `UPDATE` or `DELETE` raises). Hash-chained with canonical
JSON, so a tampered row breaks verification for everything after it. The export carries its own
verification result, so a recipient does not have to trust the exporter.

The head is also published on chain. `XorrAuditAnchor` (`0x9d22e2b3e1d31a6973b6395cbb6d369ef8b6cf12` on the hosted
X Layer fork; `0x36d503D1893CAB30B5D68DC9A96e8B91bfcBe196` on X Layer testnet) holds each commitment, signed by the delegate key and published on an unattended sweep; a count that goes
backwards reverts (`CountWentBackwards`), and `/audit/anchor` shows what the chain holds beside what the executor holds.

*Known limitation:* a party with database superuser rights could still rewrite the trail and anchor a rewrite of equal
or greater length going forward. What they cannot do is make the new trail hash to a head the chain has held since before
the rewrite; the anchor's timestamp and block carry that weight.

## 6. Biometrics

`expo-local-authentication` gates the kill switch and the delegation grant. If no hardware or no
enrolment is present the app proceeds — a device without biometrics must still be able to STOP its
bot, and blocking the kill switch behind unavailable hardware would be a worse failure than the one
it prevents. Payout paths should not make the same trade; they are gated by the allowlist instead.

## 7. Withdrawal allowlist

Withdrawals may only target an allowlisted address, and a newly added address is unusable for 24
hours. This is what stops a stolen unlocked phone from adding an address and draining the wallet in
one session.

**The list and its clock are the executor's** (PLAN.md 4.9: `server/src/withdrawals/allowlist.ts`,
migration `022-withdrawal-addresses.sql`, routes in `server/src/routes/withdrawals.ts`). It used to be
AsyncStorage on the phone, with the phone's clock deciding when 24 hours had passed — so the device
the rule guards against decided when the rule ended, and moving its date forward a day removed it.
Now:

- Adding an address writes `usable_at = now() + 24 hours` on the database's clock, and every check
  compares `usable_at <= now()` on the same clock. Nothing a client sends moves either end, and the
  24 hours are a constant, not a setting. The app is handed `usable` and `usableAt` and never compares
  a time with its own clock.
- Removal takes effect in the statement that finds the row. The row is kept, with `removed_at`, so the
  book still says which address was usable when; adding the address back is a new row with a new 24
  hours. Adding an address that is already listed is refused, and neither restarts nor ends its wait.
- Every addition and removal is appended to the hash-chained audit trail in the same transaction, and
  pushed to the owner's devices under a kind with no mute switch: a cooling-off only helps someone who
  hears about the new address while it runs.
- Rows are scoped to the chain (`xorr.chain_key`), so an address allowlisted against a fork is not
  allowlisted on X Layer mainnet, although the two share a chain id.

**Where it is enforced**

- The app asks `POST /withdrawal-addresses/check` immediately before it requests a signature for a send
  (`src/wallet/useWithdraw.ts`), so an address still cooling off — or removed from another device while
  a screen was open — is refused before anything is signed. The screens offer only usable addresses
  and say when a pending one becomes usable, and the check does not rely on them.
- The executor applies the same check to anything it prepares. `POST /withdrawals/prepare-all`, the
  whole-balance transfer that "withdraw everything" ends with, refuses before it reads anything else. A
  refusal at either point is written to the trail as a `block`.
- `POST /withdrawals/record` reads back each transaction the owner reports and writes every outgoing
  transfer to the trail, with whether its destination was usable. One that was not is written as a
  `risk`: the app will not ask for that signature, so it was signed somewhere else.
- The app builds the transfer it signs from the address the person chose, and it checks what the
  executor prepares (`src/wallet/withdrawEverything.ts`): a transfer is signed only if it moves exactly
  the prepared amount to exactly the chosen address, and an Aave exit only if it is addressed to the
  Aave pool, for the whole position, paying the owner. The executor cannot redirect a withdrawal by
  rewriting calldata.
- "Withdraw everything" runs in one order — sells through the permission's close path, then the
  owner-signed Aave exit, then the owner-signed transfer — and stops at the first step that fails.

**What this does not stop — recorded as gaps**

- The owner's key can still sign a transfer anywhere. The check is the app asking the executor, not the
  chain or the wallet refusing, so a tampered build, or another client holding the same key, goes
  around it. Binding the key itself needs a destination policy on the user's own Privy wallet
  (PLAN.md 4.13), which does not exist yet.
- The list now lives with the executor, so a compromised executor could insert an address and mark it
  usable. The owner would still have to choose it and sign the transfer — the app shows the address and
  Privy's sheet shows the recipient — and the insertion would have to bypass the trail to go
  unrecorded. Having the owner's wallet sign each entry, so the app can check the list without trusting
  the server that stores it, would close this. It is not done.

## 8. Network

- The app talks to one first-party origin, its executor (`EXPO_PUBLIC_API_URL`), plus Privy and the chain's RPC for
  user-signed transactions. Market data, Uniswap quotes and OKX DEX are read by the executor, not the app.
- Every route that touches a wallet verifies the caller's Privy access token and answers 401 without one; the endpoint
  QA checks each of them with no token and with a forged one on both executors.
- Browsers may call the executors only from `ALLOWED_ORIGINS` (`https://app.xorr.finance` on both deployments); a
  foreign origin's preflight is refused.
- The executor refuses to start on a chain whose money is real without an explicit `ALLOW_MAINNET=yes`, and on a chain
  it does not know at all (`server/src/evm/money.ts`).
- Certificate pinning is not implemented. Required before a production release.

## 9. What this review did NOT cover

- A third-party audit of the delegation contract. PLAN.md 13.11 calls for one and it has not happened.
- Jailbreak/root detection.
- Per-client rate limiting across the executor API. Only the routes that spend gas are limited (`/audit/anchor`,
  `/delegation/record`, 429 with a retry-after).

---

# Addendum — key handling (carried over from the Base build)

## The well-known-key incident

During setup the deployer address quoted in a status report was `0xf39Fd6…92266` — **anvil's
default account #0**, whose private key (`0xac09…ff80`) appears in every Foundry tutorial. Testnet
funds were sent there before that was caught.

The funds were swept to a freshly generated key
(`0x364d7Bbc139541e0e37450D527ae154B5C292581`) in tx `0xb98293…4ab1`, and nothing was lost. But the
lesson is worth writing down rather than quietly fixing:

- **Never quote an anvil/hardhat default address as a funding target.** Sweeper bots watch those
  addresses on every public chain and drain them within seconds.
- Keys used on a public network are generated locally into `.keys/` (mode 600, gitignored) and have
  never been published.

## Delegate key

On the hosted X Layer fork, `0xB3e9E76E710cEf6cB0B064E58b63e4084AecEC21` signs scheduled trades; on X Layer testnet,
`0x19033937953479E8F7b0237eB48ee87Be1D1c8ae`. Each key is a Railway variable, generated locally, never printed or
committed. Its blast radius is bounded by
`XorrDelegation`: capped per day, venue-allowlisted, time-boxed, and revocable by the user without
this server's cooperation. **Before any deployment carrying real value it must move to a KMS or an
HSM** — a file on a host is adequate for a testnet demo and is not adequate beyond that.

## Env var naming

`CHAIN` was renamed to `XORR_CHAIN` because Foundry auto-loads `.env` from the working directory and
interprets `CHAIN` as its own `--chain` flag, which broke every `cast`/`forge` command in the repo.

## The delegate key

`server/src/evm/client.ts` loads the bot's signing key from `DELEGATE_PRIVATE_KEY`, or generates
one into `server/.keys/delegate.key` (mode 600, gitignored) when that is unset.

**A file on a host is adequate for a local fork and is not adequate beyond one.** Anyone who reads
that file can sign as the delegate. What they *cannot* do is the point of the whole design:

- they cannot exceed the daily cap, which the contract enforces
- they cannot trade anywhere the user has not allowlisted
- they cannot send funds to an address of their choosing — there is no code path for it
- they cannot stop the user revoking, which needs one signature and no cooperation from us

So the blast radius of a stolen delegate key is "the bot trades badly inside limits the user set,
until the user revokes". That is a real incident and a bounded one. It is bounded by the contract,
not by our operational hygiene, which is why the contract is where the enforcement lives.

### Before any mainnet deployment

1. Move the key to a KMS or HSM — AWS KMS, GCP KMS, or a Turnkey/Fireblocks signer. The executor
   only needs `signTransaction`, so the key never has to be in process memory.
2. Give it its own IAM principal with signing permission and nothing else.
3. Alert on any `Spent` or `Closed` event whose transaction the executor did not initiate. `/history` already scans
   both from the chain, so this is a query rather than new infrastructure.
4. Rotate by granting a new delegate and revoking the old one. `grant()` overwrites the delegate
   for that owner, so rotation is one user signature and does not require our cooperation either.

### What is deliberately NOT protected

The owner key. Privy holds it on the user's device and xorr never sees it. That is why the
executor cannot grant itself permission, cannot move funds out, and cannot prevent a revoke — and
it is why a compromise of everything in this repository still cannot take a user's money.
