/**
 * Tier 4's legs through the real `runStrategy` (PLAN.md P2.14).
 *
 * A direct leg — supplying USDT0 to Aave on X Layer — spends the intent's own in-token through `spend()`, under the cap
 * in that token's 6-decimal units; it is recorded as a supply, not a buy, and takes the supplied USDT0 off the book.
 * A chain with no lending pool is a blocked run that says so, with nothing signed. The planner, the settlement choice,
 * the chain and the database are replaced by recorders.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  statements: [] as { text: string; params: unknown[] }[],
  bookedUsdt0: null as string | null,
}));

vi.mock('../db/index.js', () => {
  const record = (text: string, params: unknown[] = []) => h.statements.push({ text, params });
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      record(text, params);
      if (/INSERT INTO strategy_runs/.test(text)) return { rows: [{ id: 'run-1' }] };
      if (/SELECT units FROM positions/.test(text)) return { rows: h.bookedUsdt0 === null ? [] : [{ units: h.bookedUsdt0 }] };
      return { rows: [] };
    },
  };
  return {
    tx: async (fn: (c: typeof client) => Promise<unknown>) => fn(client),
    query: async (text: string, params: unknown[] = []) => {
      record(text, params);
      return [];
    },
    one: async (text: string, params: unknown[] = []) => {
      record(text, params);
      if (/FROM wallets/.test(text)) return { address: '0x95A0b368588713011a15f4b1041423f31B08e615' };
      return undefined;
    },
  };
});
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
vi.mock('../notifications/push.js', () => ({ send: vi.fn(async () => ({ sent: 0, skipped: 0, errors: [] })) }));
vi.mock('../rules/engine.js', () => ({
  evaluate: vi.fn(async () => ({ allowed: true, remainingUsd: 2_000 })),
  recordSpend: vi.fn(),
}));
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn(async () => 1) }));
vi.mock('../evm/gas.js', () => ({ gasStatus: vi.fn(async () => ({ enough: true })) }));
vi.mock('../evm/client.js', () => ({
  publicClient: {},
  walletClient: {},
  delegateAccount: { address: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5' },
}));
vi.mock('../evm/delegation.js', () => ({
  readPolicy: vi.fn(async () => ({
    delegate: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5',
    dailyCapUsd: 2_000,
    expiresAt: Date.now() + 86_400_000,
    revoked: false,
    remainingTodayUsd: 2_000,
    spentTodayUsd: 0,
  })),
  spendAsDelegate: vi.fn(async () => `0x${'cd'.repeat(32)}`),
  closeAsDelegate: vi.fn(async () => `0x${'ab'.repeat(32)}`),
  waitForTx: vi.fn(async () => true),
  usdToUnits: vi.fn((usd: number) => BigInt(Math.round(usd * 1_000_000))),
  DELEGATION_ADDRESS: '0x6c5528Fd8E74a047A85bAb413856A9239E73540e',
}));
vi.mock('../positions/index.js', () => ({ applyFill: vi.fn(async () => undefined) }));
vi.mock('./fill-measure.js', () => ({
  estimateOutUnits: vi.fn(async () => undefined),
  rawBalanceOf: vi.fn(async () => 0n),
  measuredDelta: vi.fn(),
  usdcRawOf: vi.fn(async () => 5_000_000_000n),
  proceedsSince: vi.fn(),
}));
vi.mock('./settle.js', () => ({ chooseSettlement: vi.fn() }));
vi.mock('../portfolio/snapshots.js', () => ({ snapshotWallet: vi.fn(async () => true) }));
vi.mock('./kinds/index.js', () => {
  class PlanRefused extends Error {
    constructor(
      readonly reason: string,
      detail: string,
    ) {
      super(detail);
    }
  }
  return { PLANNERS: { 'yield-rotation': vi.fn() }, PlanRefused, observationFor: vi.fn(async () => null) };
});

const { recordSpend } = await import('../rules/engine.js');
const { spendAsDelegate } = await import('../evm/delegation.js');
const { applyFill } = await import('../positions/index.js');
const { measuredDelta } = await import('./fill-measure.js');
const { chooseSettlement } = await import('./settle.js');
const { PLANNERS, PlanRefused } = await import('./kinds/index.js');
const { runStrategy } = await import('./run.js');
type StrategyRow = import('./run.js').StrategyRow;

const at = new Date('2026-09-19T09:00:00Z');
const POOL = '0xE3F3Caefdd7180F884c01E57f65Df979Af84f116';
const USDT0 = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
const A_USDT0 = '0xF356ae412dB5df43BD3a10746f7ad4e1C4De4297';
const USDC = '0xB6CEceAB302E2E4948951eE7843FC24E92933061';
const ROUTER = '0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA';

const strategy = (): StrategyRow =>
  ({
    id: 'strategy-4',
    wallet_id: 'wallet-1',
    kind: 'yield-rotation',
    state: 'live',
    label: 'Idle cash to Aave',
    symbol: 'USDC',
    params: { keepCashUsd: 25 } as never,
    cadence: 'daily',
    next_run_at: new Date(at.getTime() - 60_000),
    daily_allocation_usd: '500',
    retry_attempts: 0,
    created_at: new Date('2026-09-01T00:00:00Z'),
  }) as unknown as StrategyRow;

const filledUpdate = () => h.statements.find((s) => /SET status='filled'/.test(s.text));
const planner = () => vi.mocked(PLANNERS['yield-rotation']!);

beforeEach(() => {
  h.statements.length = 0;
  h.bookedUsdt0 = null;
  vi.clearAllMocks();
});

describe('the supply leg', () => {
  beforeEach(() => {
    planner().mockResolvedValue({
      inSymbol: 'USDT0',
      outSymbol: 'aUSDT0',
      amountIn: 120.5,
      usd: 120.5,
      because: '3.48% a year on USDT0 from Aave v3 on X Layer, and this USDT0 was sitting idle.',
      direct: { venue: POOL, data: '0x617ba037', unitPriceUsd: 1, tokenOut: A_USDT0, minOut: 120_487_950n },
    });
    vi.mocked(chooseSettlement).mockResolvedValue({
      payToken: { address: USDT0, decimals: 6 },
      swap: { to: POOL, data: '0x617ba037' },
      venue: 'aave',
      floor: { tokenOut: A_USDT0, minOut: 120_487_950n },
    });
  });

  it('spends USDT0 — the intent’s in-token — at the pool, under the cap, and records a supply', async () => {
    const out = await runStrategy(strategy(), at);
    expect(out.status).toBe('filled');

    expect(spendAsDelegate).toHaveBeenCalledWith(
      expect.objectContaining({ token: USDT0, venue: POOL, usd: 120.5, data: '0x617ba037', tokenOut: A_USDT0, minOut: 120_487_950n }),
    );
    // What `spend()` was told it pulls: the same 6-decimal figure the calldata supplies.
    expect(vi.mocked(chooseSettlement).mock.calls[0]![0].send).toEqual({ via: 'spend', amount: 120_500_000n });
    // run, signature, units, price, usd, quoted_units, venue, side, quoted_usd, asset_class
    expect(filledUpdate()!.params.slice(2)).toEqual([120.5, 1, 120.5, 120.5, 'aave', 'supply', null, 'crypto']);
    // Supplying is spending: it counts against the day like any outflow.
    expect(recordSpend).toHaveBeenCalledTimes(1);
    // No swap delta is measured for a supply.
    expect(measuredDelta).not.toHaveBeenCalled();
  });

  it('takes the supplied USDT0 off the book when the book holds it (from tier 4’s own swap)', async () => {
    h.bookedUsdt0 = '150';
    await runStrategy(strategy(), at);
    expect(vi.mocked(applyFill).mock.calls.map((c) => c[1])).toEqual([
      expect.objectContaining({ symbol: 'USDT0', units: -120.5, usd: -120.5 }),
    ]);
  });

  it('books nothing for USDT0 the book never held, and never books the receipt token', async () => {
    await runStrategy(strategy(), at);
    expect(applyFill).not.toHaveBeenCalled();
  });
});

describe('the swap leg', () => {
  it('is an ordinary buy of USDT0 paid in USDC, booked as a position', async () => {
    planner().mockResolvedValue({
      inSymbol: 'USDC',
      outSymbol: 'USDT0',
      amountIn: 150,
      amountInRaw: 150_000_000n,
      usd: 150,
      because: 'Aave v3 on X Layer pays 3.48% a year on USDT0 and 0.00% on USDC, so this idle USDC is swapped to USDT0 first; the next run supplies it.',
    });
    vi.mocked(chooseSettlement).mockResolvedValue({
      payToken: { address: USDC, decimals: 6 },
      swap: { to: ROUTER, data: '0xb858183f' },
      venue: 'uniswap-v3',
      floor: { tokenOut: USDT0, minOut: 149_500_000n },
    });
    vi.mocked(measuredDelta).mockResolvedValue(149.98);

    expect((await runStrategy(strategy(), at)).status).toBe('filled');
    expect(spendAsDelegate).toHaveBeenCalledWith(expect.objectContaining({ token: USDC, venue: ROUTER, usd: 150, tokenOut: USDT0 }));
    expect(filledUpdate()!.params.slice(6, 8)).toEqual(['uniswap-v3', 'buy']);
    expect(vi.mocked(applyFill).mock.calls[0]![1]).toMatchObject({ symbol: 'USDT0', units: 149.98, usd: 150 });
  });
});

describe('a chain with no lending pool', () => {
  it('is a blocked run naming the reason, with nothing signed and nothing spent', async () => {
    planner().mockRejectedValue(
      new PlanRefused('no_lending_pool', 'There is no lending pool on X Layer Testnet, so idle cash cannot be put to work here. Nothing moved.'),
    );
    const out = await runStrategy(strategy(), at);
    expect(out).toMatchObject({ status: 'blocked', reason: 'no_lending_pool' });
    expect(spendAsDelegate).not.toHaveBeenCalled();
    expect(recordSpend).not.toHaveBeenCalled();
    expect(filledUpdate()).toBeUndefined();
  });
});
