/**
 * What every venue would give for the same trade, priced at once.
 *
 * The executor already chooses between three settlement paths — Aqua, SwapVM, the aggregator — in
 * a fixed order documented in `executor/settle.ts`. That order is the right policy and it is
 * invisible: the activity trail names the venue that filled, and nothing says what the other two
 * would have done. "Aqua filled this" is a fact; "Aqua filled this and beat the aggregator by 11
 * basis points" is the claim worth making, and it is the one a judge asks about.
 *
 * So this asks all three the same question and reports every answer, including the refusals. A
 * venue that cannot serve the size says why — a maker quotes what they hold, and "no book is deep
 * enough at $5,000" is information rather than an error.
 *
 * Deliberately a QUOTE surface and nothing else. It builds no calldata that could be submitted and
 * touches no permission; the ordering decision still lives in `settle.ts`, which is where it
 * belongs. Two places that decide where a trade fills is the bug this file must not become.
 */
import type { Address } from 'viem';
import { buildSwap, quote, TOKENS as VENUE_TOKENS, SLIPPAGE } from './oneinch.js';
import { buildAquaFill } from './aqua.js';
import { publicClient, delegateAccount } from '../evm/client.js';
import { priceOf } from '../market/prices.js';
import { DELEGATION_ABI, DELEGATION_ADDRESS } from '../evm/delegation.js';
import { buildSwapVmFill, openPrograms } from './swapvm.js';
import { deliveredOnChain, PRICES_DRIFT } from '../evm/measure-route.js';
import { humanFailure } from '../executor/failure.js';
import { beforeDeadline } from '../http/deadline.js';
import { log } from '../http/request-id.js';

export type VenueQuote =
  | {
      venue: 'aqua' | 'swapvm' | '1inch';
      /** Units of the OUT token the venue says the taker receives. */
      outAmount: number;
      /** How the venue got there — pool names for the aggregator, the strategy for a book. */
      detail: string;
      served: true;
      /**
       * What the transaction costs to send, in dollars, and what is left after paying it.
       *
       * The venue with the largest `outAmount` is not always the one that leaves you better off:
       * an aggregator hop through three pools costs meaningfully more gas than a single book fill,
       * and on a small trade that difference is larger than the price difference it bought. A
       * comparison on output alone can therefore recommend the losing venue.
       *
       * `undefined` when the cost could not be estimated — never zero. A zero gas cost is a claim
       * about a transaction, and "we could not measure it" is a claim about our measurement.
       */
      gasUsd?: number;
      netUsd?: number;
    }
  | {
      venue: 'aqua' | 'swapvm' | '1inch';
      served: false;
      /** Why this venue is not an option for this size, in a sentence. */
      reason: string;
    };

export type RouteComparison = {
  inSymbol: string;
  outSymbol: string;
  amount: number;
  quotes: VenueQuote[];
  /** The venue with the highest out, or undefined when nothing could serve the size. */
  best?: 'aqua' | 'swapvm' | '1inch';
  /**
   * The venue that leaves the taker with the most AFTER gas, when every served venue could be
   * costed. Undefined when any could not — a net comparison missing one leg is not a comparison.
   */
  bestNet?: 'aqua' | 'swapvm' | '1inch';
  /**
   * How much better the winner is than the next venue that could serve, in basis points.
   *
   * Undefined when only one venue answered, because "better than nothing" is not a margin. That
   * distinction matters more than it looks: a single-venue result reported as "0 bps better" reads
   * as a tie when it is actually an absence of competition.
   */
  edgeBps?: number;
};

/**
 * How long a caller waits for a comparison (`http/patience.ts`).
 *
 * `withinMs` bounds the whole of it; `priceMs` bounds each price it reads.
 */
export type ComparePatience = { withinMs: number; priceMs: number };

/** One venue's answer, never allowed to fail the whole comparison. */
async function settled<T>(work: Promise<T>): Promise<T | undefined> {
  return work.catch(() => undefined);
}

/** A leg the comparison stopped waiting for: not the venue failing, an answer that had not arrived. */
const LATE = Symbol('late');
type Late = typeof LATE;
class OutOfTime extends Error {}

/**
 * What one of these fills costs to send, in dollars.
 *
 * Gas units come from the chain's own estimate of the actual call, not from a table of typical
 * costs — the whole point is that a three-pool aggregator route and a single book fill are
 * different transactions, and a constant would erase exactly the difference being measured.
 *
 * `undefined` rather than zero on any failure. Zero is a claim about the transaction; not knowing
 * is a claim about us, and a net-of-gas comparison built on a silent zero would confidently
 * recommend whichever venue we failed to price.
 *
 * The gas price and the price of ETH are read once for all three venues: each venue read both again, so a comparison
 * asked for the same ETH price three times over.
 */
async function gasUsdFor(
  estimate: () => Promise<bigint | Late | undefined>,
  feePerGas: bigint | undefined,
  ethUsd: number | undefined,
): Promise<number | undefined> {
  if (feePerGas === undefined || !ethUsd) return undefined;
  const units = await estimate();
  if (typeof units !== 'bigint') return undefined;
  return (Number(units * feePerGas) / 1e18) * ethUsd;
}

export async function compareVenues(params: {
  owner: Address;
  inSymbol: string;
  outSymbol: string;
  amount: number;
  /**
   * How long the caller waits. Without it every leg waits as long as it takes, as the live test does.
   *
   * `/route/compare` passes a screen's patience. The legs ran one after another with no bound, so one slow answer — a
   * 1inch call waiting its turn behind a rate limit, a dry run on a busy fork, a price on a cold cache — held the whole
   * comparison: against the hosted fork one ask took 46 s and another gave no answer inside 90 (E165). The legs that do
   * not need each other now start together, and a venue that has not answered when the time is up is reported as not
   * answering in time, beside the venues that did.
   */
  patience?: ComparePatience;
}): Promise<RouteComparison> {
  const { owner, inSymbol, outSymbol, amount, patience } = params;
  const payToken = VENUE_TOKENS[inSymbol];
  const outToken = VENUE_TOKENS[outSymbol];
  if (!payToken || !outToken) throw new Error(`No token registry entry for ${inSymbol}/${outSymbol}`);

  const amountIn = BigInt(Math.round(amount * 10 ** payToken.decimals));
  const outUnits = (raw: bigint) => Number(raw) / 10 ** outToken.decimals;

  const until = patience ? Date.now() + patience.withinMs : undefined;
  /** `work`, or `LATE` once the comparison's time is up. The work is not cancelled, and a late failure of it is swallowed. */
  const inTime = async <T>(work: Promise<T>): Promise<T | Late> => {
    if (until === undefined) return work;
    try {
      return await beforeDeadline(work, Math.max(0, until - Date.now()), () => new OutOfTime());
    } catch (e) {
      if (e instanceof OutOfTime) return LATE;
      throw e;
    }
  };
  /** A leg's answer: what it returned, `LATE`, or `undefined` when it failed. */
  const answer = <T>(work: Promise<T>): Promise<T | Late | undefined> => settled(inTime(work));
  const price = (symbol: string) => priceOf(symbol, patience?.priceMs).catch(() => undefined);

  /*
   * Started together, because none of these needs another's answer: the aggregator's quote, the programs shipped, the
   * books' fill, and what gas costs. SwapVM's floor and the fork's dry run are priced from the aggregator's quote, so
   * those wait for it below.
   */
  const aggQuote = answer(quote({ inSymbol, outSymbol, amount }));
  const programs = answer(openPrograms());
  const aquaFill = answer(
    buildAquaFill({
      owner,
      tokenIn: payToken.address,
      tokenOut: outToken.address,
      amountIn,
      slippage: SLIPPAGE.scheduled / 100,
    }),
  );
  const costs = Promise.all([answer(publicClient.getGasPrice()), price('ETH')]);
  const outPrice = price(outSymbol);

  /*
   * The aggregator first, and not only because it usually wins: SwapVM needs a minimum-out, and
   * the only honest source for one is what something else says the trade is worth. Same dependency
   * `settle.ts` has.
   */
  const aggAnswer = await aggQuote;
  const aggLate = aggAnswer === LATE;
  const agg = aggAnswer === LATE ? undefined : aggAnswer;

  /*
   * On a fork, what the route delivers there, not what 1inch quotes on Base (PLAN.md X77).
   *
   * A fork's pools stay as they were at its fork block while 1inch prices live Base, so the quote can be a price the
   * fork no longer has — the Railway fork's router refused aggregator buys for it while this table still listed the
   * route as serving. The route is dry-run through the `spend()` that would carry it, and that figure is both the
   * aggregator's row and what SwapVM's floor is priced from, as in `settle.ts`. A dry run that has not answered in time
   * leaves the aggregator with no figure here: the quote cannot stand in for it on a fork.
   */
  const onFork = PRICES_DRIFT && agg !== undefined;
  const routeAnswer = onFork
    ? await inTime(
        buildSwap({
          inSymbol,
          outSymbol,
          amount,
          amountRaw: amountIn,
          from: DELEGATION_ADDRESS,
          receiver: owner,
          slippagePct: SLIPPAGE.scheduled,
        })
          .then(async (swap) => ({
            swap,
            delivered: await deliveredOnChain({
              owner,
              via: 'spend',
              token: payToken.address,
              venue: swap.to,
              amount: amountIn,
              tokenOut: outToken.address,
              data: swap.data,
            }),
          }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            // The sentence is for the person and the cause is for the log: a revert nobody had named read only as "did
            // not go through", and the fork's aggregator row could not be diagnosed from the executor's logs.
            log.warn(`[route] the aggregator's route does not fill on this chain: ${message.replace(/\s+/g, ' ').slice(0, 600)}`);
            return { refusal: humanFailure(message) };
          }),
      )
    : undefined;
  const routeLate = routeAnswer === LATE;
  const forkRoute = routeAnswer === LATE ? undefined : routeAnswer;
  /** The aggregator's answer in raw output units: measured on a fork, quoted elsewhere; undefined where it has none. */
  const aggOutRaw = onFork
    ? forkRoute !== undefined && 'delivered' in forkRoute
      ? forkRoute.delivered
      : undefined
    : agg
      ? BigInt(Math.round(agg.outAmount * 10 ** outToken.decimals))
      : undefined;
  const aggOut = onFork ? (aggOutRaw === undefined ? undefined : outUnits(aggOutRaw)) : agg?.outAmount;

  const swapVmAnswer =
    aggOutRaw !== undefined
      ? await answer(
          buildSwapVmFill({
            owner,
            tokenIn: payToken.address,
            tokenOut: outToken.address,
            amountIn,
            slippage: SLIPPAGE.scheduled / 100,
            quotedOut: aggOutRaw,
          }),
        )
      : undefined;
  const swapVm = swapVmAnswer === LATE ? undefined : swapVmAnswer;
  const aquaAnswer = await aquaFill;
  const aqua = aquaAnswer === LATE ? undefined : aquaAnswer;

  /*
   * How many programs exist at all, so a refusal can name its own cause. Counted separately from
   * the fill attempt because `buildSwapVmFill` collapses "none shipped" and "none fillable" into
   * the same `undefined`. Undefined here when the count did not arrive in time.
   */
  const programsAnswer = await programs;
  const shippedCount = programsAnswer === LATE ? undefined : (programsAnswer?.length ?? 0);

  /*
   * Cost each fill by estimating the transaction the settlement path would actually send.
   *
   * Aqua and SwapVM both settle through `XorrDelegation.spend()`, so that is the call estimated —
   * the same one `chooseSettlement` forwards. The aggregator's leg goes through the same `spend`
   * with the router's calldata, but building that calldata is a second 1inch call on a quote
   * surface, so its cost is taken from the swap the router itself describes.
   *
   * All three are estimates against the live chain, in parallel, and any that fails stays
   * `undefined` rather than defaulting to zero.
   */
  const [feePerGasAnswer, ethUsd] = await costs;
  const feePerGas = feePerGasAnswer === LATE ? undefined : feePerGasAnswer;
  const [aquaGas, swapVmGas, aggGas] = await Promise.all([
    aqua
      ? gasUsdFor(
          () =>
            answer(
              publicClient.estimateContractGas({
                account: delegateAccount.address,
                address: DELEGATION_ADDRESS,
                abi: DELEGATION_ABI,
                functionName: 'spend',
                args: [owner, aqua.token, aqua.venue, aqua.amount, aqua.tokenOut, aqua.minOut, aqua.data],
              }),
            ),
          feePerGas,
          ethUsd,
        )
      : Promise.resolve(undefined),
    swapVm
      ? gasUsdFor(
          () =>
            answer(
              publicClient.estimateContractGas({
                account: delegateAccount.address,
                address: DELEGATION_ADDRESS,
                abi: DELEGATION_ABI,
                functionName: 'spend',
                args: [owner, swapVm.token, swapVm.venue, swapVm.amount, swapVm.tokenOut, swapVm.minOut, swapVm.data],
              }),
            ),
          feePerGas,
          ethUsd,
        )
      : Promise.resolve(undefined),
    /*
     * The aggregator costed the way the books are (PLAN.md 3.6): the whole `spend()` that would carry it.
     *
     * It used 1inch's own `estimatedGas`, which covers the router alone, while each book was estimated through
     * the delegation — so the books carried `spend()`'s overhead and the aggregator did not, and the net ranking
     * leaned toward the aggregator by exactly that much.
     */
    agg && aggOut !== undefined
      ? gasUsdFor(
          () =>
            answer(
              (async () => {
                // On a fork, the route already measured, at its measured floor; elsewhere the route as 1inch builds it.
                const measured = forkRoute && 'delivered' in forkRoute ? forkRoute : undefined;
                const swap =
                  measured?.swap ??
                  (await buildSwap({
                    inSymbol,
                    outSymbol,
                    amount,
                    amountRaw: amountIn,
                    from: DELEGATION_ADDRESS,
                    receiver: owner,
                    slippagePct: SLIPPAGE.scheduled,
                  }));
                const minOut = measured
                  ? (measured.delivered * BigInt(Math.floor((1 - SLIPPAGE.scheduled / 100) * 1_000_000))) / 1_000_000n
                  : swap.minOut;
                return publicClient.estimateContractGas({
                  account: delegateAccount.address,
                  address: DELEGATION_ADDRESS,
                  abi: DELEGATION_ABI,
                  functionName: 'spend',
                  args: [owner, payToken.address, swap.to, amountIn, outToken.address, minOut, swap.data],
                });
              })(),
            ),
          feePerGas,
          ethUsd,
        )
      : Promise.resolve(undefined),
  ]);

  /** Dollar value of an OUT-token amount, for the net comparison. Undefined if it cannot be priced. */
  const outUsd = await outPrice;
  const net = (out: number, gasUsd: number | undefined) =>
    outUsd !== undefined && gasUsd !== undefined ? out * outUsd - gasUsd : undefined;

  const quotes: VenueQuote[] = [
    aqua
      ? {
          venue: 'aqua',
          outAmount: outUnits(aqua.quotedOut),
          // The strategy is a struct; it was interpolated whole and printed "[object Object]" (PLAN.md 3.6).
          detail: `maker book from ${aqua.strategy.maker.slice(0, 10)}…, ${Number(aqua.strategy.feeBps)} bps fee`,
          served: true,
          gasUsd: aquaGas,
          netUsd: net(outUnits(aqua.quotedOut), aquaGas),
        }
      : {
          venue: 'aqua',
          served: false,
          reason:
            aquaAnswer === LATE
              ? 'The maker books did not answer in time.'
              : 'No maker book is deep enough for this size right now.',
        },
    swapVm
      ? {
          venue: 'swapvm',
          /*
           * What the program delivers for this fill, not its floor (PLAN.md 3.20).
           *
           * The floor is the aggregator's own quote less the scheduled slippage, so reporting it ranked SwapVM
           * exactly 30 bps under the aggregator at every size, by construction. The dry run of `spend()` runs the
           * router and returns its answer. The floor is still what the bytecode enforces, and is named as such;
           * it stands in only when the dry run returned nothing to read.
           */
          outAmount: outUnits(swapVm.expectedOut ?? swapVm.minOut),
          detail:
            swapVm.expectedOut === undefined
              ? 'shipped program, floor enforced in bytecode'
              : `maker program, at least ${Number(outUnits(swapVm.minOut).toPrecision(6))} enforced in bytecode`,
          served: true,
          gasUsd: swapVmGas,
          netUsd: net(outUnits(swapVm.expectedOut ?? swapVm.minOut), swapVmGas),
        }
      : {
          venue: 'swapvm',
          served: false,
          /*
           * WHY it cannot serve, distinguished rather than assumed.
           *
           * This said "no maker has shipped a program" for every refusal, which was measurably
           * false on the fork: sixteen programs were open and discoverable, and the fill was
           * refused by the dry run for this owner's permission. A comparison whose reasons are
           * guesses is worth less than one that admits the difference — "nobody is quoting" and
           * "somebody is quoting and you cannot take it" are opposite facts about the venue.
           */
          reason:
            swapVmAnswer === LATE
              ? 'The maker programs did not answer in time.'
              : aggOutRaw === undefined
                ? aggLate || routeLate
                  ? 'Needs a reference price, and the aggregator did not answer in time.'
                  : 'Needs a reference price, and the aggregator did not answer.'
                : shippedCount === undefined
                  ? 'No program can fill this size under your permission right now.'
                  : shippedCount === 0
                    ? 'No maker has shipped a program for this pair.'
                    : `${shippedCount} program${shippedCount === 1 ? ' is' : 's are'} shipped, but none can fill this size under your permission right now.`,
        },
    agg && aggOut !== undefined
      ? {
          venue: '1inch',
          outAmount: aggOut,
          /*
           * The pools by name, not "Best of 2 venues".
           *
           * `routeLabel` summarises for the order ticket, which has one line. Here the whole point
           * is that each venue's answer can be compared, and "Best of 2 venues" is a count where
           * the other two rows give a reason — so it names what it routed through, the same way the
           * activity trail does.
           */
          detail:
            (agg.venues.length ? `via ${agg.venues.join(', ')}` : 'direct, no pool hop') +
            // On a fork the amount is what the route delivers there, beside what 1inch quotes on Base (PLAN.md X77).
            (onFork ? `, measured on this fork — 1inch quotes ${Number(agg.outAmount.toPrecision(6))} on Base` : ''),
          served: true,
          gasUsd: aggGas,
          netUsd: net(aggOut, aggGas),
        }
      : {
          venue: '1inch',
          served: false,
          reason:
            aggLate || routeLate
              ? 'The aggregator did not answer in time.'
              : forkRoute && 'refusal' in forkRoute
                ? `1inch's route does not fill on this fork right now: ${forkRoute.refusal}`
                : 'The aggregator returned no route for this pair.',
        },
  ];

  return { inSymbol, outSymbol, amount, quotes, ...rankVenues(quotes) };
}

/**
 * Which venue wins, gross and after gas, and by how much (PLAN.md 3.6).
 *
 * Exported so the rule is tested as it runs rather than as a copy of it. `bestNet` is named only when every
 * served venue could be costed: a ranking that silently dropped the venue it could not price would present
 * a partial comparison as a whole one. The edge is the best served quote over the second, and is not stated
 * when the second delivers nothing.
 */
export function rankVenues(quotes: VenueQuote[]): Pick<RouteComparison, 'best' | 'bestNet' | 'edgeBps'> {
  const served = quotes.filter((q): q is Extract<VenueQuote, { served: true }> => q.served);
  const byOut = [...served].sort((a, b) => b.outAmount - a.outAmount);
  const allCosted = served.length > 0 && served.every((q) => q.netUsd !== undefined);
  const byNet = allCosted ? [...served].sort((a, b) => b.netUsd! - a.netUsd!) : [];
  return {
    best: byOut[0]?.venue,
    bestNet: byNet[0]?.venue,
    edgeBps:
      byOut.length > 1 && byOut[1]!.outAmount > 0
        ? Math.round(((byOut[0]!.outAmount - byOut[1]!.outAmount) / byOut[1]!.outAmount) * 10_000)
        : undefined,
  };
}
