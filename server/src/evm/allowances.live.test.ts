/**
 * LIVE — 1inch's Approve API, read-only (PLAN.md 3.12).
 *
 * The executor reads the router and its allowances from this API on Base. Neither deployment runs on Base itself,
 * so that branch is proven here against the real API: the spender it names is the router the executor routes
 * through, and an allowance comes back as an exact amount the executor parses.
 *
 * Run: LIVE=1 npx vitest run src/evm/allowances.live.test.ts
 */
import { describe, expect, it } from 'vitest';
import { oneinchApi } from '../venues/oneinch.js';
import { QUOTE_ADDRESSES } from './chains.js';
import { routerAllowance } from './allowances.js';

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';

describe("1inch's Approve API on Base", () => {
  it('names the router the executor routes through as the spender', async () => {
    const r = await oneinchApi<{ address: string }>('/swap/v6.0/8453/approve/spender');
    expect(r.address.toLowerCase()).toBe(QUOTE_ADDRESSES.oneInchRouter.toLowerCase());
  }, 30_000);

  it("reads a wallet's allowance to it as an exact amount", async () => {
    const allowance = await routerAllowance(QUOTE_ADDRESSES.usdcBase, OWNER, '1inch', QUOTE_ADDRESSES.oneInchRouter);
    expect(typeof allowance).toBe('bigint');
    expect(allowance! >= 0n).toBe(true);
  }, 30_000);
});
