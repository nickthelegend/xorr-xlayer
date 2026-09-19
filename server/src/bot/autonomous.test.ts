import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const oneMock = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>();
const queryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>();
const evaluateMock = vi.fn();
const readPolicyMock = vi.fn();
const placeOrderMock = vi.fn();
const armExitsMock = vi.fn();
const notifyEntryMock = vi.fn();
const earningsCalendarMock = vi.fn();
const xStockPriceMock = vi.fn<(symbol: string) => Promise<number | null>>();
const referencePriceMock = vi.fn<(symbol: string) => Promise<number | null>>();
/**
 * The corporate-action state of one wrapped xStock, keyed by its WRAPPER address: the multiplier
 * `convertToAssets(1e18)` answers, and a change the raw token has scheduled (or null).
 */
const scaleMock = vi.fn<
  (wrapper: string) => Promise<{ multiplier: number; pending: { nextMultiplier: number; effectiveAtMs: number } | null }>
>();
const appendMock = vi.fn();

/*
 * Four xStocks rather than main's eleven, so a test asserting "it picked NVDAx" is asserting a
 * ranking rather than the contents of the registry.
 */
const NVDA_WRAPPER = '0xa8ddb5cd96b5222afe198316e9a57caa642850d5';
const STOCKS = {
  NVDAx: { symbol: 'NVDAx', name: 'NVIDIA', ticker: 'NVDA', address: NVDA_WRAPPER, raw: '0xc845b2894dBddd03858fd2D643B4eF725fE0849d', decimals: 18 },
  TSLAx: { symbol: 'TSLAx', name: 'Tesla', ticker: 'TSLA', address: '0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171', raw: '0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0', decimals: 18 },
  AAPLx: { symbol: 'AAPLx', name: 'Apple', ticker: 'AAPL', address: '0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f', raw: '0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a', decimals: 18 },
  MSFTx: { symbol: 'MSFTx', name: 'Microsoft', ticker: 'MSFT', address: '0x166fbe68274b6a47e025f4ba17388c539f1fa1d0', raw: '0x5621737f42dAE558b81269FcB9E9E70c19Aa6b35', decimals: 18 },
};
vi.mock('../venues/xstocks.js', () => ({
  XSTOCKS: STOCKS,
  xStockPriceUsd: (symbol: string) => xStockPriceMock(symbol),
}));

/*
 * The chain, as the two contracts per xStock answer it: the ERC-4626 wrapper's `convertToAssets`
 * and the raw token's `newMultiplier` / `newMultiplierActivationTime`. Driven by `scaleMock`.
 */
const readContractMock = vi.fn(async (req: { address: string; functionName: string; args?: readonly unknown[] }) => {
  const byWrapper = Object.values(STOCKS).find((s) => s.address === req.address);
  const byRaw = Object.values(STOCKS).find((s) => s.raw === req.address);
  if (req.functionName === 'convertToAssets' && byWrapper) {
    const { multiplier } = await scaleMock(byWrapper.address);
    expect(req.args?.[0]).toBe(10n ** 18n);
    return BigInt(Math.round(multiplier * 1e6)) * 10n ** 12n;
  }
  if (byRaw) {
    const { multiplier, pending } = await scaleMock(byRaw.address);
    if (req.functionName === 'newMultiplier') {
      return BigInt(Math.round((pending?.nextMultiplier ?? multiplier) * 1e6)) * 10n ** 12n;
    }
    if (req.functionName === 'newMultiplierActivationTime') {
      return BigInt(Math.floor((pending?.effectiveAtMs ?? 0) / 1000));
    }
  }
  throw new Error(`unexpected read ${req.functionName} on ${req.address}`);
});
vi.mock('../evm/client.js', () => ({
  publicClient: { readContract: (req: never) => readContractMock(req) },
}));

// The session arithmetic and the drift thresholds stay real; only the second price source is faked.
vi.mock('../market/nasdaq.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./../market/nasdaq.js')>()),
  referencePriceUsd: (symbol: string) => referencePriceMock(symbol),
}));

vi.mock('../db/index.js', () => ({
  one: (sql: string, params?: unknown[]) => oneMock(sql, params),
  query: (sql: string, params?: unknown[]) => queryMock(sql, params),
}));

vi.mock('../rules/engine.js', () => ({ evaluate: (...a: unknown[]) => evaluateMock(...a) }));
vi.mock('../evm/delegation.js', () => ({
  readPolicy: (...a: unknown[]) => readPolicyMock(...a),
}));
vi.mock('../executor/order.js', () => ({
  armExits: (...a: unknown[]) => armExitsMock(...a),
  placeOrder: (...a: unknown[]) => placeOrderMock(...a),
}));
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

const OWNER = '0x1111111111111111111111111111111111111111';

/** Wednesday 11:00 ET — Nasdaq regular hours, so the off-hours guard is not the thing under test. */
const REGULAR_HOURS = new Date('2026-10-14T15:00:00Z');
/** Saturday 14:00 ET — the exchange is shut. */
const WEEKEND = new Date('2026-10-17T18:00:00Z');

/** What `placeOrder` answers for a one-shot buy that settled. */
const FILL = {
  signature: '0x5a3e0000000000000000000000000000000000000000000000000000000000aa',
  runId: 'run-1',
  filledUnits: 0.1154,
  fillPrice: 216.5,
  symbol: 'NVDAx',
  usd: 25,
};
const FILLED = {
  placed: true as const,
  orderId: 'order-1',
  outcome: { status: 'filled' as const, runId: FILL.runId, signature: FILL.signature, units: FILL.filledUnits, price: FILL.fillPrice },
};

/** A live XorrDelegation policy, as `readPolicy` returns it. */
function livePolicy(overrides: Record<string, unknown> = {}) {
  return {
    delegate: '0x2222222222222222222222222222222222222222',
    dailyCapUsd: 1000,
    expiresAt: Date.now() + 30 * 86_400_000,
    revoked: false,
    remainingTodayUsd: 1000,
    spentTodayUsd: 0,
    ...overrides,
  };
}

/** `n` readings spanning `low`..`high`, ending on `last` — the shape `price_observations` returns. */
function readings(low: number, high: number, last: number, n = 8) {
  const span = Array.from({ length: n - 1 }, (_, i) => low + ((high - low) * i) / (n - 2));
  return [...span, last].map((usd) => ({ usd: String(usd) }));
}

/** The decision record the agent stored on its proposal row — where the explain screen reads the why. */
function proposalRecord(): Record<string, unknown> | undefined {
  const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO proposals'));
  return insert ? JSON.parse(String((insert[1] as unknown[])[3])) : undefined;
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
    scaleMock.mockResolvedValue({ multiplier: 1, pending: null });
    appendMock.mockResolvedValue({ seq: '1' });
    readPolicyMock.mockResolvedValue(livePolicy());
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

    /* The multiplier is the ERC-4626 wrapper's own `convertToAssets(1e18)`, read on X Layer. */
    it('reads the multiplier from the wrapped xStock, not from a default', async () => {
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );
      scaleMock.mockResolvedValue({ multiplier: 1.0525, pending: null });

      const best = await evaluateBestSetup();
      expect(best?.corporateAction.multiplier).toBeCloseTo(1.0525, 6);
      expect(readContractMock).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'convertToAssets', address: best?.stock.address }),
      );
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

      scaleMock.mockResolvedValue({
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
      scaleMock.mockImplementation(async (wrapper: string) =>
        wrapper === NVDA_WRAPPER
          ? { multiplier: 1, pending: { nextMultiplier: 2, effectiveAtMs: Date.now() + 6 * 3_600_000 } }
          : { multiplier: 1, pending: null },
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

      scaleMock.mockResolvedValue({
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
    /** A wallet that is ready to trade, with a momentum setup on the table. */
    const ready = () => {
      oneMock.mockResolvedValue({ id: 'wallet-1', address: OWNER, agents_stopped: false });
      evaluateMock.mockResolvedValue({ allowed: true, spentTodayUsd: 0, remainingUsd: 800 });
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238) : [],
      );
      placeOrderMock.mockResolvedValue(FILLED);
      armExitsMock.mockResolvedValue({ strategyId: 'exit-1', sentence: 'Exit set' });
    };

    it('refuses when the wallet has agents stopped by the kill switch', async () => {
      oneMock.mockResolvedValue({ id: 'wallet-1', address: OWNER, agents_stopped: true });

      const result = await runAutonomousCycle('wallet-1');
      expect(result.executed).toBe(false);
      if (!result.executed) expect(result.reason).toBe('agents_stopped');
      expect(placeOrderMock).not.toHaveBeenCalled();
    });

    it('refuses when the on-chain XorrDelegation policy is revoked', async () => {
      ready();
      readPolicyMock.mockResolvedValue(livePolicy({ revoked: true }));

      const result = await runAutonomousCycle('wallet-1');
      expect(result.executed).toBe(false);
      if (!result.executed) expect(result.reason).toBe('delegation_revoked');
      expect(readPolicyMock).toHaveBeenCalledWith(OWNER);
      expect(placeOrderMock).not.toHaveBeenCalled();
    });

    it('refuses when no permission was ever granted', async () => {
      ready();
      readPolicyMock.mockResolvedValue(null);

      const result = await runAutonomousCycle('wallet-1');
      expect(result).toMatchObject({ executed: false, reason: 'no_delegation' });
      expect(placeOrderMock).not.toHaveBeenCalled();
    });

    it('refuses when the permission has expired', async () => {
      ready();
      readPolicyMock.mockResolvedValue(livePolicy({ expiresAt: Date.now() - 1 }));

      const result = await runAutonomousCycle('wallet-1');
      expect(result).toMatchObject({ executed: false, reason: 'delegation_expired' });
      expect(placeOrderMock).not.toHaveBeenCalled();
    });

    it("refuses when today's on-chain cap is used up", async () => {
      ready();
      readPolicyMock.mockResolvedValue(livePolicy({ remainingTodayUsd: 0, spentTodayUsd: 1000 }));

      const result = await runAutonomousCycle('wallet-1');
      expect(result).toMatchObject({ executed: false, reason: 'daily_cap' });
      expect(placeOrderMock).not.toHaveBeenCalled();
    });

    /*
     * The Solana version read the delegation with `.catch(() => null)` and sized against a $1,000
     * default when it came back empty. A permission that cannot be read is not a permission.
     */
    it('refuses when the permission cannot be read, rather than assuming a cap', async () => {
      ready();
      readPolicyMock.mockRejectedValue(new Error('rpc timeout'));

      const result = await runAutonomousCycle('wallet-1');
      expect(result).toMatchObject({ executed: false, reason: 'delegation_unreadable' });
      expect(evaluateMock).not.toHaveBeenCalled();
      expect(placeOrderMock).not.toHaveBeenCalled();
    });

    it('refuses a wallet whose address is not an X Layer address', async () => {
      ready();
      oneMock.mockResolvedValue({ id: 'wallet-1', address: 'So1anaPubkey1111111111111111111111', agents_stopped: false });

      const result = await runAutonomousCycle('wallet-1');
      expect(result).toMatchObject({ executed: false, reason: 'no_wallet' });
      expect(readPolicyMock).not.toHaveBeenCalled();
      expect(placeOrderMock).not.toHaveBeenCalled();
    });

    /*
     * The fail-open bug (PLAN.md G-SEC2): the chokepoint caught a rules-engine error into
     * `allowed: true`, so a database blip let a trade through unchecked. It must refuse.
     */
    it('fails closed when the rules engine throws', async () => {
      ready();
      evaluateMock.mockRejectedValue(new Error('connection terminated'));

      const result = await runAutonomousCycle('wallet-1', { fixedUsd: 25 });
      expect(result.executed).toBe(false);
      if (!result.executed) {
        expect(result.reason).toBe('rules_unavailable');
        expect(result.detail).toContain('could not be checked');
      }
      expect(placeOrderMock).not.toHaveBeenCalled();
      expect(armExitsMock).not.toHaveBeenCalled();
      expect(appendMock).not.toHaveBeenCalled();
      expect(notifyEntryMock).not.toHaveBeenCalled();
    });

    it('passes the rules engine the permission the chain holds', async () => {
      ready();
      const policy = livePolicy({ dailyCapUsd: 300 });
      readPolicyMock.mockResolvedValue(policy);

      await runAutonomousCycle('wallet-1', { fixedUsd: 25 });
      expect(evaluateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: 'wallet-1',
          dailyCapUsd: 300,
          delegationExpiresAt: new Date(policy.expiresAt),
          delegationRevoked: false,
          killed: false,
        }),
      );
    });

    it('refuses a rules verdict, naming its reason', async () => {
      ready();
      evaluateMock.mockResolvedValue({ allowed: false, reason: 'daily_cap', detail: 'Cap reached.' });

      const result = await runAutonomousCycle('wallet-1', { fixedUsd: 25 });
      expect(result).toMatchObject({ executed: false, reason: 'daily_cap', detail: 'Cap reached.' });
      expect(placeOrderMock).not.toHaveBeenCalled();
    });

    /* The contract is final: our own tally saying $800 is left does not beat the chain saying $30. */
    it('sizes against what the contract says is left today', async () => {
      ready();
      oneMock.mockResolvedValue({ id: 'wallet-1', address: OWNER, agents_stopped: false, risk_profile: 'aggressive' });
      readPolicyMock.mockResolvedValue(livePolicy({ remainingTodayUsd: 30 }));

      await runAutonomousCycle('wallet-1');
      const usd = placeOrderMock.mock.calls[0]?.[2] as number;
      expect(usd).toBeGreaterThan(0);
      expect(usd).toBeLessThanOrEqual(30);
    });

    it('places the order through placeOrder, arms exits, writes a proposal and notifies', async () => {
      ready();
      armExitsMock.mockResolvedValue({ strategyId: 'strat-exit-123', sentence: 'Exit set' });

      const result = await runAutonomousCycle('wallet-1', { fixedUsd: 25 });
      expect(result.executed).toBe(true);
      if (result.executed) {
        expect(result.receipt.signature).toBe(FILL.signature);
        expect(result.receipt.runId).toBe(FILL.runId);
        expect(result.receipt.orderId).toBe('order-1');
        expect(result.exitStrategyId).toBe('strat-exit-123');
        expect(result.proposalId).toBeDefined();
      }

      expect(placeOrderMock).toHaveBeenCalledTimes(1);
      const [w, symbol, usd, label, extra] = placeOrderMock.mock.calls[0]!;
      expect(w).toMatchObject({ id: 'wallet-1', address: OWNER });
      expect(typeof symbol).toBe('string');
      expect(usd).toBe(25);
      // The one-shot's label is what the order path attributes the booked fill to: it names the agent.
      expect(label).toContain('Momentum Scout');
      // 50 bps is 0.5%: the order path takes slippage in percent.
      // The fill's audit row is the trade's only one, so it names the agent that placed it, not the person.
      expect(extra).toEqual({ slippagePct: 0.5, placedBy: 'Momentum Scout' });

      expect(armExitsMock).toHaveBeenCalledTimes(1);
      // Exits hang off the price it filled at, not the price the setup was written at.
      expect(armExitsMock.mock.calls[0]?.[1]).toMatchObject({ entryPrice: FILL.fillPrice });

      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO proposals'),
        expect.arrayContaining(['wallet-1']),
      );
      // The order path already notified and wrote the fill's audit row: the agent adds neither a second push nor a row.
      expect(notifyEntryMock).not.toHaveBeenCalled();
      expect(appendMock).not.toHaveBeenCalled();
    });

    /*
     * The setup a caller hands in is the setup that gets placed. Re-scanning here would mean the
     * trade could differ from the one the caller had just shown somebody and been told to take.
     */
    it('places the setup the caller brought instead of scanning for a new one', async () => {
      ready();

      // No readings and no earnings, so a fresh scan would find nothing at all.
      queryMock.mockResolvedValue([]);
      expect(await evaluateBestSetup()).toBeNull();

      const chosen = {
        symbol: 'AAPLx',
        stock: { ...STOCKS.AAPLx, address: STOCKS.AAPLx.address as `0x${string}`, raw: STOCKS.AAPLx.raw as `0x${string}`, sector: 'Technology' as const },
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
      expect(placeOrderMock).toHaveBeenCalledWith(
        expect.anything(),
        'AAPLx',
        25,
        expect.any(String),
        expect.anything(),
      );
    });

    /*
     * The order path writes the fill's row, which knows nothing about why. The decision record goes on the proposal,
     * carrying the transaction hash, which is how `/activity/:seq/explain` finds the reason for that row.
     */
    it('stores the decision on the proposal, carrying the transaction hash', async () => {
      ready();

      const result = await runAutonomousCycle('wallet-1', { fixedUsd: 25 });
      const symbol = result.executed ? result.setup.symbol : '';

      const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO proposals'));
      expect(insert).toBeDefined();
      const record = JSON.parse(String((insert![1] as unknown[])[3]));
      expect(record).toMatchObject({
        symbol,
        strategyKind: 'momentum',
        signature: FILL.signature,
        runId: FILL.runId,
        units: FILL.filledUnits,
        price: FILL.fillPrice,
        slippageBps: 50,
        multiplier: 1,
        exitStrategyId: 'exit-1',
      });
      expect(record).not.toHaveProperty('slot');
      expect(appendMock).not.toHaveBeenCalled();
    });

    /*
     * `proposals.decision` is a CHECK column. Writing a word it does not allow means Postgres
     * refuses the row, and the refusal was being logged and stepped over — so the record this
     * whole feature reads back was never there, and the sweep's cooldown never matched.
     */
    it('stores the decision under a word the proposals constraint accepts', async () => {
      ready();

      await runAutonomousCycle('wallet-1', { fixedUsd: 25 });

      const insert = queryMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO proposals'));
      if (!insert) throw new Error('expected a proposal insert');
      expect(insert[0]).not.toContain("'approved'");
      expect(insert[1]).toContain(AGENT_DECISION);
    });

    /*
     * `placeOrder` answers with a refusal as readily as a fill, and a refusal is not a fill:
     * nothing downstream of it — exits, proposal, audit, notification — may run.
     */
    it('passes an order-path refusal through without arming exits or notifying', async () => {
      ready();
      placeOrderMock.mockResolvedValue({
        placed: false,
        refusal: { status: 'blocked', reason: 'not_tradable', detail: 'NVDAx cannot be settled on xlayer.' },
      });

      const result = await runAutonomousCycle('wallet-1', { fixedUsd: 25 });
      expect(result).toMatchObject({ executed: false, reason: 'not_tradable' });
      expect(armExitsMock).not.toHaveBeenCalled();
      expect(appendMock).not.toHaveBeenCalled();
      expect(notifyEntryMock).not.toHaveBeenCalled();
    });

    it('passes a run the executor blocked through under its own reason', async () => {
      ready();
      placeOrderMock.mockResolvedValue({
        placed: true,
        orderId: 'order-1',
        outcome: { status: 'blocked', runId: 'run-2', reason: 'onchain_daily_cap', detail: 'The contract allows 3.00 more today.' },
      });

      const result = await runAutonomousCycle('wallet-1', { fixedUsd: 25 });
      expect(result).toMatchObject({
        executed: false,
        reason: 'onchain_daily_cap',
        detail: 'The contract allows 3.00 more today.',
      });
      expect(armExitsMock).not.toHaveBeenCalled();
      expect(notifyEntryMock).not.toHaveBeenCalled();
    });

    it('reports a failed run as order_failed with the sentence a person reads', async () => {
      ready();
      placeOrderMock.mockResolvedValue({
        placed: true,
        orderId: 'order-1',
        outcome: { status: 'failed', runId: 'run-3', error: 'The venue rejected the order, so nothing was placed.', raw: '0xc2e441e5' },
      });

      const result = await runAutonomousCycle('wallet-1', { fixedUsd: 25 });
      expect(result).toMatchObject({
        executed: false,
        reason: 'order_failed',
        detail: 'The venue rejected the order, so nothing was placed.',
      });
      expect(notifyEntryMock).not.toHaveBeenCalled();
    });

    it('reports an order path that threw as order_failed', async () => {
      ready();
      placeOrderMock.mockRejectedValue(new Error('insert failed'));

      const result = await runAutonomousCycle('wallet-1', { fixedUsd: 25 });
      expect(result).toMatchObject({ executed: false, reason: 'order_failed' });
      if (!result.executed) expect(result.detail).toContain('insert failed');
      expect(notifyEntryMock).not.toHaveBeenCalled();
    });

    it('treats a skipped run as nothing bought', async () => {
      ready();
      placeOrderMock.mockResolvedValue({
        placed: true,
        orderId: 'order-1',
        outcome: { status: 'skipped', reason: 'already_ran_this_period' },
      });

      const result = await runAutonomousCycle('wallet-1', { fixedUsd: 25 });
      expect(result).toMatchObject({ executed: false, reason: 'order_not_filled' });
      expect(armExitsMock).not.toHaveBeenCalled();
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
      scaleMock.mockResolvedValue({
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
      readPolicyMock.mockResolvedValue(livePolicy());
      evaluateMock.mockResolvedValue({ allowed: true, spentTodayUsd: 0, remainingUsd: 800 });
      // Twelve readings, so even conservative's ten-observation floor has a band to work with.
      queryMock.mockImplementation(async (sql: string) =>
        sql.includes('price_observations') ? readings(200, 240, 238, 12) : [],
      );
      placeOrderMock.mockResolvedValue(FILLED);
      armExitsMock.mockResolvedValue({ strategyId: 'exit-1', sentence: 'Exit set' });
    };

    it('sizes the entry from the profile rather than a fixed default', async () => {
      readyWallet('aggressive');
      await runAutonomousCycle('wallet-1');
      expect(placeOrderMock.mock.calls[0]?.[2]).toBe(RISK_SETTINGS.aggressive.maxTradeUsd);

      vi.clearAllMocks();
      appendMock.mockResolvedValue({ seq: '1' });
      scaleMock.mockResolvedValue({ multiplier: 1, pending: null });
      xStockPriceMock.mockResolvedValue(238);
      referencePriceMock.mockResolvedValue(238);
      earningsCalendarMock.mockResolvedValue(null);
      readyWallet('conservative');
      await runAutonomousCycle('wallet-1');
      expect(placeOrderMock.mock.calls[0]?.[2]).toBe(RISK_SETTINGS.conservative.maxTradeUsd);
    });

    /*
     * Stored, not looked up when the trade is explained. The setting is a thing the user can
     * change, and reading it at explain time would caption last week's careful trade with this
     * week's aggressive profile — describing a decision that was never made.
     */
    it('writes the profile that was active into the decision record', async () => {
      readyWallet('conservative');
      await runAutonomousCycle('wallet-1');

      expect(proposalRecord()).toMatchObject({
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
      expect(proposalRecord()).toMatchObject({ riskProfile: 'balanced' });
    });

    it('treats a wallet with no profile column as the default', async () => {
      readyWallet(undefined);
      await runAutonomousCycle('wallet-1');
      expect(proposalRecord()).toMatchObject({ riskProfile: 'balanced' });
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

      readPolicyMock.mockResolvedValue(livePolicy());
      evaluateMock.mockResolvedValue({ allowed: true, spentTodayUsd: 0, remainingUsd: 500 });
      placeOrderMock.mockResolvedValue(FILLED);
      armExitsMock.mockResolvedValue({ strategyId: 'exit-1', sentence: 'Exit set' });

      expect(await autonomousAgentSweep()).toBe(1);
    });
  });
});
