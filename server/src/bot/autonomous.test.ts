import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';

const oneMock = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>();
const queryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>();
const evaluateMock = vi.fn();
const readDelegationMock = vi.fn();
const guardAndSpendMock = vi.fn();
const armExitsMock = vi.fn();
const notifyEntryMock = vi.fn();
const earningsCalendarMock = vi.fn();
const xStockPriceMock = vi.fn<(symbol: string) => Promise<number | null>>();
const referencePriceMock = vi.fn<(symbol: string) => Promise<number | null>>();
const readMintScaleMock = vi.fn();
const appendMock = vi.fn();

/*
 * Four xStocks rather than main's eleven, so a test asserting "it picked NVDAx" is asserting a
 * ranking rather than the contents of the registry.
 */
vi.mock('../venues/xstocks.js', () => ({
  XSTOCKS: {
    NVDAx: { symbol: 'NVDAx', name: 'NVIDIA', address: 'Xsc9NVDA', decimals: 8 },
    TSLAx: { symbol: 'TSLAx', name: 'Tesla', address: 'XsDoTSLA', decimals: 8 },
    AAPLx: { symbol: 'AAPLx', name: 'Apple', address: 'XsbEAAPL', decimals: 8 },
    MSFTx: { symbol: 'MSFTx', name: 'Microsoft', address: 'XspzMSFT', decimals: 8 },
  },
  xStockPriceUsd: (symbol: string) => xStockPriceMock(symbol),
}));

// The session arithmetic and the drift thresholds stay real; only the second price source is faked.
vi.mock('../market/nasdaq.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./../market/nasdaq.js')>()),
  referencePriceUsd: (symbol: string) => referencePriceMock(symbol),
}));

const applyFillMock = vi.fn();

vi.mock('../db/index.js', () => ({
  one: (sql: string, params?: unknown[]) => oneMock(sql, params),
  query: (sql: string, params?: unknown[]) => queryMock(sql, params),
  // The cycle books its fill inside a transaction; the client is never touched by these tests.
  tx: (fn: (c: unknown) => unknown) => fn({}),
}));
vi.mock('../positions/index.js', () => ({ applyFill: (...a: unknown[]) => applyFillMock(...a) }));

vi.mock('../rules/engine.js', () => ({ evaluate: (...a: unknown[]) => evaluateMock(...a) }));
vi.mock('../solana/delegation.js', () => ({
  readDelegation: (...a: unknown[]) => readDelegationMock(...a),
}));
vi.mock('../solana/balances.js', () => ({
  readMintScale: (...a: unknown[]) => readMintScaleMock(...a),
}));
vi.mock('../executor/place.js', () => ({
  guardAndSpend: (...a: unknown[]) => guardAndSpendMock(...a),
}));
vi.mock('../executor/order.js', () => ({ armExits: (...a: unknown[]) => armExitsMock(...a) }));
vi.mock('../notifications/alerts.js', () => ({
  notifyEntry: (...a: unknown[]) => notifyEntryMock(...a),
}));
vi.mock('../market/edgar.js', () => ({
  earningsCalendar: (...a: unknown[]) => earningsCalendarMock(...a),
}));
vi.mock('../audit/log.js', () => ({ append: (...a: unknown[]) => appendMock(...a) }));
vi.mock('./llm.js', () => ({ speak: vi.fn(async () => ({ ok: true, text: 'Optimal entry setup.' })) }));

const { evaluateBestSetup, runAutonomousCycle, autonomousAgentSweep, AGENT_DECISION } =
  await import('./autonomous.js');
const { RISK_SETTINGS, settingsFor } = await import('./risk-profile.js');

const OWNER = Keypair.generate().publicKey.toBase58();

/** Wednesday 11:00 ET — Nasdaq regular hours, so the off-hours guard is not the thing under test. */
const REGULAR_HOURS = new Date('2026-10-14T15:00:00Z');
/** Saturday 14:00 ET — the exchange is shut. */
const WEEKEND = new Date('2026-10-17T18:00:00Z');

const FILL = {
  placed: true as const,
  signature: '5K3yTestAutonomousEntrySignature',
  slot: 289412950,
  inUnits: 25_000_000n,
  outUnits: 11_540_000n,
  filledUnits: 0.1154,
  fillPrice: 216.5,
  symbol: 'NVDAx',
  usd: 25,
  side: 'buy' as const,
};

/** `n` readings spanning `low`..`high`, ending on `last` — the shape `price_observations` returns. */
function readings(low: number, high: number, last: number, n = 8) {
  const span = Array.from({ length: n - 1 }, (_, i) => low + ((high - low) * i) / (n - 2));
  return [...span, last].map((usd) => ({ usd: String(usd) }));
}

describe('autonomous xStocks trading agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(REGULAR_HOURS);

    queryMock.mockResolvedValue([]);
    oneMock.mockResolvedValue(null);
    earningsCalendarMock.mockResolvedValue(null);
    /*
     * 238 against the `readings(200, 240, ...)` band the range tests use, so the default symbol
     * sits in the upper quarter. The band position is taken from the LIVE quote, not the newest
     * stored reading — the quote is what a trade would be sized against.
     */
    xStockPriceMock.mockResolvedValue(238);
    referencePriceMock.mockResolvedValue(238);
    readMintScaleMock.mockResolvedValue({ decimals: 8, multiplier: 1, pending: null });
    appendMock.mockResolvedValue({ seq: '1' });
    applyFillMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('evaluateBestSetup', () => {
    it('picks the event-driven setup when a report is projected inside the window', async () => {
      earningsCalendarMock.mockImplementation(async (symbol: string) =>
        symbol === 'NVDAx'
          ? { symbol, cik: 1045810, reported: [], nextAt: Date.now() + 6 * 86_400_000, gapDays: [], medianGapDays: 91, errorDays: 2 }
          : null,
      );

      const best = await evaluateBestSetup();
      if (!best) throw new Error('expected a setup');
      expect(best.symbol).toBe('NVDAx');
      expect(best.strategyKind).toBe('event-driven');
      expect(best.persona).toBe('earnings-desk');
      expect(best.score).toBeGreaterThanOrEqual(90);
      expect(best.stopPrice).toBeLessThan(best.currentPrice);
      expect(best.targetPrice).toBeGreaterThan(best.currentPrice);
      expect(best.reason).toContain('give or take 2');
    });

    /*
     * A five-day window drawn around a date that could be eight days out is not a window. The
     * projection's own error decides whether it is tradeable, and EDGAR reports that error.
     */
    it('ignores a projected report whose error is wider than the window', async () => {
      earningsCalendarMock.mockImplementation(async (symbol: string) =>
        symbol === 'NVDAx'
          ? { symbol, cik: 1045810, reported: [], nextAt: Date.now() + 6 * 86_400_000, gapDays: [], medianGapDays: 91, errorDays: 9 }
          : null,
      );

      const best = await evaluateBestSetup();
      expect(best?.strategyKind).not.toBe('event-driven');
    });

    it('scores momentum off the readings the app has actually recorded', async () => {
      queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (!sql.includes('price_observations')) return [];
        return Array.isArray(params) && params[0] === 'TSLAx' ? readings(200, 240, 238) : [];
      });
      xStockPriceMock.mockImplementation(async (s) => (s === 'TSLAx' ? 238 : 216.5));
      referencePriceMock.mockImplementation(async (s) => (s === 'TSLAx' ? 238 : 216.5));


      const best = await evaluateBestSetup();
      expect(best?.symbol).toBe('TSLAx');
      expect(best?.strategyKind).toBe('momentum');
      expect(best?.reason).toContain('$200.00-$240.00');
    });

    /*
     * The band comes from the stored readings; where we sit in it comes from the live quote. A
     * symbol whose recorded history is all near the high but which is quoted near the low right
     * now is a dip, and reading the position off the newest stored row would have called it a
     * breakout.
     */
    it('positions the live quote in the band, not the newest stored reading', async () => {
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );
      xStockPriceMock.mockResolvedValue(205);
      referencePriceMock.mockResolvedValue(205);

      const best = await evaluateBestSetup();
      expect(best?.strategyKind).toBe('dca');
      expect(best?.currentPrice).toBe(205);
    });

    /*
     * The bug the synthetic ±8% range hid: with no recorded history there is no band, so neither
     * range strategy has anything to say. It used to say "upper band" about every asset on earth.
     */
    it('produces no candidate at all when there is no price history and no earnings window', async () => {
      expect(await evaluateBestSetup()).toBeNull();
    });

    it('needs more than a couple of readings before it will call something a range', async () => {
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? [{ usd: '200' }, { usd: '240' }] : [],
      );
      expect(await evaluateBestSetup()).toBeNull();
    });

    it('skips a symbol whose off-hours drift cannot be measured', async () => {
      vi.setSystemTime(WEEKEND);
      referencePriceMock.mockResolvedValue(null);
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );

      expect(await evaluateBestSetup()).toBeNull();
    });

    it('carries the chain-read multiplier and the session verdict onto the setup', async () => {
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );

      const best = await evaluateBestSetup();
      expect(best?.corporateAction.multiplier).toBe(1);
      expect(best?.corporateAction.pending).toBeNull();
      expect(best?.offHoursGuard.session).toBe('regular');
      expect(best?.suggestedSlippageBps).toBe(50);
    });

    /*
     * A scheduled multiplier change is a reason not to open anything on that symbol, not a reason
     * to prefer something else on it. A markdown still lets the candidate win on a quiet day,
     * which is exactly the entry the markdown was warning about.
     */
    it('stands the symbol down entirely when a multiplier change is inside the window', async () => {
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );

      const undisturbed = await evaluateBestSetup();
      expect(undisturbed?.strategyKind).toBe('momentum');

      readMintScaleMock.mockResolvedValue({
        decimals: 8,
        multiplier: 1,
        pending: { nextMultiplier: 2, effectiveAtMs: Date.now() + 12 * 3_600_000 },
      });

      // Every symbol is affected alike here, so there is nothing left to pick.
      expect(await evaluateBestSetup()).toBeNull();
    });

    it('stands down even when the setup would otherwise be the strongest on offer', async () => {
      earningsCalendarMock.mockImplementation(async (symbol: string) =>
        symbol === 'NVDAx'
          ? { symbol, cik: 1045810, reported: [], nextAt: Date.now() + 6 * 86_400_000, gapDays: [], medianGapDays: 91, errorDays: 2 }
          : null,
      );
      readMintScaleMock.mockImplementation(async (mint: string) =>
        mint === 'Xsc9NVDA'
          ? {
              decimals: 8,
              multiplier: 1,
              pending: { nextMultiplier: 2, effectiveAtMs: Date.now() + 6 * 3_600_000 },
            }
          : { decimals: 8, multiplier: 1, pending: null },
      );

      const best = await evaluateBestSetup();
      expect(best?.symbol).not.toBe('NVDAx');
    });

    /* A change far enough out says nothing about today, and must not cost the symbol its turn. */
    it('leaves the symbol tradable when the multiplier change is outside the window', async () => {
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );

      const undisturbed = await evaluateBestSetup();
      if (!undisturbed) throw new Error('expected a setup');

      readMintScaleMock.mockResolvedValue({
        decimals: 8,
        multiplier: 1,
        pending: { nextMultiplier: 2, effectiveAtMs: Date.now() + 10 * 86_400_000 },
      });

      const later = await evaluateBestSetup();
      expect(later?.score).toBe(undisturbed.score);
      expect(later?.corporateAction.pending?.nextMultiplier).toBe(2);
    });

    /*
     * The band comes from the stored readings; where we sit in it comes from the live quote. A
     * symbol whose recorded history is all near the high but which is quoted near the low right
     * now is a dip, and reading the position off the newest stored row would have called it a
     * breakout.
     */
    it('positions the live quote in the band, not the newest stored reading', async () => {
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );
      xStockPriceMock.mockResolvedValue(205);
      referencePriceMock.mockResolvedValue(205);

      const best = await evaluateBestSetup();
      expect(best?.strategyKind).toBe('dca');
      expect(best?.currentPrice).toBe(205);
    });

    /*
     * The bug the synthetic ±8% range hid: with no recorded history there is no band, so neither
     * range strategy has anything to say. It used to say "upper band" about every asset on earth.
     */
    it('produces no candidate at all when there is no price history and no earnings window', async () => {
      expect(await evaluateBestSetup()).toBeNull();
    });

    it('needs more than a couple of readings before it will call something a range', async () => {
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? [{ usd: '200' }, { usd: '240' }] : [],
      );
      expect(await evaluateBestSetup()).toBeNull();
    });

    it('skips a symbol whose off-hours drift cannot be measured', async () => {
      vi.setSystemTime(WEEKEND);
      referencePriceMock.mockResolvedValue(null);
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );

      expect(await evaluateBestSetup()).toBeNull();
    });

    it('carries the chain-read multiplier and the session verdict onto the setup', async () => {
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );

      const best = await evaluateBestSetup();
      expect(best?.corporateAction.multiplier).toBe(1);
      expect(best?.corporateAction.pending).toBeNull();
      expect(best?.offHoursGuard.session).toBe('regular');
      expect(best?.suggestedSlippageBps).toBe(50);
    });

  });

  describe('runAutonomousCycle', () => {
    it('refuses when the wallet has agents stopped by the kill switch', async () => {
      oneMock.mockResolvedValue({ id: 'wallet-1', address: OWNER, agents_stopped: true });

      const result = await runAutonomousCycle('wallet-1');
      expect(result.executed).toBe(false);
      if (!result.executed) expect(result.reason).toBe('agents_stopped');
      expect(guardAndSpendMock).not.toHaveBeenCalled();
    });

    it('refuses when the on-chain SPL delegation is revoked', async () => {
      oneMock.mockResolvedValue({ id: 'wallet-1', address: OWNER, agents_stopped: false });
      readDelegationMock.mockResolvedValue({ delegatedUsd: 500, isRevoked: true });

      const result = await runAutonomousCycle('wallet-1');
      expect(result.executed).toBe(false);
      if (!result.executed) expect(result.reason).toBe('delegation_revoked');
      expect(guardAndSpendMock).not.toHaveBeenCalled();
    });

    it('executes through guardAndSpend, arms exits, writes a proposal and notifies', async () => {
      oneMock.mockResolvedValue({ id: 'wallet-1', address: OWNER, agents_stopped: false });
      readDelegationMock.mockResolvedValue({ delegatedUsd: 1000, isRevoked: false });
      evaluateMock.mockResolvedValue({ allowed: true, spentTodayUsd: 0, remainingUsd: 800 });
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );
      guardAndSpendMock.mockResolvedValue(FILL);
      armExitsMock.mockResolvedValue({ strategyId: 'strat-exit-123', sentence: 'Exit set' });

      const result = await runAutonomousCycle('wallet-1', { fixedUsd: 25 });
      expect(result.executed).toBe(true);
      if (result.executed) {
        expect(result.receipt.signature).toBe(FILL.signature);
        expect(result.exitStrategyId).toBe('strat-exit-123');
        expect(result.proposalId).toBeDefined();
      }

      expect(guardAndSpendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: 'wallet-1',
          ownerPubkey: OWNER,
          usd: 25,
          side: 'buy',
          slippageBps: 50,
        }),
      );
      expect(armExitsMock).toHaveBeenCalledTimes(1);
      // Exits hang off the price it filled at, not the price the setup was written at.
      expect(armExitsMock.mock.calls[0]?.[1]).toMatchObject({ entryPrice: FILL.fillPrice });

      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO proposals'),
        expect.arrayContaining(['wallet-1']),
      );
      expect(notifyEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: 'wallet-1',
          notionalUsd: 25,
          signature: FILL.signature,
          units: FILL.filledUnits,
          price: FILL.fillPrice,
        }),
      );
    });

    /*
     * The setup a caller hands in is the setup that gets placed. Re-scanning here would mean the
     * trade could differ from the one the caller had just shown somebody and been told to take.
     */
    it('places the setup the caller brought instead of scanning for a new one', async () => {
      oneMock.mockResolvedValue({ id: 'wallet-1', address: OWNER, agents_stopped: false });
      readDelegationMock.mockResolvedValue({ delegatedUsd: 1000, isRevoked: false });
      evaluateMock.mockResolvedValue({ allowed: true, spentTodayUsd: 0, remainingUsd: 800 });
      guardAndSpendMock.mockResolvedValue(FILL);
      armExitsMock.mockResolvedValue({ strategyId: 'exit-1', sentence: 'Exit set' });

      // No readings and no earnings, so a fresh scan would find nothing at all.
      queryMock.mockResolvedValue([]);
      expect(await evaluateBestSetup()).toBeNull();

      const chosen = {
        symbol: 'AAPLx',
        stock: { symbol: 'AAPLx', name: 'Apple', address: 'XsbEAAPL', decimals: 8, sector: 'Technology' as const },
        strategyKind: 'dca' as const,
        persona: 'yield-keeper' as const,
        personaName: 'Yield Keeper',
        score: 72,
        currentPrice: 190,
        stopPrice: 174.8,
        targetPrice: 209,
        reason: 'Handed in by the caller.',
        marketCondition: 'Lower band',
        corporateAction: { multiplier: 1, pending: null, hoursUntil: null },
        offHoursGuard: {
          session: 'regular' as const,
          spreadBps: 0,
          spreadPct: 0,
          action: 'normal' as const,
          suggestedSlippageBps: 50,
          reason: 'Nasdaq regular hours.',
        },
        suggestedSlippageBps: 50,
      };

      const result = await runAutonomousCycle('wallet-1', { fixedUsd: 25, setup: chosen });
      expect(result.executed).toBe(true);
      expect(guardAndSpendMock).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: 'AAPLx', usd: 25 }),
      );
    });

    /*
     * A fill that never reaches `audit_log` did not happen as far as the app is concerned:
     * Activity is the one screen whose whole promise is showing what the agents did, and
     * `/agent/explain` starts from a row on it. `guardAndSpend` does not write one.
     */
    it('puts the fill on the audit trail, carrying the signature', async () => {
      oneMock.mockResolvedValue({ id: 'wallet-1', address: OWNER, agents_stopped: false });
      readDelegationMock.mockResolvedValue({ delegatedUsd: 1000, isRevoked: false });
      evaluateMock.mockResolvedValue({ allowed: true, spentTodayUsd: 0, remainingUsd: 800 });
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );
      guardAndSpendMock.mockResolvedValue(FILL);
      armExitsMock.mockResolvedValue({ strategyId: 'exit-1', sentence: 'Exit set' });

      await runAutonomousCycle('wallet-1', { fixedUsd: 25 });

      expect(appendMock).toHaveBeenCalledTimes(1);
      const entry = appendMock.mock.calls[0]?.[0];
      expect(entry).toMatchObject({
        walletId: 'wallet-1',
        kind: 'trade',
        signature: FILL.signature,
        amount: '$25.00',
      });
      expect(entry.action).toContain(FILL.symbol);
      // The whole decision record rides along, so explaining the trade needs no second lookup.
      expect(entry.payload).toMatchObject({
        symbol: FILL.symbol,
        strategyKind: 'momentum',
        signature: FILL.signature,
        slippageBps: 50,
        exitStrategyId: 'exit-1',
      });
      expect(typeof entry.payload.proposalId).toBe('string');
    });

    /*
     * `proposals.decision` is a CHECK column. Writing a word it does not allow means Postgres
     * refuses the row, and the refusal was being logged and stepped over — so the record this
     * whole feature reads back was never there, and the sweep's cooldown never matched.
     */
    it('stores the decision under a word the proposals constraint accepts', async () => {
      oneMock.mockResolvedValue({ id: 'wallet-1', address: OWNER, agents_stopped: false });
      readDelegationMock.mockResolvedValue({ delegatedUsd: 1000, isRevoked: false });
      evaluateMock.mockResolvedValue({ allowed: true, spentTodayUsd: 0, remainingUsd: 800 });
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );
      guardAndSpendMock.mockResolvedValue(FILL);
      armExitsMock.mockResolvedValue({ strategyId: 'exit-1', sentence: 'Exit set' });

      await runAutonomousCycle('wallet-1', { fixedUsd: 25 });

      const insert = queryMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO proposals'));
      if (!insert) throw new Error('expected a proposal insert');
      expect(insert[0]).not.toContain("'approved'");
      expect(insert[1]).toContain(AGENT_DECISION);
    });

    /*
     * The fill has to reach the book, or the agent moves real money into a position the app cannot
     * see: Holdings shows nothing, P&L counts nothing, and the sleeve breakdown has nothing to
     * attribute. Found by driving the demo path on the fork and reading the tables afterwards.
     */
    it('books the fill into the position ledger, attributed to the agent', async () => {
      oneMock.mockResolvedValue({ id: 'wallet-1', address: OWNER, agents_stopped: false });
      readDelegationMock.mockResolvedValue({ delegatedUsd: 1000, isRevoked: false });
      evaluateMock.mockResolvedValue({ allowed: true, spentTodayUsd: 0, remainingUsd: 800 });
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );
      guardAndSpendMock.mockResolvedValue(FILL);
      armExitsMock.mockResolvedValue({ strategyId: 'exit-1', sentence: 'Exit set' });

      await runAutonomousCycle('wallet-1', { fixedUsd: 25 });

      expect(applyFillMock).toHaveBeenCalledTimes(1);
      const booked = applyFillMock.mock.calls[0]?.[1];
      expect(booked).toMatchObject({
        walletId: 'wallet-1',
        symbol: FILL.symbol,
        units: FILL.filledUnits,
        usd: FILL.usd,
      });
      expect(booked.attribution).toMatchObject({ source: 'agent', label: 'Momentum Scout' });
      // The proposal that decided it, so the sleeve names the run rather than a live strategy.
      expect(typeof booked.attribution.id).toBe('string');
    });

    /* A sale is negative units, or the book would count a close as another buy. */
    it('books a sale as negative units', async () => {
      oneMock.mockResolvedValue({ id: 'wallet-1', address: OWNER, agents_stopped: false });
      readDelegationMock.mockResolvedValue({ delegatedUsd: 1000, isRevoked: false });
      evaluateMock.mockResolvedValue({ allowed: true, spentTodayUsd: 0, remainingUsd: 800 });
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );
      guardAndSpendMock.mockResolvedValue({ ...FILL, side: 'sell' });
      armExitsMock.mockResolvedValue({ strategyId: 'exit-1', sentence: 'Exit set' });

      await runAutonomousCycle('wallet-1', { fixedUsd: 25 });

      const booked = applyFillMock.mock.calls[0]?.[1];
      expect(booked.units).toBe(-FILL.filledUnits);
      expect(booked.usd).toBe(-FILL.usd);
    });

    /*
     * `guardAndSpend` answers with a refusal as readily as a receipt, and a refusal is not a fill:
     * nothing downstream of it — exits, proposal, notification — may run.
     */
    it('reports the chokepoint refusal without arming exits or notifying', async () => {
      oneMock.mockResolvedValue({ id: 'wallet-1', address: OWNER, agents_stopped: false });
      readDelegationMock.mockResolvedValue({ delegatedUsd: 1000, isRevoked: false });
      evaluateMock.mockResolvedValue({ allowed: true, spentTodayUsd: 0, remainingUsd: 800 });
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );
      guardAndSpendMock.mockResolvedValue({
        placed: false,
        status: 'blocked',
        reason: 'spread_too_wide',
        detail: 'The route moved more than the guard allows.',
      });

      const result = await runAutonomousCycle('wallet-1', { fixedUsd: 25 });
      expect(result.executed).toBe(false);
      if (!result.executed) expect(result.reason).toBe('spread_too_wide');
      expect(armExitsMock).not.toHaveBeenCalled();
      expect(notifyEntryMock).not.toHaveBeenCalled();
    });
  });

  /*
   * The setting has to CHANGE something, or it is a label. Each of these drives one knob to the
   * point where the same market reads differently to a careful agent and an aggressive one.
   */
  describe('the risk profile changes what the agent will take', () => {
    it('lets an aggressive agent take a move a conservative one will not', async () => {
      // 78th percentile: past balanced's 0.75 and aggressive's 0.65, short of conservative's 0.85.
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );
      xStockPriceMock.mockResolvedValue(231.2);
      referencePriceMock.mockResolvedValue(231.2);

      expect(await evaluateBestSetup(settingsFor('conservative'))).toBeNull();
      expect((await evaluateBestSetup(settingsFor('balanced')))?.strategyKind).toBe('momentum');
      expect((await evaluateBestSetup(settingsFor('aggressive')))?.strategyKind).toBe('momentum');
    });

    it('lets an aggressive agent accumulate a dip a conservative one leaves alone', async () => {
      // 30th percentile: inside balanced's 0.4 and aggressive's 0.5, outside conservative's 0.25.
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 212) : [],
      );
      xStockPriceMock.mockResolvedValue(212);
      referencePriceMock.mockResolvedValue(212);

      expect(await evaluateBestSetup(settingsFor('conservative'))).toBeNull();
      expect((await evaluateBestSetup(settingsFor('balanced')))?.strategyKind).toBe('dca');
    });

    it('requires more recorded history before a careful agent trusts a band', async () => {
      // Five readings: enough for balanced (6)? No — and not for conservative (10) either.
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238, 5) : [],
      );

      expect(await evaluateBestSetup(settingsFor('conservative'))).toBeNull();
      expect(await evaluateBestSetup(settingsFor('balanced'))).toBeNull();
      // Aggressive needs only four, so the same five readings are a band it will act on.
      expect((await evaluateBestSetup(settingsFor('aggressive')))?.strategyKind).toBe('momentum');
    });

    it('keeps a careful agent further clear of a scheduled corporate action', async () => {
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );
      // 72 hours out: inside conservative's 96, outside balanced's 48 and aggressive's 24.
      readMintScaleMock.mockResolvedValue({
        decimals: 8,
        multiplier: 1,
        pending: { nextMultiplier: 2, effectiveAtMs: Date.now() + 72 * 3_600_000 },
      });

      expect(await evaluateBestSetup(settingsFor('conservative'))).toBeNull();
      expect((await evaluateBestSetup(settingsFor('balanced')))?.strategyKind).toBe('momentum');
      expect((await evaluateBestSetup(settingsFor('aggressive')))?.strategyKind).toBe('momentum');
    });

    it('accepts a looser earnings projection the more aggressive it is', async () => {
      earningsCalendarMock.mockImplementation(async (symbol: string) =>
        symbol === 'NVDAx'
          ? { symbol, cik: 1045810, reported: [], nextAt: Date.now() + 6 * 86_400_000, gapDays: [], medianGapDays: 91, errorDays: 4 }
          : null,
      );

      // errorDays 4: past conservative's 1 and balanced's 3, inside aggressive's 5.
      expect(await evaluateBestSetup(settingsFor('conservative'))).toBeNull();
      expect(await evaluateBestSetup(settingsFor('balanced'))).toBeNull();
      expect((await evaluateBestSetup(settingsFor('aggressive')))?.strategyKind).toBe(
        'event-driven',
      );
    });
  });

  describe('the profile reaches the trade and the record', () => {
    const readyWallet = (profile?: string) => {
      oneMock.mockResolvedValue({
        id: 'wallet-1',
        address: OWNER,
        agents_stopped: false,
        ...(profile === undefined ? {} : { risk_profile: profile }),
      });
      readDelegationMock.mockResolvedValue({ delegatedUsd: 1000, isRevoked: false });
      evaluateMock.mockResolvedValue({ allowed: true, spentTodayUsd: 0, remainingUsd: 800 });
      // Twelve readings, so even conservative's ten-observation floor has a band to work with.
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238, 12) : [],
      );
      guardAndSpendMock.mockResolvedValue(FILL);
      armExitsMock.mockResolvedValue({ strategyId: 'exit-1', sentence: 'Exit set' });
    };

    it('sizes the entry from the profile rather than a fixed default', async () => {
      readyWallet('aggressive');
      await runAutonomousCycle('wallet-1');
      expect(guardAndSpendMock).toHaveBeenCalledWith(
        expect.objectContaining({ usd: RISK_SETTINGS.aggressive.maxTradeUsd }),
      );

      vi.clearAllMocks();
      appendMock.mockResolvedValue({ seq: '1' });
    applyFillMock.mockResolvedValue(undefined);
      readMintScaleMock.mockResolvedValue({ decimals: 8, multiplier: 1, pending: null });
      xStockPriceMock.mockResolvedValue(238);
      referencePriceMock.mockResolvedValue(238);
      earningsCalendarMock.mockResolvedValue(null);
      readyWallet('conservative');
      await runAutonomousCycle('wallet-1');
      expect(guardAndSpendMock).toHaveBeenCalledWith(
        expect.objectContaining({ usd: RISK_SETTINGS.conservative.maxTradeUsd }),
      );
    });

    /*
     * Stored, not looked up when the trade is explained. The setting is a thing the user can
     * change, and reading it at explain time would caption last week's careful trade with this
     * week's aggressive profile — describing a decision that was never made.
     */
    it('writes the profile that was active into the decision record', async () => {
      readyWallet('conservative');
      await runAutonomousCycle('wallet-1');

      expect(appendMock.mock.calls[0]?.[0].payload).toMatchObject({
        riskProfile: 'conservative',
      });
    });

    /*
     * A row written by a newer deploy, or by hand. Refusing to run would be a worse failure than
     * running carefully, and the record must name the profile that was actually APPLIED.
     */
    it('falls back for a profile this build does not know, and says which it used', async () => {
      readyWallet('reckless');
      const result = await runAutonomousCycle('wallet-1');

      expect(result.executed).toBe(true);
      expect(appendMock.mock.calls[0]?.[0].payload).toMatchObject({ riskProfile: 'balanced' });
    });

    it('treats a wallet with no profile column as the default', async () => {
      readyWallet(undefined);
      await runAutonomousCycle('wallet-1');
      expect(appendMock.mock.calls[0]?.[0].payload).toMatchObject({ riskProfile: 'balanced' });
    });
  });

  describe('autonomousAgentSweep', () => {
    it('iterates eligible wallets and honours the per-wallet cooldown', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM wallets')) {
          return [{ id: 'wallet-active-1' }, { id: 'wallet-active-2' }];
        }
        if (sql.includes('price_observations')) return readings(200, 240, 238);
        return [];
      });

      oneMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        const id = Array.isArray(params) ? params[0] : undefined;
        if (sql.includes('FROM proposals')) {
          // Parameterised on the decision word now, so the cooldown matches what the agent writes.
          expect(params).toContain(AGENT_DECISION);
          return id === 'wallet-active-1' ? { id: 'recent-prop-id' } : null;
        }
        if (sql.includes('FROM wallets')) {
          return { id, address: OWNER, agents_stopped: false, risk_profile: 'balanced' };
        }
        return null;
      });

      readDelegationMock.mockResolvedValue({ delegatedUsd: 1000, isRevoked: false });
      evaluateMock.mockResolvedValue({ allowed: true, spentTodayUsd: 0, remainingUsd: 500 });
      guardAndSpendMock.mockResolvedValue({ ...FILL, signature: '5K3ySweepSig' });
      armExitsMock.mockResolvedValue({ strategyId: 'exit-1', sentence: 'Exit set' });

      expect(await autonomousAgentSweep()).toBe(1);
    });
  });
});
