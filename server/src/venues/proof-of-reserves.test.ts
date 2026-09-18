/**
 * The property under test is refusal: an xStock whose backing cannot be read must say so, rather
 * than report a plausible-looking 1.0. A fabricated backing ratio on a tokenized-equity app is
 * the one number a judge can check against the issuer in ten seconds.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { backingFor, readAllBacking, clearBackingCache } from './proof-of-reserves.js';

vi.mock('../db/index.js', () => ({ query: vi.fn(async () => []) }));

const page = (nodes: unknown[], hasNextPage = false) => ({
  ok: true,
  status: 200,
  json: async () => ({ nodes, page: { hasNextPage } }),
});

const NVDAX = {
  symbol: 'NVDAx',
  timestamp: '2026-09-17T07:02:05.244Z',
  sharesHeld: '186898',
  circulatingSupply: '186692.75074178688',
  holdings: [{ provider: 'Alpaca', quantity: '186898', symbol: 'NVDA' }],
};

describe('xStocks proof of reserves', () => {
  beforeEach(() => clearBackingCache());
  afterEach(() => vi.unstubAllGlobals());

  it('reports the measured backing ratio for a symbol the attestor publishes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page([NVDAX])));

    const res = await backingFor('NVDAx');
    expect(res.status).toBe('verified');
    if (res.status !== 'verified') return;

    expect(res.backing.sharesHeld).toBe(186898);
    expect(res.backing.circulatingSupply).toBeCloseTo(186692.75074178688, 6);
    // 186898 / 186692.75… — fully backed, very slightly over.
    expect(res.backing.ratio).toBeCloseTo(1.0010993, 6);
    expect(res.backing.ratio).toBeGreaterThan(1);
    expect(res.backing.custodians).toEqual([
      { provider: 'Alpaca', quantity: 186898, symbol: 'NVDA' },
    ]);
    // The attestor's own observation time, not ours.
    expect(res.backing.asOf).toBe('2026-09-17T07:02:05.244Z');
  });

  it('says unverified — never 1.0 — when the endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const res = await backingFor('NVDAx');
    expect(res.status).toBe('unverified');
    if (res.status !== 'unverified') return;
    expect(res.reason).toMatch(/ECONNREFUSED/);
    expect(JSON.stringify(res)).not.toMatch(/"ratio"/);
  });

  it('says unverified when the endpoint answers with an error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));

    const res = await backingFor('NVDAx');
    expect(res.status).toBe('unverified');
    if (res.status !== 'unverified') return;
    expect(res.reason).toMatch(/503/);
  });

  it('says unverified for a symbol the attestation does not carry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page([NVDAX])));

    const res = await backingFor('TSLAx');
    expect(res.status).toBe('unverified');
    if (res.status !== 'unverified') return;
    expect(res.reason).toMatch(/does not currently publish TSLAx/);
  });

  it('drops rows with no circulating supply rather than dividing by zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      page([{ ...NVDAX, symbol: 'ZEROx', circulatingSupply: '0' }, NVDAX])));

    const res = await backingFor('ZEROx');
    expect(res.status).toBe('unverified');
    // The well-formed row on the same page still reads.
    expect((await backingFor('NVDAx')).status).toBe('verified');
  });

  it('walks every page while the attestor says there is another', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page([NVDAX], true))
      .mockResolvedValueOnce(page([{ ...NVDAX, symbol: 'TSLAx' }], false));
    vi.stubGlobal('fetch', fetchMock);

    const all = await readAllBacking();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...all.keys()].sort()).toEqual(['NVDAx', 'TSLAx']);
  });

  it('reads upstream once for concurrent callers', async () => {
    const fetchMock = vi.fn(async () => page([NVDAX]));
    vi.stubGlobal('fetch', fetchMock);

    const [a, b, c] = await Promise.all([backingFor('NVDAx'), backingFor('NVDAx'), backingFor('NVDAx')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([a.status, b.status, c.status]).toEqual(['verified', 'verified', 'verified']);
  });

  it('keeps the freshest attestation when a symbol repeats', async () => {
    const older = { ...NVDAX, timestamp: '2026-09-16T00:00:00.000Z', sharesHeld: '1' };
    vi.stubGlobal('fetch', vi.fn(async () => page([older, NVDAX])));

    const res = await backingFor('NVDAx');
    expect(res.status).toBe('verified');
    if (res.status !== 'verified') return;
    expect(res.backing.asOf).toBe(NVDAX.timestamp);
    expect(res.backing.sharesHeld).toBe(186898);
  });

  it('sends a User-Agent, which the endpoint requires', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(page([NVDAX])));
    vi.stubGlobal('fetch', fetchMock);
    await readAllBacking();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/proof-of-reserves');
    expect((init?.headers as Record<string, string>)['User-Agent']).toMatch(/xorr/);
  });
});
