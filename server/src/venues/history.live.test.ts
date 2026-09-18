/**
 * LIVE — the 1inch History API: real key, real Base history, read-only (PLAN.md 3.14).
 * Run: LIVE=1 npx vitest run src/venues/history.live.test.ts
 *
 * Asked about 0x7E5F…95Bdf, the address of the private key `1`. That key is printed in every tutorial, so the address
 * belongs to nobody in particular and scripts move tokens through it on Base all day — a real history that is never
 * empty. The busy public contracts do not serve here: the aggregation router, WETH, the Universal Router and a USDC
 * whale each answered 422 when this was written (2026-09-13).
 *
 * What is asserted is what `routes/history.ts` reads. If 1inch changes the shape it shows here, not as a History screen
 * on Base that quietly lists nothing.
 */
import { describe, expect, it } from 'vitest';
import { oneinchHistory } from './history.js';

const ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf' as const;
const HEX_ADDRESS = /^0x[0-9a-f]{40}$/i;

describe.skipIf(!process.env.LIVE)('the 1inch History API on Base', () => {
  it('answers a wallet with Base activity with its events, newest first, in the shape the history maps', async () => {
    const events = await oneinchHistory(ADDRESS, 5);

    expect(events.length).toBeGreaterThan(0);
    const now = Date.now() / 1000;
    for (const e of events) {
      expect(typeof e.id).toBe('string');
      expect(e.address.toLowerCase()).toBe(ADDRESS.toLowerCase());
      expect(typeof e.eventOrderInTransaction).toBe('number');

      const d = e.details;
      expect(d.chainId).toBe(8453);
      expect(d.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(Number.isInteger(d.blockNumber) && d.blockNumber > 0).toBe(true);
      // Seconds, not milliseconds: after Base's genesis, and not in the future.
      expect(d.blockTimeSec).toBeGreaterThan(1_686_000_000);
      expect(d.blockTimeSec).toBeLessThanOrEqual(now + 60);
      expect(typeof d.status).toBe('string');
      expect(typeof d.type).toBe('string');
      expect(typeof d.orderInBlock).toBe('number');
      expect(d.fromAddress).toMatch(HEX_ADDRESS);
      if (d.toAddress) expect(d.toAddress).toMatch(HEX_ADDRESS);

      expect(Array.isArray(d.tokenActions)).toBe(true);
      for (const a of d.tokenActions) {
        expect(a.address).toMatch(HEX_ADDRESS);
        expect(a.fromAddress).toMatch(HEX_ADDRESS);
        expect(a.toAddress).toMatch(HEX_ADDRESS);
        expect(a.amount).toMatch(/^\d+$/);
        expect(a.direction).toMatch(/^(in|out)$/i);
        expect(typeof a.standard).toBe('string');
      }
    }

    // Newest first, the order the route merges them in.
    const blocks = events.map((e) => e.details.blockNumber);
    expect(blocks).toEqual([...blocks].sort((a, b) => b - a));
    // And the movements name the wallet asked about, which is how a row picks the token that stands for its event.
    const mine = (x: string) => x.toLowerCase() === ADDRESS.toLowerCase();
    expect(events.some((e) => e.details.tokenActions.some((a) => mine(a.fromAddress) || mine(a.toAddress)))).toBe(true);

    const newest = events[0]!.details;
    console.log(
      `[1inch history] ${events.length} events for ${ADDRESS}; newest: ${newest.type} (${newest.status}) in block ` +
        `${newest.blockNumber} at ${new Date(newest.blockTimeSec * 1000).toISOString()}, ` +
        `${newest.tokenActions.length} token movements, first ${newest.tokenActions[0]?.standard ?? 'none'}`,
    );
  }, 60_000);
});
