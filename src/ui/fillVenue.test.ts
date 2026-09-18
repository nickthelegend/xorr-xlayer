import { describe, expect, it } from 'vitest';
import { blockLabel, shortSignature, venueNaming } from './fillVenue';

describe('venueNaming — the three X Layer venues are different events', () => {
  it('names a Uniswap v3 swap as one', () => {
    const n = venueNaming('uniswap-v3');
    expect(n?.label).toBe('Uniswap v3');
    expect(n?.routed).toBe(true);
    expect(n?.detail).toMatch(/Uniswap v3 pools/);
  });

  it('names an OKX DEX fill as the aggregator’s route, not as Uniswap', () => {
    const n = venueNaming('okx-dex');
    expect(n?.label).toBe('OKX DEX');
    expect(n?.routed).toBe(true);
    expect(n?.detail).toMatch(/aggregator/);
    expect(n?.label).not.toBe(venueNaming('uniswap-v3')?.label);
  });

  /*
   * Supplying to Aave is a deposit at par. Nothing was routed and no pool filled anything. Describing it as a swap
   * would be the app claiming a market trade that did not happen, next to a transaction proving something else.
   */
  it('never describes an Aave supply as a trade', () => {
    const n = venueNaming('aave');
    expect(n).toBeDefined();
    expect(n?.routed).toBe(false);
    const detail = n?.detail ?? '';
    expect(detail).not.toMatch(/\bswap(ped|s)?\b/i);
    expect(detail).not.toMatch(/\brouted\b/i);
    // And it must say plainly that nothing was traded, rather than merely omitting it.
    expect(detail).toMatch(/nothing was traded/i);
  });

  it('the three never share a label — the whole point is telling them apart', () => {
    const labels = ['uniswap-v3', 'okx-dex', 'aave'].map((v) => venueNaming(v)?.label);
    expect(new Set(labels).size).toBe(3);
  });

  it('reads a venue without regard to case or stray space', () => {
    expect(venueNaming(' Uniswap-V3 ')?.label).toBe('Uniswap v3');
  });

  it('shows an unrecognised venue verbatim rather than inventing a name for it', () => {
    // Another chain's venue, too: this build does not speak for it.
    for (const id of ['some-new-venue', '1inch', 'jupiter-route']) {
      const n = venueNaming(id);
      expect(n?.label, id).toBe(id);
      expect(n?.unrecognised, id).toBe(true);
      // No claim either way about routing: this build does not know, and must not imply it does.
      expect(n?.routed, id).toBeUndefined();
      expect(n?.detail, id).toBeUndefined();
    }
  });

  /* A run that never reached a venue — blocked, skipped, refused — has none. That is not a venue we failed to read. */
  it('answers nothing for a run that reached no venue', () => {
    expect(venueNaming(null)).toBeUndefined();
    expect(venueNaming(undefined)).toBeUndefined();
    expect(venueNaming('')).toBeUndefined();
    expect(venueNaming('   ')).toBeUndefined();
  });
});

describe('shortSignature — a truncation someone can actually match', () => {
  const hash = '0x9f2c4be1a7d35e08c61b4f9a02d7e53c8b1a6f40e2d9c37b5a18f6e04c2d9b7a1';

  it('keeps both ends', () => {
    const short = shortSignature(hash);
    expect(short.startsWith(hash.slice(0, 8))).toBe(true);
    expect(short.endsWith(hash.slice(-8))).toBe(true);
    expect(short).toContain('…');
  });

  /*
   * Two transaction hashes can begin with the same characters. A head-only truncation cannot be matched against an
   * explorer with any confidence, which makes it decoration in the shape of proof.
   */
  it('tells apart two hashes that share a prefix', () => {
    const a = `0x${'1'.repeat(32)}${'a'.repeat(32)}`;
    const b = `0x${'1'.repeat(32)}${'b'.repeat(32)}`;
    expect(shortSignature(a)).not.toBe(shortSignature(b));
  });

  it('leaves a short value exactly as it came', () => {
    expect(shortSignature('abc')).toBe('abc');
  });
});

describe('blockLabel — a block, or nothing', () => {
  it('groups a real block number', () => {
    expect(blockLabel(51_242_381)).toBe('51,242,381');
  });

  /*
   * A receipt is the one surface where a stand-in number is indistinguishable from a recorded fact, so anything that
   * is not a block draws nothing at all rather than a zero.
   */
  it('draws nothing for what is not a block', () => {
    for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(blockLabel(v as number | null | undefined), String(v)).toBeUndefined();
    }
  });
});
