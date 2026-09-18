/**
 * Chain configuration — X Layer (2026-09-18).
 *
 * X Layer is OKX's EVM chain (OP Stack since 2025-10), gas paid in OKB. The executor runs on one of:
 *
 *   xlayer          — mainnet, chain 196. Real money; starting on it needs ALLOW_MAINNET=yes.
 *   xlayer-testnet  — the public testnet, chain 1952. Contracts and wallet flows are proven here; nothing trades, because
 *                     no DEX routes on it.
 *   xlayer-fork     — an anvil fork of MAINNET (`anvil --fork-url https://rpc.xlayer.tech`). The only environment where the
 *                     whole thesis runs end to end with no real money: Circle's USDC, the wrapped xStocks and the Uniswap
 *                     v3 pools they trade in all exist there with their real state, and a fill is genuine EVM execution
 *                     against genuine pool state. Only the chain is a local copy.
 *   localnet        — an anvil copy of the testnet on this machine.
 *
 * Every address below was read on chain against X Layer's own RPC and matched to its issuer's documents (Circle for USDC,
 * OKX's token list, Uniswap's deployments page, Backed's xStocks API) on 2026-09-18. None is borrowed from another chain.
 */
import { xLayer, xLayerTestnet } from 'viem/chains';
import type { Address, Chain } from 'viem';
import 'dotenv/config';
import { KNOWN_CHAINS, isKnownChain, moneyOn, networkName, type KnownChain } from './money.js';

/** Every chain this executor knows. A chain is added in `evm/money.ts` first, saying what its money is. */
export type ChainKey = KnownChain;

// Named XORR_CHAIN, not CHAIN: Foundry auto-loads .env and treats CHAIN as its own --chain
// flag, which makes every cast/forge command in this repo fail with a confusing parse error.
const ASKED = process.env.XORR_CHAIN ?? 'localnet';

if (!isKnownChain(ASKED)) {
  throw new Error(
    `XORR_CHAIN=${ASKED} is not a chain this executor knows (${KNOWN_CHAINS.join(', ')}). ` +
      'Add it to server/src/evm/money.ts, saying what its money is, then give it an RPC and a chain in server/src/evm/chains.ts.',
  );
}
export const CHAIN_KEY: ChainKey = ASKED;

/** Guardrail: real money needs a deliberate, reviewed decision, never a default. */
if (moneyOn(CHAIN_KEY) === 'real' && process.env.ALLOW_MAINNET !== 'yes') {
  throw new Error(
    `Refusing to start against ${networkName(CHAIN_KEY)}. Set ALLOW_MAINNET=yes only with a deliberate decision.`,
  );
}

const RPCS: Record<ChainKey, string> = {
  localnet: process.env.LOCAL_RPC ?? 'http://127.0.0.1:8545',
  'xlayer-fork': process.env.FORK_RPC ?? 'http://127.0.0.1:8545',
  'xlayer-testnet': process.env.XLAYER_TESTNET_RPC ?? 'https://testrpc.xlayer.tech',
  xlayer: process.env.XLAYER_RPC ?? 'https://rpc.xlayer.tech',
};

/**
 * A fork of X Layer IS X Layer — same chain id, same deployed contracts, same everything but the node. Built from anything
 * else, viem believes the chain has no Multicall3 and refuses to batch: every balance read came back zero through a
 * `.catch`, and a funded wallet showed $0.00. So each copy takes its chain wholesale and changes only the name.
 */
const CHAINS: Record<ChainKey, Chain> = {
  localnet: { ...xLayerTestnet, name: 'X Layer testnet (local copy)' },
  'xlayer-fork': { ...xLayer, name: 'X Layer (local mainnet fork)' },
  'xlayer-testnet': xLayerTestnet,
  xlayer: xLayer,
};

export const chain = CHAINS[CHAIN_KEY];
export const rpcUrl = RPCS[CHAIN_KEY];

/**
 * Canonical addresses, per chain. A token address is a property of a chain, not of a product: where a chain does not
 * have one, it is `null` here rather than another chain's address with no code behind it.
 */
export type ChainAddresses = {
  /** Circle's native USDC — the settlement token. Not USDC.e, the bridged one OKX's own token list calls "USDC". */
  usdc: Address;
  /** Global Dollar (Paxos). Several wrapped xStocks are pooled against it rather than USDC. */
  usdg: Address | null;
  weth: Address | null;
  /** OKX's wrapped BTC on X Layer, 8 decimals. */
  btc: Address | null;
  /** Wrapped OKB, the native gas token as an ERC-20. */
  wokb: Address | null;
  /** The sentinel aggregators use for the native token (OKB here). */
  nativeToken: Address;
  /** Uniswap v3 SwapRouter02 — pulls what it is approved for, pays the recipient in its calldata. */
  uniswapRouter: Address | null;
  /** Uniswap v3 QuoterV2. */
  uniswapQuoter: Address | null;
};

const XLAYER_MAINNET = {
  usdc: '0xB6CEceAB302E2E4948951eE7843FC24E92933061',
  usdg: '0x4ae46a509F6b1D9056937BA4500cb143933D2dc8',
  weth: '0x5A77f1443D16ee5761d310e38b62f77f726bC71c',
  btc: '0xb7C00000bcDEeF966b20B3D884B98E64d2b06b4f',
  wokb: '0xe538905cf8410324e03A5A23C1c177a474D59b2b',
  nativeToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  uniswapRouter: '0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA',
  uniswapQuoter: '0xD1b797D92d87B688193A2B976eFc8D577D204343',
} as const satisfies ChainAddresses;

/** The testnet has Circle's USDC and no DEX: nothing else here was found with code behind it. */
const XLAYER_TESTNET: ChainAddresses = {
  usdc: '0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3',
  usdg: null,
  weth: null,
  btc: null,
  wokb: null,
  nativeToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  uniswapRouter: null,
  uniswapQuoter: null,
};

/** A record, so a chain added in `evm/money.ts` does not compile until it says what its addresses are. */
const ADDRESSES_BY_CHAIN: Record<ChainKey, ChainAddresses> = {
  xlayer: XLAYER_MAINNET,
  'xlayer-fork': XLAYER_MAINNET,
  'xlayer-testnet': XLAYER_TESTNET,
  localnet: XLAYER_TESTNET,
};

export const ADDRESSES = ADDRESSES_BY_CHAIN[CHAIN_KEY];

/**
 * Addresses for the chain prices are ASKED about, which is always mainnet: a quote is a question about real liquidity, and
 * the testnet has none. On the testnet prices are real mainnet prices and settlement is not possible — the fork is where
 * both halves are real at once.
 */
export const QUOTE_ADDRESSES = XLAYER_MAINNET;

/** True where the real tokens, the xStocks and their pools exist: mainnet and its fork. */
export const IS_MAINNET_STATE = CHAIN_KEY === 'xlayer' || CHAIN_KEY === 'xlayer-fork';

/**
 * The tokens a grant approves for the delegation to pull, before any equities: the one it spends and every one it may
 * have to sell. Kept to what has code on this chain, so a grant never approves an address with nothing behind it.
 */
export const APPROVABLE_TOKENS: readonly { symbol: string; address: Address }[] = [
  { symbol: 'USDC', address: ADDRESSES.usdc },
  ...(ADDRESSES.usdg ? [{ symbol: 'USDG', address: ADDRESSES.usdg }] : []),
  ...(ADDRESSES.weth ? [{ symbol: 'WETH', address: ADDRESSES.weth }] : []),
  ...(ADDRESSES.btc ? [{ symbol: 'XBTC', address: ADDRESSES.btc }] : []),
];

/**
 * Aave v3's Pool, for the yield strategy (tier 4). Aave's X Layer deployment is not verified, so the address is the Base
 * one the yield code was written against, and it is on no X Layer grant: `SETTLEMENT_VENUES` leaves it out. The yield
 * strategy is replaced or retired in the venue phase.
 */
export const AAVE_V3_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as const;

/**
 * OKX DEX on X Layer: the router a swap's `tx.to` names, and the separate approval contract it pulls the input through
 * (hence `spendVia`). Both overridable should OKX's `/supported/chain` answer change; both carry code on X Layer mainnet
 * (checked 2026-09-19).
 */
const okxAddr = (env: string | undefined, fallback: `0x${string}`): `0x${string}` =>
  env && /^0x[0-9a-fA-F]{40}$/.test(env) ? (env as `0x${string}`) : fallback;
export const OKX_DEX_ROUTER = okxAddr(process.env.OKX_DEX_ROUTER, '0x7c5bee2a8091c3ef39072f64f18fac913060aeaf');
export const OKX_DEX_APPROVE_SPENDER = okxAddr(process.env.OKX_APPROVE_SPENDER, '0x8b773D83bc66Be128c60e07E17C8901f7a64F000');

/**
 * Every contract the delegation is allowed to call, for this chain — one list, read by the grant the user signs AND by
 * the screen that shows them what they granted. A venue a chain does not have is left out rather than granted against
 * an address with no code: permission to call nothing is harmless, but it is a claim on the safety screen that is not
 * true, and that screen has to be exactly true.
 *
 * OKX DEX is on the list wherever mainnet state is (mainnet and its fork) whether or not this deployment holds an API
 * key: the contracts exist either way, and a grant signed before the key arrives must not have to be signed again.
 */
export const SETTLEMENT_VENUES: readonly `0x${string}`[] = [
  ...(ADDRESSES.uniswapRouter ? [ADDRESSES.uniswapRouter] : []),
  ...(IS_MAINNET_STATE ? [OKX_DEX_ROUTER, OKX_DEX_APPROVE_SPENDER] : []),
];

/** Where each chain shows a transaction. A record, so a chain added later says where, or does not compile. */
const EXPLORER_TX: Record<ChainKey, (hash: string) => string> = {
  // A fork shares mainnet's history up to the fork block, so an explorer link is right for a pre-fork tx and wrong for one
  // we just mined. Label it rather than link to a page that does not exist.
  'xlayer-fork': (hash) => `fork:${hash}`,
  xlayer: (hash) => `https://www.oklink.com/xlayer/tx/${hash}`,
  'xlayer-testnet': (hash) => `https://www.oklink.com/xlayer-test/tx/${hash}`,
  localnet: (hash) => `local:${hash}`,
};

export function explorerTx(hash: string): string {
  return EXPLORER_TX[CHAIN_KEY](hash);
}
