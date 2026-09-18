/**
 * USDT0 to USDC, signed by the person (PLAN.md P4.12): exactly what the wallet is asked to sign.
 */
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, parseAbi, type Address } from 'viem';
import {
  SWAP_ROUTER_02,
  USDT0_TO_USDC_PATH,
  approvalFor,
  canConvert,
  conversionCalls,
  floorFromQuote,
  rateText,
  swapCall,
} from './convert';
import { USDC_MAINNET, USDT0_MAINNET } from './stablecoins';

const OWNER: Address = '0x95A0b368588713011a15f4b1041423f31B08e615';
const ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }',
  'function exactInput(ExactInputParams params) payable returns (uint256 amountOut)',
]);

describe('canConvert', () => {
  it('is only where the pool is: mainnet and its fork', () => {
    expect(canConvert('xlayer')).toBe(true);
    expect(canConvert('xlayer-fork')).toBe(true);
    expect(canConvert('xlayer-testnet')).toBe(false);
    expect(canConvert('localnet')).toBe(false);
  });
});

describe('floorFromQuote', () => {
  it('rounds the quoted minimum down to USDC base units', () => {
    expect(floorFromQuote(100_000_000n, 99.6512349)).toBe(99_651_234n);
    expect(floorFromQuote(1_000_000n, 0.997)).toBe(997_000n);
  });

  it('refuses a floor too far from a dollar, whatever the quote says', () => {
    expect(() => floorFromQuote(100_000_000n, 96.99)).toThrow(/too far from a dollar/);
    expect(floorFromQuote(100_000_000n, 97)).toBe(97_000_000n);
  });

  it('refuses nothing to convert and a quote with no minimum', () => {
    expect(() => floorFromQuote(0n, 1)).toThrow(/no USDT0/);
    expect(() => floorFromQuote(1_000_000n, 0)).toThrow(/no minimum/);
    expect(() => floorFromQuote(1_000_000n, Number.NaN)).toThrow(/no minimum/);
  });
});

describe('approvalFor', () => {
  it('approves exactly the amount, to the router, on USDT0 — only when the allowance is short', () => {
    expect(approvalFor(5_000_000n, 5_000_000n)).toBeNull();
    const call = approvalFor(1n, 5_000_000n)!;
    expect(call.to).toBe(USDT0_MAINNET);
    const { functionName, args } = decodeFunctionData({ abi: ABI, data: call.data });
    expect(functionName).toBe('approve');
    expect(args).toEqual([SWAP_ROUTER_02, 5_000_000n]);
  });
});

describe('swapCall', () => {
  it('swaps along USDT0 → 0.01% → USDC, paying the owner, held to the floor', () => {
    const call = swapCall({ owner: OWNER, amountInRaw: 25_000_000n, minOutRaw: 24_900_000n });
    expect(call.to).toBe(SWAP_ROUTER_02);
    const { functionName, args } = decodeFunctionData({ abi: ABI, data: call.data });
    expect(functionName).toBe('exactInput');
    expect(args[0]).toEqual({
      path: USDT0_TO_USDC_PATH,
      recipient: OWNER,
      amountIn: 25_000_000n,
      amountOutMinimum: 24_900_000n,
    });
    // token (20 bytes), fee 100 as uint24, token.
    expect(USDT0_TO_USDC_PATH.toLowerCase()).toBe(
      `0x${USDT0_MAINNET.slice(2)}000064${USDC_MAINNET.slice(2)}`.toLowerCase(),
    );
  });

  it('refuses a zero amount or a zero floor', () => {
    expect(() => swapCall({ owner: OWNER, amountInRaw: 0n, minOutRaw: 1n })).toThrow();
    expect(() => swapCall({ owner: OWNER, amountInRaw: 1n, minOutRaw: 0n })).toThrow();
  });
});

describe('conversionCalls', () => {
  it('approves first when needed, then swaps', () => {
    const calls = conversionCalls({ owner: OWNER, allowance: 0n, amountInRaw: 2_000_000n, minOutRaw: 1_990_000n });
    expect(calls.map((c) => c.to)).toEqual([USDT0_MAINNET, SWAP_ROUTER_02]);
    const again = conversionCalls({ owner: OWNER, allowance: 2_000_000n, amountInRaw: 2_000_000n, minOutRaw: 1_990_000n });
    expect(again.map((c) => c.to)).toEqual([SWAP_ROUTER_02]);
  });
});

describe('rateText', () => {
  it('says the rate, or a dash where there is none', () => {
    expect(rateText(100, 99.98)).toBe('1 USDT0 = 0.9998 USDC');
    expect(rateText(0, 1)).toBe('—');
  });
});
