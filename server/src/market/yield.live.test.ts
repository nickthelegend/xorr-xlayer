/**
 * LIVE — the supply rate on screen must be the one Aave is actually paying.
 *
 * This exists because the first version quoted "0.00% a year" with total confidence: it asked the
 * mainnet Pool about the Sepolia USDC address, and Aave answers an unknown asset with a zeroed
 * struct rather than a revert. A wrong number that looks measured is the failure mode this whole
 * codebase is built to avoid.
 */
import { describe, expect, it } from 'vitest';
import { usdcSupplyYield } from './yield.js';

describe('Aave v3 USDC supply yield on Base', () => {
  it('is a real, plausible rate — never a zeroed struct read as 0%', async () => {
    const y = await usdcSupplyYield();
    expect(y.feed).toBe('live');
    expect(y.symbol).toBe('USDC');
    // A dollar money market pays something, and nothing near 100%. Outside this band the decode is
    // wrong, not the market.
    expect(y.estimatedApy).toBeGreaterThan(0.001);
    expect(y.estimatedApy).toBeLessThan(0.5);
    // The source has to name the contract, so the number can be checked against app.aave.com.
    expect(y.source).toContain('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5');
  }, 30_000);
});
