/**
 * Which venue settles this leg on X Layer, and the exact call that does it (2026-09-19).
 *
 * Split out of `run.ts` because WHERE a trade fills is a separate question from running it, with its own rules — best
 * execution (PLAN.md 3.20):
 *
 *   1. **Every venue that can serve the leg says what it would deliver.** Uniswap v3 is quoted through QuoterV2 against
 *      the pools of the chain the executor settles on; OKX DEX, when this deployment has an API key, is asked for its
 *      route too (`venues/okxdex.ts`).
 *   2. **The leg settles where the owner receives the most**, net of nothing we invent: each venue's own answer, held to
 *      the owner's tolerance by the contract's output floor.
 *
 * On a fork of X Layer the Uniswap quote is read from the fork's own pools (`venues/uniswap.ts`), so the price quoted is
 * the price a fill would get there — the Base build had to dry-run 1inch's routes on its fork because 1inch priced them
 * against live Base, and that measurement is not needed here.
 *
 * A **direct** leg — supplying idle cash to a lending pool — has no swap, and settles against the pool the intent names.
 */
import type { Address } from 'viem';
import type { OutputFloor } from '../evm/delegation.js';
import { slippageFor, SLIPPAGE, TOKENS as VENUE_TOKENS } from '../venues/tokens.js';
import { buildSwap, quote } from '../venues/uniswap.js';
import { okxConfigured, okxRoute } from '../venues/okxdex.js';
import { viaWouldFill } from '../evm/delegation.js';
import type { TradeIntent } from './kinds/index.js';

/**
 * The venue that settled, as the activity log and `/metrics` name it. `aave` is a direct leg — idle cash supplied to the
 * lending pool, no swap anywhere.
 */
export type SettlementVenue = 'uniswap-v3' | 'okx-dex' | 'aave';

/**
 * The contract call that will carry the leg, and what it pulls: `closePosition()` pulls the sold token in its own units,
 * `spend()` pulls the settlement token for the dollars.
 */
export type SettlementSend = { via: 'spend' | 'closePosition'; amount: bigint };

export type Settlement = {
  /** The token being spent, from the registry. */
  payToken: { address: Address; decimals: number };
  /** The call `spend()` (or `closePosition()`) forwards. */
  swap: { to: Address; data: `0x${string}` };
  /**
   * Where the contract must approve the tokens, when that is not the call target. OKX DEX pulls through a separate
   * approval contract (`spendVia`, PLAN.md P2.8); Uniswap's router pulls for itself, so this is absent.
   */
  spender?: Address;
  venue: SettlementVenue;
  /** What the owner must receive for the trade to stand — enforced by the contract against the owner's own balance. */
  floor: OutputFloor;
};

/**
 * @param owner  The user whose capital is being spent — never ours.
 * @param send   The call that will carry the leg and what it pulls.
 */
export async function chooseSettlement(params: {
  intent: TradeIntent;
  owner: Address;
  isClose: boolean;
  delegationFrom: Address;
  send: SettlementSend;
  /** The agent the trade is for (`agentKey`), so OKX's route is simulated as the exact agent call that would carry it. */
  agent?: `0x${string}`;
}): Promise<Settlement> {
  const { intent, owner, delegationFrom, send } = params;

  const payToken = VENUE_TOKENS[intent.inSymbol];
  if (!payToken) throw new Error(`No token registry entry for ${intent.inSymbol}`);

  if (intent.direct) {
    return {
      payToken,
      swap: { to: intent.direct.venue, data: intent.direct.data },
      venue: 'aave',
      floor: { tokenOut: intent.direct.tokenOut, minOut: intent.direct.minOut },
    };
  }

  const outToken = VENUE_TOKENS[intent.outSymbol];
  if (!outToken) throw new Error(`No token registry entry for ${intent.outSymbol}`);

  /*
   * The quote first: it is the only number that can tell a thin pair from a deep one before deciding what tolerance the
   * route needs. A failed quote is not fatal — the tolerance falls back to the urgency constant, and building the route
   * quotes again (and refuses, saying why, if there is truly no route).
   */
  const quoted = await quote({ inSymbol: intent.inSymbol, outSymbol: intent.outSymbol, amount: intent.amountIn }).catch(
    () => null,
  );

  /*
   * Urgency sets the floor; the pool sets the rest — except where the person named a tolerance of their own (PLAN.md
   * 3.9): the urgency constants and the impact widening are defaults for trades nobody is watching.
   */
  const tolerancePct =
    intent.slippagePct ?? slippageFor(params.isClose ? SLIPPAGE.stop : SLIPPAGE.scheduled, quoted?.priceImpactPct ?? null);

  // The delegation and the venue must be handed the same figure: on a close, what `closePosition` will send.
  const amountRaw = send.via === 'closePosition' ? send.amount : intent.amountInRaw;

  const uniswap = await buildSwap({
    inSymbol: intent.inSymbol,
    outSymbol: intent.outSymbol,
    amount: intent.amountIn,
    amountRaw,
    from: delegationFrom,
    receiver: owner,
    slippagePct: tolerancePct,
  });

  /*
   * OKX DEX, when this deployment is keyed for it: its route wins only when it delivers more than Uniswap's, and never on
   * a guess — a route it cannot build is simply not a candidate.
   */
  if (okxConfigured()) {
    const okx = await okxRoute({
      inSymbol: intent.inSymbol,
      outSymbol: intent.outSymbol,
      amountRaw: amountRaw ?? BigInt(Math.round(intent.amountIn * 10 ** payToken.decimals)),
      from: delegationFrom,
      receiver: owner,
      slippagePct: tolerancePct,
    }).catch(() => null);
    /*
     * And only a route this chain would actually fill. OKX quotes mainnet; on a fork its route runs through the fork's
     * pools, and a floor set from mainnet's price can be one the fork cannot meet — the contract would revert the trade
     * that Uniswap, quoted on the fork itself, would have filled. `viaWouldFill` asks the delegation contract, as the
     * delegate, with the exact call and floor; on mainnet it answers yes whenever the route is real.
     */
    if (
      okx &&
      okx.minOut > uniswap.minOut &&
      (await viaWouldFill({
        via: send.via,
        owner,
        token: payToken.address,
        spender: okx.spender,
        venue: okx.to,
        amount: send.amount,
        data: okx.data,
        tokenOut: outToken.address,
        minOut: okx.minOut,
        agent: params.agent,
      }))
    ) {
      return {
        payToken,
        swap: { to: okx.to, data: okx.data },
        spender: okx.spender,
        venue: 'okx-dex',
        floor: { tokenOut: outToken.address, minOut: okx.minOut },
      };
    }
  }

  return {
    payToken,
    swap: { to: uniswap.to, data: uniswap.data },
    venue: 'uniswap-v3',
    floor: { tokenOut: outToken.address, minOut: uniswap.minOut },
  };
}
