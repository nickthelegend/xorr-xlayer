/**
 * Convert USDT0 to USDC — a swap the PERSON signs (PLAN.md P4.12, owner decision D16).
 *
 * The executor settles in USDC, and the permission it holds only spends USDC. USDT0 arrives because it is what OKX
 * withdraws on X Layer, so turning it into USDC is the owner's own action, from their own wallet: never the agent's, and
 * never automatic — a yield strategy may hold USDT0 on purpose.
 *
 * Everything the wallet is asked to sign is built HERE, from constants this build carries: the token contracts, Uniswap's
 * SwapRouter02 and the 0.01% USDT0/USDC pool. The executor contributes only a quote, and a quote cannot move the floor
 * below `MIN_RATE` — both sides are dollars, so a quote far from one is refused rather than signed.
 *
 *   1. `approve(router, amount)` on USDT0, only when the allowance is short of the amount.
 *   2. SwapRouter02 `exactInput` along USDT0 → (0.01%) → USDC, paying the owner, with the floor as `amountOutMinimum`.
 */
import { encodeFunctionData, encodePacked, formatUnits, parseAbi, type Address, type Hex } from 'viem';
import { STABLE_DECIMALS, USDC_MAINNET, USDT0_MAINNET, hasMainnetState, type DepositChainKey } from './stablecoins';

/** Uniswap v3 SwapRouter02 on X Layer mainnet — the router every xorr trade settles through (`server/src/evm/chains.ts`). */
export const SWAP_ROUTER_02: Address = '0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA';
/** The USDT0/USDC pool's fee tier: 100 = 0.01%. */
export const USDT0_USDC_FEE = 100;
/** The tolerance the quote is asked at. A 0.01% stable pool; 0.3% is room for the block to move, not for a bad price. */
export const CONVERT_SLIPPAGE_PCT = 0.3;
/** The least USDC one USDT0 may deliver, whatever a quote says. Below this the conversion is refused, not signed. */
export const MIN_RATE = 0.97;

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);

/** The same ABI the executor encodes (`server/src/venues/uniswap.ts`): this router's struct has no deadline. */
const ROUTER_ABI = parseAbi([
  'struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }',
  'function exactInput(ExactInputParams params) payable returns (uint256 amountOut)',
]);

export { ERC20_ABI as CONVERT_ERC20_ABI };

/** A conversion is possible where the tokens and the pool are: X Layer mainnet and its fork. */
export function canConvert(chain: DepositChainKey): boolean {
  return hasMainnetState(chain);
}

/** One transaction for the wallet to sign. */
export type Call = { to: Address; data: Hex };

/**
 * The least USDC the swap may deliver, in base units, from a quote's `minimumOut`.
 *
 * Rounded down, so the floor is never above what the quote allowed; and never below `MIN_RATE` of what is paid — a quote
 * that would allow less is an error here, not a signature.
 */
export function floorFromQuote(amountInRaw: bigint, minimumOut: number): bigint {
  if (amountInRaw <= 0n) throw new Error('There is no USDT0 to convert.');
  if (!Number.isFinite(minimumOut) || minimumOut <= 0) throw new Error('The quote gave no minimum, so nothing was signed.');
  const [whole, fraction = ''] = minimumOut.toFixed(STABLE_DECIMALS + 2).split('.');
  const floor = BigInt(`${whole}${fraction.slice(0, STABLE_DECIMALS)}`);
  const least = (amountInRaw * BigInt(Math.round(MIN_RATE * 10_000))) / 10_000n;
  if (floor < least) {
    throw new Error(
      `The quote would accept ${formatUnits(floor, STABLE_DECIMALS)} USDC for ${formatUnits(amountInRaw, STABLE_DECIMALS)} USDT0 — too far from a dollar, so nothing was signed.`,
    );
  }
  return floor;
}

/** The approval, when the router's allowance is short of the amount. Exactly the amount: this is not a standing grant. */
export function approvalFor(allowance: bigint, amountInRaw: bigint): Call | null {
  if (allowance >= amountInRaw) return null;
  return {
    to: USDT0_MAINNET,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [SWAP_ROUTER_02, amountInRaw] }),
  };
}

/** Uniswap's packed path for the one pool: USDT0, fee, USDC. */
export const USDT0_TO_USDC_PATH: Hex = encodePacked(
  ['address', 'uint24', 'address'],
  [USDT0_MAINNET, USDT0_USDC_FEE, USDC_MAINNET],
);

/** The swap itself: exactly `amountInRaw` USDT0 in, at least `minOutRaw` USDC out, paid to the owner. */
export function swapCall(params: { owner: Address; amountInRaw: bigint; minOutRaw: bigint }): Call {
  if (params.amountInRaw <= 0n) throw new Error('There is no USDT0 to convert.');
  if (params.minOutRaw <= 0n) throw new Error('A conversion needs a floor above zero.');
  return {
    to: SWAP_ROUTER_02,
    data: encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'exactInput',
      args: [
        {
          path: USDT0_TO_USDC_PATH,
          recipient: params.owner,
          amountIn: params.amountInRaw,
          amountOutMinimum: params.minOutRaw,
        },
      ],
    }),
  };
}

/** Every transaction the conversion needs, in order: the approval where one is missing, then the swap. */
export function conversionCalls(params: {
  owner: Address;
  allowance: bigint;
  amountInRaw: bigint;
  minOutRaw: bigint;
}): Call[] {
  const approval = approvalFor(params.allowance, params.amountInRaw);
  return [...(approval ? [approval] : []), swapCall(params)];
}

/** A rate in words: "1 USDT0 = 0.9998 USDC". */
export function rateText(amountIn: number, amountOut: number): string {
  if (!(amountIn > 0) || !(amountOut > 0)) return '—';
  return `1 USDT0 = ${(amountOut / amountIn).toFixed(4)} USDC`;
}
