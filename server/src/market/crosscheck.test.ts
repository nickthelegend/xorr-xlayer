/**
 * `agree` answers "is there a warning to raise". `compared` answers "was there a second opinion".
 *
 * They were one field. `agree: true` alongside `oneinch: null` reads, on its own, as two sources
 * having concurred when only one was ever asked — the note said otherwise and the boolean did not,
 * and a caller reading the field rather than the prose was misled.
 *
 * The conflation was deliberate in one direction and right: reporting a DISAGREEMENT because an
 * upstream was down would make an outage look like a data-integrity problem and train people to
 * ignore the warning that matters. So `agree` keeps that meaning and `compared` carries the rest.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

process.env.ONEINCH_API_KEY ??= 'test-key';
process.env.XORR_CHAIN ??= 'base-sepolia';

const spot = vi.fn();
const feed = vi.fn();
vi.mock('../http/get.js', () => ({
  getJson: (url: string) => spot(url),
  staleValue: () => undefined,
  UpstreamUnavailable: class extends Error {},
}));
vi.mock('./prices.js', () => ({ priceOf: () => feed() }));

const { crossCheck, DISAGREEMENT_PCT } = await import('./crosscheck.js');

beforeEach(() => {
  spot.mockReset();
  feed.mockReset();
});

/** 1inch answers `{ "<address lowercased>": "<usd>" }`. */
const spotFor = (addr: string, usd: number) => ({ [addr.toLowerCase()]: String(usd) });

describe('a second opinion, and whether there was one', () => {
  it('two sources that agree are marked as compared', async () => {
    feed.mockResolvedValue(2506.28);
    spot.mockImplementation((url: string) =>
      Promise.resolve(spotFor(url.split('/').pop()!.split('?')[0]!, 2507.57)),
    );
    const r = await crossCheck('WETH');
    expect(r.compared).toBe(true);
    expect(r.agree).toBe(true);
    expect(r.spreadPct).toBeLessThan(DISAGREEMENT_PCT);
    expect(r.note).toContain('Two independent sources');
  });

  it('a real disagreement is compared AND not agreed', async () => {
    feed.mockResolvedValue(2500);
    spot.mockImplementation((url: string) =>
      // 4% apart — well past the threshold.
      Promise.resolve(spotFor(url.split('/').pop()!.split('?')[0]!, 2600)),
    );
    const r = await crossCheck('WETH');
    expect(r.compared).toBe(true);
    expect(r.agree).toBe(false);
    expect(r.note).toContain('disagree');
  });

  it('a token with no on-chain route was never compared', async () => {
    // BTC is not an ERC-20 on Base. There is no second price, and there never was.
    feed.mockResolvedValue(79765);
    const r = await crossCheck('BTC');
    expect(r.compared).toBe(false);
    expect(r.oneinch).toBeNull();
    // Still `agree`, because there is no warning to raise — that is the field's job.
    expect(r.agree).toBe(true);
    expect(r.note).toContain('not routable on Base');
  });

  it('one source down is not a disagreement, and is not a comparison either', async () => {
    feed.mockResolvedValue(2500);
    spot.mockRejectedValue(new Error('1inch is down'));
    const r = await crossCheck('WETH');
    expect(r.compared).toBe(false);
    expect(r.agree).toBe(true);
    expect(r.note).toContain('nothing to compare');
  });
});
