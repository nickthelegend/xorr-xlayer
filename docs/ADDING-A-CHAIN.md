# Adding a chain

xorr runs one deployment per chain: an executor (`server/`) set to that chain, the app built against that executor, and
two contracts on the chain. Networks (`/networks`) lists every deployment the app knows. This is what adding one takes,
in order.

## 1. Name it, and say what its money is

The first three places are records keyed by chain, so a chain missing from any of them does not compile.

| Where | What |
| --- | --- |
| `server/src/evm/money.ts` | The key, what its money is, and its name in a sentence. Money is `real` (a mainnet), `test` (a public test network) or `copy` (a local anvil copy of another chain). On `real` there is no faucet and no gas drip, and the executor starts only with `ALLOW_MAINNET=yes`. A key missing here is refused when the executor starts. |
| `server/src/evm/chains.ts` | Its RPC (`RPCS`, read from an env var you name), its viem chain (`CHAINS`), its token addresses (`ADDRESSES_BY_CHAIN`) and where it shows a transaction (`EXPLORER_TX`). |
| `src/chain.ts` | The key in `ChainKey` and `MONEY` (the same word the executor uses), its viem chain (`CHAINS`) and its label (`LABELS`). A key missing here is refused when the app is built. |
| `src/networks/deployments.ts` | A row in `DEPLOYMENTS`: key, name, chain id, the executor's URL, explorer, and whether it is a test network. Networks and Network read it. |
| `app/network.tsx` | A sentence in `CHAIN_NOTE` saying what the chain means for what the app can do. |

## 2. Deploy

1. The delegation, from `contracts/`: `SETTLEMENT_TOKEN=<the chain's USDC> forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast`, signed with your deployer's key. It refuses a settlement token with no code on the chain.
2. The audit anchor: `forge script script/DeployAnchor.s.sol --rpc-url <rpc> --broadcast`.
3. The executor, with `XORR_CHAIN=<key>`, the RPC variable named in `RPCS`, `DELEGATION_ADDRESS` and `ANCHOR_ADDRESS`. Set `AQUA_BOOK_ADDRESS` and `SWAPVM_BOOK_ADDRESS` only where those books are deployed.
4. The web app, with `scripts/build-web.mjs` against that executor. It takes the chain from the executor's `/health`, and pins the delegation contract only once the executor, the deployment record and the chain agree.

## 3. What is still Base-only

These read Base's products or chain ids directly. On a new chain, each gets that chain's equivalent or is switched off there.

| Where | What it assumes |
| --- | --- |
| `server/src/evm/chains.ts` | `ONEINCH_CHAIN_ID` (8453) and `QUOTE_ADDRESSES`: every 1inch quote is asked about Base mainnet. `IS_BASE_MAINNET_STATE`: where the tokenized equities and Aqua exist. `AAVE_V3_POOL`: Aave on Base. |
| `server/src/venues/oneinch.ts` | `CAN_SETTLE`: swaps fill only on `base` and `base-fork`. |
| `server/src/evm/gas-price.ts`, `server/src/evm/allowances.ts`, `server/src/routes/tokens.ts`, `server/src/routes/history.ts` | 1inch's own APIs when the key is `base`, and the chain's RPC otherwise. |
| `server/src/routes/privy.ts`, `server/src/verify/checks.ts` | The chain id is 84532 on Base Sepolia and 8453 on anything else. |
| `server/src/market/yield.ts`, `src/wallet/withdrawEverything.ts` | Aave v3 on Base. |
| `server/src/venues/stocks.ts` | The tokenized equities' addresses on Base. |
| `server/src/evm/basename.ts` | Basenames. |
| `server/src/evm/faucet.ts` | Test USDC comes from a faucet key on Base Sepolia, and from a holder on an anvil copy. |
| `server/src/graph/client.ts`, `src/data/subgraph.ts`, `subgraph/subgraph.yaml`, `subgraph-aqua/subgraph.yaml` | The subgraphs index Base Sepolia (the delegation) and Base (Aqua). |
| `server/src/venues/fusion-plus.ts` | Cross-chain quotes start from Base. |
| `scripts/build-web.mjs` | A fork build must answer chain 8453, from anvil. |

## 4. Prove it

- `/health` on the new executor names the chain and the commit it runs.
- `tools/prove-contract-refusals.ts`, with `PROOF_EXECUTOR`, `PROOF_RPC` and `PROOF_LOCAL_RPC` (an anvil forked from the chain): the delegation and the anchor refuse what they must, as deployed (docs/TESTPLAN.md C04–C11). Nothing in it is chain-specific.
- `tools/qa-full.mjs` against the executor. It knows `base-fork` and `base-sepolia` (`QA_EXPECT_CHAIN`); the values a check expects for a chain, such as its USDC address, are added beside theirs.
- `tools/web-sweep.mjs` against the web build.
