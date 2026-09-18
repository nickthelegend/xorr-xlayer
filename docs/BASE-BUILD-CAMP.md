# xorr — Base Build Camp 2026

Same codebase as the ETH Online submission, framed for what Base Build Camp actually asks:
something people use, built Base-native, with real transactions on Base.

## Why this is a Base app and not an app that happens to run on Base

Every part of the thesis depends on something that only exists here.

| | |
|---|---|
| **Tokenized equities** | Ondo issues NVDA, AAPL, TSLA, META, MSFT, AMZN, GOOGL and MSTR on Base under the `0xb2000…` prefix. All eight are verified live and 1inch routes USDC into every one. Buying a share from your phone is a Base transaction. |
| **1inch Aqua + SwapVM** | Both deployed on Base. `XorrAquaBook` and `XorrSwapVMBook` are Aqua apps, and the maker's book is either Solidity or SwapVM bytecode the router executes. |
| **cbBTC** | Coinbase's wrapped BTC, Base-native. "Buy BTC" settles into it. |
| **Aave v3** | The idle-cash rate on the home screen is `currentLiquidityRate` read from the Base Pool. |
| **Cheap enough to matter** | A delegated fill costs a fraction of a cent. The product is many small automated trades, which is only a product on a chain where that is not absurd. |

## The transactions

Real, on public Base Sepolia, signed by a real Privy embedded wallet:

| | |
|---|---|
| `XorrDelegation` | [`0xb14CF3D0b5269aCDE52322218adb6d5C1daE0a4e`](https://sepolia.basescan.org/address/0xb14CF3D0b5269aCDE52322218adb6d5C1daE0a4e) |
| A user-signed grant | [`0x596f4c08…`](https://sepolia.basescan.org/tx/0x596f4c08eca02e0d4dd0928e7499c4cccad31461c35e5b98e2f5bf211595ee6d) — $1,600/day cap, 1inch router allowlisted |
| A user-signed revoke | [`0xd32d3085…`](https://sepolia.basescan.org/tx/0xd32d3085616c157d6f59c0d81a651af60d899630e5593e6ce87c0cc7e3bb4713) — the kill switch, on chain |

Fills run on a Base **mainnet fork**, because 1inch, Aqua, SwapVM and the equities are mainnet-only
and this project does not spend real money to prove a point. Everything about those fills is
genuine except that the chain is a local copy: real router, real pools, real balances.

## What a judge can run in two minutes

```bash
anvil --fork-url https://mainnet.base.org --port 8545 --chain-id 8453
npx tsx server/src/fork-bootstrap.ts <your address>   # deploys, funds, writes .env.fork
npx tsx server/src/fork-grant.ts <your address> 2000  # the owner grants the policy
npx tsx server/src/seed.ts <your address>             # real strategies, real fills, real alerts
npx tsx server/src/fork-e2e.ts WETH                   # 11 assertions, real fill
(cd contracts && forge test --fork-url https://mainnet.base.org)   # 51 tests
```

`seed.ts` is a shortcut through the clicking, not through the system: it creates strategies and
runs them through the same executor the scheduler uses, so every fill, position and audit entry it
produces is one the app made itself. Without it the first thing a judge sees is every empty state
in the product, which is an honest picture of a fresh install and a poor picture of what was built.

Then check it yourself:

```bash
curl -s "localhost:8788/verify?owner=<your address>" | jq '.passed, .failed'
```

Or open `/judge` in the app — the same 21 claims, re-run in front of you.

`fork-e2e` asserts the things that matter rather than that it did not throw: the bought token
lands in the **user's** wallet, neither contract keeps a balance, the on-chain cap decrements, and
a spend past the cap reverts.

## The user-facing case

A recurring buy is the trust on-ramp: `docs/screens/32-strategy-dca.png`. It is deliberately the
least clever thing the bot can do, because a user who has watched "buy $50 of WETH every Monday"
work for three weeks will let it run something harder, and a user shown a momentum strategy on day
one will not fund the account at all.

The permission is the product. `docs/screens/05-delegate.png` says what it can and cannot do
before you sign, and `docs/screens/38-safety.png` takes it back in one tap without our cooperation.
