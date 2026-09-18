/**
 * Two ways this could report a confident, arithmetically-correct lie.
 *
 * Counting a split as income turns a 4:1 into "300% yield" — derived from real data and complete
 * nonsense, because a split hands a holder nothing. And reporting an unmeasured window as 0.00%
 * states that the token paid nothing, which is a measurement we did not take.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const QUERY = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock('../db/index.js', () => ({ query: QUERY }));

const { dividendYield, stepsFrom, accrualFrom, SPLIT_STEP } = await import('./dividend-yield.js');

// The wrapped NVDAx on X Layer — observations are keyed on the wrapper address.
const MINT = '0xa8ddb5cd96b5222afe198316e9a57caa642850d5';
const day = (n: number) => new Date(Date.now() - n * 86_400_000);

beforeEach(() => {
  vi.clearAllMocks();
  QUERY.mockResolvedValue([]);
});

describe('turning multiplier steps into income', () => {
  it('compounds the small steps a reinvested dividend makes', () => {
    const steps = stepsFrom([
      { multiplier: 1.0, at: 'a' },
      { multiplier: 1.002, at: 'b' },
      { multiplier: 1.004004, at: 'c' },
    ]);
    const { yieldFraction, excluded } = accrualFrom(steps);

    expect(excluded).toEqual([]);
    expect(yieldFraction).toBeCloseTo(0.004004, 6);
  });

  it('refuses to call a 4:1 split a 300% yield', () => {
    const steps = stepsFrom([
      { multiplier: 1.0, at: 'a' },
      { multiplier: 4.0, at: 'b' },
    ]);
    const { yieldFraction, excluded } = accrualFrom(steps);

    // The arithmetic would give 3.0. A split hands the holder nothing.
    expect(yieldFraction).toBeCloseTo(0, 12);
    expect(excluded).toHaveLength(1);
    expect(excluded[0]!.factor).toBeCloseTo(4, 12);
    expect(excluded[0]!.reason).toMatch(/split, not income/);
  });

  it('keeps the dividends either side of a split', () => {
    const steps = stepsFrom([
      { multiplier: 1.0, at: 'a' },
      { multiplier: 1.002, at: 'b' },   // dividend
      { multiplier: 4.008, at: 'c' },   // split
      { multiplier: 4.016016, at: 'd' }, // dividend
    ]);
    const { yieldFraction, excluded } = accrualFrom(steps);

    expect(excluded).toHaveLength(1);
    // 1.002 * 1.002 - 1
    expect(yieldFraction).toBeCloseTo(0.004004, 5);
  });

  it('sets aside a reverse split without calling it a loss of income', () => {
    const { excluded, yieldFraction } = accrualFrom(
      stepsFrom([{ multiplier: 4, at: 'a' }, { multiplier: 1, at: 'b' }]),
    );
    expect(excluded[0]!.reason).toMatch(/reverse split, not a loss/);
    expect(yieldFraction).toBeCloseTo(0, 12);
  });

  it('draws the line where it says it does', () => {
    const under = accrualFrom(stepsFrom([{ multiplier: 1, at: 'a' }, { multiplier: 1 + SPLIT_STEP * 0.9, at: 'b' }]));
    const over = accrualFrom(stepsFrom([{ multiplier: 1, at: 'a' }, { multiplier: 1 + SPLIT_STEP * 1.1, at: 'b' }]));
    expect(under.excluded).toEqual([]);
    expect(over.excluded).toHaveLength(1);
  });
});

describe('what a window can honestly claim', () => {
  it('reports no measurement — not zero — with nothing recorded', async () => {
    QUERY.mockResolvedValue([]);
    const w = await dividendYield({ symbol: 'NVDAx', mint: MINT });

    expect(w.status).toBe('unmeasured');
    if (w.status !== 'unmeasured') return;
    expect(w.reason).toMatch(/No multiplier has been recorded/);
    // A zero would be a claim that the token paid nothing.
    expect(JSON.stringify(w)).not.toMatch(/"yieldFraction"/);
  });

  it('reports no measurement with a single reading', async () => {
    QUERY.mockResolvedValue([{ multiplier: '1.0017', observed_at: day(3) }]);
    const w = await dividendYield({ symbol: 'NVDAx', mint: MINT });

    expect(w.status).toBe('unmeasured');
    if (w.status !== 'unmeasured') return;
    expect(w.reason).toMatch(/difference between two/);
  });

  it('measures once there are two readings', async () => {
    QUERY.mockResolvedValue([
      { multiplier: '1.0000', observed_at: day(40) },
      { multiplier: '1.0040', observed_at: day(0) },
    ]);
    const w = await dividendYield({ symbol: 'NVDAx', mint: MINT });

    expect(w.status).toBe('measured');
    if (w.status !== 'measured') return;
    expect(w.yieldFraction).toBeCloseTo(0.004, 6);
    expect(w.observations).toBe(2);
    expect(w.days).toBeCloseTo(40, 0);
  });

  it('will not annualise four days of accrual into a yearly figure', async () => {
    QUERY.mockResolvedValue([
      { multiplier: '1.0000', observed_at: day(4) },
      { multiplier: '1.0005', observed_at: day(0) },
    ]);
    const w = await dividendYield({ symbol: 'NVDAx', mint: MINT });

    if (w.status !== 'measured') throw new Error('expected measured');
    // Scaling 4 days up to a year multiplies the noise by ninety alongside the signal.
    expect(w.annualisedFraction).toBeNull();
    expect(w.yieldFraction).toBeCloseTo(0.0005, 6);
  });

  it('annualises a long enough window', async () => {
    QUERY.mockResolvedValue([
      { multiplier: '1.0000', observed_at: day(365) },
      { multiplier: '1.0200', observed_at: day(0) },
    ]);
    const w = await dividendYield({ symbol: 'NVDAx', mint: MINT });

    if (w.status !== 'measured') throw new Error('expected measured');
    expect(w.annualisedFraction).toBeCloseTo(0.02, 4);
  });

  it('treats a database failure as unmeasured rather than as zero yield', async () => {
    QUERY.mockRejectedValue(new Error('db down'));
    const w = await dividendYield({ symbol: 'NVDAx', mint: MINT });
    expect(w.status).toBe('unmeasured');
  });
});
