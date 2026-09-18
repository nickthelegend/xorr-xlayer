import { describe, expect, it } from 'vitest';
import { shortSignature, slotLabel, venueNaming } from './fillVenue';

describe('venueNaming — the two Solana outcomes are different events', () => {
  it('names a real Jupiter route as one', () => {
    const n = venueNaming('jupiter-route');
    expect(n?.label).toBe('Jupiter route');
    expect(n?.routed).toBe(true);
    expect(n?.detail).toMatch(/Jupiter program/);
  });

  /*
   * The rule from `server/src/venues/jupiter.ts`, which is the reason this module exists:
   * "Callers must not describe [venue-vault] as a Jupiter swap."
   *
   * The vault settles at a price Jupiter QUOTED. Nothing was routed and no AMM filled anything. Describing it as a
   * swap would be the app claiming an on-chain trade that did not happen, next to a signature proving something else.
   */
  it('never describes a vault settlement as a Jupiter swap', () => {
    const n = venueNaming('venue-vault');
    expect(n).toBeDefined();
    expect(n?.routed).toBe(false);
    expect(n?.label).not.toMatch(/jupiter/i);
    const detail = n?.detail ?? '';
    expect(detail).not.toMatch(/\bswap(ped|s)?\b/i);
    expect(detail).not.toMatch(/\brouted\b/i);
    expect(detail).not.toMatch(/\bAMM\b/i);
    // And it must say plainly that nothing was routed, rather than merely omitting it.
    expect(detail).toMatch(/no route was executed/i);
  });

  it('the two never share a label — the whole point is telling them apart', () => {
    expect(venueNaming('jupiter-route')?.label).not.toBe(venueNaming('venue-vault')?.label);
  });

  it('still names the EVM venues older runs recorded', () => {
    // A wallet's history does not stop existing because the product changed chain.
    for (const [id, label] of [
      ['1inch', '1inch'],
      ['aqua', 'Aqua book'],
      ['swapvm', 'SwapVM'],
      ['aave', 'Aave'],
    ] as const) {
      expect(venueNaming(id)?.label, id).toBe(label);
      expect(venueNaming(id)?.unrecognised, id).toBeUndefined();
    }
  });

  it('shows an unrecognised venue verbatim rather than inventing a name for it', () => {
    const n = venueNaming('some-new-venue');
    expect(n?.label).toBe('some-new-venue');
    expect(n?.unrecognised).toBe(true);
    // No claim either way about routing: this build does not know, and must not imply it does.
    expect(n?.routed).toBeUndefined();
    expect(n?.detail).toBeUndefined();
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
  const sig =
    '5wHu1qwD4kMv7nR2xY8pLmQ3vTbFj9cGaKdNsEz6UyPqAo1BhXtWr2ZcVm4Ln8Jf3Kd7Gs9Rt2Yb5Nc8Qw1Ex';

  it('keeps both ends', () => {
    const short = shortSignature(sig);
    expect(short.startsWith(sig.slice(0, 8))).toBe(true);
    expect(short.endsWith(sig.slice(-8))).toBe(true);
    expect(short).toContain('…');
  });

  /*
   * Two Solana signatures can begin with the same characters. A head-only truncation cannot be matched against an
   * explorer with any confidence, which makes it decoration in the shape of proof.
   */
  it('tells apart two signatures that share a prefix', () => {
    const a = `${'1'.repeat(40)}${'a'.repeat(40)}`;
    const b = `${'1'.repeat(40)}${'b'.repeat(40)}`;
    expect(shortSignature(a)).not.toBe(shortSignature(b));
  });

  it('leaves a short value exactly as it came', () => {
    expect(shortSignature('abc')).toBe('abc');
  });
});

describe('slotLabel — a slot, or nothing', () => {
  it('groups a real slot', () => {
    expect(slotLabel(283_411_902)).toBe('283,411,902');
  });

  /*
   * A receipt is the one surface where a stand-in number is indistinguishable from a recorded fact, so anything that
   * is not a slot draws nothing at all rather than a zero.
   */
  it('draws nothing for what is not a slot', () => {
    for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(slotLabel(v as number | null | undefined), String(v)).toBeUndefined();
    }
  });
});
