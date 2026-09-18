/**
 * LIVE — the supply rate on screen must be the one Aave is actually paying on X Layer.
 *
 * This exists because the first version quoted "0.00% a year" with total confidence: it asked a
 * Pool about an asset it did not list, and Aave answers an unknown asset with a zeroed struct
 * rather than a revert. A wrong number that looks measured is the failure mode this whole
 * codebase is built to avoid.
 */
import { describe, expect, it } from 'vitest';
import { supplyYield } from './yield.js';

describe('Aave v3 USDT0 supply yield on X Layer', () => {
  it('is a real, plausible rate — never a zeroed struct read as 0% — with USDC beside it', async () => {
    const y = await supplyYield();
    expect(y.feed).toBe('live');
    expect(y.symbol).toBe('USDT0');
    // A dollar money market pays something, and nothing near 100%. Outside this band the decode is
    // wrong, not the market.
    expect(y.estimatedApy).toBeGreaterThan(0.001);
    expect(y.estimatedApy).toBeLessThan(0.5);
    // The source has to name the contract, so the number can be checked against app.aave.com.
    expect(y.source).toContain('0xE3F3Caefdd7180F884c01E57f65Df979Af84f116');
    expect(y.reserves.map((r) => r.symbol)).toEqual(['USDT0', 'USDC']);
    expect(y.reserves[0]!.aToken).toBe('0xF356ae412dB5df43BD3a10746f7ad4e1C4De4297');
  }, 30_000);
});
