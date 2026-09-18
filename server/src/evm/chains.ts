/**
 * Chain configuration.
 *
 * Base is the target: 1inch routes there, and the same deployment is what goes to Base Build Camp.
 * `localnet` is an anvil fork of Base Sepolia — a real EVM running real contracts, so enforcement
 * is genuinely proven without waiting on a faucet.
 *
 * `base-fork` is an anvil fork of Base MAINNET. It is the only environment where the whole thesis
 * can actually run end to end: the real 1inch router, real USDC, real Aave, and the real Ondo
 * tokenized equities all exist there with real liquidity, and none of them exist on Sepolia. Fills
 * are genuine EVM execution against genuine pool state — the only thing that is not real is that
 * the chain is a local copy.
 */
import { base, baseSepolia, foundry } from 'viem/chains';
import type { Chain } from 'viem';
import 'dotenv/config';
import { KNOWN_CHAINS, isKnownChain, moneyOn, networkName, type KnownChain } from './money.js';
import { isSolanaCluster } from '../solana/clusters.js';

/** Every chain this executor knows. A chain is added in `evm/money.ts` first, saying what its money is. */
export type ChainKey = KnownChain;

// Named XORR_CHAIN, not CHAIN: Foundry auto-loads .env and treats CHAIN as its own --chain
// flag, which makes every cast/forge command in this repo fail with a confusing parse error.
const ASKED = process.env.XORR_CHAIN ?? 'localnet';

/*
 * When XORR_CHAIN is a Solana cluster (PLAN.md §0.2), EVM chains are inactive.
 * For any unknown chain outside of Solana, refuse start.
 */
if (isSolanaCluster(ASKED)) {
  // Active chain is Solana. EVM chain definitions fall back to localnet as a stub.
} else if (!isKnownChain(ASKED)) {
  throw new Error(
    `XORR_CHAIN=${ASKED} is not a chain this executor knows (${KNOWN_CHAINS.join(', ')}). ` +
      'Add it to server/src/evm/money.ts, saying what its money is, then give it an RPC and a chain in server/src/evm/chains.ts.',
  );
}
export const CHAIN_KEY: ChainKey = isKnownChain(ASKED) ? ASKED : 'localnet';

/** Guardrail: real money needs a deliberate, reviewed decision, never a default. */
if (moneyOn(CHAIN_KEY) === 'real' && process.env.ALLOW_MAINNET !== 'yes') {
  throw new Error(
    `Refusing to start against ${networkName(CHAIN_KEY)}. Set ALLOW_MAINNET=yes only with a deliberate decision.`,
  );
}

const RPCS: Record<ChainKey, string> = {
  localnet: process.env.LOCAL_RPC ?? 'http://127.0.0.1:8545',
  'base-fork': process.env.FORK_RPC ?? 'http://127.0.0.1:8545',
  'base-sepolia': process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org',
  base: process.env.BASE_RPC ?? 'https://mainnet.base.org',
};

const CHAINS: Record<ChainKey, Chain> = {
  localnet: { ...foundry, id: baseSepolia.id, name: 'Base Sepolia (local fork)' },
  /*
   * A fork of Base IS Base — same chain id, same deployed contracts, same everything but the
   * node. Spreading `foundry` first and only overriding the id kept foundry's empty `contracts`,
   * so viem believed the chain had no Multicall3 and refused to batch. The whole balance read came
   * back as zero through a `.catch`, and the home screen showed $0.00 for a funded wallet.
   *
   * So: take Base wholesale and change only the RPC.
   */
  'base-fork': { ...base, name: 'Base (local mainnet fork)' },
  'base-sepolia': baseSepolia,
  base,
};

export const chain = CHAINS[CHAIN_KEY];
export const rpcUrl = RPCS[CHAIN_KEY];

/** The chain id 1inch is asked about. A local fork of Base Sepolia still quotes against Base. */
export const ONEINCH_CHAIN_ID = 8453;

/**
 * Canonical addresses, per chain.
 *
 * These used to be a single flat object of Base MAINNET addresses used on every network. On Base
 * Sepolia that meant the app asked for the balance of a USDC contract that does not exist there,
 * got back `0x`, and the whole delegation flow died on a decode error before the user could sign
 * anything. A token address is a property of a chain, not of a product.
 *
 * Circle deploys USDC to a different address on Sepolia; WETH is at the same predeploy on both.
 * cbBTC and the tokenized equities are mainnet-only, and are absent here rather than pointed at an
 * address with no code — code that reads them must handle absence, not discover it at runtime.
 */
const BASE_MAINNET_ADDRESSES = {
  /** 1inch Aggregation Router v6 — the same address across every chain it supports. */
  oneInchRouter: '0x111111125421cA6dc452d289314280a0f8842A65',
  usdcBase: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  wethBase: '0x4200000000000000000000000000000000000006',
  /** Coinbase Wrapped BTC on Base — 8 decimals, the Base-native way to hold BTC exposure. */
  cbbtcBase: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  /** 1inch's sentinel for native ETH. */
  nativeEth: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
} as const;

const BASE_SEPOLIA_ADDRESSES = {
  // 1inch does not run on Sepolia. The address is kept so the venue allowlist has a stable shape;
  // nothing routes there on a testnet, and the executor's own tests use the fork for real fills.
  oneInchRouter: '0x111111125421cA6dc452d289314280a0f8842A65',
  /** Circle's USDC on Base Sepolia — a different deployment from mainnet. */
  usdcBase: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  /** WETH is the same predeploy on every OP-stack chain. */
  wethBase: '0x4200000000000000000000000000000000000006',
  cbbtcBase: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  nativeEth: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
} as const;

/**
 * Addresses for the chain the executor SETTLES on. Follows XORR_CHAIN.
 *
 * A record rather than "Sepolia's, else mainnet's": that fallback would have handed a chain added later Base mainnet's
 * token addresses, where they have no code. A chain added in `evm/money.ts` does not compile until it has a row here.
 */
const ADDRESSES_BY_CHAIN: Record<ChainKey, typeof BASE_MAINNET_ADDRESSES | typeof BASE_SEPOLIA_ADDRESSES> = {
  base: BASE_MAINNET_ADDRESSES,
  'base-fork': BASE_MAINNET_ADDRESSES,
  'base-sepolia': BASE_SEPOLIA_ADDRESSES,
  // What it read before this was a record: only Base Sepolia had a table of its own.
  localnet: BASE_MAINNET_ADDRESSES,
};

export const ADDRESSES = ADDRESSES_BY_CHAIN[CHAIN_KEY];

/**
 * The tokens a grant approves for the delegation to pull, before any equities: the one it spends and every one it may
 * have to sell. `/delegation/params` hands the app's grant this list, kept to what has code on the chain, and the fork's
 * grant script approves the same one. That script had a shorter list of its own, so a demo wallet a swap had bought into
 * cbBTC could not be sold out of it: the panic flatten's cbBTC leg reverted with SafeTransferFromFailed (2026-09-15).
 */
export const APPROVABLE_TOKENS: readonly { symbol: string; address: `0x${string}` }[] = [
  { symbol: 'USDC', address: ADDRESSES.usdcBase },
  { symbol: 'WETH', address: ADDRESSES.wethBase },
  { symbol: 'CBBTC', address: ADDRESSES.cbbtcBase },
];

/**
 * Addresses for the chain 1inch is ASKED about, which is always Base mainnet.
 *
 * These are two different things and conflating them is a real bug: 1inch has no deployment or
 * liquidity on Sepolia, so `ONEINCH_CHAIN_ID` is pinned to 8453 and every quote is a mainnet
 * question. Handing it a Sepolia token address makes it 400 on a token that chain has never heard
 * of — which is exactly what happened when the routing registry started following XORR_CHAIN.
 *
 * On a testnet the consequence is honest and worth stating: prices are real mainnet prices, and
 * settlement is not possible. The fork is where both halves are real at once.
 */
export const QUOTE_ADDRESSES = BASE_MAINNET_ADDRESSES;

/** True where the tokenized equities and Aqua actually exist. */
export const IS_BASE_MAINNET_STATE = CHAIN_KEY === 'base' || CHAIN_KEY === 'base-fork';

/** Aave v3 Pool on Base. Not deployed at this address on Base Sepolia. */
export const AAVE_V3_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as const;

/**
 * Every contract the delegation is allowed to call, for this chain.
 *
 * One list, read by the grant the user signs AND by the screen that shows them what they granted.
 * They were separate literals, both spelling out the 1inch router, which was fine only for as long
 * as there was exactly one venue: the moment tier 4 needed the Aave Pool, a grant that included it
 * and a safety screen that did not would have disagreed about what the user had actually allowed.
 *
 * Aave is left out where it has no deployment rather than granted against an address with no code.
 * Permission to call nothing is not dangerous, but it is a claim on the safety screen that is not
 * true, and this screen is the one that has to be exactly true.
 */
/**
 * Our Aqua book, when one is deployed. A venue the bot may fill against has to be on the list the
 * user signed, or `spend()` refuses it — which is the contract doing its job, and was going to be
 * the first thing an Aqua fill hit.
 */
const AQUA_BOOK = process.env.AQUA_BOOK_ADDRESS;
/**
 * Our SwapVM book, when one is deployed (PLAN.md 3.1).
 *
 * Settlement already tries it ahead of the aggregator, and `spend()` refuses any venue the user did not
 * sign for — so a grant made through the app, which is built from this list, could never reach it. The only
 * grant that ever named the book was the hand-written one in `live-swapvm.ts`.
 */
const SWAPVM_BOOK = process.env.SWAPVM_BOOK_ADDRESS;
const isAddress = (a: string | undefined): a is `0x${string}` => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);

export const SETTLEMENT_VENUES: readonly `0x${string}`[] = [
  ADDRESSES.oneInchRouter,
  ...(IS_BASE_MAINNET_STATE ? [AAVE_V3_POOL] : []),
  ...(isAddress(AQUA_BOOK) ? [AQUA_BOOK] : []),
  ...(isAddress(SWAPVM_BOOK) ? [SWAPVM_BOOK] : []),
];

/** Where each chain shows a transaction. A record, so a chain added later says where, or does not compile. */
const EXPLORER_TX: Record<ChainKey, (hash: string) => string> = {
  // A fork shares mainnet's history up to the fork block, so an explorer link is right for a
  // pre-fork tx and wrong for one we just mined. Label it rather than link to a 404.
  'base-fork': (hash) => `fork:${hash}`,
  base: (hash) => `https://basescan.org/tx/${hash}`,
  'base-sepolia': (hash) => `https://sepolia.basescan.org/tx/${hash}`,
  localnet: (hash) => `local:${hash}`,
};

export function explorerTx(hash: string): string {
  return EXPLORER_TX[CHAIN_KEY](hash);
}
