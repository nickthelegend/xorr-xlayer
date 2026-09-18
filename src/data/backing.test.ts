/**
 * Every path that is not a reading from the attestor has to say so.
 *
 * The failure worth designing against is not a wrong ratio — it is a confident "1:1 backed" drawn
 * from a request that never succeeded. So these lean on the refusals: a dead executor, a 500, a
 * body this build cannot parse, and a ratio that is not a number all end in `verified: false`.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { fetchBacking, backingLabel } from './backing';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const VERIFIED = {
  verified: true as const,
  symbol: 'NVDAx',
  ratio: 1.0010993,
  fullyBacked: true,
  sharesHeld: 186898,
  circulatingSupply: 186692.75074178688,
  custodians: [{ provider: 'Alpaca', quantity: 186898, symbol: 'NVDA' }],
  asOf: '2026-09-17T07:02:05.244Z',
};

describe('xStock backing, as the app reads it', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes through a measured attestation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(VERIFIED)));

    const b = await fetchBacking('NVDAx');
    expect(b.verified).toBe(true);
    if (!b.verified) return;
    expect(b.ratio).toBeCloseTo(1.0010993, 7);
    expect(b.custodians[0]?.provider).toBe('Alpaca');
    expect(b.asOf).toBe('2026-09-17T07:02:05.244Z');
  });

  it('reports unverified when the executor cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const b = await fetchBacking('NVDAx');
    expect(b.verified).toBe(false);
    if (b.verified) return;
    expect(b.reason).toMatch(/could not be reached/i);
  });

  it('reports unverified on a non-OK status, quoting it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })));

    const b = await fetchBacking('NVDAx');
    expect(b.verified).toBe(false);
    if (b.verified) return;
    expect(b.reason).toMatch(/502/);
  });

  it('carries the executor’s own reason through when it has one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ok({ verified: false, symbol: 'NOPEx', reason: 'The attestation does not currently publish NOPEx.' })));

    const b = await fetchBacking('NOPEx');
    expect(b.verified).toBe(false);
    if (b.verified) return;
    expect(b.reason).toMatch(/does not currently publish NOPEx/);
  });

  it('refuses a "verified" body whose ratio is not a number', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ ...VERIFIED, ratio: 'lots' })));

    const b = await fetchBacking('NVDAx');
    // A claim of backing without a number behind it is not a claim of backing.
    expect(b.verified).toBe(false);
  });

  it('refuses a body with no verified flag at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ something: 'else' })));
    expect((await fetchBacking('NVDAx')).verified).toBe(false);
  });

  it('labels the three states without ever implying backing it has not read', () => {
    expect(backingLabel(VERIFIED)).toBe('1:1 backed');
    expect(backingLabel({ ...VERIFIED, fullyBacked: false, ratio: 0.97 })).toBe('Under-backed');
    expect(backingLabel({ verified: false, symbol: 'NVDAx', reason: 'x' })).toBe('Backing unverified');
  });

  it('escapes the symbol into the path', async () => {
    const fetchMock = vi.fn((_u: string) => Promise.resolve(ok(VERIFIED)));
    vi.stubGlobal('fetch', fetchMock);
    await fetchBacking('../admin');
    expect(fetchMock.mock.calls[0]![0]).toContain('%2F');
  });
});
