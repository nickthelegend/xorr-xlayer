/** Backtest, leaderboard and proposal routes — PLAN.md 12.10 / 12.22 / 12.23. */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { one, query, tx } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { append } from '../audit/log.js';
import { LOOKBACKS, backtestDca, backtestGrid, backtestMomentum, isLookback } from '../backtest/engine.js';
import { COINGECKO_IDS } from '../market/ids.js';
import { leaderboard } from '../agents/leaderboard.js';
import { PERSONAS } from '../bot/personas.js';
import { speak } from '../bot/llm.js';
import { TONE_INSTRUCTIONS, type ToneId } from '../bot/tone.js';
import { briefing } from '../news/feed.js';
import { propose } from '../bot/propose.js';
import { send } from '../notifications/push.js';
import { canonicalSymbol, TOKENS as VENUE_TOKENS } from '../venues/tokens.js';
import { quote } from '../venues/uniswap.js';
import { ADDRESSES } from '../evm/chains.js';
import { gasPrice, networkCost } from '../evm/gas-price.js';
import { estimateOutUnits } from '../executor/fill-measure.js';
import { OKX_VENUE_NAME, okxConfigured, okxQuoteRaw } from '../venues/okxdex.js';
import { VENUE_NAME as UNISWAP_VENUE_NAME } from '../venues/uniswap.js';
import { requireUser } from '../auth/middleware.js';
import { currentWallet } from './wallet-context.js';
import { armExits, money, placeOrder } from '../executor/order.js';
import { readChain } from '../http/chain-read.js';
import { screenPatience } from '../http/patience.js';
import { beforeDeadline, StillFetching } from '../http/deadline.js';
import { readPolicy } from '../evm/delegation.js';
import type { Address } from 'viem';

export const extra = new Hono();

/*
 * Delegates to `currentWallet` rather than asking again.
 *
 * This was its own `WHERE user_id = $1 LIMIT 1` with no ORDER BY — one of nine such copies, each
 * free to return a different wallet than the others on an account with more than one row. The
 * damage is not that a query is duplicated: it is that your agents, your alerts, your limits and
 * your trades could each be resolved against a DIFFERENT wallet within one signed-in session.
 * One definition, in `wallet-context`, is the whole point of that module.
 */
async function walletId(c: Context): Promise<string | undefined> {
  return (await currentWallet(c))?.id;
}

extra.get('/agents/leaderboard', async (c) => {
  const id = await walletId(c);
  if (!id) return c.json([]);
  return c.json(await leaderboard(id));
});

/**
 * Why three of the four agents answer 422 here.
 *
 * A backtest is only honest when the strategy can actually be replayed over data we hold. Exactly
 * one of these can be:
 *
 *   - momentum-scout  — a Donchian breakout with a stop, defined entirely by daily closes. Replayed
 *                       bar by bar against the same series the live planner reads.
 *   - earnings-desk   — trades tokenized equities around EDGAR prints. Those tokens have no price
 *                       history at all: /oracle/:symbol exists precisely because the only series
 *                       that will ever exist for them is the one this deployment records by
 *                       looking. There is nothing to replay against.
 *   - yield-keeper    — supplies USDC to Aave v3. Its return is the pool's floating rate, not a
 *                       price path, and we do not hold the historical rate series.
 *   - drawdown-guard  — only ever CLOSES positions. Its result is a function of the book it is
 *                       guarding, so there is no strategy return independent of a portfolio.
 *
 * Before this, all four ran `backtestDca` over SOL and returned the same four numbers — and the
 * route never read `:id` at all, because `const id = await walletId(c)` shadowed it. Publishing one
 * strategy's numbers under another strategy's name is the single most misleading thing a screen
 * like this can do, so the three that cannot be measured now say why instead.
 */
const NOT_BACKTESTABLE: Record<string, string> = {
  'earnings-desk':
    'Earnings Desk trades tokenized equities around scheduled prints, and those tokens have no price history to replay — the only series that exists for them is the one this executor has recorded since it started looking.',
  'yield-keeper':
    'Yield Keeper does not take a price position. It supplies idle USDC to Aave v3, so its return is the pool\'s floating rate rather than a price path, and this deployment does not hold the historical rate series.',
  'drawdown-guard':
    'Drawdown Guard only closes positions. What it would have returned depends entirely on the book it was guarding, so there is no strategy return to measure independently of a portfolio.',
};

/** The persona a roster id names: a persona's own id, or the persona of this wallet's agent row with that id. */
async function personaOf(agentId: string, walletId: string | undefined): Promise<string | undefined> {
  if (Object.hasOwn(PERSONAS, agentId)) return agentId;
  if (!walletId) return undefined;
  const row = await one<{ persona_id: string; style: string | null }>(
    `SELECT persona_id, style FROM agents WHERE id = $1 AND wallet_id = $2`,
    [agentId, walletId],
  );
  // An agent a person made answers for the persona it follows (migration 027).
  return row ? (row.style ?? row.persona_id) : undefined;
}

extra.get('/agents/:id/backtest', async (c) => {
  /*
   * A lookback there is no window for is refused, not replayed.
   *
   * This cast `?lookback` straight to `Lookback`, so `7d` reached the engine as a window of NaN days: the replay never
   * ran, and the route answered 200 with a flat result nobody computed — 0% over 0 trades, under a disclaimer about
   * real history. The four `/strategies/backtest` takes, from the one list the engine keeps.
   */
  const lookback = c.req.query('lookback') ?? '90d';
  if (!isLookback(lookback)) {
    return c.json({ error: 'invalid_lookback', detail: `lookback is one of ${LOOKBACKS.join(', ')}.` }, 400);
  }
  // The AGENT, from the path. This was shadowed by the wallet lookup below and never read.
  const agentId = c.req.param('id');

  /*
   * Whichever id the roster holds for the agent.
   *
   * `GET /agents` names an agent by its persona until the wallet has a row for it, and by the row's id from then on, and
   * the roster screen routes here with the id it was given. This understood persona ids only, so a hired agent's
   * backtest answered 404 `unknown_agent` for an agent listed one screen earlier. A row id is resolved to its persona
   * within the caller's wallet; an id that is neither — another wallet's row included — is still unknown.
   *
   * The wallet read is not caught. It was `.catch(() => null)`, so a read that failed became "no wallet": an unknown
   * agent here, and a chart scaled to the default cap below.
   */
  const w = await currentWallet(c);
  const persona = await personaOf(agentId, w?.id);
  const reason = persona !== undefined && Object.hasOwn(NOT_BACKTESTABLE, persona) ? NOT_BACKTESTABLE[persona] : undefined;
  if (reason) return c.json({ error: 'not_backtestable', agent: agentId, message: reason }, 422);
  if (persona !== 'momentum-scout') {
    return c.json(
      {
        error: 'unknown_agent',
        agent: agentId,
        message: `No agent "${agentId}" is on the roster.`,
      },
      404,
    );
  }

  /*
   * The cap this backtest sizes against comes from the chain, like every other statement the
   * product makes about a user's limits. The database copy is a cache of the last grant recorded
   * through us, and a backtest scaled to a cap the user no longer has is a chart of a strategy
   * they could not run. Falls back to the default only when there is no policy to read.
   */
  // The default is for a wallet with no policy. A read that FAILED used to take it too, scaling the
  // chart to a cap the user may not have (PLAN.md 1.7) — that is a 502 now, not a guess.
  const policy = w ? await readChain('your permission', () => readPolicy(w.address as Address)) : null;
  const cap = policy?.dailyCapUsd ?? 1600;

  /*
   * WETH, not SOL.
   *
   * The old default backtested a symbol this executor cannot settle — "liquid majors" means the
   * ones with a real route on Base. Backtesting an asset the strategy could never have bought is
   * the same class of error as backtesting the wrong strategy.
   */
  const symbol = canonicalSymbol(c.req.query('symbol') ?? 'WETH');
  // History exists only for a symbol with a feed: without one there is nothing to replay, and no retry changes that.
  if (!COINGECKO_IDS[symbol]) return noHistory(c, symbol);
  try {
    return c.json(
      await within(
        backtestMomentum({
          symbol,
          lookback,
          usdPerEntry: Number(c.req.query('perRun') ?? 500),
          dailyCapUsd: cap,
        }),
      ),
    );
  } catch (e) {
    if (e instanceof TooSlow) return warming(c);
    // A fetch that failed, named as `/strategies/backtest` names it rather than as a sentence in `error`.
    return c.json({ error: 'no_history', message: e instanceof Error ? e.message : String(e) }, 502);
  }
});

// ── Approve-before-execute — PLAN.md 12.10 [G27] ─────────────────────────────

extra.get('/proposals/current', async (c) => {
  const id = await walletId(c);
  if (!id) return c.json(null);
  const row = await one<{
    id: string;
    agent: string;
    payload: Record<string, string>;
    expires_at: Date;
    decision: string | null;
  }>(
    `SELECT * FROM proposals WHERE wallet_id=$1 AND decision IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [id],
  );
  if (!row) return c.json(null);
  return c.json({
    id: row.id,
    agent: row.agent,
    ...row.payload,
    expiresAt: new Date(row.expires_at).getTime(),
  });
});

/**
 * Ask the agent to consider a trade. This is what the Bot tab calls when it finds no open
 * proposal — without it the approve-before-execute pipeline had no producer and the thread was
 * permanently empty.
 */
extra.post('/proposals/generate', async (c) => {
  const id = await walletId(c);
  if (!id) return c.json({ error: 'no_wallet' }, 400);
  const tone = ((await c.req.json().catch(() => ({}))) as { tone?: ToneId }).tone ?? 'dry';
  /*
   * Bounded, because this is the entire content of the Bot tab.
   *
   * `propose` prices every tradable asset, and on a cold cache that measured 22.8 seconds against
   * the deployed executor — long enough that the browser abandoned the request and reported a CORS
   * failure, which is not what went wrong. The work continues in the background, so the retry a
   * few seconds later reads a warm cache and answers in under a second.
   */
  let result: Awaited<ReturnType<typeof propose>>;
  try {
    result = await within(propose(id, tone), PROPOSAL_BUDGET_MS);
  } catch (e) {
    if (e instanceof TooSlow) {
      return warming(c, 'The agent is still pricing the market; ask again in a moment.');
    }
    throw e;
  }
  if (!result.created) {
    /*
     * A decline is a first-class event — screen 15 exists to show what the bot chose NOT to do —
     * but the SAME decline is one decision observed again, not a new one.
     *
     * This appended unconditionally, and the Bot tab calls it on every mount. Thirty-four of one
     * wallet's fifty-seven audit rows were "Proposed nothing", all identical: sixty percent of a
     * permanent, append-only trail was a record of page loads rather than of decisions, and the
     * catch-up panel showed the same sentence twice above "add 18 more". A log that fills with
     * its own noise is one nobody reads, which costs exactly the property it exists to have.
     *
     * So it is written when the answer CHANGES. If the bot's last word on a proposal was already
     * this decline, re-observing it adds nothing; if it proposed something in between, or the
     * reason is different, that is new and it is recorded.
     */
    if (result.reason === 'no_setup' || result.reason === 'no_market_data') {
      const last = await one<{ action: string; detail: string | null }>(
        `SELECT action, detail FROM audit_log
          WHERE wallet_id = $1 AND (action LIKE 'Proposed%' OR action LIKE 'Skipped%')
          ORDER BY seq DESC LIMIT 1`,
        [id],
      );
      const repeat = last?.action === 'Proposed nothing' && last.detail === result.detail;
      if (!repeat) {
        await append({
          walletId: id,
          agent: 'Momentum Scout',
          action: `Proposed nothing`,
          detail: result.detail,
          kind: 'block',
          payload: { reason: result.reason },
        });
      }
    }
    return c.json(result);
  }
  return c.json({
    created: true,
    id: result.id,
    agent: 'Momentum Scout',
    ...result.payload,
    expiresAt: Date.now() + 252_000,
  });
});

/**
 * Every proposal this wallet has been shown, and what happened to it.
 *
 * The thread renders the CURRENT proposal and forgets the rest, so "what has it asked me for, and
 * what did I say" had no answer anywhere. That is the record of the approve-before-execute loop
 * working — and specifically of the ones that expired, which are the interesting rows: an expiry is
 * the bot asking and being ignored, which neither an approval nor a skip tells you.
 *
 * `payload` is the proposal as it was shown, stored at the time. Rendering today's prices against
 * yesterday's proposal would rewrite what was actually put in front of someone.
 */
extra.get('/proposals', async (c) => {
  const id = await walletId(c);
  if (!id) return c.json([]);
  const rows = await query<{
    id: string;
    agent: string;
    payload: Record<string, unknown>;
    expires_at: Date;
    decision: string | null;
    decided_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, agent, payload, expires_at, decision, decided_at, created_at
       FROM proposals WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [id],
  );
  const now = Date.now();
  return c.json(
    rows.map((r) => ({
      id: r.id,
      agent: r.agent,
      payload: r.payload,
      /*
       * An undecided proposal past its expiry is expired, whether or not anything wrote that down.
       * The decision column is only set when someone acts or the thread notices; leaving those rows
       * as "awaiting" would show a queue of decisions nobody can make any more.
       */
      decision: r.decision ?? (r.expires_at.getTime() <= now ? 'expired' : null),
      decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
      expiresAt: r.expires_at.toISOString(),
      at: r.created_at.toISOString(),
    })),
  );
});

extra.post('/proposals', async (c) => {
  const body = z
    .object({
      agent: z.string(),
      payload: z.record(z.string(), z.string()),
      ttlSeconds: z.number().positive().max(3600).default(252),
    })
    .parse(await c.req.json());
  const id = await walletId(c);
  if (!id) return c.json({ error: 'no_wallet' }, 400);
  const row = await one(
    `INSERT INTO proposals (id, wallet_id, agent, payload, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval) RETURNING *`,
    [randomUUID(), id, body.agent, JSON.stringify(body.payload), String(body.ttlSeconds)],
  );
  return c.json({ id: row!.id, expiresAt: new Date(row!.expires_at).getTime() });
});

/**
 * Approve or skip a proposal.
 *
 * Approving wrote "Filled 0.0041 WETH at $2,431. Stop set at $2,406." into the thread and the trail —
 * and traded nothing. No order, no stop, no transaction: a fill that existed only as a sentence, on
 * the one card in the product that asks permission to spend. PLAN.md 1.3.
 *
 * Approving now places the order the card describes through `placeOrder`, the same path as
 * `POST /orders` — on-chain permission, cap, venue allowlist and trail all apply — and the answer is
 * what actually happened: a fill with its transaction, or why nothing was placed. When the proposal
 * named a stop and a target, a real `exit-rules` strategy holds them.
 */
extra.post('/proposals/:id/decide', async (c) => {
  const body = z.object({ decision: z.enum(['approve', 'skip']) }).parse(await c.req.json());
  const pid = c.req.param('id');
  const w = await currentWallet(c);
  if (!w) return c.json({ error: 'no_wallet' }, 400);

  /*
   * Decide first, and trade only once the decision has committed.
   *
   * Idempotent: the UPDATE matches only an undecided, unexpired proposal belonging to THIS wallet, so
   * a double approve cannot double-fill (PLAN.md 12.10) and another account's proposal id reads as
   * missing — it used to match any id at all. The order runs outside the transaction because it waits
   * on a chain, and a transaction held open across a swap is how a connection pool runs dry.
   */
  const decided = await tx(async (client) => {
    const res = await client.query<{ id: string; agent: string; payload: Record<string, unknown> }>(
      `UPDATE proposals SET decision = $3, decided_at = now()
        WHERE id = $1 AND wallet_id = $2 AND decision IS NULL AND expires_at > now()
        RETURNING id, agent, payload`,
      [pid, w.id, body.decision],
    );
    if (res.rows[0]) return { row: res.rows[0] };
    const existing = await client.query<{ decision: string | null }>(
      `SELECT decision FROM proposals WHERE id = $1 AND wallet_id = $2`,
      [pid, w.id],
    );
    const e = existing.rows[0];
    if (!e) return { gone: true as const };
    if (e.decision) return { answer: { status: e.decision, message: 'That was already decided.' } };
    return {
      answer: { status: 'expired', message: 'That proposal expired before you decided. I did not place it.' },
    };
  });
  /*
   * Not this wallet's proposal — unknown, or another account's, which the scoped query cannot tell apart — is a 404, as
   * every other owned resource answers.
   *
   * It was a 200 `{status: 'gone'}` so the chat thread could render the sentence straight from the body, which told a
   * caller that deciding something that does not exist had worked. `status` and `message` stay in the 404's body: the
   * app reads the sentence from there (`decideProposal`, src/data/local.ts).
   */
  if ('gone' in decided) {
    return c.json({ error: 'not_found', status: 'gone', message: 'That proposal no longer exists.' }, 404);
  }
  if ('answer' in decided) return c.json(decided.answer);

  const { row } = decided;
  const text = (key: string) => (typeof row.payload[key] === 'string' ? (row.payload[key] as string) : '');
  const symbol = text('symbol') ? canonicalSymbol(text('symbol')) : '';
  const record = (detail: string, kind: 'trade' | 'block', payload: Record<string, unknown> = {}) =>
    append({
      walletId: w.id,
      agent: row.agent,
      action: body.decision === 'approve' ? 'Approved a proposal' : 'Skipped a proposal',
      detail,
      kind,
      payload: { proposalId: row.id, ...payload },
    });

  if (body.decision === 'skip') {
    // A strategy's proposal says what skipping means for it — it looks again on its next run — so the
    // reply cannot promise "not today", which only the chat agent's own proposals keep.
    const message = text('onSkip') || `Skipped. I will not re-propose ${symbol || 'this'} today.`;
    await record(message, 'block');
    return c.json({ status: 'skip', message });
  }

  const usd = Number(text('usd'));
  if (!symbol || !(usd > 0)) {
    const message = 'That proposal did not say how much to buy, so I placed nothing. Ask me for a fresh one.';
    await record(message, 'block', { reason: 'no_size' });
    return c.json({ status: 'blocked', reason: 'no_size', message });
  }

  /*
   * The agent whose strategy asked, when one did (2026-09-25): the buy is that agent's, so it is charged to the agent's
   * own budget on chain like any trade it places unattended. A proposal from the chat is the owner's own decision.
   */
  const askedBy = text('strategyId')
    ? await one<{ agent_id: string | null }>(
        `SELECT agent_id FROM strategies WHERE id = $1 AND wallet_id = $2 AND chain = ${THIS_CHAIN}`,
        [text('strategyId'), w.id],
      ).catch(() => null)
    : null;
  const order = await placeOrder(w, symbol, usd, `${money(usd)} of ${symbol}, approved`, {}, askedBy?.agent_id ?? null);
  if (!order.placed) {
    const message = `I placed nothing. ${order.refusal.detail}`;
    await record(message, 'block', { reason: order.refusal.reason });
    return c.json({ status: 'blocked', reason: order.refusal.reason, message });
  }

  const { outcome, orderId } = order;
  if (outcome.status !== 'filled') {
    const status = outcome.status === 'failed' ? 'failed' : 'blocked';
    const message =
      outcome.status === 'blocked'
        ? `I placed nothing. ${outcome.detail}`
        : outcome.status === 'failed'
          ? `The order did not go through. ${outcome.error}`
          : 'I placed nothing: there was nothing to do.';
    await record(message, 'block', { orderId, runStatus: outcome.status });
    return c.json({ status, message, orderId });
  }

  /*
   * Who looks after the position now.
   *
   * A tier 6–7 proposal names the strategy that asked (PLAN.md 1.10). That strategy has its own exit —
   * momentum's stop, event-driven's close after the event — and runs it only for a position it knows
   * it opened, so the state an unattended fill would have written is written now, with the entry at
   * the price actually paid. Arming a separate exit as well would give one holding two sellers.
   */
  const strategyId = text('strategyId');
  let exits: { strategyId: string | null; sentence: string };
  if (strategyId) {
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(text('stateAfter') || '{}') as Record<string, unknown>;
    } catch {
      state = {};
    }
    if ('openEntryPrice' in state) state.openEntryPrice = outcome.price;
    const managed = await one<{ label: string }>(
      `UPDATE strategies SET params = params || $3::jsonb WHERE id = $1 AND wallet_id = $2 AND chain = ${THIS_CHAIN} RETURNING label`,
      [strategyId, w.id, JSON.stringify(state)],
    );
    const stop = Number(state.stopPrice ?? 0);
    exits = managed
      ? { strategyId: null, sentence: `${managed.label} now manages it${stop > 0 ? `, with its stop at ${money(stop)}` : ''}.` }
      : {
          strategyId: null,
          sentence: 'The strategy that asked no longer exists, so nothing is watching this position. Set a stop in Auto Close.',
        };
  } else {
    exits = await armExits(w, {
      symbol,
      entryPrice: outcome.price,
      stopPrice: Number(text('stopPrice')),
      targetPrice: Number(text('targetPrice')),
    });
  }
  const message = `Bought ${outcome.units.toFixed(4)} ${symbol} at ${money(outcome.price)}. ${exits.sentence}`;
  await record(message, 'trade', {
    orderId,
    runId: outcome.runId,
    signature: outcome.signature,
    exitStrategyId: exits.strategyId,
  });
  return c.json({
    status: 'filled',
    message,
    orderId,
    signature: outcome.signature,
    exitStrategyId: exits.strategyId,
  });
});

// ── The bot's voice ──────────────────────────────────────────────────────────

extra.post('/bot/say', async (c) => {
  const body = z
    .object({
      persona: z.enum(['momentum-scout', 'earnings-desk', 'yield-keeper', 'drawdown-guard']),
      situation: z.string().min(3).max(600),
      tone: z.enum(['dry', 'sharp', 'flat']).default('dry'),
    })
    .parse(await c.req.json());

  const out = await speak({
    persona: body.persona,
    toneInstruction: TONE_INSTRUCTIONS[body.tone as ToneId],
    situation: body.situation,
  });

  if (out.ok) return c.json({ text: out.text, model: out.model, source: 'model' });
  /*
   * No model, no text. `null`, not a written-in-advance line.
   *
   * This returned the persona's own bible line, and the chat client had to learn to ignore it —
   * its docblock records asking "why did the CBBTC buy fail?" and getting back "Nothing worth
   * chasing today. Ranges are thin and the tape is quiet." The client was fixed; the API kept
   * emitting the line, so every other caller still received a confident market remark that nothing
   * measured. `/briefing` was one of them, and it captioned three unrelated headlines with the
   * same sentence.
   *
   * The facts half of every message is rendered by the client from real records regardless, so an
   * absent voice segment costs a quip and never information.
   */
  return c.json({
    // `'none'`, not `'fallback'`: there is no fallback copy any more, and `text` is null. See the
    // note on `BriefingCard.source`.
    text: null,
    source: 'none',
    reason: out.reason,
    detail: out.detail,
  });
});

// GET /agents moved to server/src/agents/routes.ts, where it reads the persisted roster.

extra.get('/briefing', async (c) => {
  const id = await walletId(c);
  if (!id) return c.json([]);
  const tone = (c.req.query('tone') ?? 'dry') as ToneId;
  try {
    return c.json(await briefing(id, tone));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

extra.post('/devices/register', async (c) => {
  const body = z.object({ token: z.string().min(10), platform: z.string() }).parse(await c.req.json());
  const id = await walletId(c);
  if (!id) return c.json({ error: 'no_wallet' }, 400);
  await query(
    `INSERT INTO devices (token, wallet_id, platform) VALUES ($1,$2,$3)
     ON CONFLICT (token) DO UPDATE SET wallet_id=EXCLUDED.wallet_id`,
    [body.token, id, body.platform],
  );
  return c.json({ ok: true });
});

extra.post('/notify/test', async (c) => {
  const id = await walletId(c);
  if (!id) return c.json({ error: 'no_wallet' }, 400);
  return c.json(
    await send(id, {
      title: 'xorr',
      body: 'Your recurring buy ran.',
      route: '/activity',
    }),
  );
});

// ── Venues — Uniswap v3 and OKX DEX ───────────────────────────────────────────────────────────

/**
 * What is wrong with a pair and an amount, before any venue is asked — or null when nothing is.
 *
 * `/swap/quote` and `/route/compare` passed both straight through, so `in=NOPE` came back as "No route for NOPE ->
 * WETH" and `amount=abc` as a BigInt RangeError: each a 502, which tells the app to retry a request no retry can fix.
 */
function tradeRefusal(inSymbol: string, outSymbol: string, amount: number): { error: string; detail: string } | null {
  const unknown = [...new Set([inSymbol, outSymbol])].filter((symbol) => !VENUE_TOKENS[symbol]);
  if (unknown.length > 0) {
    return {
      error: 'unknown_token',
      detail: `${unknown.join(' and ')} ${unknown.length === 1 ? 'is not a token' : 'are not tokens'} that can be traded here.`,
    };
  }
  if (!(Number.isFinite(amount) && amount > 0)) {
    return { error: 'invalid_amount', detail: 'amount is how much of the token you pay, above zero.' };
  }
  return null;
}

extra.get('/swap/quote', async (c) => {
  requireUser(c);
  // The tolerance the screen shows is the one it quotes at, and the one a swap is then sent with (PLAN.md 3.9).
  const slippage = c.req.query('slippage');
  const slippagePct = slippage === undefined ? undefined : Number(slippage);
  if (slippagePct !== undefined && !(slippagePct >= 0.05 && slippagePct <= 3)) {
    return c.json({ error: 'invalid_slippage', detail: 'slippage is a percentage between 0.05 and 3.' }, 400);
  }
  // Not `.toUpperCase()`: tokenized equities are `NVDAc`, `TSLAc`, and uppercasing them
  // produced a symbol the registry has never heard of — every equity quote 502'd.
  const inSymbol = canonicalSymbol(c.req.query('in') ?? 'ETH');
  const outSymbol = canonicalSymbol(c.req.query('out') ?? 'USDC');
  const amount = Number(c.req.query('amount') ?? 1);
  const refusal = tradeRefusal(inSymbol, outSymbol, amount);
  if (refusal) return c.json(refusal, 400);
  /*
   * Inside a screen's patience (`http/patience.ts`). Nothing here had a deadline, and on the hosted fork one quote
   * answered after 97 seconds, long after the app had stopped waiting at 45 (docs/qa/ENDPOINTS.md E187); while it
   * waited, `/verify`'s eight-second price check ran out twice. A quote the aggregator has not given by `routeMs` is
   * `warming`: the app asks again, and the ask joins the request still on its way rather than starting another.
   */
  const patience = screenPatience();
  try {
    const [q, price] = await Promise.all([
      beforeDeadline(
        quote({ inSymbol, outSymbol, amount, slippagePct }),
        patience.routeMs,
        () => new StillFetching('the quote'),
      ),
      /*
       * What the route costs to send, and who pays it (PLAN.md 3.13): the gas price — 1inch's Gas Price API on Base,
       * the chain's own anywhere else — times 1inch's estimate for the route. The executor's delegate sends every
       * swap and order, so this is information rather than a charge: the user pays no gas for either. Null when it
       * cannot be read in time, never a zero. The price does not depend on the route, so it is read alongside it.
       */
      beforeDeadline(gasPrice(), patience.chainReadMs, () => new StillFetching('the gas price')).catch(() => null),
    ]);
    const gas = price && (await networkCost(q.estimatedGas, { price, priceMs: patience.priceMs }).catch(() => null));
    return c.json({ ...q, gas: gas && { ...gas, paidBy: 'executor' as const } });
  } catch (e) {
    // Late is not failed: the error handler answers it as `warming`, which the app waits out.
    if (e instanceof StillFetching) throw e;
    // No route is a real answer. The screen says so rather than showing a computed guess.
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/**
 * What every X Layer venue would give for the same trade: Uniswap v3's quote and, where this deployment is keyed for it,
 * OKX DEX's. `settle.ts` picks one and the trail names it; this says what the other would have done. A venue that could
 * not answer is listed with why — never left out, never given a number.
 *
 * A quote surface: it builds nothing submittable and touches no permission.
 */
extra.get('/route/compare', async (c) => {
  // Not `.toUpperCase()`: xStocks are `TSLAx`, and uppercasing them names a symbol the registry has never heard of.
  const inSymbol = canonicalSymbol(c.req.query('in') ?? 'USDC');
  const outSymbol = canonicalSymbol(c.req.query('out') ?? 'TSLAx');
  const amount = Number(c.req.query('amount') ?? 100);
  const refusal = tradeRefusal(inSymbol, outSymbol, amount);
  if (refusal) return c.json(refusal, 400);
  const inToken = VENUE_TOKENS[inSymbol]!;
  const outToken = VENUE_TOKENS[outSymbol]!;
  type VenueAnswer = { venue: string; outAmount: number | null; unavailable: string | null };
  const answers: VenueAnswer[] = await Promise.all([
    quote({ inSymbol, outSymbol, amount })
      .then((q): VenueAnswer => ({ venue: UNISWAP_VENUE_NAME, outAmount: q.outAmount, unavailable: null }))
      .catch((e: unknown): VenueAnswer => ({ venue: UNISWAP_VENUE_NAME, outAmount: null, unavailable: e instanceof Error ? e.message : String(e) })),
    okxConfigured()
      ? okxQuoteRaw(inSymbol, outSymbol, BigInt(Math.round(amount * 10 ** inToken.decimals)))
          .then((raw): VenueAnswer => ({ venue: OKX_VENUE_NAME, outAmount: Number(raw) / 10 ** outToken.decimals, unavailable: null }))
          .catch((e: unknown): VenueAnswer => ({ venue: OKX_VENUE_NAME, outAmount: null, unavailable: e instanceof Error ? e.message : String(e) }))
      : Promise.resolve<VenueAnswer>({ venue: OKX_VENUE_NAME, outAmount: null, unavailable: 'This deployment has no OKX DEX API key.' }),
  ]);
  const priced = answers.filter((a): a is VenueAnswer & { outAmount: number } => a.outAmount !== null && a.outAmount > 0);
  const best = priced.reduce<(VenueAnswer & { outAmount: number }) | null>((b, a) => (!b || a.outAmount > b.outAmount ? a : b), null);
  const runnerUp = priced.filter((a) => a !== best).reduce<number | null>((m, a) => (m === null || a.outAmount > m ? a.outAmount : m), null);
  return c.json({
    inSymbol,
    outSymbol,
    amount,
    venues: answers,
    best: best?.venue ?? null,
    // How much more the best venue delivers than the next, in basis points — null with fewer than two answers.
    edgeBps: best && runnerUp ? Math.round(((best.outAmount - runnerUp) / runnerUp) * 10_000) : null,
  });
});


/**
 * What a strategy WOULD have done, before you commit money to it.
 *
 * Agents had a backtest and strategies did not, which is backwards: an agent is a persona, and a
 * strategy is the thing that actually spends. For a grid it answers the question its own
 * description raises — the range holding is an assumption, and how often it held over the last
 * ninety days is a fact.
 */
/**
 * A backtest a person is waiting for, bounded — or an honest "not yet".
 *
 * `history()` fetches from CoinGecko through `http/get.ts`, which retries five times with
 * exponential backoff. That module's own docblock puts a slow host at "about twenty-five seconds",
 * and with a 15s timeout per attempt plus the outbound queue a COLD cache took over
 * **forty-five seconds** — measured right after a deploy, on `GET /agents/:id/backtest`, which is
 * the whole content of a screen.
 *
 * The retry ladder is right and stays: a scheduled run at 3am should wait patiently for a busy
 * upstream. A screen should not. So the bound is here, at the boundary where someone is watching,
 * and the answer when it is hit is the same "warming" 503 that `/market/ohlc` and `/perp/:symbol`
 * give — retryable, with a sentence, rather than a spinner that never resolves.
 */
const BACKTEST_BUDGET_MS = 12_000;

/**
 * How long the Bot tab may wait for the agent to reach a decision.
 *
 * Measured cold on the deployed executor: **22.8 seconds**, against 0.46s warm. That is the whole
 * content of a screen, and it is long enough that the browser gave up before the response arrived
 * and reported the result as a CORS failure — an error that says nothing true about the cause.
 *
 * This is the fourth route in this codebase with the same shape: a slow upstream reached from a
 * user-facing path with no budget. `/perp/:symbol` hung sixty seconds, `/yield/supply` answered a
 * bare 500, and the backtest made a screen wait forty-five.
 */
const PROPOSAL_BUDGET_MS = 10_000;

class TooSlow extends Error {}

/**
 * Answer within `budgetMs`, or hand back a `warming` 503 — and let the work finish regardless.
 *
 * The point is the `finally`: the promise is not abandoned, so the cache it was filling still gets
 * filled and the retry a few seconds later is fast. A budget that cancelled the work would make
 * every attempt equally slow.
 */
async function within<T>(work: Promise<T>, budgetMs = BACKTEST_BUDGET_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TooSlow()), budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // The fetch keeps going in the background, so the next caller finds a warm cache.
    void work.catch(() => undefined);
  }
}

/** The 503 a route gives when the thing it needs is still being fetched. */
function warming(
  c: Context,
  detail = 'The price history is still being fetched; try again in a moment.',
) {
  c.header('retry-after', '5');
  return c.json({ error: 'warming', detail }, 503);
}

/** The 404 for a symbol with no price history: the caller's to change, where a 502 would say to try again. */
function noHistory(c: Context, symbol: string) {
  return c.json(
    { error: 'no_history', detail: `There is no price history for ${symbol}, so there is nothing to replay.` },
    404,
  );
}

extra.post('/strategies/backtest', async (c) => {
  requireUser(c);
  const body = z
    .object({
      kind: z.enum(['dca', 'grid']),
      symbol: z.string().min(1),
      lookback: z.enum(LOOKBACKS).default('90d'),
      params: z.record(z.string(), z.unknown()).default({}),
    })
    .parse(await c.req.json());

  /*
   * A symbol with no history is refused before anything is fetched.
   *
   * Every throw below answered 502 `no_history` — the engine's "No price history for NOPE" included, which no retry can
   * change — so the backtest screen offered to try again. The test is the engine's own: history exists only for a
   * symbol with a feed id. 502 stays for a fetch that failed.
   */
  const symbol = canonicalSymbol(body.symbol);
  if (!COINGECKO_IDS[symbol]) return noHistory(c, symbol);

  const p = body.params as Record<string, number>;
  try {
    if (body.kind === 'grid') {
      const lower = Number(p.lower);
      const upper = Number(p.upper);
      const steps = Math.floor(Number(p.steps ?? 4));
      const usdPerStep = Number(p.usdPerStep);
      if (!(lower > 0) || !(upper > lower) || !(steps >= 1) || !(usdPerStep > 0)) {
        return c.json({ error: 'invalid_range', message: 'A range needs a bottom below its top, at least one rung, and a size.' }, 400);
      }
      return c.json(
        await within(backtestGrid({ symbol, lookback: body.lookback, lower, upper, steps, usdPerStep })),
      );
    }
    return c.json(
      await within(
        backtestDca({
          symbol,
          lookback: body.lookback,
          perRunUsd: Number(p.usd ?? 50),
          dailyCapUsd: Number(p.dailyCapUsd ?? Number.MAX_SAFE_INTEGER),
          everyNDays: Number(p.everyNDays ?? 7),
        }),
      ),
    );
  } catch (e) {
    if (e instanceof TooSlow) return warming(c);
    // No history means no backtest. Inventing one would be the worst possible failure here.
    return c.json({ error: 'no_history', message: e instanceof Error ? e.message : String(e) }, 502);
  }
});
