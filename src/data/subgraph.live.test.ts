/**
 * LIVE subgraph test — queries the deployed subgraph on The Graph's hosted Studio.
 * Run: LIVE=1 npx vitest run src/data/subgraph.live.test.ts
 */
import { describe, expect, it } from 'vitest';
import { dailySpendFor, indexerHealth, policyFor, spendsFor, unitsToUsd } from './subgraph';

// The owner that granted the live policy on Base Sepolia.
const OWNER = '0x364d7Bbc139541e0e37450D527ae154B5C292581';
const DELEGATE = '0xe992fe56589d1111d0b7bb7c4ca3946d4d53e403';

describe('The Graph — the app reads its permission history from the chain', () => {
  it('the indexer is healthy and synced', async () => {
    const h = await indexerHealth();
    expect(h.healthy).toBe(true);
    expect(h.block).toBeGreaterThan(46_000_000);
  }, 60_000);

  it('returns the live policy exactly as the contract holds it', async () => {
    const p = await policyFor(OWNER);
    expect(p).not.toBeNull();
    expect(p!.delegate.toLowerCase()).toBe(DELEGATE);
    expect(unitsToUsd(p!.dailyCap)).toBe(400);
    expect(p!.revoked).toBe(false);
    expect(unitsToUsd(p!.totalSpent)).toBeGreaterThan(0);
  }, 60_000);

  it('returns the real settled trades, with verifiable transaction hashes', async () => {
    const spends = await spendsFor(OWNER);
    expect(spends.length).toBeGreaterThan(0);
    for (const s of spends) {
      expect(s.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(unitsToUsd(s.amount)).toBeGreaterThan(0);
      expect(Number(s.blockNumber)).toBeGreaterThan(0);
    }
    // The running daily total never exceeds the cap the contract enforces.
    for (const s of spends) expect(unitsToUsd(s.spentToday)).toBeLessThanOrEqual(400);
  }, 60_000);

  it('rolls spend up per UTC day, matching the contract cap window', async () => {
    const days = await dailySpendFor(OWNER);
    expect(days.length).toBeGreaterThan(0);
    for (const d of days) {
      expect(d.tradeCount).toBeGreaterThan(0);
      expect(unitsToUsd(d.total)).toBeLessThanOrEqual(400);
    }
  }, 60_000);

  it('an address with no policy comes back null rather than inventing one', async () => {
    expect(await policyFor('0x000000000000000000000000000000000000dEaD')).toBeNull();
  }, 60_000);
});
