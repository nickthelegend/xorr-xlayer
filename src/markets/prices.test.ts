/**
 * Each class is priced by its own read, and a failed read is a failure rather than a list of dashes.
 */
import { describe, expect, it } from 'vitest';
import { assetClasses } from '@/data/fixtures/markets';
import type { Quote, StockQuote } from '@/data/marketData';
import { FEED_SYMBOLS, priceClasses, priceInstrument, sourceOf } from './prices';

const byId = (id: string) => assetClasses.find((c) => c.id === id)!;
const inst = (sym: string) => assetClasses.flatMap((c) => c.instruments).find((i) => i.sym === sym)!;

const quote = (price: number, change24h: number): Quote => ({ price, change24h, source: 'coingecko' });
const share = (symbol: string, price: number | null): StockQuote => ({
  symbol,
  name: symbol,
  address: '0x0',
  price,
  venues: [],
  feed: price === null ? 'unavailable' : 'live',
});

describe('one instrument, priced', () => {
  it('takes a feed quote with its day’s change', () => {
    const btc = priceInstrument(inst('BTC'), { BTC: quote(80_000, -1.234) }, {});
    expect(btc).toMatchObject({ px: '$80,000', chg: '−1.23%', up: false, feed: 'live' });
  });

  it('prices a share from the snapshot, with no invented change, and a share with no route as no price', () => {
    expect(priceInstrument(inst('NVDAc'), {}, { NVDAc: share('NVDAc', 232.14) })).toMatchObject({
      px: '$232.14',
      chg: '',
      feed: 'live',
    });
    expect(priceInstrument(inst('NVDAc'), {}, { NVDAc: share('NVDAc', null) })).toMatchObject({
      px: '—',
      feed: 'unavailable',
    });
  });

  it('shows a dash for a live instrument the answer left out — never the catalog’s number', () => {
    expect(priceInstrument(inst('ETH'), {}, {})).toMatchObject({ px: '—', chg: '', feed: 'unavailable' });
  });

  it('gives gold its real price when the feed has one, and leaves an index alone', () => {
    expect(priceInstrument(inst('XAUT'), { XAUT: quote(4_420, 0.5) }, {})).toMatchObject({ feed: 'live', chg: '+0.50%' });
    expect(priceInstrument(inst('SPYx'), {}, {})).toEqual(inst('SPYx'));
  });
});

describe('classes follow their own read', () => {
  it('asks the feed for everything but the shares', () => {
    expect(FEED_SYMBOLS).toContain('BTC');
    expect(FEED_SYMBOLS).toContain('XAUT');
    expect(FEED_SYMBOLS.some((s) => s.endsWith('c') && s !== s.toUpperCase())).toBe(false);
    expect(sourceOf(byId('stocks'))).toBe('stocks');
    expect(sourceOf(byId('crypto'))).toBe('feed');
  });

  it('draws crypto while the share snapshot is still out', () => {
    const classes = priceClasses(assetClasses, { data: { BTC: quote(80_000, 1) } }, {});
    expect(classes.find((c) => c.id === 'crypto')!.state).toBe('ready');
    expect(classes.find((c) => c.id === 'stocks')!.state).toBe('loading');
    expect(classes.find((c) => c.id === 'indices')!.state).toBe('ready');
  });

  it('fails only the class whose read failed, with the error', () => {
    const boom = new Error('503 for /market/stocks');
    const classes = priceClasses(assetClasses, { data: {} }, { error: boom });
    const stocks = classes.find((c) => c.id === 'stocks')!;
    expect(stocks.state).toBe('failed');
    expect(stocks.error).toBe(boom);
    expect(classes.filter((c) => c.state === 'failed')).toHaveLength(1);
  });

  it('keeps the catalog rows, unpriced, for a class still loading', () => {
    const loading = priceClasses([byId('crypto')], {}, {})[0]!;
    expect(loading.state).toBe('loading');
    expect(loading.instruments).toBe(byId('crypto').instruments);
  });
});
