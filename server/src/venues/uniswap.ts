/**
 * Uniswap v3 on X Layer — the venue every xorr trade settles through (2026-09-19).
 *
 * The wrapped xStocks, XBTC and WOKB all trade in Uniswap v3 pools on X Layer; 1inch, the Base build's venue, does not run
 * here. Two jobs, the same two the 1inch client had, with the same signatures so the executor's callers did not change:
 *
 *   `quote`     — what the person is shown before they commit. QuoterV2 `quoteExactInput`, read with `eth_call`.
 *   `buildSwap` — the calldata `XorrDelegation` forwards: SwapRouter02 `exactInput`, paying the OWNER (never the contract,
 *                 which must hold nothing between trades), with an output floor the contract also enforces.
 *
 * Quotes are read from the chain the executor settles on when that chain has the pools (mainnet, or a fork of it, where
 * the pools are the fork's own state — the price is the price a fill would get). On the testnet, which has no pools, a
 * quote is a mainnet question, asked of mainnet: prices are real there and nothing settles.
 */
import { createPublicClient, encodeFunctionData, encodePacked, http, parseAbi, type Address, type Hex } from 'viem';
import { xLayer } from 'viem/chains';
import { ADDRESSES, CHAIN_KEY, IS_MAINNET_STATE, QUOTE_ADDRESSES } from '../evm/chains.js';
import { priceOf } from '../market/prices.js';
import {
  CAN_SETTLE,
  DEFAULT_SLIPPAGE_PCT,
  SETTLEMENT_SYMBOL,
  TOKENS,
  canonicalSymbol,
  routeLabel,
  type SwapCalldata,
  type SwapQuote,
} from './tokens.js';

export type { SwapCalldata, SwapQuote } from './tokens.js';

export const VENUE_NAME = 'Uniswap v3';

const QUOTER_ABI = parseAbi([
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);

/** SwapRouter02's `exactInput` — no deadline in this router's struct; the contract's floor and the tx bound the trade. */
export const ROUTER_ABI = parseAbi([
  'struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }',
  'function exactInput(ExactInputParams params) payable returns (uint256 amountOut)',
]);

/** The client quotes are read from. See the file header. */
let quoteClient: ReturnType<typeof createPublicClient> | undefined;
async function quoter() {
  if (IS_MAINNET_STATE) {
    const { publicClient } = await import('../evm/client.js');
    return publicClient;
  }
  quoteClient ??= createPublicClient({ chain: xLayer, transport: http(process.env.XLAYER_RPC ?? 'https://rpc.xlayer.tech') });
  return quoteClient;
}

/** Tokens and fees from `from` to `to`, as the list Uniswap's path encodes. Throws where either side has no pool. */
export function routeBetween(from: string, to: string): { tokens: string[]; fees: number[] } {
  const a = TOKENS[from];
  const b = TOKENS[to];
  if (!a || !b) throw new Error(`No route for ${from} -> ${to}`);
  if (a.toUsdc === null) throw new Error(`No route for ${from} -> ${to}: ${from} has no pool with liquidity on X Layer`);
  if (b.toUsdc === null) throw new Error(`No route for ${from} -> ${to}: ${to} has no pool with liquidity on X Layer`);

  // from → … → USDC
  const tokens = [from, ...a.toUsdc.map((h) => h.via)];
  const fees = a.toUsdc.map((h) => h.fee);
  // USDC → … → to, which is `to`'s route reversed.
  const back = [to, ...b.toUsdc.map((h) => h.via)].reverse();
  const backFees = b.toUsdc.map((h) => h.fee).reverse();
  tokens.push(...back.slice(1));
  fees.push(...backFees);

  /*
   * Collapse a detour through USDC that returns to where it came from: NVDAx → USDG → USDC → USDG → SPYx is NVDAx → USDG
   * → SPYx. Two stable swaps that cancel out would cost fees and slippage for nothing.
   */
  for (let i = 1; i + 1 < tokens.length; ) {
    if (tokens[i] === SETTLEMENT_SYMBOL && tokens[i - 1] === tokens[i + 1]) {
      tokens.splice(i, 2);
      fees.splice(i - 1, 2);
      i = Math.max(1, i - 1);
    } else {
      i += 1;
    }
  }
  if (tokens.length < 2 || fees.length !== tokens.length - 1) throw new Error(`No route for ${from} -> ${to}`);
  if (tokens.length === 2 && tokens[0] === tokens[1]) throw new Error(`No route for ${from} -> ${to}: same token`);
  return { tokens, fees };
}

/** Uniswap's packed path: token, fee, token, fee, token… */
export function encodePath(route: { tokens: string[]; fees: number[] }): Hex {
  const types: ('address' | 'uint24')[] = [];
  const values: (Address | number)[] = [];
  route.tokens.forEach((sym, i) => {
    types.push('address');
    values.push(TOKENS[sym]!.address);
    if (i < route.fees.length) {
      types.push('uint24');
      values.push(route.fees[i]!);
    }
  });
  return encodePacked(types, values);
}

function scale(amount: number, decimals: number): bigint {
  // Through a fixed-point string: `amount * 10 ** 18` loses precision past 2^53.
  const [whole, frac = ''] = amount.toFixed(decimals).split('.');
  return BigInt(whole + frac.padEnd(decimals, '0').slice(0, decimals));
}
function unscale(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

async function quoteRaw(path: Hex, amountIn: bigint): Promise<{ amountOut: bigint; gasEstimate: bigint }> {
  const client = await quoter();
  const address = (IS_MAINNET_STATE ? ADDRESSES.uniswapQuoter : QUOTE_ADDRESSES.uniswapQuoter) as Address;
  const { result } = await client.simulateContract({
    address,
    abi: QUOTER_ABI,
    functionName: 'quoteExactInput',
    args: [path, amountIn],
  });
  return { amountOut: result[0], gasEstimate: result[3] };
}

export async function quote(params: {
  inSymbol: string;
  outSymbol: string;
  amount: number;
  slippagePct?: number;
  /** Skip the price-impact cross-check — what makes this quote safe to call FROM a price (see `stocks.ts`). */
  skipPriceImpact?: boolean;
}): Promise<SwapQuote> {
  const inSymbol = canonicalSymbol(params.inSymbol);
  const outSymbol = canonicalSymbol(params.outSymbol);
  const from = TOKENS[inSymbol];
  const to = TOKENS[outSymbol];
  if (!from || !to) throw new Error(`No route for ${params.inSymbol} -> ${params.outSymbol}`);
  if (!(params.amount > 0)) throw new Error('A quote needs an amount above zero');

  const route = routeBetween(inSymbol, outSymbol);
  const slippagePct = params.slippagePct ?? DEFAULT_SLIPPAGE_PCT;
  const { amountOut, gasEstimate } = await quoteRaw(encodePath(route), scale(params.amount, from.decimals));
  if (amountOut <= 0n) throw new Error(`No liquidity for ${inSymbol} -> ${outSymbol} at this size`);
  const outAmount = unscale(amountOut, to.decimals);
  const venues = [VENUE_NAME];

  return {
    priceImpactPct: params.skipPriceImpact ? null : await priceImpact(inSymbol, outSymbol, params.amount, outAmount),
    inSymbol,
    outSymbol,
    inAmount: params.amount,
    outAmount,
    minimumOut: outAmount * (1 - slippagePct / 100),
    slippagePct,
    venues,
    estimatedGas: gasEstimate > 0n ? Number(gasEstimate) : undefined,
    route: route.tokens.length > 2 ? `${VENUE_NAME} via ${route.tokens.slice(1, -1).join(', ')}` : routeLabel(venues),
  };
}

/**
 * Price impact, measured rather than asserted: the gap between the rate this size gets and the market's mid from the
 * same feed every screen uses. Where either leg has no independent price the answer is `null` — returning 0 would claim
 * a free trade.
 */
async function priceImpact(inSymbol: string, outSymbol: string, inAmount: number, outAmount: number): Promise<number | null> {
  if (!(inAmount > 0) || !(outAmount > 0)) return null;
  const [inUsd, outUsd] = await Promise.all([
    priceOf(inSymbol, 4_000).catch(() => 0),
    priceOf(outSymbol, 4_000).catch(() => 0),
  ]);
  if (!(inUsd > 0) || !(outUsd > 0)) return null;
  const atMid = (inAmount * inUsd) / outUsd;
  if (!(atMid > 0)) return null;
  const impact = ((atMid - outAmount) / atMid) * 100;
  return Number.isFinite(impact) ? Math.max(0, impact) : null;
}

/**
 * The calldata for a real swap.
 *
 * `from` is the address holding the tokens when it executes — the delegation contract, which pulls the owner's funds and
 * calls the router in one transaction, having approved the router for exactly this amount. `receiver` is where the bought
 * tokens land, and it is the OWNER: the router pays `recipient`, so nothing piles up in the contract.
 */
export async function buildSwap(params: {
  inSymbol: string;
  outSymbol: string;
  amount: number;
  /** The exact input in the token's own units, when the caller has it from the chain — a sale of a whole balance. */
  amountRaw?: bigint;
  from: Address;
  receiver: Address;
  slippagePct?: number;
}): Promise<SwapCalldata> {
  if (!CAN_SETTLE) {
    throw new Error(
      `Cannot fill on ${CHAIN_KEY}: no Uniswap pools there. Prices are real (quoted against X Layer mainnet); ` +
        'settlement needs XORR_CHAIN=xlayer-fork or xlayer.',
    );
  }
  const inSymbol = canonicalSymbol(params.inSymbol);
  const outSymbol = canonicalSymbol(params.outSymbol);
  const src = TOKENS[inSymbol];
  const dst = TOKENS[outSymbol];
  if (!src || !dst) throw new Error(`No route for ${params.inSymbol} -> ${params.outSymbol}`);

  const route = routeBetween(inSymbol, outSymbol);
  const path = encodePath(route);
  const amountIn = params.amountRaw ?? scale(params.amount, src.decimals);
  if (amountIn <= 0n) throw new Error('A swap needs an amount above zero');
  const slippagePct = params.slippagePct ?? DEFAULT_SLIPPAGE_PCT;

  const { amountOut } = await quoteRaw(path, amountIn);
  const minOut = (amountOut * BigInt(Math.floor((1 - slippagePct / 100) * 1_000_000))) / 1_000_000n;
  if (minOut <= 0n) throw new Error(`The ${inSymbol} -> ${outSymbol} route delivers nothing at this size`);

  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'exactInput',
    args: [{ path, recipient: params.receiver, amountIn, amountOutMinimum: minOut }],
  });
  return { to: ADDRESSES.uniswapRouter as Address, data, value: '0', minOut };
}
