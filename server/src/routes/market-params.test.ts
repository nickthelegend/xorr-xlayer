/**
 * The market and yield routes, asked badly (docs/qa/ENDPOINTS.md E052, E101, E103, E108, E113, E219, E220).
 *
 * A request the caller has to change is refused by name before anything upstream is asked: a code in `error`, a
 * sentence in `detail`, 400 for what is malformed and 404 for what does not exist. Never a 404 with a hole where the
 * symbol should be, a 500 from a conversion that threw, or a 200 that words a failed query as "no readings yet". These
 * drive the real routes with the upstreams, the chain and the database stood in for.
 */
import { Hono } from 'hono';
import { decodeFunctionData, getAddress, maxUint256, parseAbi } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.XORR_CHAIN ??= 'xlayer-testnet';

vi.mock('../http/get.js', () => ({
  getJson: vi.fn(),
  staleValue: () => undefined,
  UpstreamUnavailable: class extends Error {},
}));
vi.mock('../db/index.js', () => ({ one: vi.fn(), query: vi.fn(), tx: vi.fn() }));
vi.mock('../evm/client.js', () => ({
  publicClient: { getCode: vi.fn(), readContract: vi.fn(), multicall: vi.fn() },
  delegateAccount: { address: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5' },
}));
vi.mock('../auth/privy.js', () => ({
  UnauthorizedError: class extends Error {
    readonly status = 401;
  },
  verifyToken: vi.fn(),
}));
vi.mock('./wallet-context.js', () => ({
  currentWallet: vi.fn(),
  requireWallet: vi.fn(),
  NoWalletError: class extends Error {},
}));
vi.mock('../market/yield.js', () => ({
  usdcSupplyYield: vi.fn(),
  usdcReserve: vi.fn(),
  aavePoolIsDeployedHere: vi.fn(),
}));
vi.mock('../market/edgar.js', () => ({ earningsCalendar: vi.fn() }));
vi.mock('../market/crosscheck.js', () => ({ crossCheck: vi.fn() }));
vi.mock('../evm/balances.js', () => ({ suppliedUsd: vi.fn() }));

const { getJson } = await import('../http/get.js');
const { query } = await import('../db/index.js');
const { currentWallet } = await import('./wallet-context.js');
const pool = await import('../market/yield.js');
const { earningsCalendar } = await import('../market/edgar.js');
const { crossCheck } = await import('../market/crosscheck.js');
const { market } = await import('./market.js');
const { errorResponse } = await import('../http/errors.js');

const app = new Hono();
// Signed in, as the auth middleware would have decided it.
app.use('*', async (c, next) => {
  c.set('user', { userId: 'did:privy:owner' } as never);
  await next();
});
app.onError(errorResponse);
app.route('/', market);

const OWNER = getAddress('0x95a0b368588713011a15f4b1041423f31b08e615');
const RESERVE = {
  apy: 0.04,
  pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  // A stand-in: the aToken is never read by the withdraw calldata, only the pool and the asset.
  aToken: '0x000000000000000000000000000000000000a70c',
  // X Layer's USDC, the reserve's asset.
  asset: '0xB6CEceAB302E2E4948951eE7843FC24E92933061',
};
const WITHDRAW = parseAbi(['function withdraw(address asset, uint256 amount, address to) returns (uint256)']);

async function call(path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(
    path,
    body === undefined
      ? undefined
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A refusal as this API writes one: a code a client can branch on, and a sentence for a person. */
function refused(r: { status: number; body: Record<string, unknown> }, status: number, code: string) {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body.error).toBe(code);
  expect(r.body.detail).toEqual(expect.stringMatching(/\w+ \w+/));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentWallet).mockResolvedValue({ id: 'wallet-1', address: OWNER } as never);
});

describe('GET /market/ohlc', () => {
  it('names a missing symbol, a symbol nothing prices and a days that is not a number, and asks no upstream', async () => {
    refused(await call('/market/ohlc'), 400, 'missing_symbol');

    const nope = await call('/market/ohlc?symbol=NOPE&days=1');
    refused(nope, 404, 'no_feed');
    expect(nope.body.detail).toContain('NOPE');

    refused(await call('/market/ohlc?symbol=BTC&days=abc'), 400, 'invalid_days');
    refused(await call('/market/ohlc?symbol=BTC&days=0'), 400, 'invalid_days');
    expect(getJson).not.toHaveBeenCalled();
  });
});

describe('GET /market/earnings', () => {
  it('names a missing symbol and a symbol that is not an equity, before reading any filing', async () => {
    refused(await call('/market/earnings'), 400, 'missing_symbol');
    const btc = await call('/market/earnings?symbol=BTC');
    refused(btc, 404, 'not_an_equity');
    expect(btc.body.detail).toContain('BTC');
    expect(earningsCalendar).not.toHaveBeenCalled();
  });

  it('tells a record with no entry (404) from one that could not be read (502), and names no source in either', async () => {
    vi.mocked(earningsCalendar).mockResolvedValueOnce(null);
    const none = await call('/market/earnings?symbol=nvdax');
    refused(none, 404, 'no_filings');
    // Asked under the registry's spelling, whatever the caller sent.
    expect(earningsCalendar).toHaveBeenCalledWith('NVDAx');

    vi.mocked(earningsCalendar).mockRejectedValueOnce(
      new Error('503 Service Unavailable for https://data.sec.gov/submissions/CIK0001045810.json'),
    );
    const down = await call('/market/earnings?symbol=NVDAx');
    refused(down, 502, 'filings_unavailable');

    for (const r of [none, down]) expect(JSON.stringify(r.body)).not.toMatch(/edgar|sec\.gov/i);
  });
});

describe('GET /market/stocks/history', () => {
  it('names a missing symbol and an hours that is not a number, and reads nothing', async () => {
    refused(await call('/market/stocks/history'), 400, 'missing_symbol');
    refused(await call('/market/stocks/history?symbol=WETH'), 404, 'not_an_equity');
    refused(await call('/market/stocks/history?symbol=NVDAx&hours=abc'), 400, 'invalid_hours');
    expect(query).not.toHaveBeenCalled();
  });

  it('answers a read that failed as a failure, never as "No readings yet"', async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error('invalid input syntax for type interval: "NaN hours"'));
    const r = await call('/market/stocks/history?symbol=NVDAx&hours=24');
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('No readings yet');
  });

  it('reads the hours asked for, held to a year', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ at: new Date('2026-09-13T10:00:00Z'), usd: '181.5' }] as never);
    const r = await call('/market/stocks/history?symbol=NVDAx&hours=99999');
    expect(r.status).toBe(200);
    expect(vi.mocked(query).mock.calls[0]![1]).toEqual(['NVDAx', String(24 * 365)]);
    expect(r.body.points).toEqual([{ at: Date.parse('2026-09-13T10:00:00Z'), usd: 181.5 }]);
  });
});

describe('GET /market/crosscheck', () => {
  it('names a missing symbol, and asks neither price source', async () => {
    refused(await call('/market/crosscheck'), 400, 'missing_symbol');
    expect(crossCheck).not.toHaveBeenCalled();
  });
});

describe('POST /yield/withdraw-calldata', () => {
  beforeEach(() => {
    vi.mocked(pool.aavePoolIsDeployedHere).mockResolvedValue(true);
    vi.mocked(pool.usdcReserve).mockResolvedValue(RESERVE as never);
  });

  it('refuses an amount that is not dollars above zero before converting it or reading the chain', async () => {
    for (const usd of ['abc', 0, -5, '', true, [1]]) {
      refused(await call('/yield/withdraw-calldata', { usd }), 400, 'invalid_amount');
    }
    expect(pool.aavePoolIsDeployedHere).not.toHaveBeenCalled();
    expect(pool.usdcReserve).not.toHaveBeenCalled();

    // Above zero, and less than the smallest unit a pool pays out.
    refused(await call('/yield/withdraw-calldata', { usd: 0.0000001 }), 400, 'invalid_amount');
  });

  it('refuses where no pool is deployed, rather than hand the wallet calldata for an address with no code', async () => {
    vi.mocked(pool.aavePoolIsDeployedHere).mockResolvedValue(false);
    refused(await call('/yield/withdraw-calldata', { usd: null }), 409, 'aave_not_deployed');
    expect(pool.usdcReserve).not.toHaveBeenCalled();
  });

  it('answers a pool check that failed as a failed chain read, never as "no pool"', async () => {
    vi.mocked(pool.aavePoolIsDeployedHere).mockRejectedValue(new Error('rpc down'));
    const r = await call('/yield/withdraw-calldata', { usd: 5 });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('chain_read_failed');
  });

  it('where a pool exists, builds withdraw() to the owner: everything for null, exact units for an amount', async () => {
    const all = await call('/yield/withdraw-calldata', { usd: null });
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ to: RESERVE.pool, isMax: true });
    expect(decodeFunctionData({ abi: WITHDRAW, data: all.body.data as `0x${string}` }).args).toEqual([
      RESERVE.asset,
      maxUint256,
      OWNER,
    ]);

    const five = await call('/yield/withdraw-calldata', { usd: '5' });
    expect(five.body).toMatchObject({ isMax: false });
    expect(decodeFunctionData({ abi: WITHDRAW, data: five.body.data as `0x${string}` }).args).toEqual([
      RESERVE.asset,
      5_000_000n,
      OWNER,
    ]);
  });
});
