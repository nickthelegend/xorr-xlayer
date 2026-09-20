/**
 * Two independent price sources, compared.
 *
 * Every number on every screen came from one place — CoinGecko — and a single source is a single
 * point of being wrong. Not maliciously: a thin pair, a stale cache, a bad tick. The app's own
 * standard is that no number on screen is invented, and "we asked one API and believed it" is a
 * weaker version of that than it sounds.
 *
 * So the same asset is priced a second way: the X Layer Uniswap v3 pools the executor would actually trade against,
 * quoted at a real $1,000 size. That second property is what makes it worth having rather than just being another API —
 * if the two disagree, the one that matters for a fill is the one built from the pools the fill will touch.
 *
 * A wrapped xStock is not priced by CoinGecko, and for a while this said it therefore had no second source at all —
 * while `market/nasdaq.ts` was already computing one for the agent's off-hours guard, and the README was advertising
 * it. Its second source is the issuer's own mark for the same token on Solana (Jupiter's price API) times the
 * wrapper's `convertToAssets` multiplier: a number arrived at through a different venue, a different chain and a
 * different oracle, which is exactly what makes a second opinion worth having. Measured on 2026-09-20: TSLAx at
 * $364.18 against the X Layer pool's $363.85, 0.09% apart.
 *
 * Where that reference cannot be had — no Solana mint for the token, Jupiter unreachable, the multiplier unreadable —
 * the answer is still "only one source answered", never a comparison of a number with itself.
 *
 * When they agree, this says so quietly. When they do not, the app says THAT rather than picking a
 * winner, because picking one silently is how a wrong price becomes an executed trade.
 */
import { SETTLEMENT_SYMBOL, canonicalSymbol, isRoutable, TOKENS } from '../venues/tokens.js';
import { isStock } from '../venues/stocks.js';
import { priceOf } from './prices.js';
import { referencePriceUsd } from './nasdaq.js';

/** The size the pool is asked about: large enough to be a real trade, small enough not to be all price impact. */
const PROBE_USD = 1_000;

/** A feed symbol and the X Layer token that carries it in the pools. */
const POOL_TOKEN: Record<string, string> = { BTC: 'XBTC', OKB: 'WOKB' };

/**
 * Above this the two sources are telling different stories and the app must say so.
 *
 * 0.75% is chosen from what the sources actually do: an aggregator's mid and a spot feed's mid
 * differ by a few basis points on a liquid pair all day long, and a gap five times wider than that
 * is not noise. Tight enough to catch a stale feed, loose enough not to cry wolf on every tick.
 */
export const DISAGREEMENT_PCT = 0.75;

export type CrossCheck = {
  symbol: string;
  /**
   * The independent price, whichever feed answered for this asset: CoinGecko for crypto, the issuer's own Solana mark
   * for a wrapped xStock. `referenceSource` names it, so a screen can say where the number came from instead of
   * assuming.
   */
  reference: number | null;
  referenceSource: 'coingecko' | 'xstocks' | null;
  /** The CoinGecko feed specifically — null for an asset CoinGecko does not price. Equal to `reference` when it is the source. */
  coingecko: number | null;
  /** Derived from the X Layer pools a fill would actually touch. */
  pool: number | null;
  spreadPct: number | null;
  /**
   * Were there actually two numbers to compare?
   *
   * `agree` answers "is there a warning to raise", which is the question the screens ask, and it
   * is deliberately true when a source is missing — reporting a disagreement because one API was
   * down would make an outage look like a data-integrity problem and train people to ignore the
   * warning that matters.
   *
   * But `agree: true` alongside `pool: null` is, read on its own, a claim that two sources
   * concurred when only one was ever asked. The note said so and the boolean did not, and a
   * caller reading the field rather than the prose was misled. So the two questions get two
   * fields: `compared` is whether a second opinion exists, `agree` is whether to say anything.
   */
  compared: boolean;
  agree: boolean;
  note: string;
};

/** What $1,000 of USDC buys in the pools, as a USD price per unit. Null when the pools will not quote it. */
async function poolPrice(symbol: string): Promise<number | null> {
  if (symbol === SETTLEMENT_SYMBOL) return 1;
  try {
    const { quote } = await import('../venues/uniswap.js');
    const q = await quote({ inSymbol: SETTLEMENT_SYMBOL, outSymbol: symbol, amount: PROBE_USD, skipPriceImpact: true });
    return q.outAmount > 0 ? PROBE_USD / q.outAmount : null;
  } catch {
    return null;
  }
}

export async function crossCheck(symbol: string): Promise<CrossCheck> {
  /*
   * No fallback address. This defaulted to WETH for anything not in the registry, so asking for
   * BTC returned WETH's price labelled as BTC — a confident, wrong number, which is the one thing
   * this app is not allowed to produce. A symbol with nothing to price against has no second
   * opinion, and saying that is the correct answer.
   */
  /*
   * The fallback used to be `TOKENS[symbol.toUpperCase()]`, which is backwards: uppercasing is
   * precisely what loses the lowercase `c` on a tokenized equity, so it could never resolve one and
   * every equity silently reported "not routable on Base" — for assets that route on Base daily.
   */
  const key = canonicalSymbol(POOL_TOKEN[symbol.toUpperCase()] ?? symbol);
  const token = TOKENS[key];
  if (!token || !isRoutable(key)) {
    const feed = await priceOf(symbol, 8_000).catch(() => null);
    return {
      symbol,
      reference: feed,
      referenceSource: feed === null ? null : 'coingecko',
      coingecko: feed,
      pool: null,
      spreadPct: null,
      compared: false,
      agree: true,
      note: `${symbol} has no pool on X Layer, so there is no on-chain price to compare against.`,
    };
  }
  if (isStock(key)) {
    const [own, issuer] = await Promise.all([
      priceOf(key, 8_000).catch(() => null),
      referencePriceUsd(key).catch(() => null),
    ]);
    if (own === null || issuer === null || !(issuer > 0)) {
      return {
        symbol,
        reference: issuer,
        referenceSource: issuer === null ? null : 'xstocks',
        coingecko: null,
        pool: own,
        spreadPct: null,
        compared: false,
        agree: true,
        note:
          own === null && issuer === null
            ? 'Neither price source answered.'
            : `Only one source answered for ${key}, so there is nothing to compare.`,
      };
    }
    const spread = (Math.abs(issuer - own) / ((issuer + own) / 2)) * 100;
    const same = spread <= DISAGREEMENT_PCT;
    return {
      symbol,
      reference: issuer,
      referenceSource: 'xstocks',
      coingecko: null,
      pool: own,
      spreadPct: spread,
      compared: true,
      agree: same,
      note: same
        ? `The X Layer pool and the issuer's own mark for ${key} are within ${spread.toFixed(2)}%.`
        : `The X Layer pool and the issuer's own mark for ${key} disagree by ${spread.toFixed(2)}%. A fill would happen at the pool price, ${own.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}.`,
    };
  }

  const [coingecko, pool] = await Promise.all([priceOf(symbol, 8_000).catch(() => null), poolPrice(key)]);

  /*
   * One source missing is not a disagreement.
   *
   * Reporting "they disagree" when only one answered would make an outage look like a data
   * integrity problem, and would train people to ignore the warning that matters.
   */
  if (coingecko === null || pool === null) {
    return {
      symbol,
      reference: coingecko,
      referenceSource: coingecko === null ? null : 'coingecko',
      coingecko,
      pool,
      spreadPct: null,
      compared: false,
      agree: true,
      note:
        coingecko === null && pool === null
          ? 'Neither price source answered.'
          : `Only one source answered, so there is nothing to compare.`,
    };
  }

  const spreadPct = (Math.abs(coingecko - pool) / ((coingecko + pool) / 2)) * 100;
  const agree = spreadPct <= DISAGREEMENT_PCT;
  return {
    symbol,
    reference: coingecko,
    referenceSource: 'coingecko',
    coingecko,
    pool,
    spreadPct,
    compared: true,
    agree,
    note: agree
      ? `Two independent sources within ${spreadPct.toFixed(2)}%.`
      : `The two price sources disagree by ${spreadPct.toFixed(2)}%. The number shown is the market feed; a fill would happen nearer ${pool.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}.`,
  };
}
