import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const priceMock = vi.fn<(symbol: string) => Promise<number | null>>();

vi.mock('../venues/xstocks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../venues/xstocks.js')>()),
  xStockPriceUsd: (s: string) => priceMock(s),
}));

const { observeSweep, resetObserveClock, OBSERVE_EVERY_MS } = await import('./observe.js');
const { XSTOCKS } = await import('../venues/xstocks.js');

const T0 = new Date('2026-09-17T12:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

describe('recording what the xStocks cost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetObserveClock();
    priceMock.mockResolvedValue(216.5);
  });

  afterEach(() => resetObserveClock());

  it('prices every symbol in the universe', async () => {
    const out = await observeSweep(T0);
    expect(out).toEqual({ asked: Object.keys(XSTOCKS).length, recorded: Object.keys(XSTOCKS).length, unpriced: [] });
    expect(priceMock).toHaveBeenCalledTimes(Object.keys(XSTOCKS).length);
  });

  /*
   * The scheduler ticks every thirty seconds; eleven symbols at that rate is more than thirty
   * thousand quotes a day to build a series whose own window is a month.
   */
  it('does nothing when the last pass was recent', async () => {
    await observeSweep(T0);
    priceMock.mockClear();

    expect(await observeSweep(later(OBSERVE_EVERY_MS - 1))).toBeNull();
    expect(priceMock).not.toHaveBeenCalled();
  });

  it('runs again once the interval has passed', async () => {
    await observeSweep(T0);
    priceMock.mockClear();

    const out = await observeSweep(later(OBSERVE_EVERY_MS));
    expect(out).not.toBeNull();
    expect(priceMock).toHaveBeenCalledTimes(Object.keys(XSTOCKS).length);
  });

  /*
   * A gap in the series is the honest record of a gap in what was knowable — which is exactly why
   * the range logic counts observations rather than assuming a shape.
   */
  it('reports a symbol it could not price rather than inventing a reading', async () => {
    priceMock.mockImplementation(async (s) => (s === 'TSLAx' ? null : 216.5));

    const out = await observeSweep(T0);
    expect(out?.unpriced).toEqual(['TSLAx']);
    expect(out?.recorded).toBe(Object.keys(XSTOCKS).length - 1);
  });

  it('treats a throw as unpriced rather than ending the sweep', async () => {
    priceMock.mockImplementation(async (s) => {
      if (s === 'NVDAx') throw new Error('venue down');
      return 216.5;
    });

    const out = await observeSweep(T0);
    expect(out?.unpriced).toContain('NVDAx');
    // Every other symbol still got asked: one venue failure is not the whole sweep's.
    expect(priceMock).toHaveBeenCalledTimes(Object.keys(XSTOCKS).length);
  });

  it('does not count a zero or negative price as a reading', async () => {
    priceMock.mockResolvedValue(0);
    const out = await observeSweep(T0);
    expect(out?.recorded).toBe(0);
    expect(out?.unpriced).toHaveLength(Object.keys(XSTOCKS).length);
  });
});
