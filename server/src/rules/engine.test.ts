/**
 * Rule-engine unit tests — PLAN.md 12.9. Pure logic; no DB, no chain.
 * The database-backed path is exercised in executor.chain.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { evaluate, type RuleContext } from './engine.js';

const base: RuleContext = {
  walletId: 'w1',
  usd: 100,
  dailyCapUsd: 1600,
  delegationExpiresAt: new Date(Date.now() + 86_400_000),
  delegationRevoked: false,
};

/** Stand-in for the daily-spend query, so the ordering of checks can be tested without a DB. */
const client = (spent: number) =>
  ({
    query: async () => ({ rows: [{ spent_usd: String(spent) }] }),
  }) as never;

describe('limits are enforced outside the client', () => {
  it('allows a spend inside the cap', async () => {
    const v = await evaluate(base, client(0));
    expect(v.allowed).toBe(true);
    if (v.allowed) expect(v.remainingUsd).toBe(1500);
  });

  it('refuses a spend that would breach the cap, and says by how much', async () => {
    const v = await evaluate({ ...base, usd: 900 }, client(1000));
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toBe('daily_cap');
      expect(v.detail).toContain('$1,600');
      expect(v.detail).toContain('600.00'); // what is actually left
    }
  });

  it('a used-up cap does NOT silence an exit', async () => {
    /*
     * The most dangerous bug this file can miss.
     *
     * The account cap is checked before the planner has decided anything, so an `exit-rules`
     * strategy arrived with a placeholder size and was refused with `daily_cap` whenever the
     * wallet had spent its day — a take-profit, a stop-loss and a trailing stop all switched off
     * by a SPENDING limit. A cap exists to bound what goes at risk; a cap that blocks an exit
     * traps you in the position it was supposed to protect.
     */
    const spentOut = await evaluate(
      { ...base, usd: 900, dailyCapUsd: 1000, reducesRiskOnly: true },
      client(1000),
    );
    expect(spentOut.allowed).toBe(true);

    // Even past the cap entirely, which is where a stop matters most.
    const wayOver = await evaluate(
      { ...base, usd: 5_000, dailyCapUsd: 1000, reducesRiskOnly: true },
      client(4315),
    );
    expect(wayOver.allowed).toBe(true);
  });

  it('but permission still governs an exit', async () => {
    // Revoked and expired are the user saying no, not saying "not more than this much".
    const revoked = await evaluate(
      { ...base, reducesRiskOnly: true, delegationRevoked: true },
      client(0),
    );
    expect(revoked.allowed).toBe(false);
    if (!revoked.allowed) expect(revoked.reason).toBe('delegation_revoked');

    const expired = await evaluate(
      { ...base, reducesRiskOnly: true, delegationExpiresAt: new Date(Date.now() - 1000) },
      client(0),
    );
    expect(expired.allowed).toBe(false);
    if (!expired.allowed) expect(expired.reason).toBe('delegation_expired');

    const killed = await evaluate({ ...base, reducesRiskOnly: true, killed: true }, client(0));
    expect(killed.allowed).toBe(false);
  });

  it('a BUY is still capped — the exemption is for exits only', async () => {
    const v = await evaluate({ ...base, usd: 900, dailyCapUsd: 1000 }, client(1000));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe('daily_cap');
  });

  it('never claims a negative amount is left', async () => {
    /*
     * Lowering the cap mid-day, or re-granting a smaller one, puts today's spend above it. That
     * is the cap working. The refusal used to subtract anyway and say "$-3,315.00 is left",
     * which is not a sentence about money anyone can act on.
     */
    const v = await evaluate({ ...base, usd: 120, dailyCapUsd: 1000 }, client(4315));
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toBe('daily_cap');
      expect(v.detail).not.toMatch(/-|−/);
      expect(v.detail).toContain('used up');
      expect(v.detail).toContain('$4,315.00'); // what actually went out
    }
  });

  it('says what is left when something still is', async () => {
    const v = await evaluate({ ...base, usd: 900 }, client(1000));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.detail).toContain('600.00 is left');
  });

  it('allows a spend that exactly reaches the cap', async () => {
    const v = await evaluate({ ...base, usd: 600 }, client(1000));
    expect(v.allowed).toBe(true);
    if (v.allowed) expect(v.remainingUsd).toBe(0);
  });

  it('refuses when the kill switch is on — before anything else is considered', async () => {
    const v = await evaluate({ ...base, killed: true, usd: 1 }, client(0));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe('agents_stopped');
  });

  it('refuses when the delegation is revoked', async () => {
    const v = await evaluate({ ...base, delegationRevoked: true }, client(0));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe('delegation_revoked');
  });

  it('refuses when the delegation has expired — Run For is a real deadline', async () => {
    const v = await evaluate(
      { ...base, delegationExpiresAt: new Date(Date.now() - 1000) },
      client(0),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe('delegation_expired');
  });

  it('refuses a non-positive amount', async () => {
    for (const usd of [0, -5, Number.NaN]) {
      const v = await evaluate({ ...base, usd }, client(0));
      expect(v.allowed, `usd=${usd}`).toBe(false);
    }
  });

  it('produces screen 15’s spread rejection verbatim', async () => {
    const v = await evaluate({ ...base, spreadPct: 0.42, maxSpreadPct: 0.25 }, client(0));
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toBe('spread_too_wide');
      expect(v.detail).toBe('Spread 0.42% > your 0.25% limit');
    }
  });

  it('a tight spread inside the limit passes', async () => {
    const v = await evaluate({ ...base, spreadPct: 0.1, maxSpreadPct: 0.25 }, client(0));
    expect(v.allowed).toBe(true);
  });
});
