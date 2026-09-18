import { describe, expect, it, vi, beforeEach } from 'vitest';

const oneMock = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>();

vi.mock('../db/index.js', () => ({
  one: (sql: string, p?: unknown[]) => oneMock(sql, p),
  query: vi.fn(async () => []),
}));
const sleevesForMock = vi.fn();
vi.mock('../positions/sleeves.js', () => ({ sleevesFor: (...a: unknown[]) => sleevesForMock(...a) }));

const { explainTrade } = await import('./explain.js');

const RECORD = {
  symbol: 'NVDAx',
  strategyKind: 'momentum',
  persona: 'momentum-scout',
  personaName: 'Momentum Scout',
  score: 94,
  usd: 25,
  units: 0.1154,
  price: 216.5,
  stopPrice: 205,
  targetPrice: 240,
  signature: '5K3ySig',
  slot: 289412950,
  opening: 'The band held, so it took the break.',
  reason: 'NVDAx is trading in the top quarter of the recorded band.',
  marketCondition: 'Upper band, 95th percentile of observed range',
  multiplier: 1,
  pendingMultiplier: null,
  pendingEffectiveAtMs: null,
  nasdaqSession: 'regular',
  spreadBps: 12,
  slippageBps: 50,
  exitStrategyId: 'exit-1',
  decidedAtMs: 1_760_000_000_000,
  proposalId: 'prop-1',
};

const row = (payload: Record<string, unknown>) => ({
  seq: '42',
  at: new Date('2026-09-17T10:00:00Z'),
  agent: 'Momentum Scout',
  kind: 'trade',
  signature: '5K3ySig',
  payload,
});

describe('explaining a trade from the trail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oneMock.mockResolvedValue(null);
    sleevesForMock.mockResolvedValue({
      symbol: 'NVDAx',
      sleeves: [],
      heldUnits: 0,
      attributedUnits: 0,
      unattributedUnits: 0,
      overAttributedUnits: 0,
    });
  });

  it('reads the decision record back off the row', async () => {
    oneMock.mockResolvedValue(row(RECORD));

    const out = await explainTrade('wallet-1', '42');
    expect(out?.status).toBe('explained');
    if (out?.status !== 'explained') throw new Error('expected an explanation');
    expect(out.record.symbol).toBe('NVDAx');
    expect(out.record.score).toBe(94);
    expect(out.record.marketCondition).toContain('95th percentile');
    expect(out.signature).toBe('5K3ySig');
    expect(out.at).toBe('2026-09-17T10:00:00.000Z');
  });

  /*
   * Most rows in `audit_log` carry something else entirely — a run id, a strategy id, a raw error.
   * Casting one of those to a record hands the screen an object full of `undefined`, which renders
   * as a confident page of blanks.
   */
  it('reports no record rather than a page of blanks for another kind of row', async () => {
    oneMock.mockResolvedValue(row({ runId: 'run-9', strategyId: 'strat-3', released: true }));

    const out = await explainTrade('wallet-1', '42');
    expect(out?.status).toBe('no_record');
    expect(out).not.toHaveProperty('record');
  });

  it('refuses a payload that is only partly a record', async () => {
    const { score: _score, ...missingScore } = RECORD;
    oneMock.mockResolvedValue(row(missingScore));

    const out = await explainTrade('wallet-1', '42');
    expect(out?.status).toBe('no_record');
  });

  it('keeps the row identity even when there is nothing to explain', async () => {
    oneMock.mockResolvedValue(row({ runId: 'run-9' }));

    const out = await explainTrade('wallet-1', '42');
    expect(out).toMatchObject({ seq: '42', agent: 'Momentum Scout', kind: 'trade' });
  });

  /*
   * The audit sequence is a global counter. Scoping has to happen in the query, or
   * `/activity/8/explain` becomes a way to read another wallet's trade.
   */
  it('scopes the read to the wallet in the query itself', async () => {
    await explainTrade('wallet-1', '42');
    const [sql, params] = oneMock.mock.calls[0] ?? [];
    expect(sql).toContain('wallet_id = $1');
    expect(params).toEqual(['wallet-1', '42']);
  });

  it('answers null for a sequence this wallet does not have', async () => {
    oneMock.mockResolvedValue(null);
    expect(await explainTrade('wallet-1', '999')).toBeNull();
  });

  it('does not reach the database for a sequence that is not a number', async () => {
    expect(await explainTrade('wallet-1', '1; DROP TABLE audit_log')).toBeNull();
    expect(await explainTrade('wallet-1', 'abc')).toBeNull();
    expect(oneMock).not.toHaveBeenCalled();
  });
});

describe('the trade, in the context of what else holds the symbol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oneMock.mockResolvedValue(row(RECORD));
    sleevesForMock.mockResolvedValue({
      symbol: 'NVDAx',
      sleeves: [
        { source: 'agent', sourceId: 'p1', label: 'Momentum Scout', units: 0.11, costUsd: 25, openedAt: 1 },
        { source: 'strategy', sourceId: 's1', label: 'Recurring buy', units: 4, costUsd: 800, openedAt: 2 },
      ],
      heldUnits: 4.11,
      attributedUnits: 4.11,
      unattributedUnits: 0,
      overAttributedUnits: 0,
    });
  });

  /*
   * Several strategies can stack on one token, so "the agent bought NVDAx" is half an answer. The
   * other half is what else is in there.
   */
  it('carries the sleeve breakdown for the symbol it traded', async () => {
    const out = await explainTrade('wallet-1', '42');
    if (out?.status !== 'explained') throw new Error('expected an explanation');

    expect(sleevesForMock).toHaveBeenCalledWith('wallet-1', 'NVDAx');
    expect(out.sleeves?.sleeves.map((s) => s.label)).toEqual(['Momentum Scout', 'Recurring buy']);
  });

  /*
   * An empty breakdown says "nothing else holds this symbol", which is a claim. A failed read is
   * the absence of one, and must not be dressed as the other.
   */
  it('reports null rather than an empty breakdown when the read fails', async () => {
    sleevesForMock.mockRejectedValue(new Error('db down'));

    const out = await explainTrade('wallet-1', '42');
    if (out?.status !== 'explained') throw new Error('expected an explanation');
    expect(out.sleeves).toBeNull();
    // The explanation itself still stands: the decision record does not depend on the breakdown.
    expect(out.record.symbol).toBe('NVDAx');
  });
});
