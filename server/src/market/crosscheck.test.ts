/**
 * `agree` answers "is there a warning to raise". `compared` answers "was there a second opinion".
 *
 * They were one field. `agree: true` alongside `pool: null` reads, on its own, as two sources
 * having concurred when only one was ever asked — the note said otherwise and the boolean did not,
 * and a caller reading the field rather than the prose was misled.
 *
 * The conflation was deliberate in one direction and right: reporting a DISAGREEMENT because an
 * upstream was down would make an outage look like a data-integrity problem and train people to
 * ignore the warning that matters. So `agree` keeps that meaning and `compared` carries the rest.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const quote = vi.fn();
const feed = vi.fn();
vi.mock('../venues/uniswap.js', () => ({ quote: (p: unknown) => quote(p) }));
vi.mock('./prices.js', () => ({ priceOf: (s: string) => feed(s) }));

const { crossCheck, DISAGREEMENT_PCT } = await import('./crosscheck.js');

beforeEach(() => {
  quote.mockReset();
  feed.mockReset();
});

/** What the pool hands back for $1,000 of USDC at a given unit price. */
const poolAt = (usd: number) => ({ outAmount: 1_000 / usd });

describe('a second opinion, and whether there was one', () => {
  it('two sources that agree are marked as compared', async () => {
    feed.mockResolvedValue(79_765);
    quote.mockResolvedValue(poolAt(79_800));
    const r = await crossCheck('BTC');
    expect(r.compared).toBe(true);
    expect(r.agree).toBe(true);
    expect(r.pool).toBeCloseTo(79_800, 0);
    expect(r.spreadPct).toBeLessThan(DISAGREEMENT_PCT);
    expect(r.note).toContain('Two independent sources');
  });

  it('asks the pool that carries the symbol on X Layer, at a real size', async () => {
    feed.mockResolvedValue(79_765);
    quote.mockResolvedValue(poolAt(79_765));
    await crossCheck('BTC');
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ inSymbol: 'USDC', outSymbol: 'XBTC', amount: 1_000 }));
  });

  it('a real disagreement is compared AND not agreed', async () => {
    feed.mockResolvedValue(100);
    // 4% apart — well past the threshold.
    quote.mockResolvedValue(poolAt(104));
    const r = await crossCheck('OKB');
    expect(r.compared).toBe(true);
    expect(r.agree).toBe(false);
    expect(r.note).toContain('disagree');
  });

  it('a symbol with no pool on X Layer was never compared', async () => {
    feed.mockResolvedValue(160);
    const r = await crossCheck('SOL');
    expect(r.compared).toBe(false);
    expect(r.pool).toBeNull();
    // Still `agree`, because there is no warning to raise — that is the field's job.
    expect(r.agree).toBe(true);
    expect(r.note).toContain('no pool on X Layer');
    expect(quote).not.toHaveBeenCalled();
  });

  it('a wrapped xStock is not compared with its own pool price', async () => {
    feed.mockResolvedValue(412.5);
    const r = await crossCheck('TSLAx');
    expect(r.compared).toBe(false);
    expect(r.pool).toBe(412.5);
    expect(r.note).toContain('priced by its own X Layer pool');
    expect(quote).not.toHaveBeenCalled();
  });

  it('one source down is not a disagreement, and is not a comparison either', async () => {
    feed.mockResolvedValue(79_765);
    quote.mockRejectedValue(new Error('the quoter reverted'));
    const r = await crossCheck('BTC');
    expect(r.compared).toBe(false);
    expect(r.agree).toBe(true);
    expect(r.note).toContain('nothing to compare');
  });
});
