/**
 * GET /wallet/tokens — every token the signed-in wallet holds, in the chain's own words (PLAN.md 3.10).
 *
 * The Assets tab's Holdings are the ledger: positions the executor recorded from its own fills. A wallet holds more
 * than that book — the ETH that pays for gas, a deposit, a token sent in, anything bought elsewhere — and nothing
 * listed it. This does, from wherever this deployment can read the wallet truthfully:
 *
 *   - On Base, 1inch's Balance API: every token on 1inch's list, native ETH included, not only the registry — named,
 *     sized and given a logo by 1inch's Token API (`venues/balance.ts`).
 *   - On a fork or a testnet, 1inch would describe Base mainnet, which is not the chain the executor is on. So the
 *     registry is read in the multicall `/wallet/balance` already makes, with USDC and native ETH beside it, and logos
 *     come from where the market screens get theirs.
 *
 * `source` says which answered. Each token is priced where a feed can be trusted to mean it, and is `null` where not
 * — never 0. A balance read that fails is a 502 naming what failed, never an empty list: that would say the wallet
 * is empty.
 */
import { Hono } from 'hono';
import { formatUnits, getAddress, type Address } from 'viem';
import { readChain } from '../http/chain-read.js';
import { currentRequestId, log } from '../http/request-id.js';
import { ADDRESSES, CHAIN_KEY } from '../evm/chains.js';
import { publicClient } from '../evm/client.js';
import { cashUsd, holdings } from '../evm/balances.js';
import { TOKENS } from '../venues/oneinch.js';
import { holdingsOnBase, type BaseHoldings, type HeldToken } from '../venues/balance.js';
import { logosFor } from '../market/logos.js';
import { priceOf } from '../market/prices.js';
import { requireWallet } from './wallet-context.js';

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

  if (CHAIN_KEY === 'xlayer') {
    let held: BaseHoldings;
    try {
      held = await holdingsOnBase(owner);
    } catch (e) {
      /*
       * The answer `readChain` gives a failed RPC read — a 502, a sentence saying what could not be read, the cause in
       * the log — with the source named, since here it was 1inch that did not answer rather than the chain.
       */
      log.warn(`[tokens] 1inch could not read the wallet's tokens: ${e instanceof Error ? e.message : String(e)}`);
      return c.json(
        {
          error: 'balance_read_failed',
          source: '1inch',
          message: 'Could not read your tokens from 1inch just now.',
          requestId: currentRequestId(),
        },
        502,
      );
    }
    return c.json({
      owner,
      chain: CHAIN_KEY,
      source: '1inch',
      tokens: await priced(held.tokens),
      undescribed: held.undescribed,
    });
  }

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
 * What a fork or testnet wallet holds, read from the chain: native ETH, USDC, and every other registry token.
 *
 * `holdings` is the registry multicall behind `/wallet/balance`. It leaves out the two tokens it treats separately:
 * USDC, which that route counts as cash, and native ETH, which has no contract to batch. Both are read here beside it,
 * at this chain's addresses — Circle's USDC is a different deployment on Sepolia. If any of the three reads throws,
 * the list is not answered at all.
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
      symbol: 'ETH',
      address: ADDRESSES.nativeToken,
      decimals: 18,
      units: Number(formatUnits(wei, 18)),
      native: true,
      feed: 'ETH',
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
