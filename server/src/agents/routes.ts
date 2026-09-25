/**
 * Agents — hire, make, configure, fire.
 *
 * The roster was `Record<string, boolean>` in zustand: it survived a refresh and nothing else, so
 * the thing trading your money did not exist anywhere durable. These routes make an agent a row
 * that a reinstall cannot forget, that a strategy can belong to, and that can be measured against
 * its own filled trades rather than against a fixture.
 *
 * And, since 2026-09-16, an agent a person makes: `POST /agents/custom` — a name, a mandate in their own words, and the
 * one of the four personas it follows in voice and in the strategies it runs. It is a row like any other: strategies can
 * belong to it, its limits are enforced on every run, and its record is its own filled trades.
 *
 * Everything is scoped to the caller's wallet. An agent id from another user must read as missing,
 * never as forbidden — the second answer confirms it exists.
 */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { one, query } from '../db/index.js';
import { isAddressEqual, parseEventLogs, type Address, type Hex } from 'viem';
import { DELEGATION_ABI, DELEGATION_ADDRESS, readAgentBudget, waitForReceipt } from '../evm/delegation.js';
import { agentKey } from '../evm/agentKey.js';
import { append } from '../audit/log.js';
import { currentWallet } from '../routes/wallet-context.js';
import { PERSONAS, type PersonaId } from '../bot/personas.js';
import { NO_TRADES, agentRecords, type AgentRecord } from './leaderboard.js';
import { notifyKill } from '../notifications/alerts.js';
import { agentPreview } from '../bot/preview.js';
import { readBasket, validateTargets, type BasketRow } from '../bot/basket.js';
import {
  DEFAULT_RISK_PROFILE,
  RISK_BLURB,
  RISK_PROFILES,
  RISK_SETTINGS,
  isRiskProfile,
  settingsFor,
} from '../bot/risk-profile.js';

export const agents = new Hono();

type AgentRow = {
  id: string;
  wallet_id: string;
  persona_id: string;
  name: string;
  hired: boolean;
  tone: string;
  risk_limits: Record<string, unknown>;
  /** A made agent's mandate, in its maker's words (migration 027). Null on the four, whose mandate is their persona's. */
  role?: string | null;
  /** The persona a made agent follows. Null on the four. */
  style?: string | null;
  created_at: Date;
};

/** A made agent's persona id is its own, so the one-row-per-persona rule can never fold two made agents into one. */
const CUSTOM = 'custom:';
const isCustom = (personaId: string) => personaId.startsWith(CUSTOM);
const isPersona = (id: string) => Object.hasOwn(PERSONAS, id);

/** How many agents of its own one wallet may make. */
export const MAX_CUSTOM_AGENTS = 12;

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

/** The palette a persona is drawn with. Product config, not measured data — legitimately local. */
const GRADIENTS: Record<string, { c1: string; c2: string }> = {
  'momentum-scout': { c1: '#5B93FF', c2: '#1B44CE' },
  'earnings-desk': { c1: '#F0BE55', c2: '#C98518' },
  'yield-keeper': { c1: '#49E39B', c2: '#12A45F' },
  'drawdown-guard': { c1: '#B58CFF', c2: '#7A45E0' },
};

function toApi(row: AgentRow, record?: AgentRecord) {
  const custom = isCustom(row.persona_id);
  const persona = PERSONAS[(custom ? row.style : row.persona_id) as PersonaId];
  return {
    id: row.id,
    personaId: row.persona_id,
    name: row.name,
    role: row.role ?? persona?.role ?? '',
    hired: row.hired,
    tone: row.tone,
    riskLimits: row.risk_limits,
    custom,
    ...(custom && row.style ? { style: row.style } : {}),
    ...(GRADIENTS[row.persona_id] ?? { c1: '#5B93FF', c2: '#1B44CE' }),
    // Zeros with a label, never a borrowed number: an agent that has not traded says so.
    pnl30d: record?.pnl30d ?? 0,
    win: record?.win ?? 0,
    trades: record?.trades ?? 0,
    metric: record?.metric ?? 'No record yet',
  };
}

/**
 * GET /agents — the four personas, each marked hired or not, then the agents this wallet made, with real metrics.
 *
 * The full roster is returned rather than only what is hired, because the roster screen shows all
 * four and needs to know which are which. A made agent follows them, oldest first.
 */
agents.get('/agents', async (c) => {
  const id = await walletId(c);
  if (!id) {
    return c.json(
      Object.values(PERSONAS).map((p) =>
        toApi({
          id: p.id,
          wallet_id: '',
          persona_id: p.id,
          name: p.name,
          hired: false,
          tone: 'dry',
          risk_limits: {},
          created_at: new Date(),
        }),
      ),
    );
  }

  const [rows, records] = await Promise.all([
    query<AgentRow>(`SELECT * FROM agents WHERE wallet_id = $1 ORDER BY created_at, id`, [id]),
    agentRecords(id),
  ]);
  const byPersona = new Map(rows.map((r) => [r.persona_id, r]));

  /*
   * Each agent's own budget, read from the chain (2026-09-25) — the contract's figure, never a copy of it — and the key
   * the app signs `setAgentBudget` with. Only an agent that exists on this wallet has one: a persona nobody hired yet
   * has no row, so nothing to budget. A read that fails is null, which the screen says rather than showing $0.
   */
  const owner = (
    await one<{ address: string | null }>(`SELECT address FROM wallets WHERE id = $1`, [id])
  )?.address;
  const budgets = new Map<string, number | null>(
    await Promise.all(
      rows.map(async (r): Promise<[string, number | null]> => [
        r.id,
        owner ? await readAgentBudget(owner as Address, agentKey(r.id)).catch(() => null) : null,
      ]),
    ),
  );
  const onChain = (row: AgentRow | undefined) =>
    row
      ? { onChainKey: agentKey(row.id), budgetUsd: budgets.get(row.id) ?? null }
      : { onChainKey: null, budgetUsd: null };

  const personas = Object.values(PERSONAS).map((p) => {
    const row = byPersona.get(p.id);
    return {
      ...toApi(
        row ?? {
          id: p.id,
          wallet_id: id,
          persona_id: p.id,
          name: p.name,
          hired: false,
          tone: 'dry',
          risk_limits: {},
          created_at: new Date(),
        },
        records.get(p.id),
      ),
      ...onChain(row),
    };
  });
  const made = rows
    .filter((r) => isCustom(r.persona_id))
    .map((r) => ({ ...toApi(r, records.get(r.persona_id) ?? NO_TRADES), ...onChain(r) }));
  return c.json([...personas, ...made]);
});

const HireInput = z.object({
  personaId: z.string().refine((v) => isPersona(v) || isCustom(v), { message: 'unknown persona' }),
});

/**
 * Stop every agent on this wallet, now, until resumed — and read that state (PLAN.md 2.14).
 *
 * Enforced by the executor rather than remembered by one browser: every rule check reads it (`evaluate`'s
 * `killed`), so a scheduled run, a proposal and an order are all refused while it holds. It signs nothing
 * and costs nothing; the revoke on the Safety screen remains the stop that does not depend on this server
 * at all. A close the user places themselves is not an agent trading, and stays available.
 */
async function stoppedState(walletId: string): Promise<{ stopped: boolean; since: number | null }> {
  const row = await one<{ agents_stopped: boolean; agents_stopped_at: Date | null }>(
    `SELECT agents_stopped, agents_stopped_at FROM wallets WHERE id = $1`,
    [walletId],
  );
  return {
    stopped: row?.agents_stopped === true,
    since: row?.agents_stopped_at ? new Date(row.agents_stopped_at).getTime() : null,
  };
}

async function setStopped(c: Context, stopped: boolean) {
  const id = await walletId(c);
  if (!id) return c.json({ error: 'no_wallet' }, 400);
  const changed = await one<{ id: string }>(
    `UPDATE wallets SET agents_stopped = $2, agents_stopped_at = CASE WHEN $2 THEN now() ELSE NULL END
      WHERE id = $1 AND agents_stopped IS DISTINCT FROM $2 RETURNING id`,
    [id, stopped],
  );
  // Written once per change: a second tap on "stop" is not a second event.
  if (changed) {
    await append({
      walletId: id,
      agent: 'xorr',
      action: stopped ? 'You stopped the agents' : 'You resumed the agents',
      detail: stopped
        ? 'Nothing will be placed for you until you resume. Closing a position yourself still works.'
        : 'Strategies run on their schedules again, inside the same limits.',
      kind: 'risk',
    });
    if (stopped) {
      void notifyKill({
        walletId: id,
        reason: 'User activated agent kill switch.',
      }).catch(() => undefined);
    }
  }
  return c.json(await stoppedState(id));
}

/**
 * The target basket, and where it actually sits right now.
 *
 * The live weights are read on every request rather than cached: a drifted basket is the entire
 * point of the screen, and a cached weight is a claim about a portfolio as it was. A sleeve that
 * cannot be priced comes back as `usd: null` rather than zero, and the screen says so — counting
 * it as nothing would make every other sleeve look over-weight.
 */
agents.get('/agents/basket', async (c) => {
  const w = await currentWallet(c);
  if (!w) return c.json({ error: 'no_wallet' }, 400);

  const row = await one<BasketRow>(
    `SELECT wallet_id, targets, band_pct, cadence, enabled FROM agent_baskets WHERE wallet_id = $1`,
    [w.id],
  );

  if (!row || Object.keys(row.targets ?? {}).length === 0) {
    return c.json({ configured: false, targets: {}, bandPct: 5, cadence: 'daily', enabled: false });
  }

  const { sleeves, totalUsd, unpriced } = await readBasket(w.address, row.targets);
  return c.json({
    configured: true,
    targets: row.targets,
    bandPct: Number(row.band_pct),
    cadence: row.cadence,
    enabled: row.enabled,
    sleeves,
    totalUsd,
    unpriced,
  });
});

const BasketInput = z.object({
  targets: z.record(z.string(), z.number()),
  bandPct: z.number().min(0.5).max(50).optional(),
  cadence: z.enum(['daily', 'weekly', 'biweekly', 'monthly']).optional(),
  enabled: z.boolean().optional(),
});

/**
 * Set it.
 *
 * The weights are validated against the same rule the planner uses — real equities, positive, and
 * summing to 100 — because a basket the planner will refuse to act on is worse stored than
 * rejected: it looks configured and does nothing.
 */
agents.post('/agents/basket', async (c) => {
  const w = await currentWallet(c);
  if (!w) return c.json({ error: 'no_wallet' }, 400);

  const parsed = BasketInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'bad_basket', detail: 'Send targets as { SYMBOL: percent }.' }, 400);
  }
  const { targets, bandPct = 5, cadence = 'daily', enabled = true } = parsed.data;

  const problem = validateTargets(targets);
  if (problem) return c.json({ error: 'bad_targets', detail: problem }, 400);

  await query(
    `INSERT INTO agent_baskets (wallet_id, targets, band_pct, cadence, enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (wallet_id) DO UPDATE
        SET targets = $2, band_pct = $3, cadence = $4, enabled = $5, updated_at = now()`,
    [w.id, JSON.stringify(targets), bandPct, cadence, enabled],
  );

  /*
   * On the trail, because this is a standing instruction to trade.
   *
   * A basket is not a preference; it is a set of weights the executor will buy and sell to reach,
   * on its own, for as long as it is enabled. That belongs in the record beside the trades it
   * will produce.
   */
  await append({
    walletId: w.id,
    agent: 'Basket',
    action: enabled ? 'Basket targets set' : 'Basket paused',
    detail: `${Object.entries(targets).map(([s, p]) => `${p}% ${s}`).join(', ')}, rebalanced ${cadence} once a sleeve is ${bandPct}% out.`,
    kind: 'risk',
    payload: { targets, bandPct, cadence, enabled },
  }).catch(() => undefined);

  return c.json({ configured: true, targets, bandPct, cadence, enabled });
});

/** The rebalances that have run, including the ones that decided to do nothing. */
agents.get('/agents/basket/runs', async (c) => {
  const w = await currentWallet(c);
  if (!w) return c.json({ error: 'no_wallet' }, 400);

  const rows = await query<{
    id: string;
    period_key: string;
    status: string;
    symbol: string | null;
    side: string | null;
    usd: string | null;
    drift_pct: string | null;
    detail: string;
    signature: string | null;
    started_at: Date;
  }>(
    `SELECT id, period_key, status, symbol, side, usd, drift_pct, detail, signature, started_at
       FROM basket_runs WHERE wallet_id = $1 ORDER BY started_at DESC LIMIT 50`,
    [w.id],
  );

  return c.json(
    rows.map((r) => ({
      id: r.id,
      periodKey: r.period_key,
      status: r.status,
      symbol: r.symbol,
      side: r.side,
      usd: r.usd === null ? null : Number(r.usd),
      driftPct: r.drift_pct === null ? null : Number(r.drift_pct),
      detail: r.detail,
      signature: r.signature,
      at: new Date(r.started_at).toISOString(),
    })),
  );
});

/**
 * How much risk the agent may take, and what each choice actually changes.
 *
 * The options come back with the current setting, so the screen offering the choice does not carry
 * its own copy of the table. A second copy would drift from the agent the first time a threshold
 * moved, and the drift would show up as a screen confidently describing behaviour the agent no
 * longer has.
 */
agents.get('/agents/risk-profile', async (c) => {
  const w = await currentWallet(c);
  if (!w) return c.json({ error: 'no_wallet' }, 400);

  const row = await one<{ risk_profile: string | null }>(
    `SELECT risk_profile FROM wallets WHERE id = $1`,
    [w.id],
  );
  // A value this build does not know falls back, and the answer names what is actually in force.
  const active = isRiskProfile(row?.risk_profile) ? row.risk_profile : DEFAULT_RISK_PROFILE;

  return c.json({
    active,
    settings: settingsFor(active),
    options: RISK_PROFILES.map((p) => ({
      profile: p,
      blurb: RISK_BLURB[p],
      settings: RISK_SETTINGS[p],
    })),
  });
});

const RiskInput = z.object({ profile: z.enum(RISK_PROFILES) });

/**
 * Change it.
 *
 * Written to the trail, because this is a risk control. Turning an agent from conservative to
 * aggressive doubles its position size and halves the distance it keeps from a scheduled split —
 * that is a change to what the money is exposed to, and a change to what the money is exposed to
 * belongs in the audit log next to the trades it will produce.
 */
agents.post('/agents/risk-profile', async (c) => {
  const w = await currentWallet(c);
  if (!w) return c.json({ error: 'no_wallet' }, 400);

  const parsed = RiskInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { error: 'bad_profile', detail: `Pick one of: ${RISK_PROFILES.join(', ')}.` },
      400,
    );
  }
  const { profile } = parsed.data;

  const before = await one<{ risk_profile: string | null }>(
    `SELECT risk_profile FROM wallets WHERE id = $1`,
    [w.id],
  );
  const previous = isRiskProfile(before?.risk_profile) ? before.risk_profile : DEFAULT_RISK_PROFILE;

  await query(`UPDATE wallets SET risk_profile = $2 WHERE id = $1`, [w.id, profile]);

  // Only when it actually moved. A trail row per no-op tap is noise in the record that matters most.
  if (previous !== profile) {
    const s = settingsFor(profile);
    await append({
      walletId: w.id,
      agent: 'xorr',
      action: `Agent risk set to ${profile}`,
      detail: `Entries up to $${s.maxTradeUsd}, a breakout counted from the ${Math.round(s.momentumEntryAt * 100)}th percentile, ${s.corporateActionWindowHours} hours clear of any scheduled split or dividend, and ${s.cooldownMinutes} minutes between entries.`,
      kind: 'risk',
      payload: { previous, profile, settings: s },
    }).catch(() => undefined);
  }

  return c.json({ active: profile, settings: settingsFor(profile), previous });
});

/**
 * When the autonomous agent next looks, and what it will look at.
 *
 * `/agents/` plural, not `/agent/`. The singular prefix is the MACHINE surface — reached with an
 * agent key or not at all — so a user route registered there is dead between two correct refusals:
 * a Privy token is told it needs an agent key, and an agent key is told the route belongs to a
 * signed-in user. `agent-prefix.test.ts` guards that, and caught this one.
 *
 * Deliberately does not evaluate the setups. That would be a quote and a mint read per symbol on
 * every load, and the answer would be a prediction of what the agent is going to decide — which
 * this cannot know, because the sweep reads its conditions at tick time. Naming a winner here
 * would be wrong the moment a price moved, on the one panel whose job is setting expectations
 * accurately.
 */
agents.get('/agents/preview', async (c) => {
  const w = await currentWallet(c);
  if (!w) return c.json({ error: 'no_wallet' }, 400);
  return c.json(await agentPreview(w.id));
});

agents.get('/agents/stopped', async (c) => {
  const id = await walletId(c);
  if (!id) return c.json({ stopped: false, since: null });
  return c.json(await stoppedState(id));
});
agents.post('/agents/stop', (c) => setStopped(c, true));
agents.post('/agents/resume', (c) => setStopped(c, false));

/** POST /agents — hire. Idempotent: hiring twice is the same agent, not two of them. */
agents.post('/agents', async (c) => {
  const body = HireInput.parse(await c.req.json());
  const id = await walletId(c);
  if (!id) return c.json({ error: 'no_wallet' }, 400);

  if (isCustom(body.personaId)) {
    // An agent this wallet made, hired again after it was let go. Only its own: another wallet's reads as missing.
    const row = await one<AgentRow>(
      `UPDATE agents SET hired = true, fired_at = NULL WHERE wallet_id = $1 AND persona_id = $2 RETURNING *`,
      [id, body.personaId],
    );
    if (!row) return c.json({ error: 'not_found' }, 404);
    await append({
      walletId: id,
      agent: row.name,
      action: `Hired ${row.name}`,
      detail: `${row.role ?? 'An agent you made'}. It trades only inside the limits you already signed.`,
      kind: 'risk',
      payload: { personaId: row.persona_id },
    });
    return c.json(toApi(row));
  }

  const persona = PERSONAS[body.personaId as PersonaId]!;
  const row = await one<AgentRow>(
    `INSERT INTO agents (id, wallet_id, persona_id, name)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (wallet_id, persona_id)
       DO UPDATE SET hired = true, fired_at = NULL
     RETURNING *`,
    [randomUUID(), id, persona.id, persona.name],
  );

  await append({
    walletId: id,
    agent: persona.name,
    action: `Hired ${persona.name}`,
    detail: `${persona.role}. It trades only inside the limits you already signed.`,
    kind: 'risk',
    payload: { personaId: persona.id },
  });

  return c.json(toApi(row!));
});

/**
 * The limits an agent can be held to (PLAN.md 2.15), and nothing else.
 *
 * Any record was accepted and nothing read it, so a limit spelled any way at all was saved and silently
 * ignored. These two are enforced on every run (`agentLimitRefusal` in `executor/run.ts`); an unknown key is
 * refused rather than stored as a limit that does nothing.
 */
const RiskLimits = z
  .object({
    maxUsdPerTrade: z.number().positive().optional(),
    maxUsdPerDay: z.number().positive().optional(),
  })
  .strict();

const PatchInput = z.object({
  tone: z.enum(['dry', 'sharp', 'flat']).optional(),
  riskLimits: RiskLimits.optional(),
});

/** What a person gives an agent they make. The persona it follows is one of the four; everything else is theirs. */
const CreateInput = z
  .object({
    name: z.string().trim().min(2).max(24),
    role: z.string().trim().min(3).max(80),
    style: z.string().refine(isPersona, { message: 'one of the four agents' }),
    tone: z.enum(['dry', 'sharp', 'flat']).optional(),
    riskLimits: RiskLimits.optional(),
  })
  .strict();

/**
 * POST /agents/custom — make an agent (2026-09-16).
 *
 * A name no other agent on the wallet has, the four's included, because a name is how the roster, a conversation and
 * the trail tell agents apart; the index in migration 027 holds that against two requests racing. Made hired: making an
 * agent is choosing it.
 */
agents.post('/agents/custom', async (c) => {
  const body = CreateInput.parse(await c.req.json());
  const id = await walletId(c);
  if (!id) return c.json({ error: 'no_wallet' }, 400);

  const nameTaken = () =>
    c.json(
      { error: 'name_taken', message: `An agent is already called ${body.name}. Give this one another name.` },
      409,
    );
  const existing = await query<{ name: string; persona_id: string }>(
    `SELECT name, persona_id FROM agents WHERE wallet_id = $1`,
    [id],
  );
  const lower = body.name.toLowerCase();
  if (
    Object.values(PERSONAS).some((p) => p.name.toLowerCase() === lower) ||
    existing.some((a) => a.name.toLowerCase() === lower)
  ) {
    return nameTaken();
  }
  if (existing.filter((a) => isCustom(a.persona_id)).length >= MAX_CUSTOM_AGENTS) {
    return c.json(
      { error: 'too_many_agents', message: `This wallet already has ${MAX_CUSTOM_AGENTS} agents of its own.` },
      409,
    );
  }

  const agentId = randomUUID();
  let row: AgentRow | undefined;
  try {
    row = await one<AgentRow>(
      `INSERT INTO agents (id, wallet_id, persona_id, name, role, style, tone, risk_limits)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
      [
        agentId,
        id,
        `${CUSTOM}${agentId}`,
        body.name,
        body.role,
        body.style,
        body.tone ?? 'dry',
        JSON.stringify(body.riskLimits ?? {}),
      ],
    );
  } catch (e) {
    // The name index: another request made an agent with this name between the check above and this insert.
    if ((e as { code?: string }).code === '23505') return nameTaken();
    throw e;
  }

  const persona = PERSONAS[body.style as PersonaId]!;
  await append({
    walletId: id,
    agent: body.name,
    action: `Made ${body.name}`,
    detail: `${body.role}. Works like ${persona.name}, and trades only inside the limits you already signed.`,
    kind: 'risk',
    payload: { agentId, style: body.style },
  });

  return c.json(toApi(row!), 201);
});

/** PATCH /agents/:id — tone and limits. */
/**
 * An agent's budget, just set by its owner on chain, written into the trail (2026-09-25).
 *
 * The owner signs `setAgentBudget` with their own wallet; the executor could not set a budget if it tried. So this
 * records one and never makes one: the figure is the transaction's own `AgentBudgetSet` event, from the delegation
 * contract, for this wallet and this agent's key — not anything the app says it asked for.
 */
agents.post('/agents/:id/budget', async (c) => {
  const body = z
    .object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte transaction hash') })
    .parse(await c.req.json());
  const w = await currentWallet(c);
  if (!w?.address) return c.json({ error: 'no_wallet' }, 400);
  const row = await one<{ id: string; name: string }>(`SELECT id, name FROM agents WHERE id = $1 AND wallet_id = $2`, [
    c.req.param('id'),
    w.id,
  ]);
  if (!row) return c.json({ error: 'not_found', message: 'This wallet has no such agent.' }, 404);

  const receipt = await waitForReceipt(body.txHash as Hex).catch(() => undefined);
  if (!receipt) {
    return c.json({ error: 'tx_not_found', message: 'That transaction is not on this chain, so nothing was recorded.' }, 422);
  }
  if (receipt.status !== 'success') {
    return c.json({ error: 'tx_reverted', message: 'That transaction failed on chain, so it set no budget.' }, 422);
  }
  const key = agentKey(row.id);
  const set = parseEventLogs({ abi: DELEGATION_ABI, logs: receipt.logs, eventName: 'AgentBudgetSet' }).find(
    (l) =>
      isAddressEqual(l.address, DELEGATION_ADDRESS) &&
      isAddressEqual(l.args.owner, w.address as Address) &&
      l.args.agent === key,
  );
  if (!set) {
    return c.json({ error: 'not_a_budget', message: `That transaction did not set ${row.name}'s budget.` }, 422);
  }

  const budgetUsd = Number(set.args.budget) / 1e6;
  await append({
    walletId: w.id,
    agent: row.name,
    action: 'Budget set',
    detail:
      budgetUsd > 0
        ? `${row.name} may spend $${budgetUsd.toFixed(2)} from here, held by the contract. Its buys come out of it, and its sales go back in.`
        : `${row.name} has no budget now, so the contract will refuse any buy it tries. A sale of what it holds puts the proceeds back.`,
    kind: 'risk',
    signature: body.txHash,
    payload: { agentKey: key, budgetUsd },
  });
  return c.json({ budgetUsd, onChainKey: key });
});

agents.patch('/agents/:id', async (c) => {
  const body = PatchInput.parse(await c.req.json());
  const id = await walletId(c);
  if (!id) return c.json({ error: 'no_wallet' }, 400);

  const row = await one<AgentRow>(
    `UPDATE agents SET
       tone = COALESCE($3, tone),
       risk_limits = COALESCE($4::jsonb, risk_limits)
     WHERE id = $1 AND wallet_id = $2
     RETURNING *`,
    [
      c.req.param('id'),
      id,
      body.tone ?? null,
      body.riskLimits ? JSON.stringify(body.riskLimits) : null,
    ],
  );
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(toApi(row));
});

/**
 * DELETE /agents/:id — fire.
 *
 * Firing pauses the agent's strategies rather than deleting them. A user who fires an agent means
 * "stop trading", not "erase what you did" — the history has to survive, and a paused strategy can
 * be handed to another agent.
 */
agents.delete('/agents/:id', async (c) => {
  const id = await walletId(c);
  if (!id) return c.json({ error: 'no_wallet' }, 400);

  const row = await one<AgentRow>(
    `UPDATE agents SET hired = false, fired_at = now()
     WHERE id = $1 AND wallet_id = $2 RETURNING *`,
    [c.req.param('id'), id],
  );
  if (!row) return c.json({ error: 'not_found' }, 404);

  // Every chain's, deliberately: the agent is not per chain, and a fired agent must not keep trading
  // on a chain other than the one it was fired from.
  const paused = await query<{ id: string }>(
    `UPDATE strategies SET state = 'paused'
     WHERE agent_id = $1 AND state IN ('live','watch') RETURNING id`,
    [row.id],
  );

  await append({
    walletId: id,
    agent: row.name,
    action: `Fired ${row.name}`,
    detail:
      paused.length > 0
        ? `${paused.length} of its strategies were paused. Nothing was sold.`
        : 'It had nothing running.',
    kind: 'risk',
    payload: { agentId: row.id, pausedStrategies: paused.length },
  });

  return c.json({ ok: true, pausedStrategies: paused.length });
});
