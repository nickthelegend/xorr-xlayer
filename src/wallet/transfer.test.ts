/**
 * The transfer a send signs (PLAN.md 3.11): sent to the token's own contract, to the destination, in the token's own
 * decimals — exactly, from the typed string.
 */
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi } from 'viem';
import { transferCall } from './transfer';

const TO = '0x95A0b368588713011a15f4b1041423f31B08e615';
// Circle's USDC on the X Layer testnet, and X Layer mainnet's XBTC and WOKB (`server/src/evm/chains.ts`).
const TESTNET_USDC = { address: '0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3', decimals: 6 };
const XBTC = { address: '0xb7C00000bcDEeF966b20B3D884B98E64d2b06b4f', decimals: 8 };
const WOKB = { address: '0xe538905cf8410324e03A5A23C1c177a474D59b2b', decimals: 18 };
const argsOf = (data: `0x${string}`) => decodeFunctionData({ abi: erc20Abi, data });

describe('the transfer a send signs', () => {
  it("goes to the token's own contract, to the destination, in that token's decimals", () => {
    const usdc = transferCall(TESTNET_USDC, TO, '12.5');
    expect(usdc.to).toBe(TESTNET_USDC.address);
    expect(argsOf(usdc.data)).toEqual({ functionName: 'transfer', args: [TO, 12_500_000n] });
    expect(argsOf(transferCall(XBTC, TO, '0.0005').data).args).toEqual([TO, 50_000n]);
    // 0.1 as a float is 100000000000000006 wei; typed, it is exactly 10^17.
    expect(argsOf(transferCall(WOKB, TO, '0.1').data).args).toEqual([TO, 100_000_000_000_000_000n]);
  });

  it('refuses more precision than the token has, rather than rounding it away', () => {
    expect(() => transferCall(TESTNET_USDC, TO, '1.0000001')).toThrow('This token has 6 decimal places');
  });

  it('refuses what is not an amount', () => {
    expect(() => transferCall(WOKB, TO, '1e18')).toThrow('is not an amount');
    expect(() => transferCall(WOKB, TO, '')).toThrow('is not an amount');
  });
});
