/**
 * The agent's Graph-driven decision logic. Pure; the live path is covered by decide.live.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { flowImbalance } from './decide.js';
import { unitsToUsd } from './client.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const spend = (token: string) => ({ token }) as never;

describe('flow imbalance — what being picked off looks like from outside', () => {
  it('is zero with no history', () => {
    expect(flowImbalance([], USDC)).toBe(0);
  });

  it('is 1 when every settled trade ran the same way', () => {
    expect(flowImbalance([spend(USDC), spend(USDC), spend(USDC)], USDC)).toBe(1);
  });

  it('is 0.5 for balanced two-way flow — a healthy book', () => {
    expect(flowImbalance([spend(USDC), spend(WETH)], USDC)).toBe(0.5);
  });

  it('ignores case, because addresses arrive lowercased from the subgraph', () => {
    expect(flowImbalance([spend(USDC.toLowerCase())], USDC)).toBe(1);
  });
});

describe('unit conversion', () => {
  it('reads USDC base units as dollars', () => {
    expect(unitsToUsd('25000000')).toBe(25);
    expect(unitsToUsd('400000000')).toBe(400);
  });
});
