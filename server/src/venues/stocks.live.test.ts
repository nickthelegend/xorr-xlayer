/**
 * LIVE — every tokenized equity we offer must be real and routable on Base right now.
 *
 * A dead symbol here is worse than a missing one: the app would show a Buy button that quotes,
 * takes the tap, and then fails at signing time. Run with: npm run test:live
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, http, erc20Abi } from 'viem';
import { base } from 'viem/chains';
import { STOCKS } from './stocks.js';
import { pastTheThrottle } from '../evm/throttle.js';
import { quote } from './oneinch.js';

/**
 * Deliberately real Base, not a fork: several of these tokens have no EVM bytecode at all (their
 * account code is the single byte 0xef and the node implements them natively), so a fork cannot
 * read them. The public RPC rate-limits, hence the spacing below.
 */
const client = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });


describe('tokenized equities on Base', () => {
  it('every address is a real token with the symbol and decimals we claim', async () => {
    // One multicall rather than 24 reads: the public Base RPC rate-limits well below that.
    const list = Object.values(STOCKS);
    const results = await pastTheThrottle(() =>
      client.multicall({
        allowFailure: false,
        contracts: list.flatMap((s) => [
          { address: s.address, abi: erc20Abi, functionName: 'symbol' } as const,
          { address: s.address, abi: erc20Abi, functionName: 'decimals' } as const,
          { address: s.address, abi: erc20Abi, functionName: 'totalSupply' } as const,
        ]),
      }),
    );

    list.forEach((s, i) => {
      const [symbol, decimals, supply] = results.slice(i * 3, i * 3 + 3) as [string, number, bigint];
      expect(symbol, `${s.symbol} address points at ${symbol}`).toBe(s.symbol);
      expect(decimals, `${s.symbol} decimals`).toBe(s.decimals);
      expect(supply, `${s.symbol} has no supply`).toBeGreaterThan(0n);
    });
  }, 120_000);

  it('1inch routes USDC into every one of them at a plausible price', async () => {
    for (const s of Object.values(STOCKS)) {
      const q = await quote({ inSymbol: 'USDC', outSymbol: s.symbol, amount: 100 });
      expect(q.outAmount, `${s.symbol} has no route`).toBeGreaterThan(0);
      // $100 of a listed US equity is a fraction of a share to a few shares. Anything outside
      // that says the decimals are wrong, not that the market moved.
      const impliedPrice = 100 / q.outAmount;
      expect(impliedPrice, `${s.symbol} implied $${impliedPrice}/share`).toBeGreaterThan(5);
      expect(impliedPrice, `${s.symbol} implied $${impliedPrice}/share`).toBeLessThan(5_000);
      expect(q.venues.length, `${s.symbol} route has no venues`).toBeGreaterThan(0);
    }
  }, 180_000);
});
