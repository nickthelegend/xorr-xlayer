/**
 * GET /wallet/tokens — every token the signed-in wallet holds, in the chain's own words (PLAN.md 3.10).
 *
 * The Assets tab's Holdings are the ledger: positions the executor recorded from its own fills. A wallet holds more than
 * that book — the OKB that pays for gas, a deposit, a token sent in, anything bought elsewhere — and this lists it, read
 * from the chain on every network: native OKB, USDC, and every registry token in the multicall `/wallet/balance` makes.
 * (The Base build used 1inch's Balance API on mainnet; 1inch does not run on X Layer.)
 *
 * Each token is priced where a feed can be trusted to mean it, and is `null` where not — never 0. A balance read that
 * fails is a 502 naming what failed, never an empty list: that would say the wallet is empty.
 */
import { Hono } from 'hono';
import { formatUnits, getAddress, type Address } from 'viem';
import { readChain } from '../http/chain-read.js';
import { ADDRESSES, CHAIN_KEY } from '../evm/chains.js';
import { publicClient } from '../evm/client.js';
import { cashUsd, holdings } from '../evm/balances.js';
import { TOKENS } from '../venues/tokens.js';
import { logosFor } from '../market/logos.js';
import { priceOf } from '../market/prices.js';
import { requireWallet } from './wallet-context.js';

/** A token the wallet holds: sized in its own units, with the feed that prices it (null: none) and its logo. */
export type HeldToken = {
  symbol: string;
  address: Address;
  decimals: number;
  units: number;
  /** The chain's own gas token, which has no contract. */
  native?: boolean;
  feed: string | null;
  logo: string | null;
};

export const tokenRoutes = new Hono();

/** A held token as the app receives it: priced, without the feed name it was priced by. */
export type WalletToken = Omit<HeldToken, 'feed'> & { usd: number | null };

/**
 * How long one price may take before its token is shown unpriced.
 *
 * A token list is a screen, so it gets a screen's patience, not a scheduled buy's. A feed working through its retry
 * ladder costs that one token its dollar value rather than costing the whole list its answer. Four seconds is what the
 * quote's price-impact check allows.
 */
export const PRICE_DEADLINE_MS = 4_000;

tokenRoutes.get('/wallet/tokens', async (c) => {
  const w = await requireWallet(c);
  const owner = getAddress(w.address);

  // A read that throws becomes `ChainReadFailed`, which the error handler answers with a 502, as for `/wallet/balance`.
  const read = await readChain('your tokens', () => chainHoldings(owner));
  // Logos are decoration. They are read after the balances, so they can never fail them, and `logosFor` never throws.
  const logos = await logosFor(read.map((t) => t.symbol));
  return c.json({
    owner,
    chain: CHAIN_KEY,
    source: 'chain',
    tokens: await priced(read.map((t) => ({ ...t, logo: logos[t.symbol]?.url ?? null }))),
    // Every token read here is in the registry, and the registry describes it.
    undescribed: [],
  });
});

/**
 * What the wallet holds, read from the chain: native OKB, USDC, and every other registry token.
 *
 * `holdings` is the registry multicall behind `/wallet/balance`. It leaves out the two tokens it treats separately:
 * USDC, which that route counts as cash, and native OKB, which has no contract to batch. Both are read here beside it, at
 * this chain's addresses — Circle's USDC is a different deployment on the testnet. If any of the three reads throws, the
 * list is not answered at all.
 */
async function chainHoldings(owner: Address): Promise<Omit<HeldToken, 'logo'>[]> {
  const [registered, usdc, wei] = await Promise.all([
    holdings(owner),
    cashUsd(owner),
    publicClient.getBalance({ address: owner }),
  ]);
  const rows: Omit<HeldToken, 'logo'>[] = [];
  if (wei > 0n) {
    rows.push({
      symbol: 'OKB',
      address: ADDRESSES.nativeToken,
      decimals: 18,
      units: Number(formatUnits(wei, 18)),
      native: true,
      // OKB is priced as its wrapped twin, WOKB — the same asset.
      feed: 'WOKB',
    });
  }
  // `cashUsd` answers in USDC's own units, read at its six decimals.
  if (usdc > 0) rows.push({ symbol: 'USDC', address: ADDRESSES.usdc, decimals: 6, units: usdc, feed: 'USDC' });
  for (const h of registered) {
    const token = TOKENS[h.symbol];
    if (token) {
      rows.push({ symbol: h.symbol, address: token.address, decimals: token.decimals, units: h.units, feed: h.symbol });
    }
  }
  return rows;
}

/** Each token priced by its feed: largest value first, then the unpriced, by symbol. */
async function priced(tokens: HeldToken[]): Promise<WalletToken[]> {
  const prices = await Promise.all(tokens.map((t) => (t.feed === null ? null : usdPrice(t.feed))));
  return tokens
    .map(({ feed: _feed, ...token }, i): WalletToken => {
      const price = prices[i] ?? null;
      return { ...token, usd: price === null ? null : token.units * price };
    })
    .sort(byValue);
}

/** A dollar price, or null where the feed has none, answers with something that is not a price, or is not back in time. */
async function usdPrice(symbol: string): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const price = await Promise.race([
      priceOf(symbol, PRICE_DEADLINE_MS),
      // Raced here as well as inside `priceOf`, so a list is held to its own four seconds whatever a price lookup does.
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no price for ${symbol} within ${PRICE_DEADLINE_MS}ms`)),
          PRICE_DEADLINE_MS,
        );
      }),
    ]);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function byValue(a: WalletToken, b: WalletToken): number {
  if (a.usd !== null && b.usd !== null && a.usd !== b.usd) return b.usd - a.usd;
  if ((a.usd === null) !== (b.usd === null)) return a.usd === null ? 1 : -1;
  return a.symbol.localeCompare(b.symbol);
}
