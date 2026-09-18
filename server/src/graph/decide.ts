/**
 * The agent's pre-flight check, decided from indexed chain data.
 *
 * Every branch here changes what the bot DOES, which is the difference between using The Graph and
 * merely displaying it. Called by the executor before any spend.
 *
 * It reads TWO independent subgraphs over two different protocols:
 *
 *   - `xorr` (subgraph/)      — our XorrDelegation contract. What this user has permitted, what
 *                               they have spent today, and how their realised flow has run.
 *   - `xorr-aqua` (subgraph-aqua/) — the official 1inch Aqua deployment. Which maker books are
 *                               open right now and how deep each one is.
 *
 * Neither index can see the other's half, and the decision needs both: a permission with no venue
 * and a venue with no permission are equally dead. The join is what picks the route — an Aqua book
 * when one can fill the size, the 1inch aggregator when none can.
 */
import {
  dailySpendFor,
  indexesThisDeployment,
  policyFor,
  spendsFor,
  unitsToUsd,
  type Spend,
} from './client.js';
import { aquaIndexConfigured, bestBookFor, AquaIndexUnavailable } from './aqua.js';

/** Where the trade should go, and why. */
export type Route =
  | { venue: 'aqua'; strategyHash: string; maker: string; why: string }
  | { venue: '1inch'; why: string };

export type Decision =
  | {
      act: true;
      sizeUsd: number;
      rationale: string;
      observedRemainingUsd: number;
      route: Route;
    }
  | { act: false; reason: string; rationale: string };

/** How much of the cap the bot is willing to commit in one trade. */
const MAX_FRACTION_OF_REMAINING = 0.25;
/** Below this, a trade costs more in gas than it is worth. */
const MIN_TRADE_USD = 5;
/**
 * If nearly all recent flow ran one way, the book is being picked off rather than traded around.
 * Stand down rather than keep quoting into it.
 */
const ONE_SIDED_THRESHOLD = 0.9;
const ONE_SIDED_MIN_SAMPLES = 4;

export function flowImbalance(spends: Spend[], token: string): number {
  if (spends.length === 0) return 0;
  const sameToken = spends.filter((s) => s.token.toLowerCase() === token.toLowerCase()).length;
  return sameToken / spends.length;
}

/**
 * Which venue can fill this, according to the Aqua index.
 *
 * Three outcomes, all meaningful: a book deep enough (route there), no book deep enough (route to
 * the aggregator), or the index is unreachable (route to the aggregator, and say so — silently
 * treating "cannot see" as "nothing there" would hide an outage behind a worse fill).
 */
async function chooseRoute(params: {
  app?: string;
  tokenOut?: string;
  /** How much of `tokenOut` the size buys — asked for only when there is an index to hold it to. */
  amountOut?: Promise<bigint | undefined>;
}): Promise<Route> {
  if (!aquaIndexConfigured() || !params.app || !params.tokenOut || !params.amountOut) {
    return { venue: '1inch', why: 'No Aqua book index configured for this deployment.' };
  }
  /*
   * A size that could not be priced is its own reason.
   *
   * It read "No Aqua book index configured for this deployment" — on a deployment with an index, about a price that did
   * not come back — which sent whoever read it to look at the configuration.
   */
  const amountOut = await params.amountOut;
  if (amountOut === undefined) {
    return {
      venue: '1inch',
      why: 'Could not price this size in the token it buys, so no Aqua book was checked for depth.',
    };
  }
  try {
    const book = await bestBookFor(params.app, params.tokenOut, amountOut);
    if (!book) {
      return { venue: '1inch', why: 'No open Aqua book is deep enough for this size.' };
    }
    return {
      venue: 'aqua',
      strategyHash: book.id,
      maker: book.maker,
      why: `An open Aqua book has the depth and has filled ${book.fillCount} times.`,
    };
  } catch (e) {
    if (e instanceof AquaIndexUnavailable) {
      return { venue: '1inch', why: `Could not read the Aqua index (${e.message}).` };
    }
    throw e;
  }
}

export async function decide(params: {
  owner: string;
  wantUsd: number;
  token: string;
  /** The Aqua app to look for books under — our XorrAquaBook deployment. */
  aquaApp?: string;
  /** The token the trade buys, for the depth check. */
  tokenOut?: string;
  /**
   * How many base units of `tokenOut` the size buys — or how to find out.
   *
   * A function is called only when the depth check will run, and at the start, beside the index reads.
   * `/graph/decision` priced the size before it asked anything else, with no deadline, so a CoinGecko lane backed up
   * behind the market warmer held the route for as long as the lane did — on the fork executor, whose index is for
   * another contract, where the decision never reaches the depth check at all.
   */
  amountOut?: bigint | (() => Promise<bigint | undefined>);
}): Promise<Decision> {
  // 0. Is the index even about this contract? On a fork it is not, and a decision drawn from a
  //    different deployment's history would be worse than no decision. The contract itself is
  //    checked immediately after this in every caller, so standing aside here is safe.
  if (!indexesThisDeployment()) {
    return {
      act: false,
      reason: 'index_is_for_another_deployment',
      rationale:
        'The subgraph indexes a different delegation contract than this executor is using, so I ' +
        'am not reading permission from it.',
    };
  }

  const depthChecked = aquaIndexConfigured() && Boolean(params.aquaApp) && Boolean(params.tokenOut);
  const sizing = !depthChecked
    ? undefined
    : typeof params.amountOut === 'function'
      ? params.amountOut()
      : Promise.resolve(params.amountOut);
  // A decision that stops before the depth check leaves this unread, and its failure must not surface unhandled.
  void sizing?.catch(() => undefined);

  /*
   * The three delegation-index reads, asked together and used in order.
   *
   * They were asked one after another, each allowed five seconds, so an index that answered slowly cost a decision up to
   * fifteen before the venue index was even asked. None depends on another's answer. Each is still read in the order
   * below, so a decision stops at the same step for the same reason as it did — only sooner — and the reads a stop
   * leaves unused are caught, so their failures are not unhandled rejections.
   */
  const policyRead = policyFor(params.owner);
  const daysRead = dailySpendFor(params.owner, 1);
  const recentRead = spendsFor(params.owner, 20);
  void daysRead.catch(() => undefined);
  void recentRead.catch(() => undefined);

  // 1. The permission, as the CHAIN records it. Our database is not consulted.
  const policy = await policyRead;
  if (!policy) {
    return { act: false, reason: 'no_policy_onchain', rationale: 'No permission exists on-chain.' };
  }
  if (policy.revoked) {
    return { act: false, reason: 'revoked', rationale: 'The permission was revoked on-chain.' };
  }
  if (Number(policy.expiresAt) * 1000 <= Date.now()) {
    return { act: false, reason: 'expired', rationale: 'The permission has expired.' };
  }

  // 2. Today's spend, from indexed events rather than from our own bookkeeping.
  const days = await daysRead;
  const today = Math.floor(Date.now() / 86_400_000).toString();
  const spentToday = days.find((d) => d.day === today);
  const capUsd = unitsToUsd(policy.dailyCap);
  const usedUsd = spentToday ? unitsToUsd(spentToday.total) : 0;
  const remaining = Math.max(0, capUsd - usedUsd);

  if (remaining < MIN_TRADE_USD) {
    return {
      act: false,
      reason: 'cap_exhausted',
      rationale: `The chain shows today's cap is used up.`,
    };
  }

  // 3. Realised flow. One-sided flow is what being picked off looks like from the outside.
  const recent = await recentRead;
  const imbalance = flowImbalance(recent, params.token);
  if (recent.length >= ONE_SIDED_MIN_SAMPLES && imbalance >= ONE_SIDED_THRESHOLD) {
    return {
      act: false,
      reason: 'one_sided_flow',
      rationale: 'Recent settled flow ran almost entirely one way, so I am standing down.',
    };
  }

  const sizeUsd = Math.min(params.wantUsd, remaining * MAX_FRACTION_OF_REMAINING, remaining);
  if (sizeUsd < MIN_TRADE_USD) {
    return {
      act: false,
      reason: 'size_too_small',
      rationale: 'What is left today is too small to be worth the gas.',
    };
  }

  // 4. The venue, from the SECOND index. This is the join: the delegation subgraph says how much
  //    may move, the Aqua subgraph says where it can move to.
  const route = await chooseRoute({
    app: params.aquaApp,
    tokenOut: params.tokenOut,
    amountOut: sizing,
  });

  return {
    act: true,
    sizeUsd,
    observedRemainingUsd: remaining,
    route,
    rationale: `Permission is live on-chain and today has room. ${route.why}`,
  };
}
