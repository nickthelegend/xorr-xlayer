/**
 * What an xStock order actually costs, read off the quote that would fill it (X Layer, 2026-09-19).
 *
 * The order ticket showed a size and a CTA. Between those two is everything that decides what the
 * person ends up holding, and none of it was on the screen: the price impact at this size, the
 * tolerance the swap is sent with, and the pools the order is routed through. A ticket that hides
 * those is asking someone to agree to a number it has not shown them.
 *
 * Every field here is read from a real Uniswap v3 quote (QuoterV2 `quoteExactInput`, `venues/uniswap.ts`)
 * for the real size, along the same path the fill takes. Nothing is modelled and nothing has a
 * default that stands in for a missing reading — a quote that cannot be had raises `UnpricedError`,
 * and a figure the venue did not report arrives here as null.
 *
 * The quote is taken with the same inputs the executor's fill uses — the wrapped xStock (what the
 * pools hold), the same route (`routeBetween`), the same tolerance — so the breakdown is a preview of
 * that order and not of a similar one.
 */
import { quote, routeBetween, VENUE_NAME } from './uniswap.js';
import { UnpricedError } from './errors.js';
import { XSTOCKS, xStockKey, xStockPriceUsd } from './xstocks.js';
import { SETTLEMENT_SYMBOL } from './tokens.js';

export { UnpricedError } from './errors.js';

/** The executor's own default (`DEFAULT_SLIPPAGE_PCT` 0.3% in `tokens.ts`), in basis points. */
export const DEFAULT_SLIPPAGE_BPS = 30;

/**
 * One pool the order passes through, in order.
 *
 * Uniswap routes are sequential, not split: the whole order passes through every hop, so `percent`
 * is 100 on each. `USDC → TSLAx` is one hop; `USDC → USDG → NVDAx` is two.
 */
export type RouteHop = {
  /** A readable name for the hop: `Uniswap v3 USDC→USDG 0.01%`. */
  label: string;
  /** How much of the order this hop carries, as a percent. Always 100 on a sequential Uniswap path. */
  percent: number | null;
  /** The venue: `Uniswap v3`. */
  venue: string;
  /** The token going into this pool. */
  from: string;
  /** The token coming out of it. */
  to: string;
  /** The pool's fee tier, as a percent: 0.05 for the 500 tier, 0.01 for 100. */
  feePct: number;
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
   * The floor: the least the swap may deliver at this tolerance and still fill. The same rule the
   * swap's `amountOutMinimum` is built with (`uniswap.buildSwap`), so a fill below it reverts.
   */
  minimumReceive: number;
  /** Measured impact at this size against the market mid, as a percent. Null when it could not be measured. */
  priceImpactPct: number | null;
  /** What that impact costs, in USD, at this size. Null when the impact was not measured. */
  priceImpactUsd: number | null;
  /** The tolerance the quote was taken at. */
  slippageBps: number;
  /**
   * The worst the tolerance allows, in USD — the gap between what is expected and the floor.
   *
   * "0.3%" is a figure someone has to do arithmetic on before it means anything; "at worst $0.75
   * less" is the same fact already in money.
   */
  slippageWorstUsd: number;
  /** Every pool, in the order the route takes them. */
  hops: RouteHop[];
  /**
   * What an aggregator or interface takes on top of the pools. Null: xorr routes straight to
   * Uniswap's router and nothing is taken beyond each pool's own fee tier (listed per hop).
   */
  platformFeeUsd: number | null;
  /** The quoter's gas estimate for the swap, in gas units. Null when it gave none. */
  estimatedGas: number | null;
  /** The price this order works out to per token, once impact is in it. */
  effectivePrice: number;
  /** The pool mark for one token, to read `effectivePrice` against. */
  markPrice: number;
};

/** Uniswap v3 fee tiers are hundredths of a basis point: 500 → 0.05%. */
function feePct(fee: number): number {
  return fee / 10_000;
}

/** The pools along a route, as the path encodes them. */
function hopsOf(route: { tokens: string[]; fees: number[] }): RouteHop[] {
  return route.fees.map((fee, i) => {
    const from = route.tokens[i]!;
    const to = route.tokens[i + 1]!;
    const pct = feePct(fee);
    return {
      label: `${VENUE_NAME} ${from}→${to} ${pct}%`,
      percent: 100,
      venue: VENUE_NAME,
      from,
      to,
      feePct: pct,
    };
  });
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
   * The mark: one wrapped share's worth, from the same pools (`stocks.ts`).
   *
   * Two jobs: it converts a dollar sale into share units, and it is what `effectivePrice` is read
   * against on either side. Without it there is no honest way to put a token figure into money, so
   * a missing mark is a missing breakdown rather than a breakdown with a guessed denominator.
   */
  const markPrice = await xStockPriceUsd(key);
  if (!markPrice || !(markPrice > 0)) {
    throw new UnpricedError(`No price for ${key}, so its cost cannot be broken down.`);
  }

  const buying = params.side === 'buy';
  const inSymbol = buying ? SETTLEMENT_SYMBOL : key;
  const outSymbol = buying ? key : SETTLEMENT_SYMBOL;
  // The wrapper never rebases, so a dollar sale is simply usd / mark wrapped shares.
  const amount = buying ? params.usd : params.usd / markPrice;

  let route: { tokens: string[]; fees: number[] };
  let q: Awaited<ReturnType<typeof quote>>;
  try {
    route = routeBetween(inSymbol, outSymbol);
    q = await quote({ inSymbol, outSymbol, amount, slippagePct: slippageBps / 100 });
  } catch (e) {
    if (e instanceof UnpricedError) throw e;
    // No pool, no liquidity at this size, or the quoter could not be reached: all "we could not find out".
    throw new UnpricedError(e instanceof Error ? e.message : String(e));
  }
  if (!(q.outAmount > 0)) throw new UnpricedError(`No liquidity for ${inSymbol} -> ${outSymbol} at this size.`);

  const pay = q.inAmount;
  const receive = q.outAmount;
  const minimumReceive = q.minimumOut;

  /*
   * Every figure into USD through one rule: what a unit of the RECEIVED token is worth.
   *
   * Buying, that is the mark for one share. Selling, the received token is USDC and a dollar is a
   * dollar. Doing this once is what keeps the two sides of the ticket from disagreeing about what a
   * tenth of a percent costs.
   */
  const receivedUnitUsd = buying ? markPrice : 1;
  const impact = q.priceImpactPct;

  return {
    symbol: key,
    side: params.side,
    usd: params.usd,
    pay,
    payToken: inSymbol,
    receive,
    receiveToken: outSymbol,
    minimumReceive,
    priceImpactPct: impact,
    priceImpactUsd: impact === null ? null : (impact / 100) * params.usd,
    slippageBps: Math.round(q.slippagePct * 100),
    slippageWorstUsd: Math.max(0, (receive - minimumReceive) * receivedUnitUsd),
    hops: hopsOf(route),
    platformFeeUsd: null,
    estimatedGas: q.estimatedGas ?? null,
    // What one share costs once impact is in it, on either side: dollars paid over shares moved.
    effectivePrice: buying ? pay / receive : receive / pay,
    markPrice,
  };
}
