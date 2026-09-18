import { describe, expect, it, vi, beforeEach } from 'vitest';

const queryMock = vi.fn<(sql: string, p?: unknown[]) => Promise<unknown[]>>();
const placeOrderMock = vi.fn();
const placeSwapMock = vi.fn();
const appendMock = vi.fn();
/** Wrapper units per symbol, as one `chainUnitsOf` multicall answers: null = not checked. */
const unitsMock = vi.fn<(owner: string, symbols: string[]) => Promise<Map<string, number | null>>>();
const priceMock = vi.fn<(symbol: string) => Promise<number | null>>();

vi.mock('../db/index.js', () => ({
  one: vi.fn(),
  query: (sql: string, p?: unknown[]) => queryMock(sql, p),
}));
vi.mock('../executor/order.js', () => ({ placeOrder: (...a: unknown[]) => placeOrderMock(...a) }));
vi.mock('../executor/swap.js', () => ({ placeSwap: (...a: unknown[]) => placeSwapMock(...a) }));
vi.mock('../audit/log.js', () => ({ append: (...a: unknown[]) => appendMock(...a) }));
vi.mock('../evm/balances.js', () => ({
  chainUnitsOf: (owner: string, symbols: string[]) => unitsMock(owner, symbols),
}));

/** Every asked symbol answered from `bySymbol`; a symbol it does not name holds `fallback`. */
function holding(bySymbol: Record<string, number | null>, fallback: number | null = 2) {
  return async (_owner: string, symbols: string[]) =>
    new Map(symbols.map((s) => [s, s in bySymbol ? bySymbol[s]! : fallback] as [string, number | null]));
}
vi.mock('../venues/xstocks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../venues/xstocks.js')>()),
  xStockPriceUsd: (symbol: string) => priceMock(symbol),
}));

const { planBasket, readBasket, rebalanceOnce, validateTargets } = await import('./basket.js');

const OWNER = '0x1111111111111111111111111111111111111111';
const WALLET = { id: 'w1', address: OWNER };
const BASKET = {
  wallet_id: 'w1',
  targets: { NVDAx: 50, TSLAx: 50 },
  band_pct: 5,
  cadence: 'daily' as const,
  enabled: true,
};

/** A sleeve as `readBasket` would have built it. */
const sleeve = (symbol: string, targetPct: number, usd: number | null, total: number) => ({
  symbol,
  targetPct,
  units: usd === null ? 0 : usd / 100,
  usd,
  actualPct: usd === null ? null : (usd / total) * 100,
  driftPct: usd === null ? null : (usd / total) * 100 - targetPct,
});

describe('validateTargets', () => {
  it('accepts a basket that names real equities and sums to 100', () => {
    expect(validateTargets({ NVDAx: 40, TSLAx: 30, AAPLx: 30 })).toBeNull();
  });

  /*
   * Normalising `{ NVDAx: 60 }` to 100% would read "hold 60% NVDA" as "put everything in NVDA" —
   * a different instruction, and a much larger position.
   */
  it('reports a list that does not sum instead of normalising it', () => {
    expect(validateTargets({ NVDAx: 60 })).toContain('60%');
    expect(validateTargets({ NVDAx: 70, TSLAx: 70 })).toContain('140%');
  });

  it('refuses a symbol this app cannot hold', () => {
    expect(validateTargets({ WETH: 100 })).toContain('not a tokenized equity');
  });

  it('refuses a weight of zero or less', () => {
    expect(validateTargets({ NVDAx: 100, TSLAx: 0 })).toContain('above zero');
    expect(validateTargets({ NVDAx: 120, TSLAx: -20 })).toContain('above zero');
  });

  it('refuses an empty basket', () => {
    expect(validateTargets({})).toContain('at least one');
  });
});

describe('planBasket', () => {
  it('does nothing while every sleeve is inside the band', () => {
    // 52/48 against a 50/50 target: 2 points out, inside a 5-point band.
    const sleeves = [sleeve('NVDAx', 50, 520, 1000), sleeve('TSLAx', 50, 480, 1000)];
    const plan = planBasket(sleeves, 1000, 5, []);

    expect(plan.action).toBe('in_band');
    if (plan.action === 'in_band') expect(Math.abs(plan.worstDriftPct)).toBeCloseTo(2, 5);
  });

  it('sells the sleeve that has run past the band', () => {
    // 60/40 against 50/50: NVDAx is 10 points over.
    const sleeves = [sleeve('NVDAx', 50, 600, 1000), sleeve('TSLAx', 50, 400, 1000)];
    const plan = planBasket(sleeves, 1000, 5, []);

    expect(plan.action).toBe('trade');
    if (plan.action !== 'trade') return;
    expect(plan.leg).toMatchObject({ symbol: 'NVDAx', side: 'sell' });
    // All the way back to target, not to the edge of the band.
    expect(plan.leg.usd).toBeCloseTo(100, 5);
  });

  it('buys the sleeve that has lagged past the band', () => {
    const sleeves = [sleeve('NVDAx', 50, 400, 1000), sleeve('TSLAx', 50, 600, 1000)];
    const plan = planBasket(sleeves, 1000, 5, []);

    expect(plan.action).toBe('trade');
    if (plan.action === 'trade') expect(plan.leg).toMatchObject({ symbol: 'NVDAx', side: 'buy' });
  });

  it('takes only the largest drift, leaving the rest for the next run', () => {
    // NVDAx +12, AAPLx −8, TSLAx −4 against a 40/30/30 target.
    const sleeves = [
      sleeve('NVDAx', 40, 520, 1000),
      sleeve('TSLAx', 30, 260, 1000),
      sleeve('AAPLx', 30, 220, 1000),
    ];
    const plan = planBasket(sleeves, 1000, 5, []);

    expect(plan.action).toBe('trade');
    if (plan.action === 'trade') expect(plan.leg.symbol).toBe('NVDAx');
  });

  /*
   * The dangerous case. An unpriceable sleeve counted as zero would shrink the portfolio total,
   * make every other sleeve look over-weight, and sell down a perfectly good basket to close a gap
   * that does not exist.
   */
  it('stands the whole run down when any sleeve cannot be priced, naming it', () => {
    const sleeves = [sleeve('NVDAx', 50, 600, 1000), sleeve('TSLAx', 50, null, 1000)];
    const plan = planBasket(sleeves, 600, 5, ['TSLAx']);

    expect(plan.action).toBe('stand_down');
    if (plan.action === 'stand_down') expect(plan.reason).toContain('TSLAx');
  });

  it('stands down on an empty basket rather than dividing by nothing', () => {
    const plan = planBasket([sleeve('NVDAx', 100, 0, 1)], 0, 5, []);
    expect(plan.action).toBe('stand_down');
  });

  it('stands down when the correction is smaller than the minimum trade', () => {
    // 10 points out, but of a $50 basket — $5, under the $10 floor.
    const sleeves = [sleeve('NVDAx', 50, 30, 50), sleeve('TSLAx', 50, 20, 50)];
    const plan = planBasket(sleeves, 50, 5, []);

    expect(plan.action).toBe('stand_down');
    if (plan.action === 'stand_down') expect(plan.reason).toContain('minimum trade');
  });

  it('measures drift in points of the basket, so the band means the same at any size', () => {
    const small = planBasket([sleeve('NVDAx', 50, 600, 1000), sleeve('TSLAx', 50, 400, 1000)], 1000, 5, []);
    const large = planBasket(
      [sleeve('NVDAx', 50, 600_000, 1_000_000), sleeve('TSLAx', 50, 400_000, 1_000_000)],
      1_000_000,
      5,
      [],
    );
    expect(small.action).toBe('trade');
    expect(large.action).toBe('trade');
    if (small.action === 'trade' && large.action === 'trade') {
      expect(small.leg.driftPct).toBeCloseTo(large.leg.driftPct, 5);
    }
  });
});

describe('readBasket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unitsMock.mockImplementation(holding({}));
    priceMock.mockResolvedValue(100);
  });

  it('values each sleeve from the chain balance and a live price', async () => {
    const { sleeves, totalUsd, unpriced } = await readBasket(OWNER, { NVDAx: 50, TSLAx: 50 });

    expect(unpriced).toEqual([]);
    expect(totalUsd).toBe(400);
    expect(sleeves.map((s) => s.usd)).toEqual([200, 200]);
    expect(sleeves.every((s) => s.actualPct === 50)).toBe(true);
    expect(sleeves.every((s) => s.driftPct === 0)).toBe(true);
  });

  /* A balance that could not be read is not a balance of zero. */
  it('marks a sleeve unpriced when its balance was not checked', async () => {
    unitsMock.mockImplementation(holding({ NVDAx: null }));

    const { unpriced, sleeves } = await readBasket(OWNER, { NVDAx: 50, TSLAx: 50 });
    expect(unpriced).toContain('NVDAx');
    expect(sleeves.find((s) => s.symbol === 'NVDAx')?.usd).toBeNull();
    // With anything unpriced, no percentages are computed at all — they would be wrong.
    expect(sleeves.every((s) => s.actualPct === null)).toBe(true);
  });

  it('marks every sleeve unpriced when the balance read itself fails', async () => {
    unitsMock.mockRejectedValue(new Error('rpc down'));

    const { unpriced, totalUsd } = await readBasket(OWNER, { NVDAx: 50, TSLAx: 50 });
    expect(unpriced).toEqual(['NVDAx', 'TSLAx']);
    expect(totalUsd).toBe(0);
  });

  it('reads the wrapped xStocks by their registry symbols, in one call', async () => {
    await readBasket(OWNER, { nvdax: 50, TSLAx: 50 });
    expect(unitsMock).toHaveBeenCalledTimes(1);
    expect(unitsMock).toHaveBeenCalledWith(OWNER, ['NVDAx', 'TSLAx']);
  });

  it('reads nothing for an owner that is not an X Layer address', async () => {
    const { unpriced } = await readBasket('OwnerPubkey111', { NVDAx: 50, TSLAx: 50 });
    expect(unpriced).toEqual(['NVDAx', 'TSLAx']);
    expect(unitsMock).not.toHaveBeenCalled();
  });

  it('marks a sleeve unpriced when nothing can price it', async () => {
    priceMock.mockImplementation(async (s) => (s === 'TSLAx' ? null : 100));
    const { unpriced } = await readBasket(OWNER, { NVDAx: 50, TSLAx: 50 });
    expect(unpriced).toEqual(['TSLAx']);
  });

  it('marks a symbol that is not an xStock at all', async () => {
    const { unpriced } = await readBasket(OWNER, { WETH: 100 });
    expect(unpriced).toEqual(['WETH']);
    expect(unitsMock).not.toHaveBeenCalledWith(OWNER, expect.arrayContaining(['WETH']));
  });
});

describe('rebalanceOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unitsMock.mockImplementation(holding({}));
    priceMock.mockResolvedValue(100);
    appendMock.mockResolvedValue({ seq: '1' });
    // Default: the claim succeeds, every other write is a no-op.
    queryMock.mockImplementation(async (sql: string) =>
      sql.includes('INSERT INTO basket_runs') ? [{ id: 'run-1' }] : [],
    );
  });

  /*
   * The guarantee `strategy_runs` gives, kept. A retry, a restart, or two schedulers racing all
   * converge on one run per period because the database refuses the second claim.
   */
  it('does nothing at all when the period is already claimed', async () => {
    queryMock.mockImplementation(async () => []);

    expect(await rebalanceOnce(WALLET, BASKET)).toBeNull();
    expect(placeOrderMock).not.toHaveBeenCalled();
    expect(placeSwapMock).not.toHaveBeenCalled();
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('claims the period before it reads anything', async () => {
    const order: string[] = [];
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO basket_runs')) {
        order.push('claim');
        return [{ id: 'run-1' }];
      }
      return [];
    });
    unitsMock.mockImplementation(async (_o, symbols) => {
      order.push('read');
      return new Map(symbols.map((s) => [s, 2] as [string, number | null]));
    });

    await rebalanceOnce(WALLET, BASKET);
    // A claim taken after the work leaves a window where both callers have decided to trade.
    expect(order[0]).toBe('claim');
  });

  it('keys the period on the wallet and the cadence', async () => {
    await rebalanceOnce(WALLET, BASKET, new Date('2026-09-17T12:00:00Z'));
    const claim = queryMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO basket_runs'));
    expect(claim?.[1]).toContain('basket:w1:2026-09-17');
  });

  it('records an in-band run rather than dropping it silently', async () => {
    const out = await rebalanceOnce(WALLET, BASKET);

    expect(out?.status).toBe('skipped');
    expect(placeOrderMock).not.toHaveBeenCalled();
    expect(placeSwapMock).not.toHaveBeenCalled();
    const update = queryMock.mock.calls.find(([sql]) => sql.includes('UPDATE basket_runs'));
    expect(update?.[1]?.[1]).toBe('skipped');
    // A schedule showing nothing on the quiet days looks like a strategy that stopped running.
    expect(String(update?.[1]?.[2])).toContain('inside the 5% band');
  });

  it('sells the over-weight sleeve through closePosition and writes the trail', async () => {
    // NVDAx worth $600 against TSLAx at $400: 10 points over a 50/50 target.
    unitsMock.mockImplementation(holding({ NVDAx: 6, TSLAx: 4 }));
    placeSwapMock.mockResolvedValue({
      status: 200,
      body: { status: 'filled', from: 'NVDAx', to: 'USDC', sold: 1, received: 99.5, usd: 99.5, txHash: '0xRebalSig1' },
    });

    const out = await rebalanceOnce(WALLET, BASKET);

    expect(out).toMatchObject({ status: 'filled', symbol: 'NVDAx', side: 'sell', signature: '0xRebalSig1', usd: 99.5 });
    // $100 of a $600 sleeve is a sixth of its six units: one, sold into the settlement token.
    expect(placeSwapMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w1', address: OWNER }),
      { from: 'NVDAx', to: 'USDC', amount: '1.000000' },
    );
    expect(placeOrderMock).not.toHaveBeenCalled();
    // The swap path wrote the fill's audit row; the basket does not write a second.
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('buys the under-weight sleeve as a one-off order', async () => {
    unitsMock.mockImplementation(holding({ NVDAx: 4, TSLAx: 6 }));
    placeOrderMock.mockResolvedValue({
      placed: true,
      orderId: 'order-1',
      outcome: { status: 'filled', runId: 'run-9', signature: '0xRebalBuy', units: 1, price: 100 },
    });

    const out = await rebalanceOnce(WALLET, BASKET);

    expect(out).toMatchObject({ status: 'filled', symbol: 'NVDAx', side: 'buy', signature: '0xRebalBuy' });
    expect(placeOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w1', address: OWNER }),
      'NVDAx',
      expect.closeTo(100, 5),
      expect.stringContaining('NVDAx'),
    );
    expect(placeSwapMock).not.toHaveBeenCalled();
  });

  it('records a refusal from the order path without writing a trade to the trail', async () => {
    unitsMock.mockImplementation(holding({ NVDAx: 4, TSLAx: 6 }));
    placeOrderMock.mockResolvedValue({
      placed: true,
      orderId: 'order-1',
      outcome: { status: 'blocked', runId: 'run-9', reason: 'onchain_daily_cap', detail: 'That would go past the daily cap.' },
    });

    const out = await rebalanceOnce(WALLET, BASKET);

    expect(out).toMatchObject({ status: 'failed', detail: 'That would go past the daily cap.' });
    expect(appendMock).not.toHaveBeenCalled();
    const update = queryMock.mock.calls.find(([sql]) => sql.includes('UPDATE basket_runs'));
    expect(update?.[1]?.[1]).toBe('failed');
  });

  it('records a refused sale without writing a trade to the trail', async () => {
    unitsMock.mockImplementation(holding({ NVDAx: 6, TSLAx: 4 }));
    placeSwapMock.mockResolvedValue({
      status: 409,
      body: { status: 'blocked', reason: 'delegation_inactive', detail: 'The trading permission is revoked or expired.' },
    });

    const out = await rebalanceOnce(WALLET, BASKET);

    expect(out).toMatchObject({ status: 'failed', detail: 'The trading permission is revoked or expired.' });
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('records an order path that threw as a failed run', async () => {
    unitsMock.mockImplementation(holding({ NVDAx: 4, TSLAx: 6 }));
    placeOrderMock.mockRejectedValue(new Error('rpc down'));

    const out = await rebalanceOnce(WALLET, BASKET);
    expect(out?.status).toBe('failed');
    expect(out?.status === 'failed' && out.detail).toContain('rpc down');
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('stands down and records why when a sleeve cannot be priced', async () => {
    priceMock.mockImplementation(async (s) => (s === 'TSLAx' ? null : 100));

    const out = await rebalanceOnce(WALLET, BASKET);
    expect(out?.status).toBe('skipped');
    expect(out?.status === 'skipped' && out.detail).toContain('TSLAx');
    expect(placeOrderMock).not.toHaveBeenCalled();
    expect(placeSwapMock).not.toHaveBeenCalled();
  });
});
