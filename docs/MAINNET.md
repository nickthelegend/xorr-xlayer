# Going live on X Layer mainnet

Everything the demo does on the fork, on the real chain with real money. Prepared and rehearsed 2026-09-25; **nothing
here has been run against mainnet yet** — it waits for the owner's funds and go-ahead, because it spends real OKB and
the agent will trade real USDC inside the permission the owner signs.

## What it costs

Gas on X Layer is ~0.02 gwei (measured 2026-09-25). OKB was $119.42.

| Step | Gas | OKB | USD |
|---|---|---|---|
| Deploy XorrDelegation + XorrAuditAnchor | 1.65M | 0.000033 | $0.004 |
| Sign the permission (16 approvals + grant) | ~1.05M | 0.000021 | $0.003 |
| One trade (buy or sell) | ~210–230k | 0.0000045 | $0.0005 |
| 100 trades | ~22M | 0.00044 | $0.05 |

Gas is effectively free; the OKB below is working balance, not spend.

## What to fund

| Address | What it is | Send |
|---|---|---|
| `0x1725a1B284D58dC9bb79DfB7B205d4d0D5d4E4eA` | the deployer (key in `server/.env.deployer`) | **0.01 OKB** |
| `0x55C2a91A99C8b8cC5A9EE5c5e9053F2B9C080584` | the mainnet executor's delegate — pays gas for every agent trade and audit anchor (key in `server/.env.mainnet-delegate`) | **0.05 OKB** |
| your own wallet in the mainnet app | shown on the app's Deposit screen after you sign in | **0.02 OKB** + **USDT $120–150** |

From OKX: withdraw **OKB** on the **X Layer** network, and **USDT** on the **X Layer** network — it arrives as USDT0, and
the Deposit screen converts it to USDC with your own signature. Do not withdraw USDC to X Layer: OKX had suspended USDC
on X Layer (research 2026-09-19).

## The steps (Claude runs them once funded and told to go)

1. **Contracts.** `CONFIRM_MAINNET=yes ./contracts/deploy-xlayer-mainnet.sh` — refuses without the confirmation and
   under 0.005 OKB; writes `contracts/deployments/xlayer-mainnet.json`. Rehearsed on a fork of mainnet: both contracts
   deploy against Circle's USDC, and because the deployer has never sent on mainnet they land at the same addresses as
   on testnet — XorrDelegation `0x156DCE9E9d523775AB51f882616A431EdBfBcA22`, XorrAuditAnchor
   `0x36d503D1893CAB30B5D68DC9A96e8B91bfcBe196`. Then verify source on Sourcify, as testnet was.
2. **Executor.** New Railway service `executor-mainnet` with its own Postgres, from `server/`:
   `XORR_CHAIN=xlayer`, `ALLOW_MAINNET=yes`, `DELEGATION_ADDRESS`, `ANCHOR_ADDRESS`, `DELEGATE_PRIVATE_KEY` (from
   `server/.env.mainnet-delegate`), `XORR_DELEGATE_ADDRESS`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`,
   `PRIVY_AUTHORIZATION_KEY`, `PRIVY_KEY_QUORUM_ID`, `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`,
   `OPENROUTER_API_KEY`, `OPERATOR_TOKEN`, `ALLOWED_ORIGINS=<the mainnet web URL>`. No `FAUCET_PRIVATE_KEY`: there are
   no test funds on mainnet, and the Deposit screen leaves that section out where the network has none. Deployed with `npm run deploy:executor` (add the service
   to `scripts/deploy-executor.mjs`).
3. **Web.** A separate Vercel project, `xorr-xlayer-mainnet`, built by `deploy:web` with `XORR_WEB_API` = the mainnet
   executor. The fork demo stays at `xorr-xlayer.vercel.app` for the video and for judges to try without money.
4. **Privy.** Add the mainnet web URL to the app's allowed domains (dashboard → the app → Domains). The wallet policy
   for mainnet is created by the executor on first use, owned by the same key quorum.
5. **Prove it.** `/verify` on the mainnet executor, then: sign in, deposit, sign the permission ($100/day, 7 days), one
   $20 buy from the ticket (settles on Uniswap or OKX DEX, whichever pays more — on mainnet both quote the same
   chain), Stop all. Every step is an OKLink transaction.

## What changes for a user on mainnet

- The agent trades **real USDC** inside the permission: at most the daily cap, only on the allowlisted venues, only
  into the owner's own wallet. Revoking needs one signature and nothing from us.
- The OKX-vs-Uniswap choice is exact on mainnet: both quote the chain the trade settles on, so no fork drift.
- There are no test funds, so first-time use starts at Deposit.
