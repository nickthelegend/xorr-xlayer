/**
 * The transfer a send signs (PLAN.md 3.11): sent to the token's own contract, to the destination, in the token's own
 * decimals — exactly, from the typed string.
 */
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi } from 'viem';
import { transferCall } from './transfer';

const TO = '0x95A0b368588713011a15f4b1041423f31B08e615';
const SEPOLIA_USDC = { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 };
const CBBTC = { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 };
const WETH = { address: '0x4200000000000000000000000000000000000006', decimals: 18 };
const argsOf = (data: `0x${string}`) => decodeFunctionData({ abi: erc20Abi, data });

describe('the transfer a send signs', () => {
  it("goes to the token's own contract, to the destination, in that token's decimals", () => {
    const usdc = transferCall(SEPOLIA_USDC, TO, '12.5');
    expect(usdc.to).toBe(SEPOLIA_USDC.address);
    expect(argsOf(usdc.data)).toEqual({ functionName: 'transfer', args: [TO, 12_500_000n] });
    expect(argsOf(transferCall(CBBTC, TO, '0.0005').data).args).toEqual([TO, 50_000n]);
    // 0.1 as a float is 100000000000000006 wei; typed, it is exactly 10^17.
    expect(argsOf(transferCall(WETH, TO, '0.1').data).args).toEqual([TO, 100_000_000_000_000_000n]);
  });

  it('refuses more precision than the token has, rather than rounding it away', () => {
    expect(() => transferCall(SEPOLIA_USDC, TO, '1.0000001')).toThrow('This token has 6 decimal places');
  });

  it('refuses what is not an amount', () => {
    expect(() => transferCall(WETH, TO, '1e18')).toThrow('is not an amount');
    expect(() => transferCall(WETH, TO, '')).toThrow('is not an amount');
  });
});
