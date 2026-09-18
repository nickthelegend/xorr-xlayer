/**
 * Two independent price sources, compared.
 *
 * Every number on every screen came from one place — CoinGecko — and a single source is a single
 * point of being wrong. Not maliciously: a thin pair, a stale cache, a bad tick. The app's own
 * standard is that no number on screen is invented, and "we asked one API and believed it" is a
 * weaker version of that than it sounds.
 *
 * So the same asset is priced a second way: 1inch's spot API, which derives its number from the
 * on-chain liquidity the executor would actually trade against. That second property is what makes
 * it worth having rather than just being another API — if the two disagree, the one that matters
 * for a fill is the one built from the pools the fill will touch.
 *
 * When they agree, this says so quietly. When they do not, the app says THAT rather than picking a
 * winner, because picking one silently is how a wrong price becomes an executed trade.
 */
import { getJson } from '../http/get.js';
import { ONEINCH_CHAIN_ID } from '../evm/chains.js';
import { canonicalSymbol, TOKENS } from '../venues/oneinch.js';
import { priceOf } from './prices.js';

const API_KEY = process.env.ONEINCH_API_KEY ?? '';

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
  /** The feed the screens use. */
  coingecko: number | null;
  /** Derived from the pools a fill would actually touch. */
  oneinch: number | null;
  spreadPct: number | null;
  /**
   * Were there actually two numbers to compare?
   *
   * `agree` answers "is there a warning to raise", which is the question the screens ask, and it
   * is deliberately true when a source is missing — reporting a disagreement because one API was
   * down would make an outage look like a data-integrity problem and train people to ignore the
   * warning that matters.
   *
   * But `agree: true` alongside `oneinch: null` is, read on its own, a claim that two sources
   * concurred when only one was ever asked. The note said so and the boolean did not, and a
   * caller reading the field rather than the prose was misled. So the two questions get two
   * fields: `compared` is whether a second opinion exists, `agree` is whether to say anything.
   */
  compared: boolean;
  agree: boolean;
  note: string;
};

async function oneinchSpot(address: string): Promise<number | null> {
  if (!API_KEY) return null;
  try {
    const res = await getJson<Record<string, string>>(
      `https://api.1inch.dev/price/v1.1/${ONEINCH_CHAIN_ID}/${address}?currency=USD`,
      8_000,
      8_000,
      { Authorization: `Bearer ${API_KEY}` },
    );
    const raw = res[address.toLowerCase()] ?? res[address];
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
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
  const token = TOKENS[canonicalSymbol(symbol === 'ETH' ? 'WETH' : symbol)];
  if (!token) {
    return {
      symbol,
      coingecko: await priceOf(symbol, 8_000).catch(() => null),
      oneinch: null,
      spreadPct: null,
      compared: false,
      agree: true,
      note: `${symbol} is not routable on Base, so there is no on-chain price to compare against.`,
    };
  }

  const [coingecko, oneinch] = await Promise.all([
    priceOf(symbol, 8_000).catch(() => null),
    oneinchSpot(token.address),
  ]);

  /*
   * One source missing is not a disagreement.
   *
   * Reporting "they disagree" when only one answered would make an outage look like a data
   * integrity problem, and would train people to ignore the warning that matters.
   */
  if (coingecko === null || oneinch === null) {
    return {
      symbol,
      coingecko,
      oneinch,
      spreadPct: null,
      compared: false,
      agree: true,
      note:
        coingecko === null && oneinch === null
          ? 'Neither price source answered.'
          : `Only one source answered, so there is nothing to compare.`,
    };
  }

  const spreadPct = (Math.abs(coingecko - oneinch) / ((coingecko + oneinch) / 2)) * 100;
  const agree = spreadPct <= DISAGREEMENT_PCT;
  return {
    symbol,
    coingecko,
    oneinch,
    spreadPct,
    compared: true,
    agree,
    note: agree
      ? `Two independent sources within ${spreadPct.toFixed(2)}%.`
      : `The two price sources disagree by ${spreadPct.toFixed(2)}%. The number shown is the market feed; a fill would happen nearer ${oneinch.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}.`,
  };
}
