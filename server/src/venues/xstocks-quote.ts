/**
 * What an xStock order actually costs, read off the quote that would fill it.
 *
 * The order ticket showed a size and a CTA. Between those two is everything that decides what the
 * person ends up holding, and none of it was on the screen: the venue's own price impact at this
 * size, the tolerance the swap is sent with, and the pools the order is routed through. A ticket
 * that hides those is asking someone to agree to a number it has not shown them.
 *
 * Every field here is read from a real Jupiter quote for the real size. Nothing is modelled and
 * nothing has a default that stands in for a missing reading — `quote()` raises rather than
 * inventing one (see `jupiter.ts`), and a figure the venue did not report arrives here as null.
 *
 * The quote is taken with the same inputs `executor/place.ts` uses for the fill — same mint, same
 * unit conversion, same `slippageBps` — so the breakdown is a preview of that order and not of a
 * similar one.
 */
import { quote, UnpricedError, type JupiterQuoteResponse } from './jupiter.js';
import { XSTOCKS, xStockKey, xStockPriceUsd } from './xstocks.js';
import { DEFAULT_MINTS } from '../solana/clusters.js';
import { fromUiAmount, readMintScale } from '../solana/balances.js';

/** USDC is six decimals on every cluster this runs on, and carries no scaled-UI multiplier. */
const USDC_DECIMALS = 6;

/** The executor's own default, and what `place.ts` sends when an intent names no tolerance. */
export const DEFAULT_SLIPPAGE_BPS = 50;

export type RouteHop = {
  /** The AMM, in the aggregator's own words: `Whirlpool`, `Raydium CLMM`, `Meteora DLMM`. */
  label: string;
  /** How much of the order this hop carries, as a percent. Null when the venue did not say. */
  percent: number | null;
};

export type XStockQuoteBreakdown = {
  symbol: string;
  side: 'buy' | 'sell';
  /** The size asked for, in USD. */
  usd: number;
  /** What is paid, in that token's own units, and which token it is. */
  pay: number;
  payToken: string;
  /** What the venue expects to deliver, and in what. */
  receive: number;
  receiveToken: string;
  /**
   * The floor: the least the venue may deliver at this tolerance and still fill.
   *
   * `otherAmountThreshold`, not arithmetic on `receive` — it is the number the swap is actually
   * submitted with, so a swap that delivers less than this reverts.
   */
  minimumReceive: number;
  /** The venue's measured impact at this size, as a percent. Null when it reported none. */
  priceImpactPct: number | null;
  /** What that impact costs, in USD, at this size. Null when the impact was not reported. */
  priceImpactUsd: number | null;
  /** The tolerance the quote was taken at, as the venue echoed it back. */
  slippageBps: number;
  /**
   * The worst the tolerance allows, in USD — the gap between what is expected and the floor.
   *
   * This is the number the percentage is for. "0.5%" is a figure someone has to do arithmetic on
   * before it means anything; "at worst $1.25 less" is the same fact already in money.
   */
  slippageWorstUsd: number;
  /** Every hop, in the order the route takes them. */
  hops: RouteHop[];
  /**
   * What the aggregator takes. Null means it takes nothing, which is this deployment's case — no
   * referral account is configured — and is reported rather than omitted, because a missing line
   * reads the same as one nobody checked.
   */
  platformFeeUsd: number | null;
  /** The price this order works out to per token, once impact is in it. */
  effectivePrice: number;
  /** The pool mark for one token, to read `effectivePrice` against. */
  markPrice: number;
};

/** A string field from the wire as a finite number, or null. */
function toNum(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * How many raw units of `symbol` are worth `usd` at `mark`.
 *
 * Through `readMintScale`, exactly as `place.ts` converts for a sell. xStocks are Token-2022 with
 * the Scaled UI Amount extension: an issuer multiplier decides how many raw units a displayed
 * holding is, and dividing by a hardcoded 8 decimals prices the pre-split position. A preview built
 * on the wrong conversion would quote a different order from the one that fills.
 */
async function sellUnits(mint: string, usd: number, mark: number): Promise<bigint> {
  const scale = await readMintScale(mint);
  return fromUiAmount(usd / mark, scale);
}

/** The hops, in order, as the venue named them. An empty route is not a route. */
function hopsOf(q: JupiterQuoteResponse): RouteHop[] {
  return (q.routePlan ?? []).map((leg) => ({
    label: leg.swapInfo.label,
    percent: toNum(leg.percent),
  }));
}

/**
 * The breakdown for one order.
 *
 * Raises `UnpricedError` when no venue will price the pair — the ticket shows that as "no quote"
 * rather than a breakdown of zeroes, which would read as a free trade.
 */
export async function xStockQuote(params: {
  symbol: string;
  side: 'buy' | 'sell';
  usd: number;
  slippageBps?: number;
}): Promise<XStockQuoteBreakdown> {
  const key = xStockKey(params.symbol);
  const token = key ? XSTOCKS[key] : undefined;
  if (!key || !token) throw new UnpricedError(`${params.symbol} is not a tokenized equity here.`);
  if (!(params.usd > 0)) throw new UnpricedError('The amount must be above zero.');

  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  /*
   * The mark, from the same read `place.ts` prices a sell against.
   *
   * Two jobs: it converts a dollar sale into token units, and it is what `effectivePrice` is read
   * against on either side. Without it there is no honest way to put a token figure into money, so
   * a missing mark is a missing breakdown rather than a breakdown with a guessed denominator.
   */
  const markPrice = await xStockPriceUsd(key);
  if (!markPrice || !(markPrice > 0)) {
    throw new UnpricedError(`No price for ${key}, so its cost cannot be broken down.`);
  }

  const buying = params.side === 'buy';
  const amountUnits = buying
    ? BigInt(Math.round(params.usd * 10 ** USDC_DECIMALS))
    : await sellUnits(token.address, params.usd, markPrice);

  const q = await quote({
    inSymbolOrMint: buying ? 'USDC' : token.address,
    outSymbolOrMint: buying ? token.address : 'USDC',
    amountUnits,
    slippageBps,
  });

  /*
   * Read back in the units each side is actually denominated in.
   *
   * The venue echoes `slippageBps`, and it is that echo which is reported — not what was asked for.
   * A venue that clamped the tolerance would otherwise have the ticket promise a floor it never
   * agreed to.
   */
  const outDecimals = buying ? token.decimals : USDC_DECIMALS;
  const inDecimals = buying ? USDC_DECIMALS : token.decimals;
  const pay = Number(q.inAmount) / 10 ** inDecimals;
  const receive = Number(q.outAmount) / 10 ** outDecimals;
  const minimumReceive = Number(q.otherAmountThreshold) / 10 ** outDecimals;

  /*
   * Every figure into USD through one rule: what a unit of the RECEIVED token is worth.
   *
   * Buying, that is the mark for one share. Selling, the received token is USDC and a dollar is a
   * dollar. Doing this once is what keeps the two sides of the ticket from disagreeing about what a
   * half-percent costs.
   */
  const receivedUnitUsd = buying ? markPrice : 1;

  const priceImpactPct = toNum(q.priceImpactPct);
  const platformFee = toNum(q.platformFee?.amount);

  return {
    symbol: key,
    side: params.side,
    usd: params.usd,
    pay,
    payToken: buying ? 'USDC' : key,
    receive,
    receiveToken: buying ? key : 'USDC',
    minimumReceive,
    // The wire carries a fraction — 0.00056 — and every surface that reads it wants a percentage.
    priceImpactPct: priceImpactPct === null ? null : priceImpactPct * 100,
    priceImpactUsd: priceImpactPct === null ? null : priceImpactPct * params.usd,
    slippageBps: q.slippageBps,
    slippageWorstUsd: Math.max(0, (receive - minimumReceive) * receivedUnitUsd),
    hops: hopsOf(q),
    platformFeeUsd: platformFee === null ? null : (platformFee / 10 ** outDecimals) * receivedUnitUsd,
    // What one share costs once impact is in it, on either side: dollars paid over shares moved.
    effectivePrice: buying ? pay / receive : receive / pay,
    markPrice,
  };
}
