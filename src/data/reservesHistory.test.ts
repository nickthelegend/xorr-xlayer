/**
 * A chart cannot say how much it rests on; the caption has to. These pin that the count always
 * travels with the line, and that a short series reads as "we have not watched long" rather than
 * as a claim about the token.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { fetchReservesHistory, provenance } from './reservesHistory';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const series = (n: number) => ({
  symbol: 'NVDAx',
  observations: n,
  points: Array.from({ length: n }, (_, i) => ({
    ratio: 1.0011,
    sharesHeld: 186898,
    circulatingSupply: 186692.75,
    asOf: new Date(Date.now() - i * 3600_000).toISOString(),
  })),
  from: null,
  to: null,
});

describe('reserves history', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('says how many observations a line rests on', () => {
    expect(provenance(series(12))).toMatch(/12 attestations/);
  });

  it('refuses to present one observation as a trend', () => {
    expect(provenance(series(1))).toMatch(/not enough to show a trend/i);
  });

  it('treats an empty series as "not watched yet", not as a fact about the token', () => {
    const s = provenance(series(0));
    expect(s).toMatch(/No attestations recorded yet/i);
    // It must not imply the token was ever unbacked.
    expect(s).not.toMatch(/unbacked|not backed|zero/i);
  });

  it('returns null when the executor cannot be reached, rather than an empty chart', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await fetchReservesHistory('NVDAx')).toBeNull();
  });

  it('returns null on a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    expect(await fetchReservesHistory('NVDAx')).toBeNull();
  });

  it('distinguishes "no points recorded" from "could not load"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(series(0))));
    const h = await fetchReservesHistory('NVDAx');
    // An empty-but-real answer is not null: the screen says "none recorded yet", not "failed".
    expect(h).not.toBeNull();
    expect(h!.observations).toBe(0);
  });

  it('rejects a body with no points array rather than rendering blanks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ symbol: 'NVDAx' })));
    expect(await fetchReservesHistory('NVDAx')).toBeNull();
  });
});
