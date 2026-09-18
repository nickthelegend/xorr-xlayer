/**
 * Hyperliquid's answers, read the way the Futures screens need them.
 *
 * The network is mocked; the shapes are the venue's own, copied from a real `metaAndAssetCtxs` and
 * `candleSnapshot` response on 2026-09-13.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const postJson = vi.fn();
const staleValue = vi.fn();
vi.mock('../http/get.js', () => ({
  postJson: (...a: unknown[]) => postJson(...a),
  staleValue: (...a: unknown[]) => staleValue(...a),
  postKey: (url: string, payload: unknown) => `${url}#${JSON.stringify(payload)}`,
}));

const { perpMarkets, perpCandles } = await import('./hyperliquid.js');

const META = {
  universe: [
    { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
    { name: 'ETH', szDecimals: 4, maxLeverage: 25 },
    { name: 'OLD', szDecimals: 2, maxLeverage: 3, isDelisted: true },
    { name: 'kPEPE', szDecimals: 0, maxLeverage: 10 },
  ],
};
const CONTEXTS = [
  { funding: '0.0000034505', openInterest: '35715.00472', prevDayPx: '77081.0', dayNtlVlm: '628585034.09', oraclePx: '77211.3', markPx: '77178.0' },
  { funding: '0.0000125', openInterest: '985003.05', prevDayPx: '2516.2', dayNtlVlm: '390168973.80', oraclePx: '2521.92', markPx: '2521.3' },
  { funding: '0.0', openInterest: '0.0', prevDayPx: '1.0', dayNtlVlm: '999999999999', oraclePx: '1.0', markPx: '1.0' },
  { funding: '-0.00002', openInterest: '1200000000', prevDayPx: '0.0', dayNtlVlm: '1500000.0', oraclePx: '0.0093', markPx: '0.0093' },
];

beforeEach(() => {
  postJson.mockReset();
  staleValue.mockReset();
});

describe('perpMarkets', () => {
  it('turns the venue contexts into markets, busiest first, without delisted contracts', async () => {
    postJson.mockResolvedValue([META, CONTEXTS]);
    const markets = await perpMarkets();

    expect(markets.map((m) => m.symbol)).toEqual(['BTC', 'ETH', 'kPEPE']);
    const btc = markets[0]!;
    expect(btc.maxLeverage).toBe(40);
    expect(btc.fundingRate).toBeCloseTo(0.0000034505, 12);
    // Open interest arrives in contracts; dollars are contracts times the mark.
    expect(btc.openInterestUsd).toBeCloseTo(35715.00472 * 77178, 0);
    expect(btc.change24hPct).toBeCloseTo(((77178 - 77081) / 77081) * 100, 6);
  });

  it('says it has no 24h change rather than inventing one', async () => {
    postJson.mockResolvedValue([META, CONTEXTS]);
    const pepe = (await perpMarkets()).find((m) => m.symbol === 'kPEPE');
    expect(pepe?.change24hPct).toBeNull();
  });

  it('falls back to a recent answer when the venue does not respond', async () => {
    postJson.mockRejectedValue(new Error('timed out'));
    staleValue.mockReturnValue([META, CONTEXTS]);
    expect((await perpMarkets()).length).toBe(3);
  });

  it('fails when there is no recent answer to fall back to', async () => {
    postJson.mockRejectedValue(new Error('timed out'));
    staleValue.mockReturnValue(undefined);
    await expect(perpMarkets()).rejects.toThrow('timed out');
  });
});

describe('perpCandles', () => {
  it('asks the same question for a whole candle, so the cache can answer it', async () => {
    postJson.mockResolvedValue([{ t: 1, o: '1', h: '2', l: '0.5', c: '1.5' }]);
    const tenPast = Date.UTC(2026, 8, 13, 10, 10);
    const fiftyPast = Date.UTC(2026, 8, 13, 10, 50);
    await perpCandles('BTC', '1D', tenPast);
    await perpCandles('BTC', '1D', fiftyPast);
    expect(postJson.mock.calls[0]![1]).toEqual(postJson.mock.calls[1]![1]);
    expect(postJson.mock.calls[0]![1]).toMatchObject({
      type: 'candleSnapshot',
      req: { coin: 'BTC', interval: '1h', endTime: Date.UTC(2026, 8, 13, 11, 0) },
    });
  });

  it('returns bars in the app shape — open, high, low, close', async () => {
    postJson.mockResolvedValue([
      { t: 100, o: '77182.0', h: '77189.0', l: '77069.0', c: '77103.0' },
      { t: 200, o: '77104.0', h: '77146.0', l: '77034.0', c: '77091.0' },
    ]);
    const candles = await perpCandles('BTC', '1D');
    expect(candles.times).toEqual([100, 200]);
    expect(candles.bars[0]).toEqual([77182, 77189, 77069, 77103]);
  });
});
