# Going live on Base mainnet

Everything in this build already targets Base. `base-fork` spreads `{...base}` — same chain id
(8453), same contracts, same token addresses, same 1inch router, same Aave pool. The fork is not an
approximation of Base; it *is* Base, served by a local node. So "make it work on Base" was mostly
already true, and the remaining work is the part that spends money.

## Verified against the live chain

`npm run readiness:base --prefix server` asks Base mainnet the questions the executor will ask it.
It signs nothing, sends nothing and holds no key, so it costs nothing but RPC calls.

Last run — **17 ok, 1 blocking, 1 warning**:

| | |
|---|---|
| chain | id 8453, block 51,054,818 |
| tokens | WETH, USDC, cbBTC and all eight tokenized equities answer `decimals()` at the registered addresses |
| 1inch router | 24,151 bytes at `0x11111112…` |
| Aave v3 pool | 1,933 bytes at `0xA238Dd80…` |
| Aave USDC rate | 4.08%, read live from `currentLiquidityRate` |
| 1inch route | 100 USDC → 0.040118 WETH via Tesseraswap, Aerodrome V3 |
| explorer | `https://basescan.org/tx/…` |

Everything the product depends on exists on Base mainnet and answers correctly, right now.

## The one blocker

**`XorrDelegation` is not deployed to Base mainnet.** Without it there is no permission to grant and
nothing can trade.

This is deliberately not automated. It spends real ETH, it is irreversible, and the address it
produces becomes the thing users sign permissions against.

It is also blocked on funding: the deployer `0x364d7Bbc139541e0e37450D527ae154B5C292581` holds
**0 ETH on Base mainnet**. Send it gas first — a deployment of this size costs well under a dollar
on Base, but zero is zero.

Then:

```bash
cd contracts
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_RPC" --broadcast --private-key "$(cat ../.keys/deployer.key)"
```

Take the printed address and set it in both places, because the app and the executor each need it:

```
DELEGATION_ADDRESS=0x…
EXPO_PUBLIC_DELEGATION_ADDRESS=0x…
XORR_CHAIN=base
ALLOW_MAINNET=yes
```

Re-run the readiness check. It should come back with zero blocking.

## The warning, and why it matters more than it looks

`BASE_RPC` is `https://mainnet.base.org`, the free public endpoint. It throttles after a short
burst — the readiness check originally rate-limited *itself* from its sixth call onward and
reported real, deployed tokens as unreachable.

The check now batches through Multicall3, which is how the app reads balances too, so it fits. But
an executor serving screens does many more reads than this, and on the public endpoint a busy
moment will surface as prices that will not load. **Set a dedicated provider before launch.** Any
of Alchemy, QuickNode or Base's own paid tier; the variable is already `BASE_RPC` and nothing else
changes.

## What `ALLOW_MAINNET` is for

`server/src/evm/chains.ts` refuses to boot on `base` unless `ALLOW_MAINNET=yes`. That guard is not
ceremony — every other environment in this repo is safe to point anything at, and this one moves
real money. Leave it out of any `.env` that gets copied around, and set it only on the deployment
that is meant to be live.

## Building the app for Base

```bash
EXPO_PUBLIC_API_URL=https://your-base-executor npm run build:base
```

Not `expo export`. That command produces a perfectly valid build for the *wrong* chain: the client
reads `EXPO_PUBLIC_XORR_CHAIN`, falls back to `base-sepolia`, and that variable is not in `.env` —
so the obvious command yields a Sepolia bundle pointing at `http://localhost:8788`, which looks
exactly like a successful production build and is not one. It works perfectly on the machine that
built it, which is what makes it ship.

So `build:base` refuses rather than documents. Before building it checks that an executor URL is
set, that it is not localhost, and — by asking `/health` — that the executor actually settles on
`base`. A Base app wired to a Sepolia executor is the mistake worth catching: both halves work,
they simply disagree about which chain the money is on.

Afterwards it checks the artifact rather than the intent. `chainLabel` folds to a literal at minify
time, so a Base bundle contains "settles on Base" and a Sepolia one does not — an environment
variable that was set and then ignored produces the same console output as one that worked, and
only the output tells you which happened.

A verified Base bundle was produced this way; the `dist-base/` it writes is gitignored.

## What does not change

Nothing else. No code path is testnet-only, no address is hardcoded to a fork, and
`explorerTx` already returns basescan URLs on `base` — the same function returns a `fork:` label on
the fork precisely so a link never 404s and makes a real transaction look fabricated.
