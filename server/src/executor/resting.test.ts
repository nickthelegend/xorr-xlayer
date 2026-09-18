/**
 * Wrapped xStock levels do not move when the multiplier does.
 *
 * On X Layer a position is the ERC-4626 wrapper, priced per wrapper share, and a wrapper share is
 * worth `multiplier × raw price` — continuous across a split. Rescaling a stop by the Solana factor
 * here would halve it on a 2:1 split and let a real 50% fall through.
 */
import { describe, expect, it, vi } from 'vitest';

// The database is never reached here; mocked so importing the registry does not need a configured chain.
vi.mock('../db/index.js', () => ({ query: vi.fn(async () => []) }));
const { restingLevels } = await import('./resting.js');

describe('resting levels on X Layer', () => {
  it('passes a wrapped xStock level through at factor 1 even when a basis says the multiplier moved', async () => {
    const out = await restingLevels({
      symbol: 'NVDAx',
      levels: { entryPrice: 200, peakPrice: 220 },
      storedBasis: { multiplier: 1, recordedAt: '2026-09-01T00:00:00Z' },
      levelSetAt: new Date('2026-09-01T00:00:00Z'),
    });
    expect(out).toMatchObject({ status: 'ok', levels: { entryPrice: 200, peakPrice: 220 }, factor: 1, adjusted: false });
  });

  it('never refuses a wrapped xStock level: the level does not depend on reading the raw token', async () => {
    const out = await restingLevels({ symbol: 'tslax', levels: { entryPrice: 300 }, levelSetAt: new Date(0) });
    expect(out.status).toBe('ok');
  });

  it('leaves a non-xStock exactly as it was', async () => {
    const out = await restingLevels({ symbol: 'WETH', levels: { entryPrice: 3000 }, levelSetAt: new Date(0) });
    expect(out).toMatchObject({ status: 'ok', levels: { entryPrice: 3000 }, factor: 1, adjusted: false });
  });
});
