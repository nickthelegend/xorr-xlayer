/**
 * What each strategy kind wants to do this run.
 *
 * A planner answers "what trade, if any" and nothing else. Whether the trade is ALLOWED is decided
 * once, by the gates in run.ts — the on-chain cap, the expiry, the revocation flag, the venue
 * allowlist and the Graph check. Keeping those in one place is the point: a second tier with its
 * own copy of the safety logic is a second tier that can get it wrong.
 *
 * A planner that returns null is not a failure. "Nothing to do" is the correct answer most of the
 * time for a rebalance that has not drifted or a stop that has not been hit, and it must not read
 * as an error in the activity log.
 */
import { priceOf } from '../../market/prices.js';
import { daily, history } from '../../backtest/engine.js';
import { earningsCalendar } from '../../market/edgar.js';
import { holdings, cashUsd } from '../../evm/balances.js';
import { sellableUnits } from '../stack.js';
import { aavePoolIsDeployedHere, noLendingPoolHere, usdcReserve, usdt0Reserve } from '../../market/yield.js';
import { supplyCalldata } from '../../venues/aave.js';
import { publicClient } from '../../evm/client.js';
import { usdToUnits } from '../../evm/delegation.js';
import { restingLevels, type MultiplierBasis } from '../resting.js';
import { AAVE_V3_POOL, CHAIN_KEY, IS_MAINNET_STATE } from '../../evm/chains.js';
import { erc20Abi, type Address, type Hex } from 'viem';
import { SETTLEMENT_SYMBOL } from '../../venues/tokens.js';

/**
 * One leg.
 *
 * `amountIn` is in the INPUT token's own units — dollars when paying with USDC, coins when selling
 * a holding. It is separate from `usd` because conflating them scaled a $1,500 position into
 * 1500e18 wei of WETH and the router refused a trade a hundred thousand times too large.
 *
 * `usd` is the dollar value of the leg, for the cap check and the activity log only.
 */
export type TradeIntent = {
  inSymbol: string;
  outSymbol: string;
  amountIn: number;
  usd: number;
  /** Shown in the activity log, so a user can see WHY this trade happened. */
  because: string;
  /**
   * State the strategy should carry into its next run, written with the fill.
   *
   * Most tiers are stateless: a rebalance re-reads the portfolio, a stop re-reads the price. A
   * grid is not — it has to remember which rungs it already bought, or it buys the same rung on
   * every tick. Persisting it in the SAME transaction as the fill is what stops the two from
   * disagreeing after a crash: a lot that was bought but not recorded would be bought again.
   */
  stateAfter?: Record<string, unknown>;
  /**
   * The exact on-chain amount, when the planner knows it.
   *
   * A whole-position close must move the balance the chain actually holds. `amountIn` is a float
   * and cannot represent a wei count — converting it back overshot a real WETH balance by 8 wei
   * and the transfer reverted, which on a stop-loss is the worst possible time for a rounding
   * error. Set for a full close; absent for a sized trade, where a float is the right precision.
   */
  amountInRaw?: bigint;
  /**
   * The slippage tolerance a person chose for this trade, in percent (PLAN.md 3.9).
   *
   * Set only for a trade someone placed with one — a swap — and then it is the tolerance every venue gets.
   */
  slippagePct?: number;
  /**
   * Not every leg is a swap.
   *
   * Supplying to a lending pool moves the same capital under the same daily cap, but there is no
   * router to quote and no output token to price — the calldata is the whole trade. When this is
   * set the executor calls `venue` with `data` instead of asking 1inch for a route, and takes
   * `unitPriceUsd` as the price rather than looking one up. Leaving it undefined is the swap path,
   * unchanged.
   */
  direct?: {
    venue: Address;
    data: Hex;
    unitPriceUsd: number;
    /**
     * What the owner receives from the call and the least of it, raw — the receipt token for a
     * supply. The delegation holds the owner's balance to this across the call (PLAN.md 1.4), so a
     * direct leg names its output like any swap does.
     */
    tokenOut: Address;
    minOut: bigint;
  };
};

export type PlanContext = {
  owner: Address;
  /** What this run is allowed to spend, already capped by policy and by `decide()`. */
  budgetUsd: number;
  params: Record<string, unknown>;
  symbol: string;
  /**
   * Units of `symbol` that OTHER live strategies have already committed to selling.
   *
   * Stacking makes this necessary. `planExitRules` closes the whole position, so two exits on one
   * symbol firing in the same window would each try to sell everything — the first succeeds and
   * the second sells units that no longer exist. Passed in rather than read here so the planner
   * stays a function of what it is given.
   *
   * Absent means nothing is stacked, which is the ordinary case and reads as zero.
   */
  claimedSellUnits?: number;
  /** When the strategy's resting levels were set, for scaling them across a split. */
  levelSetAt?: Date;
};

/** Below this a rebalance is noise: the drift costs less than the gas and the spread. */
const MIN_TRADE_USD = 5;

/**
 * Tier 2 — rebalance to target weights.
 *
 * Deterministic, and the only input is the user's own target. It trades the single largest drift
 * rather than every sleeve at once: one leg per run is easier to read in the activity log, easier
 * to reverse, and converges just as well across runs.
 */
export async function planRebalance(ctx: PlanContext): Promise<TradeIntent | null> {
  const targets = ctx.params.targets as Record<string, number> | undefined;
  if (!targets || Object.keys(targets).length === 0) return null;

  /*
   * Weights are percentages of the WHOLE portfolio, and whatever is not targeted is cash.
   *
   * Normalising by the sum of the targets was wrong and quietly so: a single `{ WETH: 60 }` became
   * 60/60 = 100%, so a "hold 60% WETH" instruction would have bought until nothing was left. A
   * target list that sums past 100 is a user error, not something to renormalise away.
   */
  const totalWeight = Object.values(targets).reduce((a, b) => a + b, 0);
  if (totalWeight <= 0 || totalWeight > 100) return null;

  const [cash, held] = await Promise.all([cashUsd(ctx.owner), holdings(ctx.owner)]);
  const heldUsd = new Map(held.map((h) => [h.symbol, h.usd]));
  const portfolio = cash + held.reduce((a, h) => a + h.usd, 0);
  if (portfolio < MIN_TRADE_USD) return null;

  // The sleeve furthest BELOW its target is the one to buy. Selling the furthest-above is the
  // mirror case and is handled the same way, with the legs swapped.
  let worst: { symbol: string; driftUsd: number } | null = null;
  for (const [symbol, weight] of Object.entries(targets)) {
    const targetUsd = portfolio * (weight / 100);
    const driftUsd = targetUsd - (heldUsd.get(symbol) ?? 0);
    if (!worst || Math.abs(driftUsd) > Math.abs(worst.driftUsd)) worst = { symbol, driftUsd };
  }
  if (!worst) return null;

  const size = Math.min(Math.abs(worst.driftUsd), ctx.budgetUsd);
  if (size < MIN_TRADE_USD) return null;

  const pct = ((Math.abs(worst.driftUsd) / portfolio) * 100).toFixed(1);
  if (worst.driftUsd > 0) {
    return {
      inSymbol: 'USDC',
      outSymbol: worst.symbol,
      amountIn: size,
      usd: size,
      because: `${worst.symbol} is ${pct}% under its target weight.`,
    };
  }
  // Selling: the amount has to be in coins, not dollars.
  const price = await priceOf(worst.symbol);
  if (!(price > 0)) return null;
  return {
    inSymbol: worst.symbol,
    outSymbol: 'USDC',
    amountIn: size / price,
    usd: size,
    because: `${worst.symbol} is ${pct}% over its target weight.`,
  };
}

/**
 * Tier 3 — take profit and stop loss.
 *
 * It can only CLOSE. That is the whole reason this tier sits below momentum in the ladder: a
 * strategy that can only reduce risk is easy to hand over, and one that can open positions is not.
 * There is no branch here that buys.
 */
/**
 * The price an exit would actually be paid at: what selling `units` returns on the chain this executor settles on.
 *
 * On X Layer mainnet that is exactly `priceOf` — the same pools — and on the testnet nothing settles at all. They part
 * on a fork of mainnet. The fork carries mainnet's pools as they stood at the fork block and moves them only when we
 * trade, while prices and the agent's signals read the live market (`venues/uniswap.ts`, `quoter`). An exit judged on
 * the market fires on a move the position cannot realise: on the hosted fork a "+10% take profit" fired on METAx at
 * $745.63 against an entry of $672.95 and sold for $9.99 what had cost $10 — a take profit that locked in a loss.
 *
 * The entry price is a fill on the settling chain, so the mark it is compared with has to be one too. Null when the
 * sale has no route, so a level never fires on a price nobody would pay.
 */
async function exitMark(symbol: string, units: number | (() => Promise<number>)): Promise<number | null> {
  const marketIsElsewhere = IS_MAINNET_STATE && CHAIN_KEY !== 'xlayer';
  if (!marketIsElsewhere) return priceOf(symbol).catch(() => null);
  const amount = typeof units === 'number' ? units : await units().catch(() => 0);
  if (!(amount > 0)) return null;
  const { quote } = await import('../../venues/uniswap.js');
  const q = await quote({ inSymbol: symbol, outSymbol: SETTLEMENT_SYMBOL, amount, skipPriceImpact: true }).catch(
    () => null,
  );
  return q && q.outAmount > 0 ? q.outAmount / amount : null;
}

export async function planExitRules(ctx: PlanContext): Promise<TradeIntent | null> {
  const takeProfitPct = Number(ctx.params.takeProfitPct ?? 0);
  const stopLossPct = Number(ctx.params.stopLossPct ?? 0);
  const trailConfigured = Number(ctx.params.trailPct ?? 0) > 0;
  if (!(Number(ctx.params.entryPrice ?? 0) > 0) || (!takeProfitPct && !stopLossPct && !trailConfigured)) {
    return null;
  }

  const held = (await holdings(ctx.owner)).find((h) => h.symbol === ctx.symbol);
  if (!held || held.usd < MIN_TRADE_USD) return null;

  /*
   * Restate the stored levels for today's multiplier before comparing anything to a mark.
   *
   * These levels are USD per DISPLAYED token, and a split changes what a displayed token is. An
   * entry of $200 read against a post-4:1-split mark of $50 is a 75% fall that never happened, and
   * would fire every stop on the token at once. `resting.ts` refuses rather than guesses, and a
   * level it will not vouch for must not fire.
   */
  const resting = await restingLevels({
    symbol: ctx.symbol,
    levels: {
      entryPrice: Number(ctx.params.entryPrice ?? 0),
      peakPrice: Number(ctx.params.peakPrice ?? 0),
    },
    storedBasis: (ctx.params.multiplierBasis as MultiplierBasis | undefined) ?? null,
    levelSetAt: ctx.levelSetAt ?? new Date(0),
  });
  if (resting.status === 'unsafe') return null;

  const entry = resting.levels.entryPrice ?? 0;
  if (!(entry > 0)) return null;

  /*
   * What is left after the rest of the stack has had its say.
   *
   * A sibling exit that has already fired — or has claimed its period and may have broadcast — has
   * spent those units whether or not the balance above reflects it yet. Selling them again is the
   * failure this guard exists for, and it is the one that looks fine in isolation on both sides.
   *
   * After the level check, not before: whether these levels can be trusted at all is a question
   * about the split, and there is no point sizing a sale that must not happen.
   */
  const sellable = sellableUnits(held.units, ctx.claimedSellUnits ?? 0);
  if (sellable <= 0) return null;
  const sellUsd = held.units > 0 ? held.usd * (sellable / held.units) : 0;
  if (sellUsd < MIN_TRADE_USD) return null;

  const mark = await exitMark(ctx.symbol, sellable);
  if (!(mark !== null && mark > 0)) return null;
  const movePct = ((mark - entry) / entry) * 100;

  const hitTP = takeProfitPct > 0 && movePct >= takeProfitPct;
  const hitSL = stopLossPct > 0 && movePct <= -Math.abs(stopLossPct);

  /*
   * A trailing stop: a fixed distance below the best price seen since entry.
   *
   * The one people actually ask for, because a fixed stop either sits too close and gets taken out
   * by noise, or too far and gives back the whole move. `peakPrice` is maintained by
   * `observationFor` on every run — including the ones where nothing fires, which is most of them
   * and is exactly when the trailing has to happen.
   */
  const trailPct = Number(ctx.params.trailPct ?? 0);
  const peak = resting.levels.peakPrice ?? 0;
  const trailFloor = trailPct > 0 && peak > 0 ? peak * (1 - trailPct / 100) : 0;
  const hitTrail = trailFloor > 0 && mark <= trailFloor;

  if (!hitTP && !hitSL && !hitTrail) return null;

  /*
   * The whole position, unless another strategy has already spoken for part of it.
   *
   * A partial close on a stop is a decision the user did not make, so the raw amount is passed
   * through untouched when nothing is stacked — closing to the wei rather than to whatever a float
   * rounds to. Once a sibling has claimed units, the raw figure would be a claim on more than
   * remains, so it is dropped and the sized amount stands on its own.
   */
  const partial = sellable < held.units;
  return {
    inSymbol: ctx.symbol,
    outSymbol: 'USDC',
    amountIn: sellable,
    amountInRaw: partial ? undefined : held.raw,
    usd: sellUsd,
    because: hitTP
      ? `${ctx.symbol} is up ${movePct.toFixed(1)}% from ${entry.toFixed(2)}, which is your take profit.`
      : hitSL
        ? `${ctx.symbol} is down ${Math.abs(movePct).toFixed(1)}% from ${entry.toFixed(2)}, which is your stop.`
        : `${ctx.symbol} fell ${trailPct}% from its high of ${peak.toFixed(2)}, which is your trailing stop.`,
  };
}

/**
 * Tier 1 — recurring buy. A fixed amount, on a schedule. The bot picks nothing.
 */
export function planDca(ctx: PlanContext): TradeIntent {
  return {
    inSymbol: 'USDC',
    outSymbol: ctx.symbol === 'ETH' ? 'WETH' : ctx.symbol,
    amountIn: ctx.budgetUsd,
    usd: ctx.budgetUsd,
    because:
      typeof ctx.params.placedBy === 'string' && ctx.params.placedBy
        ? `Placed by ${ctx.params.placedBy}.`
        : ctx.params.manual === true
          ? 'Placed by you.'
          : 'Scheduled recurring buy.',
    // A one-shot order placed with a tolerance of its own — a swap — carries it to settlement (PLAN.md 3.9).
    ...(typeof ctx.params.slippagePct === 'number' ? { slippagePct: ctx.params.slippagePct } : {}),
  };
}

/**
 * Tier 5 — range accumulation.
 *
 * The user draws a band and the bot buys a rung lower and sells a rung higher inside it. Fifth on
 * the ladder because it forecasts nothing — but it does ASSUME something, which is why it sits
 * above the tiers that assume nothing at all: it assumes the range holds. A range that breaks
 * leaves you holding everything you bought on the way down, and the honest thing is to say so
 * rather than keep buying.
 *
 * Rungs are crossings, not levels. Acting on "the price is below rung 3" would buy rung 3 again
 * on every tick for as long as the price stayed there; acting on "the price has CROSSED rung 3
 * since we last looked" buys it once. That is what `lastLevel` is for, and it is why the first run
 * of a grid deliberately trades nothing — there is no previous position to have crossed from, and
 * inventing one would put on a position the user did not ask for at a price nobody chose.
 */
export async function planGrid(ctx: PlanContext): Promise<TradeIntent | null> {
  const lower = Number(ctx.params.lower ?? NaN);
  const upper = Number(ctx.params.upper ?? NaN);
  const steps = Math.floor(Number(ctx.params.steps ?? 4));
  const usdPerStep = Number(ctx.params.usdPerStep ?? ctx.budgetUsd);
  if (!(lower > 0) || !(upper > lower) || !(steps >= 1) || !(usdPerStep >= MIN_TRADE_USD)) {
    return null;
  }

  const price = await priceOf(ctx.symbol);
  if (!(price > 0)) return null;

  /*
   * Outside the band, do nothing — and record that it left.
   *
   * A grid whose range has broken should stop, not keep averaging down past the floor its owner
   * drew. The state flag is what lets the next run say "your range broke" instead of silently
   * doing nothing forever, which looks identical to being switched off.
   */
  const openLots = Array.isArray(ctx.params.openLots) ? (ctx.params.openLots as number[]) : [];
  if (price < lower || price > upper) {
    return null;
  }

  // Rung prices, low to high. `steps` gaps means `steps + 1` rungs.
  const rungs = Array.from({ length: steps + 1 }, (_, i) => lower + (i * (upper - lower)) / steps);
  // How many rungs the price is at or above — the rung the price is currently standing on.
  const level = rungs.filter((r) => price >= r).length - 1;

  const lastLevel = Number.isFinite(Number(ctx.params.lastLevel))
    ? Number(ctx.params.lastLevel)
    : null;

  // First sight of the price: take a reading, place nothing.
  if (lastLevel === null) return null;
  if (level === lastLevel) return null;

  if (level < lastLevel) {
    // Fell through a rung. Buy that rung, once, and remember we hold it.
    if (openLots.includes(level)) return null;
    const size = Math.min(usdPerStep, ctx.budgetUsd);
    if (size < MIN_TRADE_USD) return null;
    return {
      inSymbol: 'USDC',
      outSymbol: ctx.symbol === 'ETH' ? 'WETH' : ctx.symbol,
      amountIn: size,
      usd: size,
      because: `${ctx.symbol} fell through ${rungs[level]!.toFixed(2)} inside your range.`,
      stateAfter: { lastLevel: level, openLots: [...openLots, level] },
    };
  }

  /*
   * Rose through a rung. Sell the lowest lot we are holding — the one bought cheapest, which is
   * the one this rung's rise has actually made a profit on. Selling the most recent instead would
   * book the smallest gain available and leave the cheap lot exposed to the range breaking.
   */
  const lot = openLots.length ? Math.min(...openLots) : undefined;
  if (lot === undefined) {
    // Nothing held, so nothing to sell. Move the marker so the next fall is a real crossing.
    return null;
  }
  const held = (await holdings(ctx.owner)).find((h) => h.symbol === ctx.symbol);
  if (!held || held.usd < MIN_TRADE_USD) return null;

  const size = Math.min(usdPerStep, held.usd);
  return {
    inSymbol: ctx.symbol,
    outSymbol: 'USDC',
    amountIn: size / price,
    usd: size,
    because: `${ctx.symbol} rose through ${rungs[level]!.toFixed(2)}, closing the lot bought at ${rungs[lot]!.toFixed(2)}.`,
    stateAfter: { lastLevel: level, openLots: openLots.filter((l) => l !== lot) },
  };
}

/**
 * A planner's refusal to plan, with the reason a person should read.
 *
 * Distinct from `null` ("nothing to do this run"): this strategy CANNOT run here, and saying "checked, nothing to do" on
 * every tick would hide that. `run.ts` records it as a blocked run carrying `reason` and the message.
 */
export class PlanRefused extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(detail);
    this.name = 'PlanRefused';
  }
}

/**
 * Tier 4 — move idle cash to yield, on Aave v3 on X Layer (PLAN.md P2.14, D15).
 *
 * The pool pays on USDT0 and next to nothing on USDC, so idle USDC takes two runs to put to work — one leg per run, the
 * same as every tier:
 *
 *   a. USDT0 sitting in the owner's wallet is supplied: a DIRECT leg that spends USDT0 through `spend()` (counted
 *      against the cap in its own 6-decimal units) and calls `supply(USDT0, amount, owner)`, so the aToken lands with the
 *      owner and the delegation holds nothing afterwards.
 *   b. Otherwise, USDC beyond `keepCashUsd` is swapped to USDT0 through Uniswap — an ordinary swap leg — but only while
 *      USDT0's rate beats USDC's. The next run finds the USDT0 and supplies it.
 *
 * What must be true before anything moves, each of which has stopped a real run:
 *
 *  - There is a pool on this chain. The testnet has none; the run is refused saying so, rather than dying inside
 *    `spend()` as an opaque VenueCallFailed.
 *  - The reserve answers. Aave returns a ZEROED struct for an asset it does not list, so "0.00% a year" is what a wrong
 *    address looks like; `usdt0Reserve` throws on it, and moving cash into a venue whose rate could not be read is the
 *    opposite of what this tier is for.
 *  - The cash is genuinely idle. `keepCashUsd` is the USDC buffer the user does not want swept, and it defaults to
 *    leaving something behind: a strategy that empties the spendable balance stops every other strategy the account has.
 */
export async function planYieldRotation(ctx: PlanContext): Promise<TradeIntent | null> {
  const keepCashUsd = Number(ctx.params.keepCashUsd ?? 25);
  const minMoveUsd = Math.max(Number(ctx.params.minMoveUsd ?? 25), MIN_TRADE_USD);

  if (!AAVE_V3_POOL || !(await aavePoolIsDeployedHere())) throw new PlanRefused('no_lending_pool', noLendingPoolHere());

  const earn = await usdt0Reserve();

  // ── a. USDT0 already in the wallet: supply it. ──
  const heldRaw = await publicClient.readContract({
    address: earn.asset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [ctx.owner],
  });
  const supplyUsd = Math.min(Number(heldRaw) / 10 ** earn.decimals, ctx.budgetUsd);
  if (supplyUsd >= minMoveUsd) {
    /*
     * The calldata amount and the amount `spend()` pulls have to be the SAME number.
     *
     * `spend()` pulls `usdToUnits(usd)` of the pay token — USDT0 here, 6 decimals like the cap — and approves the pool
     * for exactly that, so calldata asking for more would exceed the approval and revert, and less would strand dust in
     * the delegation. Deriving both from one function keeps them equal; `usd` is the round-tripped value.
     */
    const amountRaw = usdToUnits(supplyUsd) > heldRaw ? heldRaw : usdToUnits(supplyUsd);
    const usd = Number(amountRaw) / 1e6;
    return {
      inSymbol: earn.symbol,
      outSymbol: `a${earn.symbol}`,
      amountIn: usd,
      usd,
      because: `${(earn.apy * 100).toFixed(2)}% a year on USDT0 from Aave v3 on X Layer, and this USDT0 was sitting idle.`,
      direct: {
        venue: earn.pool,
        data: supplyCalldata({ asset: earn.asset, amountRaw, owner: ctx.owner }),
        // A dollar of USDT0 supplied is a dollar of aUSDT0: the yield arrives as the balance growing, not the price.
        unitPriceUsd: 1,
        // The aToken, read from the reserve. Aave's ray arithmetic can land a supply a wei short, so the floor leaves a
        // basis point — nowhere near enough to hide a supply credited elsewhere.
        tokenOut: earn.aToken,
        minOut: (amountRaw * 9_999n) / 10_000n,
      },
    };
  }

  // ── b. Idle USDC: swap it to USDT0 when USDT0 earns more. ──
  const cash = await cashUsd(ctx.owner);
  const idle = cash - keepCashUsd;
  if (idle < minMoveUsd) return null;
  const size = Math.min(idle, ctx.budgetUsd);
  if (size < minMoveUsd) return null;

  const usdc = await usdcReserve();
  if (!(earn.apy > usdc.apy)) return null;

  const amountRaw = usdToUnits(size);
  const usd = Number(amountRaw) / 1e6;
  const pct = (apy: number) => `${(apy * 100).toFixed(2)}%`;
  return {
    inSymbol: 'USDC',
    outSymbol: earn.symbol,
    amountIn: usd,
    // The exact figure `spend()` pulls, so the route is built for what the delegation hands it.
    amountInRaw: amountRaw,
    usd,
    because: `Aave v3 on X Layer pays ${pct(earn.apy)} a year on USDT0 and ${pct(usdc.apy)} on USDC, so this idle USDC is swapped to USDT0 first; the next run supplies it.`,
  };
}

/** Every kind that has a planner. A kind not listed here cannot run, and run.ts says so. */
/**
 * The other half of tier 6: the stop actually firing.
 *
 * `planMomentum` attaches a stop at entry and would be worthless without something that acts on
 * it. Rather than a second strategy the user has to remember to create, the same kind handles
 * both sides — hold nothing, look for a breakout; hold something, watch the stop.
 *
 * It only ever SELLS here, so it belongs in `CLOSE_ONLY_KINDS` for the same reason exit-rules
 * does: a stop that the daily cap can silence is not a stop.
 */
async function planMomentumExit(ctx: PlanContext): Promise<TradeIntent | null> {
  const stop = Number(ctx.params.stopPrice ?? Number.NaN);
  const entry = Number(ctx.params.openEntryPrice ?? Number.NaN);
  if (!(stop > 0) || !(entry > 0)) return null;

  const held = (await holdings(ctx.owner)).find((h) => h.symbol === ctx.symbol);
  if (!held || held.usd < MIN_TRADE_USD) return null;

  const price = await priceOf(ctx.symbol);
  if (!(price > 0) || price > stop) return null;

  return {
    inSymbol: ctx.symbol,
    outSymbol: 'USDC',
    amountIn: held.units,
    amountInRaw: held.raw,
    usd: held.usd,
    because: `${ctx.symbol} fell to ${price.toFixed(2)}, through the ${stop.toFixed(2)} stop set when this entry opened.`,
    // The position is closed; forget it so the next breakout can be taken on its own merits.
    stateAfter: { openEntryPrice: 0, stopPrice: 0 },
  };
}

/** Entry or exit, decided by whether this strategy already holds a position. */
async function planMomentumBoth(ctx: PlanContext): Promise<TradeIntent | null> {
  const open = Number(ctx.params.openEntryPrice ?? 0) > 0;
  return open ? planMomentumExit(ctx) : planMomentum(ctx);
}

export const PLANNERS: Record<string, (ctx: PlanContext) => Promise<TradeIntent | null> | TradeIntent | null> = {
  dca: planDca,
  buy: planDca,
  'recurring-buy': planDca,
  rebalance: planRebalance,
  'exit-rules': planExitRules,
  'yield-rotation': planYieldRotation,
  grid: planGrid,
  momentum: planMomentumBoth,
  'event-driven': planEventDriven,
};

/**
 * What a strategy needs to REMEMBER before it can decide anything, updated every run.
 *
 * Two tiers need this and they need it for the same reason: they act on a change rather than on a
 * level, and a change can only be seen against something previously recorded.
 *
 *   - A grid trades on crossings, so its first run has nothing to have crossed from.
 *   - A trailing stop trails the high-water mark, which has to be updated on the runs where it
 *     does NOT fire. Updating it only on a fill would leave the stop pinned to the price at
 *     entry, which is an ordinary stop wearing a trailing stop's name.
 *
 * Deliberately separate from the planner and run BEFORE it, so the planner sees the current
 * observation and stays a pure function of what it is given.
 */
export async function observationFor(
  kind: string,
  ctx: PlanContext,
): Promise<Record<string, unknown> | null> {
  if (kind === 'grid') {
    if (Number.isFinite(Number(ctx.params.lastLevel))) return null;
    const lower = Number(ctx.params.lower ?? NaN);
    const upper = Number(ctx.params.upper ?? NaN);
    const steps = Math.floor(Number(ctx.params.steps ?? 4));
    if (!(lower > 0) || !(upper > lower) || !(steps >= 1)) return null;

    const price = await priceOf(ctx.symbol).catch(() => 0);
    if (!(price > 0)) return null;
    const rungs = Array.from({ length: steps + 1 }, (_, i) => lower + (i * (upper - lower)) / steps);
    const level = Math.max(rungs.filter((r) => price >= r).length - 1, 0);
    return { lastLevel: level, openLots: [] };
  }

  if (kind === 'exit-rules') {
    const trailPct = Number(ctx.params.trailPct ?? NaN);
    if (!Number.isFinite(trailPct) || trailPct <= 0) return null;
    // The peak in the same terms the stop is judged in (`exitMark`): what the held units would sell for here.
    const heldUnits = async () => (await holdings(ctx.owner)).find((h) => h.symbol === ctx.symbol)?.units ?? 0;
    const price = (await exitMark(ctx.symbol, heldUnits)) ?? 0;
    if (!(price > 0)) return null;
    /*
     * The high-water mark only ever goes up.
     *
     * That is the whole mechanism: the stop is a fixed distance below the best price seen since
     * the position was opened, so it follows a rise and never follows a fall. Seeding it from the
     * entry price rather than from today's mark matters — seeding from the mark on a position
     * already underwater would place the stop below where it should be and let the loss run.
     */
    /*
     * The peak is written in TODAY's displayed-price terms, because `price` is. The stored levels
     * may have been set under an older multiplier, so they are restated first and the basis is
     * rewritten with them — otherwise this would file today's number in yesterday's units and the
     * two would silently disagree the moment a split happened.
     *
     * A level we cannot restate safely is left exactly as it is: refusing to touch it keeps the
     * refusal in one place, the planner, which already declines to fire on it.
     */
    const restated = await restingLevels({
      symbol: ctx.symbol,
      levels: {
        entryPrice: Number(ctx.params.entryPrice ?? 0),
        peakPrice: Number(ctx.params.peakPrice ?? 0),
      },
      storedBasis: (ctx.params.multiplierBasis as MultiplierBasis | undefined) ?? null,
      levelSetAt: ctx.levelSetAt ?? new Date(0),
    });
    if (restated.status === 'unsafe') return null;

    const entry = restated.levels.entryPrice ?? 0;
    const peak = restated.levels.peakPrice ?? 0;
    const basis: MultiplierBasis = {
      multiplier: restated.currentMultiplier,
      recordedAt: new Date().toISOString(),
    };
    const rebase = restated.adjusted
      ? { entryPrice: entry, multiplierBasis: basis }
      : {};

    const seed = peak > 0 ? peak : Math.max(entry, 0);
    if (price > seed) return { ...rebase, peakPrice: price };
    if (seed > 0 && peak === 0) return { ...rebase, peakPrice: seed };
    return Object.keys(rebase).length > 0 ? rebase : null;
  }

  return null;
}

/**
 * Tier 6 — momentum and breakouts.
 *
 * The ladder's own words: *"Buys strength on liquid majors, with a stop attached to every entry.
 * The first strategy that needs the bot to be right about the future. Ships asking first."* All
 * three of those constrain the implementation, so all three are honoured here rather than
 * paraphrased.
 *
 * **Buys strength.** A Donchian breakout: price closes above the highest close of the lookback
 * window. Deterministic, defined entirely by observable history, and the oldest published
 * definition of a breakout — which matters because the alternative is a threshold someone invented
 * and cannot defend.
 *
 * **On liquid majors.** Restricted to symbols with a real settlement route. A breakout on
 * something the executor cannot fill is a signal it cannot act on, and acting on it anyway is how
 * a strategy books slippage instead of a position.
 *
 * **A stop attached to every entry.** The intent carries `stateAfter` describing the stop, so the
 * position is never open without one. A momentum entry with no exit is the single most expensive
 * shape in this whole ladder.
 *
 * **Ships asking first.** `requiresApprovalByDefault` already returns true for tier ≥ 6, so this
 * proposes rather than executes unless the user explicitly turns that off. Nothing here overrides
 * that, deliberately.
 *
 * A trend filter sits on top of the breakout: the fast average must be above the slow one. Without
 * it a single spike in a falling market triggers an entry, which is precisely the trade this
 * strategy is worst at surviving.
 */
export async function planMomentum(ctx: PlanContext): Promise<TradeIntent | null> {
  const lookbackDays = Math.floor(Number(ctx.params.lookbackDays ?? 20));
  const stopPct = Number(ctx.params.stopPct ?? 8);
  const size = Math.min(Number(ctx.params.usdPerEntry ?? ctx.budgetUsd), ctx.budgetUsd);
  if (!(lookbackDays >= 5) || !(stopPct > 0) || !(size >= MIN_TRADE_USD)) return null;

  /*
   * Already in this trade? Then there is nothing to add.
   *
   * Momentum re-entering its own open position is how a "strategy" becomes a way to buy the same
   * breakout four times on the way up and hold four times the intended size into the reversal.
   */
  if (ctx.params.openEntryPrice !== undefined && Number(ctx.params.openEntryPrice) > 0) return null;

  // The same series the backtests read, so a live entry and a backtested one see one history.
  const points = daily(await history(ctx.symbol, Math.max(lookbackDays * 2, 60)));
  const closes = points.map(([, p]) => p).filter((p) => Number.isFinite(p) && p > 0);
  // A window plus the bar being tested, plus enough left over for the slow average to mean
  // anything. Too little history is "unknown", not "no breakout".
  if (closes.length < lookbackDays + 2) return null;

  const price = await priceOf(ctx.symbol);
  if (!(price > 0)) return null;

  // The window EXCLUDES the current price — comparing it to a high it set itself always breaks out.
  const window = closes.slice(-lookbackDays - 1, -1);
  const high = Math.max(...window);
  if (!(price > high)) return null;

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const fast = mean(closes.slice(-Math.max(3, Math.floor(lookbackDays / 4))));
  const slow = mean(closes.slice(-lookbackDays));
  if (!(fast > slow)) return null;

  return {
    inSymbol: 'USDC',
    outSymbol: ctx.symbol === 'ETH' ? 'WETH' : ctx.symbol,
    amountIn: size,
    usd: size,
    because:
      `${ctx.symbol} closed above its ${lookbackDays}-day high of ${high.toFixed(2)} at ` +
      `${price.toFixed(2)}, with the short average above the long one. Stop set ${stopPct}% below entry.`,
    stateAfter: {
      openEntryPrice: price,
      // The stop travels with the position from the moment it opens, not from a later run.
      stopPrice: price * (1 - stopPct / 100),
      openedAt: Date.now(),
    },
  };
}

/**
 * Tier 7 — events and earnings. The Earnings Desk's strategy, and the last rung by design.
 *
 * The ladder: *"Positions around scheduled events, and flattens before the print. Most judgement,
 * most ways to be wrong. Last."* The persona that runs it is *"pedantic and calendar-driven…
 * slightly weary of people who trade into prints."* Both are honoured literally: it buys the run-up
 * and it is **flat when the print lands**, every time, without exception.
 *
 * The judgement — and the ways to be wrong — live entirely in the entry. The exit is not a view
 * about anything; it is a promise. So the exit is unconditional, exempt from the daily cap (a
 * flatten a spent allowance can silence is not a flatten), and sells the WHOLE holding in the
 * symbol rather than only what this strategy bought. A partial flatten would leave the user exposed
 * to precisely the event they created this to avoid, while the screen told them they were covered.
 * That is worse than not having the feature.
 *
 * The date comes from SEC EDGAR — the regulator's own record of when a company has reported — and
 * is PROJECTED from that cadence, never invented. A projection is treated as what it is: the
 * flatten window widens by the company's own observed cadence error, so NVIDIA's ±7 days buys seven
 * days of margin and Apple's metronomic 91s buy none. A user who knows the real date pins it, and
 * then the margin is just the lead time.
 *
 * If the calendar cannot be read, or the cadence is not quarterly, or the date has already passed
 * without this having flattened, it sells and stands down. A calendar strategy that has lost the
 * calendar has no edge left, and holding on the assumption the date is still right is how it turns
 * into a position nobody chose.
 */
async function planEventEntry(ctx: PlanContext, event: EventWindow): Promise<TradeIntent | null> {
  const size = Math.min(Number(ctx.params.usdPerEvent ?? ctx.budgetUsd), ctx.budgetUsd);
  if (size < MIN_TRADE_USD) return null;

  const openFrom = Number(ctx.params.entryFromDays ?? 10);
  const openUntil = Number(ctx.params.entryUntilDays ?? 2);
  // The near edge sits ABOVE the flatten window on purpose: buying inside it would be paying a
  // spread for a position the very next run is obliged to sell.
  if (!(event.daysAway <= openFrom && event.daysAway >= Math.max(openUntil, event.flattenWithin)))
    return null;

  return {
    inSymbol: 'USDC',
    outSymbol: ctx.symbol,
    amountIn: size,
    usd: size,
    because:
      `${ctx.symbol} reports ${event.confirmed ? 'on' : 'around'} ${event.dateLabel}, ` +
      `${event.daysAway} days away. Buying the run-up; this sells before the print.`,
    stateAfter: { openedForEventAt: event.at, openEntryPrice: 0 },
  };
}

async function planEventFlatten(
  ctx: PlanContext,
  reason: string,
): Promise<TradeIntent | null> {
  const held = (await holdings(ctx.owner)).find((h) => h.symbol === ctx.symbol);
  if (!held || held.usd < MIN_TRADE_USD) return null;
  return {
    inSymbol: ctx.symbol,
    outSymbol: 'USDC',
    amountIn: held.units,
    amountInRaw: held.raw,
    usd: held.usd,
    because: reason,
    stateAfter: { openedForEventAt: 0 },
  };
}

type EventWindow = {
  at: number;
  daysAway: number;
  dateLabel: string;
  confirmed: boolean;
  /** Days before the event at which this must already be flat: lead time plus projection error. */
  flattenWithin: number;
};

export async function planEventDriven(ctx: PlanContext): Promise<TradeIntent | null> {
  const leadDays = Number(ctx.params.flattenLeadDays ?? 1);
  const holdingNow = (await holdings(ctx.owner)).find((h) => h.symbol === ctx.symbol);
  const hasPosition = !!holdingNow && holdingNow.usd >= MIN_TRADE_USD;

  /*
   * A pinned date is the user's own knowledge and outranks anything derived. It also needs no
   * error margin: they are not guessing.
   */
  const pinned = Number(ctx.params.eventAt ?? Number.NaN);
  let at: number;
  let confirmed: boolean;
  let errorDays = 0;

  if (Number.isFinite(pinned) && pinned > 0) {
    at = pinned;
    confirmed = true;
  } else {
    const cal = await earningsCalendar(ctx.symbol).catch(() => null);
    if (!cal || cal.nextAt === null) {
      // No calendar means no strategy. Do not hold a position on a date nobody can name.
      return hasPosition
        ? planEventFlatten(
            ctx,
            `No reporting date could be read for ${ctx.symbol}, so this cannot promise to be flat before one. Closing.`,
          )
        : null;
    }
    at = cal.nextAt;
    confirmed = false;
    errorDays = cal.errorDays;
  }

  const daysAway = Math.round((at - Date.now()) / 86_400_000);
  const dateLabel = new Date(at).toISOString().slice(0, 10);
  const flattenWithin = leadDays + errorDays;

  /*
   * The date has passed and this is still holding. Something was wrong — a moved date, a missed
   * run — and the promise is already broken. Close, and say so rather than carrying on.
   */
  if (daysAway < 0) {
    return hasPosition
      ? planEventFlatten(
          ctx,
          `${ctx.symbol} was expected to report on ${dateLabel} and that date has passed. Closing rather than holding through an unknown.`,
        )
      : null;
  }

  if (daysAway <= flattenWithin) {
    return hasPosition
      ? planEventFlatten(
          ctx,
          `${ctx.symbol} reports ${confirmed ? 'on' : 'around'} ${dateLabel}, ${daysAway} days away. ` +
            `Flat before the print${errorDays > 0 ? `, with ${errorDays} days of margin because that date is projected` : ''}.`,
        )
      : null;
  }

  // Outside the flatten window, holding is the position working. Only add when flat.
  if (hasPosition) return null;
  return planEventEntry(ctx, { at, daysAway, dateLabel, confirmed, flattenWithin });
}
