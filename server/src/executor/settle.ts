/**
 * Which venue settles this leg, and the exact call that does it.
 *
 * Split out of `run.ts`, which had grown back to 1,058 lines as venues were added — and venue
 * selection is the part that kept growing. `run.ts` is about a run: claim the period, check the
 * gates, send, measure, write the book. WHERE a trade fills is a separate question with its own
 * rules, and it now has a file where those rules can be read end to end instead of in the middle
 * of transaction bookkeeping.
 *
 * The rule is best execution, and it is the whole content of this module (PLAN.md 3.20):
 *
 *   1. **Every venue that can serve the leg says what it would deliver.** An **Aqua** book quotes
 *      the size from its own curve; a maker's **SwapVM** program is dry-run through `spend()`, which
 *      returns the router's answer; **the aggregator** quotes the route.
 *   2. **The leg settles where the owner receives the most.** A book wins when it delivers at least
 *      what the aggregator quotes, and Aqua wins a tie with SwapVM: the maker self-custodies through
 *      Aqua, a program's terms are enforced in bytecode, and between equal prices a book is the
 *      better counterparty.
 *
 * It had been a fixed order — Aqua whenever a book could serve, then SwapVM, then the aggregator —
 * and on the rebuilt fork that would have filled a $50 buy 1.1% under the aggregator's quote,
 * because a shallow book could serve it.
 *
 * Neither book is tried on a close or a direct leg. An exit has to be certain, and a book deep
 * enough to buy into may not be deep enough to sell out of.
 *
 * On a fork of Base the aggregator is measured, not taken at its word (PLAN.md X77). 1inch prices a
 * route against live Base, while a fork's pools stay as they were at its fork block and drift from
 * Base as the market moves — so a quote there can be a price the fork no longer has, and the Railway
 * fork's router refused aggregator buys for it. On a fork the route is dry-run through the call that
 * will carry the leg (`evm/measure-route.ts`), and what it delivers there is what a book has to beat,
 * what SwapVM's floor is priced from, and what the owner is held to, less the tolerance. Real Base
 * prices and executes the same state, and settles on the quote.
 */
import type { Address } from 'viem';
import type { OutputFloor } from '../evm/delegation.js';
import { deliveredOnChain, PRICES_DRIFT } from '../evm/measure-route.js';
import { buildSwap, quote, slippageFor, SLIPPAGE, TOKENS as VENUE_TOKENS, type SwapCalldata } from '../venues/oneinch.js';
import { buildAquaFill } from '../venues/aqua.js';
import type { AquaFill } from '../venues/aqua.js';
import { buildSwapVmFill } from '../venues/swapvm.js';
import type { SwapVmFill } from '../venues/swapvm.js';
import { aquaIndexConfigured } from '../graph/aqua.js';
import type { TradeIntent } from './kinds/index.js';

/**
 * The venue that settled, as the activity log and `/metrics` name it.
 *
 * `aave` is a direct leg — idle cash supplied to the pool, no swap anywhere. It was labelled
 * `1inch`, because that was the fallthrough, so the first Earn deposit on the rebuilt fork was
 * written down as an aggregator fill and `/metrics` reported "1inch: 1 fill, 0 bps" for a trade the
 * aggregator never saw.
 */
export type SettlementVenue = 'aqua' | 'swapvm' | '1inch' | 'aave';

/**
 * The contract call that will carry the leg, and what it pulls (PLAN.md X77).
 *
 * On a fork the route is dry-run before it is chosen, and a dry run is only a measurement if it is the
 * call that will be sent: `closePosition()` pulls the sold token in its own units, `spend()` pulls the
 * settlement token for the dollars.
 */
export type SettlementSend = { via: 'spend' | 'closePosition'; amount: bigint };

export type Settlement = {
  /** The token being spent, from the registry. */
  payToken: { address: Address; decimals: number };
  /** The call `spend()` (or `closePosition()`) forwards. */
  swap: { to: Address; data: `0x${string}` };
  venue: SettlementVenue;
  /**
   * What the owner must receive for the trade to stand. Enforced by the contract against the owner's
   * own balance (PLAN.md 1.4) — each venue supplies its own honest floor: the book's quote less
   * slippage, the program's compiled minimum, the router's `dstAmount` less slippage (on a fork, what
   * its route delivers there less slippage), or the pool's receipt token.
   */
  floor: OutputFloor;
};

/** A book that can serve the leg, and what it would deliver the owner, in the output token's base units. */
type BookOffer = { venue: 'aqua'; fill: AquaFill; out: bigint } | { venue: 'swapvm'; fill: SwapVmFill; out: bigint };

/** The aggregator's route on a fork: as measured there, at the tolerance it was built with, or why it cannot run. */
type MeasuredRoute = { swap: SwapCalldata; delivered: bigint; tolerancePct: number } | { refusal: unknown };

/**
 * The better of the two books for this leg, Aqua keeping a tie.
 *
 * A program is compared on what its dry run delivered or, when that came back with nothing to read, on
 * the floor its bytecode enforces — the least it can deliver, never more than it promised.
 */
function bestBook(aqua: AquaFill | undefined, swapVm: SwapVmFill | undefined): BookOffer | undefined {
  const offers: BookOffer[] = [];
  if (aqua) offers.push({ venue: 'aqua', fill: aqua, out: aqua.quotedOut });
  if (swapVm) offers.push({ venue: 'swapvm', fill: swapVm, out: swapVm.expectedOut ?? swapVm.minOut });
  // Strictly more to displace, so the one listed first — Aqua — keeps a tie.
  return offers.reduce<BookOffer | undefined>((best, o) => (best === undefined || o.out > best.out ? o : best), undefined);
}

/** `amount` less `pct` percent, rounded down to a whole raw unit. */
function lessPct(amount: bigint, pct: number): bigint {
  return (amount * BigInt(Math.floor((1 - pct / 100) * 1_000_000))) / 1_000_000n;
}

/**
 * @param owner     The user whose capital is being spent — never ours.
 * @param preferred What the subgraph join recommended, when it had an opinion.
 * @param send      The call that will carry the leg and what it pulls, so a fork can measure exactly that.
 */
export async function chooseSettlement(params: {
  intent: TradeIntent;
  owner: Address;
  preferred: string | undefined;
  isClose: boolean;
  delegationFrom: Address;
  send: SettlementSend;
}): Promise<Settlement> {
  const { intent, owner, preferred, delegationFrom, send } = params;
  const isCloseIntent = () => params.isClose;
  /*
   * "Route to 1inch" is only an answer about the books when an Aqua index gave it (PLAN.md 3.4).
   *
   * `decide()` also says 1inch when no Aqua index is configured at all, or when it could not read one — and
   * this treated every one of those as "no book is deep enough" and skipped both books without looking. A
   * delegation index alone could silently route every fill past a book that was sitting there on chain.
   * Without an Aqua index, the books are discovered from Aqua's own logs below, as they would be with no
   * index at all.
   */
  const skipBooks = preferred === '1inch' && aquaIndexConfigured();

  const payToken = VENUE_TOKENS[intent.inSymbol];
  if (!payToken) throw new Error(`No token registry entry for ${intent.inSymbol}`);
  const outToken = VENUE_TOKENS[intent.outSymbol];
  const tokenOut = (outToken?.address ?? payToken.address) as Address;
  const amountIn = intent.amountInRaw ?? BigInt(Math.round(intent.amountIn * 10 ** payToken.decimals));
  const booksInPlay = !intent.direct && !isCloseIntent() && !skipBooks;
  // A tolerance the person chose is the tolerance every venue gets (PLAN.md 3.9); otherwise the scheduled one.
  const bookSlippage = (intent.slippagePct ?? SLIPPAGE.scheduled) / 100;

  /*
   * The aggregator's quote first.
   *
   * It is the price a book has to beat, SwapVM's floor is taken from it, and it is the only number that
   * can tell a thin pair from a deep one before deciding what tolerance the route needs. A direct leg has
   * no route to quote. Failure is not fatal: an Aqua book quotes itself, and the aggregator's tolerance
   * falls back to the urgency constant.
   */
  const quoted = intent.direct
    ? null
    : await quote({
        inSymbol: intent.inSymbol,
        outSymbol: intent.outSymbol,
        amount: intent.amountIn,
      }).catch(() => null);
  const quotedOut = quoted ? BigInt(Math.round(quoted.outAmount * 10 ** (outToken?.decimals ?? 18))) : undefined;

  /*
   * Urgency sets the floor; the pool sets the rest.
   *
   * A risk-reducing close gets more room than a scheduled buy — see `SLIPPAGE` — but those
   * constants know nothing about the pair being traded. On a thin pool a $60 order can move
   * the price further than the ceiling allows, and the router then refuses at a price its
   * own quote had already predicted. `slippageFor` widens the ceiling by the impact the
   * quote reports, with a cap: a quote predicting several percent is saying the size is
   * wrong for the pool, and accepting that is paying for your own market impact.
   *
   * Except where the person named a tolerance of their own (PLAN.md 3.9): the urgency constants and the
   * impact widening are defaults for trades nobody is watching, not a ceiling to put on someone who chose.
   * A route that needs more than they allowed is refused, and says so.
   */
  const tolerancePct = () =>
    intent.slippagePct ?? slippageFor(isCloseIntent() ? SLIPPAGE.stop : SLIPPAGE.scheduled, quoted?.priceImpactPct ?? null);

  const route = (slippagePct: number) =>
    buildSwap({
      inSymbol: intent.inSymbol,
      outSymbol: intent.outSymbol,
      // In the INPUT token's units. Passing dollars here scaled a position into wei and the
      // router refused a trade orders of magnitude too large.
      amount: intent.amountIn,
      /*
       * The delegation and the router have to be handed the same figure, or the router reverts for the difference.
       * On a whole-position close that is the chain's own balance; on any close it is what `closePosition` will send.
       * A partial sale arrives as a float of coins, which the router rounded to wei and the close floored, so in 42%
       * of $10 WETH sales the router pulled a wei more than it had been approved for: SafeTransferFromFailed, on a
       * rebalance's sell leg on the fork (2026-09-15).
       */
      amountRaw: send.via === 'closePosition' ? send.amount : intent.amountInRaw,
      from: delegationFrom,
      receiver: owner,
      slippagePct,
    });

  /*
   * On a fork, what the route delivers there, measured before anything is held against it (PLAN.md X77).
   *
   * Built at the leg's own tolerance and dry-run through the call that will carry it. A route that cannot
   * run on the fork at all is kept as its refusal: a book that serves is then the only way the leg fills,
   * and with none, that refusal is the leg's answer. A direct leg has no route.
   */
  const measureRoute = async (): Promise<MeasuredRoute> => {
    const tol = tolerancePct();
    try {
      const swap = await route(tol);
      const delivered = await deliveredOnChain({
        owner,
        via: send.via,
        token: payToken.address,
        venue: swap.to,
        amount: send.amount,
        tokenOut,
        data: swap.data,
      });
      return { swap, delivered, tolerancePct: tol };
    } catch (refusal) {
      return { refusal };
    }
  };
  const measured = PRICES_DRIFT && !intent.direct ? await measureRoute() : undefined;
  const delivered = measured && 'delivered' in measured ? measured.delivered : undefined;
  /** What a book has to beat, and what SwapVM's floor is priced from: on a fork what the route delivers there. */
  const reference = delivered ?? quotedOut;
  const routeCannotFill = measured !== undefined && delivered === undefined;

  /*
   * The books, asked together.
   *
   * Aqua: the taker side is the side an operator can legitimately act on — the MAKER self-custodies
   * through Aqua (they signed their own ship), and WE trade inside a cap the taker signed and can revoke.
   * `delegatedFillArgs` returns exactly what `spend()` takes, so the fill goes through the same permission
   * as every other trade: cap, expiry and venue allowlist, all enforced by the contract rather than by us.
   *
   * SwapVM: the same shape with different enforcement — the deadline, the floor and the fee are compiled
   * into bytecode the router executes, rather than trusted to whoever submits the fill. It needs a reference,
   * because `delegatedFillArgs` takes a minimum out and the only honest source for that is what something
   * else said this trade is worth: the quote, or on a fork what the route delivers there.
   *
   * `undefined` from either is not a failure: a maker quotes what they hold, and the aggregator is there
   * for the rest. Tried whenever a book exists and nothing rules the books out — the chain is the authority
   * here as everywhere else.
   */
  const [aqua, swapVm] = booksInPlay
    ? await Promise.all([
        buildAquaFill({
          owner,
          tokenIn: payToken.address,
          tokenOut,
          amountIn,
          slippage: bookSlippage,
        }).catch(() => undefined),
        reference === undefined
          ? Promise.resolve(undefined)
          : buildSwapVmFill({
              owner,
              tokenIn: payToken.address,
              tokenOut,
              amountIn,
              slippage: bookSlippage,
              quotedOut: reference,
            }).catch(() => undefined),
      ])
    : [undefined, undefined];

  /*
   * Best execution. A book settles the leg when it delivers at least what the aggregator would — its quote,
   * or on a fork what its route delivers there. With nothing to hold a book against — no quote, or a route
   * the fork cannot run — a book that serves is taken: its own quote is real.
   */
  const book = bestBook(aqua, swapVm);
  if (book && (routeCannotFill || reference === undefined || book.out >= reference)) {
    if (book.venue === 'aqua') {
      return {
        payToken,
        swap: { to: book.fill.venue, data: book.fill.data },
        venue: 'aqua',
        floor: { tokenOut: book.fill.tokenOut, minOut: book.fill.minOut },
      };
    }
    return {
      payToken,
      swap: { to: book.fill.venue, data: book.fill.data },
      venue: 'swapvm',
      floor: { tokenOut: book.fill.tokenOut, minOut: book.fill.minOut },
    };
  }

  if (intent.direct) {
    return {
      payToken,
      swap: { to: intent.direct.venue, data: intent.direct.data },
      venue: 'aave',
      floor: { tokenOut: intent.direct.tokenOut, minOut: intent.direct.minOut },
    };
  }

  if (measured) {
    // On a fork: the route as measured there, held to what it delivers less the tolerance — or why it cannot run.
    if (!('delivered' in measured)) throw measured.refusal;
    if (!outToken) throw new Error(`No token registry entry for ${intent.outSymbol}`);
    const minOut = lessPct(measured.delivered, measured.tolerancePct);
    if (minOut <= 0n) {
      throw new Error(`The ${intent.inSymbol} -> ${intent.outSymbol} route delivers nothing on this fork at this size`);
    }
    return {
      payToken,
      swap: { to: measured.swap.to, data: measured.swap.data },
      venue: '1inch',
      floor: { tokenOut: outToken.address, minOut },
    };
  }

  const aggregator = await route(tolerancePct());
  if (!outToken) throw new Error(`No token registry entry for ${intent.outSymbol}`);
  return {
    payToken,
    swap: { to: aggregator.to, data: aggregator.data },
    venue: '1inch',
    floor: { tokenOut: outToken.address, minOut: aggregator.minOut },
  };
}
