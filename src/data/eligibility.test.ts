/**
 * Unknown is not permission.
 *
 * Every failure path here must end in `eligible: false`, because the screen gates a buy button on
 * it — and a wallet the issuer would refuse must not be offered a trade because our request
 * timed out.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { fetchEligibility, mayBuy } from './eligibility';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const ELIGIBLE = {
  symbol: 'NVDAx',
  wallet: 'W',
  mint: 'M',
  eligible: true,
  indeterminate: false,
  checks: [],
  summary: 'Nothing on this mint blocks the transfer.',
  permanentDelegate: null,
};

describe('xStock eligibility, as the app reads it', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes an eligible wallet through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(ELIGIBLE)));
    const e = await fetchEligibility('NVDAx', 'W');
    expect(e.eligible).toBe(true);
    expect(mayBuy(e)).toBe(true);
  });

  it('refuses to offer a buy when the executor is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const e = await fetchEligibility('NVDAx', 'W');
    expect(e.eligible).toBe(false);
    expect(e.indeterminate).toBe(true);
    expect(mayBuy(e)).toBe(false);
  });

  it('refuses on a non-OK status, quoting it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const e = await fetchEligibility('NVDAx', 'W');
    expect(e.eligible).toBe(false);
    expect(e.summary).toMatch(/503/);
  });

  it('carries a real refusal through verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({
      ...ELIGIBLE,
      eligible: false,
      indeterminate: false,
      summary: 'The issuer has paused all transfers of this token. No buy can settle until it is unpaused.',
      checks: [{ id: 'mint-paused', title: 'Transfers paused', status: 'blocked', detail: 'paused' }],
    })));

    const e = await fetchEligibility('NVDAx', 'W');
    expect(mayBuy(e)).toBe(false);
    expect(e.indeterminate).toBe(false);
    expect(e.summary).toMatch(/paused all transfers/);
  });

  it('treats an unreadable body as unknown rather than permission', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ nonsense: true })));
    expect(mayBuy(await fetchEligibility('NVDAx', 'W'))).toBe(false);
  });

  it('never lets a missing answer count as permission', () => {
    expect(mayBuy(undefined)).toBe(false);
  });

  it('escapes both the symbol and the wallet into the request', async () => {
    const fetchMock = vi.fn((_u: string) => Promise.resolve(ok(ELIGIBLE)));
    vi.stubGlobal('fetch', fetchMock);
    await fetchEligibility('../admin', 'a b');
    const url = fetchMock.mock.calls[0]![0];
    expect(url).toContain('%2F');
    expect(url).toContain('wallet=a%20b');
  });
});
