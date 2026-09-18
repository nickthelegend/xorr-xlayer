/**
 * The strategy ladder's API surface: create, list, amend, end, run, backtest.
 *
 * Split out of `routes/index.ts`, which had grown to 1,098 lines covering wallets, delegation,
 * strategies, positions, the audit trail, limits and prices — seven concerns whose only relation
 * was having been written on the same day. This is the largest of them and the one that changes
 * most, since every ladder tier lands here.
 *
 * A pure move: the handlers, their validation and their comments are unchanged, and the shared
 * wallet lookup now comes from `wallet-context.ts` rather than being duplicated. `server/index.ts`
 * mounts this the same way it already mounts `market`, `alerts` and the rest.
 */
import { randomUUID } from 'node:crypto';
import { httpStatusFor } from '../executor/failure.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { one, query } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { append } from '../audit/log.js';
import {
  runStrategy,
  CLOSE_ONLY_KINDS,
  EXECUTABLE_KINDS,
  SELF_SIZING_KINDS,
  type StrategyRow,
} from '../executor/run.js';
import { stackOn, stackSummary } from '../executor/stack.js';
import { sleevesFor } from '../positions/sleeves.js';
import {
  SETTLEMENT_SYMBOL,
  TOKENS as VENUE_TOKENS,
  TOKENS,
  canonicalSymbol,
} from '../venues/oneinch.js';
import { nextRuns, type Cadence } from '../executor/schedule.js';
import { nextRunOnResume, resumeMovedSchedule, stateOnResume } from '../executor/resume.js';
import { CHAIN_KEY } from '../evm/chains.js';
import { equitiesFunctional, isStock } from '../venues/stocks.js';
import { readPolicy } from '../evm/delegation.js';
import type { Address } from 'viem';
import { placeOrder } from '../executor/order.js';
import { placeSwap } from '../executor/swap.js';
import { currentWallet, requireWallet, type WalletRow } from './wallet-context.js';

export const strategyRoutes = new Hono();

/**
 * A moment written the way a record should write one: in UTC, and saying so.
 *
 * This was `toDateString()`, which formats in the SERVER's timezone. The server runs in UTC and
 * the reader does not: a strategy created from IST whose first run is 2026-09-16T22:03Z went into
 * the trail as "First run Wed Sep 16 2026" while the form that created it, formatting locally, had
 * just said "Thu, Sep 17". The same instant, two different days, in two places in one app — and
 * the one that is wrong for the reader is the one written permanently into an append-only log.
 *
 * The row cannot know the reader's timezone, and guessing one would only move the error. Naming
 * the zone removes it: the cap already resets "at midnight UTC" on `/limits`, and every run is
 * computed in UTC, so this is the unit the rest of the system already speaks.
 */
function utcStamp(at: Date): string {
  const date = at.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const time = at.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `${date}, ${time} UTC`;
}



/** A rebalance across the whole portfolio carries its targets instead of one symbol (PLAN.md 2.17). */
const PORTFOLIO = 'PORTFOLIO';

const StrategyInput = z.object({
  /**
   * A kind the executor can actually run.
   *
   * Same argument as `symbol` below, and it was missing for the same reason — the UI only offers
   * buildable tiers, so nothing ever sent a bad one. But the API is the boundary: `kind: 'grid'`
   * was accepted, scheduled forever, and blocked at every single run with "nothing here knows how
   * to run a grid strategy". A strategy that can never act should be refused when it is created,
   * while there is still someone to tell.
   */
  kind: z.string().refine((v) => EXECUTABLE_KINDS.has(v), {
    message: `not runnable yet — one of: ${[...EXECUTABLE_KINDS].join(', ')}`,
  }),
  state: z.enum(['draft', 'watch', 'live', 'paused', 'ended']),
  label: z.string(),
  /**
   * Must be a symbol the executor can actually route and settle. The UI already only offers these,
   * but the API is the boundary that matters: without this check a client could create a strategy
   * that schedules forever and fails every run, and the failure would look like our bug rather
   * than an impossible request.
   */
  symbol: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  cadence: z.enum(['daily', 'weekly', 'biweekly', 'monthly']).optional(),
  nextRunAt: z.number().optional(),
  dailyAllocationUsd: z.number().nonnegative(),
  /** Which hired agent runs this. Optional: a user can set a strategy up themselves. */
  agentId: z.string().uuid().optional(),
}).superRefine((s, ctx) => {
  /*
   * The symbol — or, for a portfolio rebalance, its targets — must be something this executor settles.
   *
   * Onboarding creates exactly one strategy, "Rebalance to targets" on `PORTFOLIO`, and the symbol check
   * refused it: `PORTFOLIO` is not a token. The one strategy a new user approves failed validation and
   * nothing was created (PLAN.md 2.17). A portfolio rebalance is accepted when `params.targets` names
   * tradable symbols with positive percents of the whole portfolio summing to 100 or less — what is not
   * targeted stays cash, which is why the settlement token itself is not a target.
   */
  if (s.symbol !== PORTFOLIO) {
    if (!(canonicalSymbol(s.symbol) in TOKENS)) {
      ctx.addIssue({
        code: 'custom',
        path: ['symbol'],
        message: `not tradable on this chain — one of: ${Object.keys(TOKENS).join(', ')}`,
      });
    }
    return;
  }
  if (s.kind !== 'rebalance') {
    ctx.addIssue({ code: 'custom', path: ['symbol'], message: `${PORTFOLIO} is only for a rebalance; a ${s.kind} strategy needs a tradable symbol` });
    return;
  }
  const targets = s.params.targets;
  if (!targets || typeof targets !== 'object' || Array.isArray(targets) || Object.keys(targets).length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['params', 'targets'],
      message: 'a portfolio rebalance needs targets: tradable symbols and the percent of the portfolio each should be',
    });
    return;
  }
  let total = 0;
  for (const [symbol, weight] of Object.entries(targets as Record<string, unknown>)) {
    const name = canonicalSymbol(symbol);
    if (!(name in TOKENS)) {
      ctx.addIssue({ code: 'custom', path: ['params', 'targets', symbol], message: `${symbol} is not tradable on this chain` });
    } else if (name === SETTLEMENT_SYMBOL) {
      ctx.addIssue({
        code: 'custom',
        path: ['params', 'targets', symbol],
        message: `${SETTLEMENT_SYMBOL} is not a target: whatever is not targeted stays in ${SETTLEMENT_SYMBOL}`,
      });
    }
    if (typeof weight !== 'number' || !(weight > 0)) {
      ctx.addIssue({ code: 'custom', path: ['params', 'targets', symbol], message: `${symbol} needs a percent above zero` });
    } else {
      total += weight;
    }
  }
  if (total > 100.0001) {
    ctx.addIssue({ code: 'custom', path: ['params', 'targets'], message: `the targets add up to ${total}%, more than the whole portfolio` });
  }
});

function toApi(r: StrategyRow) {
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    label: r.label,
    symbol: r.symbol,
    params: r.params,
    cadence: r.cadence ?? undefined,
    /*
     * An ended strategy has no next run.
     *
     * Ending one clears `next_run_at` (`moveStrategy`), and strategies ended before it did kept a date the scheduler will
     * never reach — the fork published seventeen. Migration 024 clears those rows; this keeps any row that still carries
     * one from publishing it.
     */
    nextRunAt: r.state !== 'ended' && r.next_run_at ? new Date(r.next_run_at).getTime() : undefined,
    dailyAllocationUsd: Number(r.daily_allocation_usd),
    /*
     * When the row was written, not when it was read.
     *
     * This was `Date.now()`, so every strategy was created at the moment of each request — and every run of every
     * strategy appeared to predate the strategy that made it.
     */
    createdAt: new Date(r.created_at).getTime(),
    /** The agent that runs it, when one does — how an agent someone made finds its own strategies (2026-09-16). */
    agentId: r.agent_id ?? undefined,
    /*
     * What a resume will put this back to, published only while it is paused.
     *
     * A paused row that resumes into `watch` and one that resumes into `live` are different things
     * to tap, and the list had no way to tell them apart. On any row that is not paused this is
     * stale bookkeeping rather than a fact about the strategy, so it is not published.
     */
    pausedFrom: r.state === 'paused' ? (r.paused_from ?? undefined) : undefined,
  };
}

/**
 * Why this wallet may not commit `allocationUsd` more a day — or null when it may. PLAN.md 9.2.
 *
 * Asked when a strategy is created and when one is resumed. Resuming used to skip it: the total
 * counts only `live` and `watch`, so pausing a strategy frees its allowance — pause one, create
 * another in the room it left, resume the first, and the day was committed past the cap this check
 * exists to hold. The permission is read from the chain, where absent means refuse.
 */
async function commitmentRefusal(
  w: WalletRow,
  ask: { allocationUsd: number; closeOnly: boolean; doing: string; excludeId?: string },
): Promise<{ error: string; message: string } | null> {
  const policy = await readPolicy(w.address as Address);
  if (!policy || policy.revoked) {
    return {
      error: 'no_delegation',
      message: `No active trading permission on-chain. Grant one before ${ask.doing}.`,
    };
  }
  if (policy.expiresAt <= Date.now()) {
    return { error: 'delegation_expired', message: 'The trading permission has expired. Renew it first.' };
  }

  /*
   * A strategy that can only CLOSE commits nothing, so the cap has nothing to say about it.
   *
   * The commitment check refused an `exit-rules` strategy whose own allocation was zero, because
   * the strategies already live summed past the cap — so a user whose day was committed could not
   * add a stop-loss, which is exactly the moment they would want one. Same mistake as the runtime
   * gate: a limit on putting capital at risk was being applied to the thing that takes it off.
   */
  if (ask.closeOnly) return null;

  const sums = await query<{ sum: string | null }>(
    `SELECT SUM(daily_allocation_usd) AS sum FROM strategies
      WHERE wallet_id = $1 AND state IN ('live','watch') AND kind <> ALL($2::text[]) AND id <> $3
        AND chain = ${THIS_CHAIN}`,
    [w.id, [...CLOSE_ONLY_KINDS], ask.excludeId ?? ''],
  );
  const committed = Number(sums[0]?.sum ?? 0) + ask.allocationUsd;
  if (committed > policy.dailyCapUsd) {
    return {
      error: 'over_cap',
      message: `That would commit $${committed.toLocaleString('en-US')} a day against a $${policy.dailyCapUsd.toLocaleString('en-US')} cap. Raise the cap or lower this strategy.`,
    };
  }
  return null;
}

/**
 * Everything running on one symbol, and what it commits between them.
 *
 * Stacking is ordinary — a recurring buy accumulating, a stop under it, a take-profit above — and
 * until now there was nowhere to see the whole of it. A strategy list sorted by next run scatters
 * the three across the page, so the question "what is acting on my NVDAc" had no answer.
 *
 * The daily commitment counts only the strategies that can OPEN. A stop-loss commits nothing, and
 * folding its zero into the total would read as having been considered and found free rather than
 * as not applying.
 */
/**
 * Who opened which part of a holding.
 *
 * The companion to `/strategies/stack/:symbol`: that one says what is RUNNING on a symbol, this
 * one says what each of them has actually put there. Once several strategies stack on one token,
 * the position row alone cannot answer either question.
 *
 * The parts that do not add up are returned rather than smoothed. `unattributedUnits` is what the
 * book holds that no source here claims — a wallet funded outside the app, or a position older
 * than this ledger — and `overAttributedUnits` is the reverse, which is what an outside transfer
 * out looks like from in here. Dividing either among the sleeves would be a guess presented as a
 * record.
 */
strategyRoutes.get('/positions/:symbol/sleeves', async (c) => {
  const w = await requireWallet(c);
  return c.json(await sleevesFor(w.id, c.req.param('symbol')));
});

strategyRoutes.get('/strategies/stack/:symbol', async (c) => {
  const w = await requireWallet(c);
  const symbol = c.req.param('symbol');
  const stack = await stackOn(w.id, symbol);
  return c.json({ symbol, stack, ...stackSummary(stack) });
});

strategyRoutes.get('/strategies', async (c) => {
  const w = await currentWallet(c);
  if (!w) return c.json([]);
  const rows = await query<StrategyRow>(
    `SELECT * FROM strategies WHERE wallet_id=$1 AND chain = ${THIS_CHAIN} ORDER BY created_at DESC`,
    [w.id],
  );
  return c.json(rows.map(toApi));
});

/**
 * Every run this wallet's strategies have made.
 *
 * `strategy_runs` is where the product's central claim actually lives — "the bot trades unattended
 * and every run is recorded, including the ones it refused". The table has been written on every
 * tick since the scheduler existed and could only be read by the leaderboard, the alert evaluator
 * and one verification check. Nothing showed it to the person whose money it is.
 *
 * Refusals are included and are the point. A list of fills is a highlight reel; `blocked` and
 * `skipped` rows with their reason are what let someone see the limits doing their job.
 *
 * Joined to `strategies` so a row can say what it was trying to do — a run id and a status with no
 * symbol attached is not something anyone can act on — and scoped by `wallet_id` through that join,
 * which is what stops one caller reading another's runs.
 */
strategyRoutes.get('/runs', async (c) => {
  /*
   * Parsed the way `/history` parses it.
   *
   * `Number('abc')` survived the clamp as NaN and reached Postgres as `LIMIT 'NaN'`, which answered 500 in the
   * database's own words for a request only the caller could fix. Floored as well: LIMIT takes a whole number, and
   * `limit=1.5` failed the same way.
   */
  const asked = c.req.query('limit');
  const n = asked === undefined ? 100 : Number(asked);
  if (!Number.isFinite(n)) {
    return c.json({ error: 'bad_limit', detail: 'limit is a number of runs, at most 200.' }, 400);
  }
  const limit = Math.min(200, Math.max(1, Math.floor(n)));
  const w = await currentWallet(c);
  if (!w) return c.json([]);
  const rows = await query<{
    id: string;
    strategy_id: string;
    kind: string;
    label: string;
    symbol: string;
    status: string;
    usd: string | null;
    units: string | null;
    price: string | null;
    signature: string | null;
    error: string | null;
    started_at: Date;
    finished_at: Date | null;
    venue: string | null;
    side: string | null;
  }>(
    `SELECT r.id, r.strategy_id, s.kind, s.label, s.symbol, r.status, r.usd, r.units, r.price,
            r.signature, r.error, r.started_at, r.finished_at, r.venue, r.side
       FROM strategy_runs r
       JOIN strategies s ON s.id = r.strategy_id
      WHERE s.wallet_id = $1 AND s.chain = ${THIS_CHAIN}
      ORDER BY r.started_at DESC
      LIMIT $2`,
    [w.id, limit],
  );
  return c.json(
    rows.map((r) => ({
      id: r.id,
      strategyId: r.strategy_id,
      kind: r.kind,
      label: r.label,
      symbol: r.symbol,
      status: r.status,
      /*
       * NUMERIC comes back from pg as a string, deliberately — it is arbitrary precision and
       * JavaScript numbers are not. Parsed here because these are display quantities with known
       * small magnitudes, and null stays null: a blocked run has no price, and zero is not the
       * same fact.
       */
      usd: r.usd === null ? null : Number(r.usd),
      units: r.units === null ? null : Number(r.units),
      price: r.price === null ? null : Number(r.price),
      signature: r.signature,
      error: r.error,
      at: r.started_at.toISOString(),
      finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
      // Where a fill settled and which way it went (PLAN.md 3.1) — facts about the fill, recorded with it.
      venue: r.venue,
      side: r.side,
    })),
  );
});

type StrategyState = 'draft' | 'watch' | 'live' | 'paused' | 'ended';

/** The states that hold allowance against the daily cap. */
const COMMITTED_STATES: ReadonlySet<string> = new Set(['live', 'watch']);

/**
 * What a move says on the trail.
 *
 * A pause says what it is NOT, in the sentence itself. Pausing one strategy stops one row from
 * being selected by the scheduler; the delegation is untouched and every other strategy and agent
 * goes on trading. The kill switch is the only thing that revokes on chain, and someone reading
 * this line later must not be left thinking they had already pulled it.
 */
function describeMove(
  from: string,
  to: StrategyState,
  label: string,
  scheduleMoved = false,
): { action: string; detail: string } {
  switch (to) {
    case 'paused':
      return {
        action: `Paused ${label}`,
        detail:
          'It will not run again until you resume it. Nothing was sold, and your permission is ' +
          'still live — this stops one strategy, not the bot.',
      };
    case 'live':
      return {
        action: `${from === 'paused' ? 'Resumed' : 'Started'} ${label}`,
        detail: scheduleMoved
          ? 'It runs on its schedule again, inside your daily cap. Its next run was overdue, so it moves to the next one rather than buying now.'
          : 'It runs on its schedule again, inside your daily cap.',
      };
    case 'watch':
      return {
        action: `${from === 'paused' ? 'Resumed watching' : 'Watching'} ${label}`,
        detail: 'It records what it would do and moves nothing.',
      };
    case 'draft':
      return { action: `Moved ${label} back to draft`, detail: 'It will not run until you start it.' };
    case 'ended':
      return {
        action: `Ended ${label}`,
        detail: 'It will not run again. Your history and any position it opened are untouched.',
      };
  }
}

/**
 * Every change to a strategy's state goes through here.
 *
 * There were three ways to change one, and they disagreed. `POST /strategies/:id/{pause,resume,end}`
 * — the routes the Strategy screen calls — updated by id alone, so anyone signed in who had another
 * account's strategy id could pause, resume or end it, and nothing reached the trail. PATCH and
 * DELETE did check the wallet, and were each registered twice, the second copies unreachable.
 *
 * One path now, holding four things:
 *   - scoped to the caller's wallet, so another account's id reads exactly like a missing one;
 *   - written on the trail when the state changes, and not when a repeated tap changes nothing;
 *   - an ended strategy stays ended — retiring clears `next_run_at`, so a resumed one would sit
 *     "live" and never run;
 *   - resuming asks the cap question creating asks (`commitmentRefusal`).
 */
async function moveStrategy(c: Context, to: StrategyState): Promise<Response | StrategyRow> {
  const w = await requireWallet(c);
  const id = c.req.param('id');
  const current = await one<StrategyRow>(`SELECT * FROM strategies WHERE id = $1 AND wallet_id = $2 AND chain = ${THIS_CHAIN}`, [
    id,
    w.id,
  ]);
  if (!current) return c.json({ error: 'not_found' }, 404);
  if (current.state === to) return current;
  if (current.state === 'ended') {
    return c.json(
      { error: 'strategy_ended', message: 'An ended strategy stays ended. Set up a new one instead.' },
      409,
    );
  }
  if (COMMITTED_STATES.has(to) && !COMMITTED_STATES.has(current.state)) {
    const refusal = await commitmentRefusal(w, {
      allocationUsd: Number(current.daily_allocation_usd),
      closeOnly: CLOSE_ONLY_KINDS.has(current.kind),
      doing: 'resuming it',
      excludeId: current.id,
    });
    if (refusal) return c.json(refusal, 400);
  }

  /*
   * A resume never causes an immediate spend.
   *
   * `next_run_at` stays where it was while a strategy is paused, so a daily buy paused on Monday and
   * resumed on Friday is four days overdue — the next tick selects it, `periodKey` buckets it under
   * Friday rather than the Monday it was due, and a real buy settles seconds after a tap that said
   * "resume". A due time already past moves to the next slot from now; one still ahead is left
   * exactly where the user set it. "Run now" is next to Resume for anyone who meant it at once.
   */
  const resuming = current.state === 'paused' && to !== 'ended';
  const before = current.next_run_at ? new Date(current.next_run_at) : null;
  const after = resuming ? nextRunOnResume(before, current.cadence, new Date()) : before;
  const scheduleMoved = resuming && resumeMovedSchedule(before, after);

  /*
   * `paused_from` is written on the way in and cleared on the way out (migration 031).
   *
   * Without it every resume meant `live`, and a strategy in `watch` — whose entire purpose is to
   * record what it WOULD do and move nothing — came back from a pause able to spend.
   */
  const row = await one<StrategyRow>(
    `UPDATE strategies
        SET state = $3::text,
            paused_from = CASE WHEN $3::text = 'paused' THEN $5::text ELSE NULL END,
            next_run_at = CASE WHEN $3::text = 'ended' THEN NULL ELSE $4::timestamptz END
      WHERE id = $1 AND wallet_id = $2
      RETURNING *`,
    [id, w.id, to, after, current.state],
  );
  if (!row) return c.json({ error: 'not_found' }, 404);

  await append({
    walletId: w.id,
    agent: 'xorr',
    ...describeMove(current.state, to, row.label, scheduleMoved),
    kind: 'risk',
    payload: {
      strategyId: row.id,
      from: current.state,
      state: to,
      /*
       * Said on the trail, because it is a change to when someone's money moves. A silent one
       * reads as a bug the first time it surprises them.
       */
      ...(scheduleMoved ? { nextRunMovedTo: after?.toISOString() } : {}),
    },
  });
  return row;
}

/**
 * Pause, resume or retire a strategy.
 *
 * There was no way to stop one. A user could add strategies until they hit the cap and then had
 * no route out — which also meant the cap, working correctly, read as the app being broken. The
 * commitment total only counts `live` and `watch`, so pausing frees the allowance immediately.
 */
strategyRoutes.patch('/strategies/:id', async (c) => {
  const body = z
    .object({ state: z.enum(['draft', 'watch', 'live', 'paused', 'ended']) })
    .parse(await c.req.json());
  const moved = await moveStrategy(c, body.state);
  return moved instanceof Response ? moved : c.json(toApi(moved));
});

/**
 * Retire a strategy.
 *
 * Marks it `ended` rather than deleting the row: the runs and audit entries that reference it are
 * the user's own history, and a delete would take them with it.
 */
strategyRoutes.delete('/strategies/:id', async (c) => {
  const moved = await moveStrategy(c, 'ended');
  return moved instanceof Response ? moved : c.json({ ok: true });
});

/** The same moves by name — what the app's Strategy screen calls. */
for (const [path, to] of [
  ['pause', 'paused'],
  ['end', 'ended'],
] as const) {
  strategyRoutes.post(`/strategies/:id/${path}`, async (c) => {
    const moved = await moveStrategy(c, to);
    return moved instanceof Response ? moved : c.json(toApi(moved));
  });
}

/**
 * Resume, to whichever state the pause was taken out of.
 *
 * This route used to be generated beside `pause` and `end` with a fixed destination of `live`, so a
 * strategy in `watch` — the state whose entire purpose is to record what it WOULD do and move
 * nothing — came back from a pause able to spend. The row remembers (`paused_from`, migration 031)
 * and the destination is read from it rather than assumed.
 *
 * The client deliberately does not choose: a resume is "undo the pause", and letting a caller name
 * the state would put the question back where the bug was.
 */
strategyRoutes.post('/strategies/:id/resume', async (c) => {
  const w = await requireWallet(c);
  const current = await one<StrategyRow>(
    `SELECT * FROM strategies WHERE id = $1 AND wallet_id = $2 AND chain = ${THIS_CHAIN}`,
    [c.req.param('id'), w.id],
  );
  if (!current) return c.json({ error: 'not_found' }, 404);

  const moved = await moveStrategy(c, stateOnResume(current.paused_from));
  return moved instanceof Response ? moved : c.json(toApi(moved));
});

/**
 * A market order the user placed themselves — screen 14's "Buy ${amount} of {symbol}".
 *
 * ## Why this reuses `runStrategy` rather than adding a second spend path
 *
 * Everything that spends the user's money goes through one place: the period claim, the
 * policy engine, the on-chain cap read, the venue allowlist, the 1inch route and the
 * `spendAsDelegate` call. A "place this order now" endpoint that re-implemented any of that
 * would be a second door into the same room, and the second door is the one nobody
 * remembers to lock.
 *
 * So a manual order is a one-shot strategy: a `buy` row with no cadence, run immediately and
 * retired. It inherits every guard by construction, it shows up in the strategy list and the
 * audit trail like anything else, and there is exactly one code path that can move money.
 *
 * ## Why the app may call this at all
 *
 * `POST /orders` is not the bot acting on its own — it is the user exercising the authority
 * they already granted, and every limit on that authority is enforced server-side and
 * on-chain. A compromised phone can spend up to the cap at an allowlisted venue, which is
 * exactly the risk the cap describes and exactly what the kill switch ends in one tap. It
 * cannot withdraw, cannot name a destination, and cannot pick a price.
 */
/**
 * The floor an order has to clear: a cent.
 *
 * `.positive()` alone accepted `$0.000001`, which is not a smaller order — it is an order that rounds to
 * nothing at the venue and comes back `TF` after a real route, a real claim against the period and a real
 * audit row. Money in this product is denominated to the cent everywhere it is written; this is that, said
 * where it can be enforced.
 *
 * The app refuses it first and says so on the ticket (`src/markets/amount.ts`). This is the same rule on
 * the side that has to hold whatever a client sends, and `order-amount.test.ts` checks the two agree.
 */
export const ORDER_MIN_USD = 0.01;

/** And the ceiling, which has always been here. */
export const ORDER_MAX_USD = 1_000_000;

const OrderInput = z.object({
  symbol: z.string().min(1).max(12),
  usd: z.number().min(ORDER_MIN_USD).max(ORDER_MAX_USD),
});

/** One order, placed now. The path itself — permission, one-shot row, run — is `placeOrder`. */
strategyRoutes.post('/orders', async (c) => {
  const w = await requireWallet(c);
  const body = OrderInput.parse(await c.req.json());
  const order = await placeOrder(w, body.symbol, body.usd);
  if (!order.placed) return c.json(order.refusal, 409);
  return c.json({ ...order.outcome, orderId: order.orderId }, httpStatusFor(order.outcome));
});

/**
 * One swap, placed now — the request the Swap screen sends (PLAN.md 3.9). `placeSwap` says how each pair settles.
 */
const SwapInput = z.object({
  from: z.string().min(1).max(12),
  to: z.string().min(1).max(12),
  // The decimal as typed, parsed into the token's own base units exactly — never through a float.
  amount: z
    .string()
    .regex(/^\d{1,12}(\.\d{1,18})?$/, 'a plain decimal amount')
    .refine((a) => Number(a) > 0, 'an amount above zero'),
  slippagePct: z.number().min(0.05).max(3).optional(),
});

strategyRoutes.post('/swap', async (c) => {
  const w = await requireWallet(c);
  const body = SwapInput.parse(await c.req.json());
  const swap = await placeSwap(w, body);
  return c.json(swap.body, swap.status as 200 | 400 | 409 | 502 | 503);
});

/**
 * Run one strategy now.
 *
 * A cadence is the point of the product, but it is useless for showing someone what the bot does:
 * "come back on Sunday" is not a demo, and it is not a way to test a change either. This runs the
 * same `runStrategy` the scheduler runs, with the same period claim — so triggering it twice in a
 * period is a no-op rather than a double buy, which is the property that makes it safe to expose.
 */
strategyRoutes.post('/strategies/:id/run', async (c) => {
  const w = await requireWallet(c);
  const row = await one<StrategyRow>(
    `SELECT * FROM strategies WHERE id = $1 AND wallet_id = $2 AND chain = ${THIS_CHAIN}`,
    [c.req.param('id'), w.id],
  );
  // Scoped to the caller's own wallet: an id from another user must look like a missing strategy,
  // not like a permission error, because the latter confirms it exists.
  if (!row) return c.json({ error: 'not_found' }, 404);

  const outcome = await runStrategy(row);
  return c.json(outcome, httpStatusFor(outcome));
});

strategyRoutes.post('/strategies', async (c) => {
  const body = StrategyInput.parse(await c.req.json());
  // Stored under the registry's names, which the planner and holdings use: `weth` or `nvdac` from a client is `WETH` or `NVDAc` here.
  if (body.symbol === PORTFOLIO) {
    const targets = body.params.targets as Record<string, number>;
    body.params = {
      ...body.params,
      targets: Object.fromEntries(Object.entries(targets).map(([symbol, weight]) => [canonicalSymbol(symbol), weight])),
    };
  } else {
    /*
     * The symbol itself, too.
     *
     * Only a portfolio's targets were renamed, and `body.symbol` was stored as sent: `weth` went into the row as `weth`
     * and missed every lookup keyed by the registry afterwards — prices, holdings, the leaderboard's marks. The schema
     * has already refused a symbol that does not resolve.
     */
    body.symbol = canonicalSymbol(body.symbol);
  }

  /*
   * Refuse at creation what cannot settle here, rather than at run time.
   *
   * The schema check above proves the symbol is a token this executor knows. It does not prove the
   * token WORKS on the chain this deployment points at — the tokenized equities have real Base
   * addresses and do not function on a fork of Base, where `totalSupply()` reverts. So a user could
   * create a recurring buy of NVDAc that scheduled forever and failed every single run with `TF`,
   * and the failure read as our bug rather than an impossible request. That is the same reasoning
   * the schema check is there for, one layer deeper.
   */
  // A portfolio rebalance settles each of its targets, so each is held to the same test.
  const settles = body.symbol === PORTFOLIO ? Object.keys(body.params.targets as Record<string, number>) : [body.symbol];
  const equity = settles.find((symbol) => isStock(symbol));
  if (equity && !(await equitiesFunctional())) {
    return c.json(
      {
        error: 'not_settleable_here',
        message:
          `${canonicalSymbol(equity)} cannot be settled on ${CHAIN_KEY}. The tokenized ` +
          'equities are live on Base mainnet and do not function on a fork of it, so a strategy ' +
          'for one would schedule forever and fill never.',
      },
      400,
    );
  }

  /*
   * The settlement token is what a buy is PAID IN, so it cannot also be what a buy BUYS.
   *
   * The app offered USDC in the recurring-buy target list and this route accepted it: `USDC` is a
   * token the executor knows, so the schema check and the equity check above both pass. The
   * strategy was created, scheduled, and would have failed on every run until someone turned it
   * off — 1inch rejects a swap whose source and destination match outright, `src and dst should be
   * different`, HTTP 400. Same reasoning as the equity check directly above: refuse the impossible
   * request at creation, in the executor, so no client can schedule it.
   *
   * Only for the kinds that ACQUIRE the symbol by swapping into it. The first version of this
   * guard refused every USDC strategy, which would have broken `yield-rotation` — the tier whose
   * entire job is sweeping idle USDC into Aave, and which is correctly `symbol: 'USDC'`. It never
   * shipped: found by listing this wallet's USDC strategies while testing the guard and seeing a
   * legitimate one sitting next to the illegitimate one.
   */
  const BUYS_ITS_SYMBOL: readonly string[] = ['dca', 'grid', 'momentum', 'event-driven'];
  if (
    BUYS_ITS_SYMBOL.includes(body.kind) &&
    canonicalSymbol(body.symbol) === SETTLEMENT_SYMBOL
  ) {
    return c.json(
      {
        error: 'not_settleable_here',
        message:
          `${SETTLEMENT_SYMBOL} is what a buy is paid in, so there is no swap to make. ` +
          'To put idle cash to work, supply it to Aave instead.',
      },
      400,
    );
  }

  const w = await requireWallet(c);

  /*
   * PLAN.md 9.2: the sum of live strategies can never exceed the delegation's daily cap, enforced
   * at CREATION so a user cannot quietly over-commit by adding one more.
   *
   * Read from the CHAIN. This used to read a `delegations` row written by /delegation/record, and
   * a row that was never written meant `del` was null and the whole check was skipped — a wallet
   * with a real $1,600 on-chain cap accepted a $999,999/day strategy, because the guard's failure
   * mode was to wave everything through. Absent permission has to mean refuse, not allow.
   */
  /*
   * WHOSE agent, before WHETHER you may trade.
   *
   * This ran below the delegation gate, so naming an agent that is not yours reported "grant
   * permission first" — you would grant it, retry, and only then be told the real problem. A
   * malformed request is malformed regardless of permission state, and answering the fixable
   * thing first is the difference between one round trip and two.
   *
   * It also made the isolation test vacuous: another wallet's agent id was refused for having no
   * delegation rather than for belonging to someone else, so the test passed green without ever
   * reaching the rule it exists to check.
   *
   * The query is scoped to this wallet, so the answer is only ever about your own roster and
   * names nothing belonging to anyone else.
   */
  let attached: { id: string; name: string } | undefined;
  if (body.agentId) {
    attached = await one<{ id: string; name: string }>(
      `SELECT id, name FROM agents WHERE id = $1 AND wallet_id = $2 AND hired = true`,
      [body.agentId, w.id],
    );
    if (!attached) {
      return c.json(
        { error: 'unknown_agent', message: 'That agent is not one you have hired.' },
        400,
      );
    }
  }

  const refusal = await commitmentRefusal(w, {
    allocationUsd: body.dailyAllocationUsd,
    closeOnly: CLOSE_ONLY_KINDS.has(body.kind),
    doing: 'creating a strategy',
  });
  if (refusal) return c.json(refusal, 400);

  /*
   * A spending strategy needs an amount; a self-sizing one decides its own.
   *
   * "Buy $0 of WETH every week" was accepted and would then be blocked at every single run — a
   * strategy that looks live on the list and can never do anything. A rebalance or a stop is
   * different: it is sized by looking, so zero is the correct configuration for it.
   */
  if (!SELF_SIZING_KINDS.has(body.kind) && !(body.dailyAllocationUsd > 0)) {
    return c.json(
      {
        error: 'invalid_request',
        detail: `dailyAllocationUsd: a ${body.kind} strategy needs an amount above zero.`,
      },
      400,
    );
  }

  const nextRunAt = body.nextRunAt
    ? new Date(body.nextRunAt)
    : body.cadence
      ? nextRuns(body.cadence as Cadence, 1)[0]!
      : null;

  // An agent id from another wallet must not be attachable. Verified here rather than trusted,
  // because the alternative is a strategy that reports to an agent its owner cannot see or fire.
  let agentId: string | null = null;
  /*
   * Nobody's persona until one is actually chosen.
   *
   * This defaulted to 'Yield Keeper', so every strategy created without an explicit agent was
   * credited to the tier that only ever moves idle cash into Aave — including a plain WETH
   * recurring buy, which was visible on the deployed build as "Created $50 of WETH, daily ·
   * Yield Keeper". Same mistake as the five literals in `executor/run.ts`, in the one place that
   * writes the row a user sees first.
   *
   * The user created this. `xorr` is the name this codebase already uses for the system acting on
   * an instruction rather than on its own initiative — 'Wallet connected' is written the same way.
   */
  let agentName = 'xorr';
  if (attached) {
    agentId = attached.id;
    agentName = attached.name;
  }

  const row = await one<StrategyRow>(
    `INSERT INTO strategies (id, wallet_id, kind, state, label, symbol, params, cadence, next_run_at, daily_allocation_usd, agent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      randomUUID(),
      w.id,
      body.kind,
      body.state,
      body.label,
      body.symbol,
      JSON.stringify(body.params),
      body.cadence ?? null,
      nextRunAt,
      body.dailyAllocationUsd,
      agentId,
    ],
  );

  await append({
    walletId: w.id,
    agent: agentName,
    action: `Created ${body.label}`,
    detail: nextRunAt ? `First run ${utcStamp(nextRunAt)}.` : 'Ready to run.',
    kind: 'risk',
    payload: { strategyId: row!.id },
  });

  return c.json(toApi(row!));
});
