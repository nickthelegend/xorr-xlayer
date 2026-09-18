import { describe, expect, it } from 'vitest';
import { getNasdaqSession, underlyingTicker, evaluateOffHoursGuard } from './nasdaq.js';

// 2026-10-14 is a Wednesday; 2026-10-17 a Saturday. ET is UTC-4 on both (EDT).
const WED_1100_ET = new Date('2026-10-14T15:00:00Z');
const WED_0700_ET = new Date('2026-10-14T11:00:00Z');
const SAT_1400_ET = new Date('2026-10-17T18:00:00Z');

describe('nasdaq session and off-hours slippage guard', () => {
  it('underlyingTicker normalizes both tokenized forms', () => {
    expect(underlyingTicker('NVDAx')).toBe('NVDA');
    expect(underlyingTicker('TSLAc')).toBe('TSLA');
    expect(underlyingTicker('AAPL')).toBe('AAPL');
    expect(underlyingTicker('msftx')).toBe('MSFT');
  });

  it('identifies regular market session (Wednesday 11:00 ET)', () => {
    const session = getNasdaqSession(WED_1100_ET);
    expect(session.session).toBe('regular');
    expect(session.isExchangeOpen).toBe(true);
    expect(session.phase).toBe('regular');
  });

  it('identifies pre-market extended session (Wednesday 07:00 ET)', () => {
    const session = getNasdaqSession(WED_0700_ET);
    expect(session.session).toBe('extended');
    expect(session.phase).toBe('pre-market');
    expect(session.isExchangeOpen).toBe(true);
  });

  it('identifies weekend closed session (Saturday 14:00 ET)', () => {
    const session = getNasdaqSession(SAT_1400_ET);
    expect(session.session).toBe('closed');
    expect(session.phase).toBe('weekend');
    expect(session.isExchangeOpen).toBe(false);
  });

  describe('evaluateOffHoursGuard', () => {
    it('returns normal 50 bps slippage during regular hours', () => {
      const verdict = evaluateOffHoursGuard({
        symbol: 'NVDAx',
        onChainPrice: 216.5,
        referencePrice: 216.5,
        now: WED_1100_ET,
      });

      expect(verdict.session).toBe('regular');
      expect(verdict.action).toBe('normal');
      expect(verdict.suggestedSlippageBps).toBe(50);
      expect(verdict.spreadBps).toBe(0);
    });

    it('widens slippage tolerance off-hours when the drift is mild', () => {
      const verdict = evaluateOffHoursGuard({
        symbol: 'NVDAx',
        onChainPrice: 217.2, // ~0.3% from the reference
        referencePrice: 216.5,
        now: SAT_1400_ET,
      });

      expect(verdict.session).toBe('closed');
      expect(verdict.action).toBe('widen_slippage');
      expect(verdict.suggestedSlippageBps).toBe(120);
      expect(verdict.spreadBps).toBe(32);
    });

    it('holds when the off-hours drift exceeds 1.5%', () => {
      const verdict = evaluateOffHoursGuard({
        symbol: 'NVDAx',
        onChainPrice: 221.0, // ~2.1% from the reference
        referencePrice: 216.5,
        now: SAT_1400_ET,
      });

      expect(verdict.session).toBe('closed');
      expect(verdict.action).toBe('hold');
      expect(verdict.reason).toContain('Holding to protect against off-hours slippage');
    });

    /*
     * The case the old reference-price table hid. With no second source there is nothing to
     * measure the pool against, and the guard's whole job is measuring — so it stands down rather
     * than reporting a spread it did not compute.
     */
    it('holds off-hours when no reference price is available, and reports no spread', () => {
      const verdict = evaluateOffHoursGuard({
        symbol: 'SPYx',
        onChainPrice: 640.25,
        referencePrice: null,
        now: SAT_1400_ET,
      });

      expect(verdict.action).toBe('hold');
      expect(verdict.spreadBps).toBeNull();
      expect(verdict.spreadPct).toBeNull();
      expect(verdict.reason).toContain('no independent price');
    });

    it('holds in an extended session with no reference price', () => {
      const verdict = evaluateOffHoursGuard({
        symbol: 'SPYx',
        onChainPrice: 640.25,
        referencePrice: null,
        now: WED_0700_ET,
      });

      expect(verdict.session).toBe('extended');
      expect(verdict.action).toBe('hold');
      expect(verdict.spreadBps).toBeNull();
    });

    /*
     * Regular hours are the exception: the underlying is trading and arbitrage is closing the gap,
     * so a missing second opinion is not a reason to refuse the trade.
     */
    it('trades normally during regular hours even without a reference price', () => {
      const verdict = evaluateOffHoursGuard({
        symbol: 'SPYx',
        onChainPrice: 640.25,
        referencePrice: null,
        now: WED_1100_ET,
      });

      expect(verdict.action).toBe('normal');
      expect(verdict.suggestedSlippageBps).toBe(50);
      expect(verdict.spreadBps).toBeNull();
    });

    it('holds in an extended session when the drift is past 1.2%', () => {
      const verdict = evaluateOffHoursGuard({
        symbol: 'NVDAx',
        onChainPrice: 220.0, // ~1.6% from the reference
        referencePrice: 216.5,
        now: WED_0700_ET,
      });

      expect(verdict.session).toBe('extended');
      expect(verdict.action).toBe('hold');
    });
  });
});
