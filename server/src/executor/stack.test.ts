import { describe, expect, it, vi, beforeEach } from 'vitest';

const queryMock = vi.fn<(sql: string, p?: unknown[]) => Promise<unknown[]>>();

vi.mock('../db/index.js', () => ({ query: (sql: string, p?: unknown[]) => queryMock(sql, p) }));
vi.mock('../db/chain-scope.js', () => ({ THIS_CHAIN: `'solana-fork'` }));

const { claimedSellUnits, sellableUnits, stackOn, stackSummary } = await import('./stack.js');

const strategyRow = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  kind: 'dca',
  label: 'Recurring buy',
  state: 'live',
  daily_allocation_usd: '25',
  next_run_at: new Date('2026-09-18T00:00:00Z'),
  ...over,
});

describe('sellableUnits', () => {
  it('leaves what the rest of the stack has not spoken for', () => {
    expect(sellableUnits(10, 4)).toBe(6);
    expect(sellableUnits(10, 0)).toBe(10);
  });

  /*
   * A claim larger than the balance means the others have already sold everything. The answer is
   * zero units to sell, not a negative quantity to be arithmetic'd into a buy somewhere downstream.
   */
  it('never returns a negative quantity', () => {
    expect(sellableUnits(10, 12)).toBe(0);
    expect(sellableUnits(10, 10)).toBe(0);
  });

  it('treats a nonsense balance as nothing to sell', () => {
    expect(sellableUnits(0, 0)).toBe(0);
    expect(sellableUnits(-1, 0)).toBe(0);
    expect(sellableUnits(Number.NaN, 0)).toBe(0);
  });

  it('ignores a negative claim rather than turning it into extra units', () => {
    expect(sellableUnits(10, -5)).toBe(10);
  });
});

describe('claimedSellUnits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue([]);
  });

  it('adds up what the siblings have committed', async () => {
    queryMock.mockResolvedValue([{ units: '3' }, { units: '1.5' }]);
    expect(await claimedSellUnits('w1', 'NVDAc', 's1')).toBe(4.5);
  });

  /*
   * A pending run has claimed its period and may have broadcast. Treating it as zero is exactly
   * how a second stop sells units the first has already sent to the chain.
   */
  it('counts runs still in flight, not only settled ones', async () => {
    await claimedSellUnits('w1', 'NVDAc', 's1');
    const [sql] = queryMock.mock.calls[0] ?? [];
    expect(sql).toContain("r.status IN ('pending','filled')");
  });

  it('leaves out runs that never sold anything', async () => {
    const [sql] = (await claimedSellUnits('w1', 'NVDAc', 's1'), queryMock.mock.calls[0] ?? []);
    expect(sql).not.toContain('failed');
    expect(sql).not.toContain('blocked');
  });

  it('asks only about sells, and only about this symbol', async () => {
    await claimedSellUnits('w1', 'NVDAc', 's1');
    const [sql, params] = queryMock.mock.calls[0] ?? [];
    expect(sql).toContain("r.side = 'sell'");
    expect(params).toEqual(['w1', 'NVDAc', 's1', '30']);
  });

  /* Its own in-flight run is not a claim against itself. */
  it('excludes the asking strategy', async () => {
    await claimedSellUnits('w1', 'NVDAc', 's1');
    const [sql] = queryMock.mock.calls[0] ?? [];
    expect(sql).toContain('s.id <> $3');
  });

  /*
   * A sale from last week is already reflected in the balance this is compared against, so
   * counting it again would subtract it twice.
   */
  it('looks only at the window the balance may not have caught up with', async () => {
    await claimedSellUnits('w1', 'NVDAc', 's1');
    const [sql] = queryMock.mock.calls[0] ?? [];
    expect(sql).toContain("started_at > now() - ($4 || ' minutes')::interval");
  });

  it('reads a failed lookup as no claim rather than throwing into the run', async () => {
    queryMock.mockRejectedValue(new Error('db down'));
    expect(await claimedSellUnits('w1', 'NVDAc', 's1')).toBe(0);
  });

  it('ignores a row with no units recorded', async () => {
    queryMock.mockResolvedValue([{ units: null }, { units: '2' }]);
    expect(await claimedSellUnits('w1', 'NVDAc', 's1')).toBe(2);
  });
});

describe('stackOn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue([]);
  });

  it('lists the live strategies on a symbol', async () => {
    queryMock.mockResolvedValue([strategyRow(), strategyRow({ id: 's2', kind: 'exit-rules', daily_allocation_usd: '0' })]);
    const stack = await stackOn('w1', 'NVDAc');

    expect(stack.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(stack[0]).toMatchObject({ kind: 'dca', dailyAllocationUsd: 25, closeOnly: false });
    expect(stack[1]).toMatchObject({ kind: 'exit-rules', closeOnly: true });
  });

  /* Reading a stack, the question is what is BUILDING the position before what is protecting it. */
  it('puts the strategies that can open before the ones that only close', async () => {
    queryMock.mockResolvedValue([
      strategyRow({ id: 'exit', kind: 'exit-rules' }),
      strategyRow({ id: 'buy', kind: 'dca' }),
    ]);
    expect((await stackOn('w1', 'NVDAc')).map((s) => s.id)).toEqual(['buy', 'exit']);
  });

  it('carries a missing next run as null rather than a date of zero', async () => {
    queryMock.mockResolvedValue([strategyRow({ next_run_at: null })]);
    expect((await stackOn('w1', 'NVDAc'))[0]?.nextRunAt).toBeNull();
  });

  it('asks only for the states that can still act', async () => {
    await stackOn('w1', 'NVDAc');
    const [sql] = queryMock.mock.calls[0] ?? [];
    expect(sql).toContain("state IN ('live','watch')");
  });
});

describe('stackSummary', () => {
  const open = { id: 'a', kind: 'dca', label: '', state: 'live', dailyAllocationUsd: 25, nextRunAt: null, closeOnly: false };
  const close = { id: 'b', kind: 'exit-rules', label: '', state: 'live', dailyAllocationUsd: 0, nextRunAt: null, closeOnly: true };

  it('sums what the stack commits per day', () => {
    expect(stackSummary([open, { ...open, id: 'c', dailyAllocationUsd: 10 }, close])).toEqual({
      opening: 2,
      closeOnly: 1,
      dailyCommitmentUsd: 35,
    });
  });

  /*
   * A stop-loss commits nothing, and adding its zero to the total would suggest it had been
   * considered and found to cost nothing rather than not applying.
   */
  it('counts the close-only strategies apart from the commitment', () => {
    expect(stackSummary([close, close])).toEqual({ opening: 0, closeOnly: 2, dailyCommitmentUsd: 0 });
  });

  it('is empty for an empty stack', () => {
    expect(stackSummary([])).toEqual({ opening: 0, closeOnly: 0, dailyCommitmentUsd: 0 });
  });
});
