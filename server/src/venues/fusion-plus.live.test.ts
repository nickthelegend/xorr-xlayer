/**
 * LIVE Fusion+ cross-chain quotes (PLAN.md 3.16) — the real 1inch quoter and Token API, from Base, for every destination
 * and token the registry lists.
 * Run: LIVE=1 npx vitest run src/venues/fusion-plus.live.test.ts
 *
 * Read-only. The quoter is asked with `enableEstimate=false`, so it issues no quote id and nothing that comes back could
 * be submitted; the Token API only describes contracts.
 */
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { TOKENS, oneinchApi } from './oneinch.js';
import {
  CROSSCHAIN_TOKENS,
  DESTINATIONS,
  PRESETS,
  SOURCE,
  crosschainQuote,
  quoteFailure,
  quotePath,
  readAsk,
  toCrosschainQuote,
  type CrosschainAsk,
  type CrosschainToken,
  type QuoterAnswer,
} from './fusion-plus.js';

/** A wallet the quoter is told about. Nothing is signed for it, and it needs no balance: no estimate is asked for. */
const WALLET: Address = '0x364d7Bbc139541e0e37450D527ae154B5C292581';

/** Enough to clear a resolver's costs into Ethereum, and small enough to be an ordinary transfer. */
const AMOUNT: Record<CrosschainToken, string> = { USDC: '100', WETH: '0.05' };

/** `GET /token/v1.2/{chain}/custom/{address}` — the fields checked here. */
type TokenInfo = { symbol: string; decimals: number; address: string };

function ask(to: number, token: CrosschainToken, amount: string): CrosschainAsk {
  const a = readAsk({ to: String(to), token, amount });
  if ('error' in a) throw new Error(a.detail);
  return a;
}

describe.skipIf(!process.env.LIVE)('1inch Fusion+ quotes from Base', () => {
  it('every registry address is the token it claims to be, by 1inch’s Token API', async () => {
    const seen: string[] = [];
    for (const token of CROSSCHAIN_TOKENS) {
      const source = TOKENS[token]!;
      const s = await oneinchApi<TokenInfo>(`/token/v1.2/${SOURCE.chainId}/custom/${source.address}`, 60_000);
      expect(s, `Base ${token}`).toMatchObject({ symbol: token, decimals: source.decimals });
      expect(s.address.toLowerCase()).toBe(source.address.toLowerCase());
      seen.push(`Base ${s.symbol}/${s.decimals}`);

      for (const d of DESTINATIONS) {
        const t = d.tokens[token];
        const info = await oneinchApi<TokenInfo>(`/token/v1.2/${d.chainId}/custom/${t.address}`, 60_000);
        expect(info, `${d.name} ${token}`).toMatchObject({ symbol: token, decimals: t.decimals });
        expect(info.address.toLowerCase()).toBe(t.address.toLowerCase());
        seen.push(`${d.name} ${info.symbol}/${info.decimals}`);
      }
    }
    console.log(`[live] Token API: ${seen.join(', ')}`);
  }, 120_000);

  it('quotes every destination and token, in the shape this module reads, pricing each as the asset it claims', async () => {
    const lines: string[] = [];
    for (const d of DESTINATIONS) {
      for (const token of CROSSCHAIN_TOKENS) {
        const a = ask(d.chainId, token, AMOUNT[token]);
        // The question the route asks, uncached, so every pair is a fresh answer from the quoter.
        const answer = await oneinchApi<QuoterAnswer>(quotePath(a, WALLET), 0);
        const pair = `${d.name} ${token}`;

        // The raw fields `QuoterAnswer` types, as the quoter actually sends them.
        expect(answer.srcTokenAmount, pair).toBe(a.raw.toString());
        expect(answer.dstTokenAmount, pair).toMatch(/^\d+$/);
        for (const name of PRESETS) {
          const p = answer.presets[name];
          expect(p, `${pair} ${name}`).toBeTruthy();
          expect(typeof p!.auctionDuration).toBe('number');
          expect(p!.auctionDuration).toBeGreaterThan(0);
          expect(typeof p!.startAuctionIn).toBe('number');
          expect(p!.auctionStartAmount).toMatch(/^\d+$/);
          expect(p!.auctionEndAmount).toMatch(/^\d+$/);
          expect(p!.costInDstToken).toMatch(/^\d+$/);
        }
        // No estimate, no quote id: nothing in the answer is an order waiting to be sent.
        expect((answer as { quoteId?: unknown }).quoteId ?? null, pair).toBeNull();

        // The quoter prices the destination contract as the asset sent — USDC at a dollar, WETH at what Base's WETH is
        // worth. A different token behind the address would not price that way.
        const srcUsd = Number(answer.prices?.usd?.srcToken);
        const dstUsd = Number(answer.prices?.usd?.dstToken);
        expect(Math.abs(dstUsd / srcUsd - 1), `${pair}: $${srcUsd} sent, $${dstUsd} received`).toBeLessThan(0.03);
        if (token === 'USDC') expect(Math.abs(dstUsd - 1), pair).toBeLessThan(0.03);

        const q = toCrosschainQuote(a, answer);
        // The amount that arrives is the amount sent less the fill, in the token's own units: a wrong decimals entry
        // would miss this by a factor of 10^12.
        expect(q.to.amount / q.from.amount, pair).toBeGreaterThan(0.9);
        expect(q.to.amount / q.from.amount, pair).toBeLessThan(1.01);
        expect(q.presets.map((p) => p.name)).toEqual([...PRESETS]);
        expect(q.presets.filter((p) => p.recommended).length, pair).toBeLessThanOrEqual(1);
        for (const p of q.presets) {
          expect(p.receiveLeast, `${pair} ${p.name}`).toBeGreaterThan(0);
          expect(p.receiveLeast).toBeLessThanOrEqual(p.receiveMost);
          expect(p.receiveMost).toBeLessThan(q.from.amount * 1.01);
          expect(p.costUsd, `${pair} ${p.name}`).not.toBeNull();
          expect(p.costUsd!).toBeGreaterThanOrEqual(0);
          expect(p.costUsd!).toBeLessThan(25);
        }
        expect(q.submittable).toBe(false);

        lines.push(
          `${pair}: ${q.from.amount} -> ${q.to.amount} | ` +
            q.presets
              .map((p) => `${p.name}${p.recommended ? '*' : ''} ${p.auctionSeconds}s ${p.receiveLeast}..${p.receiveMost} cost $${p.costUsd!.toFixed(4)}`)
              .join(' | '),
        );
      }
    }
    console.log(`[live] Fusion+ quotes from Base:\n  ${lines.join('\n  ')}`);
  }, 180_000);

  it("a dust amount is refused by 1inch, and reads as a refusal with 1inch's status", async () => {
    const a = ask(1, 'USDC', '0.01');
    const failure = await crosschainQuote(a, WALLET).then(
      () => undefined,
      (e: unknown) => quoteFailure(e, a),
    );
    expect(failure).toEqual({
      error: 'quoter_refused',
      detail: expect.stringMatching(/^1inch's Fusion\+ quoter would not quote 0\.01 USDC from Base to Ethereum\. It answered 4\d\d/),
    });
    console.log(`[live] refusal: ${failure?.detail}`);
  }, 60_000);
});
