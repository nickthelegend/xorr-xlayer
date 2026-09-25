/**
 * An agent a person makes is a row of its own, held to the rules the four are (2026-09-16).
 *
 * The database and the wallet are stood in for; the decisions are the routes' own. A made agent takes its own persona id
 * and the persona it follows; its name is refused when one of the four or another agent on the wallet already has it,
 * whatever the case, or when a racing request took it first; a wallet makes at most twelve; the roster lists the four and
 * then the made ones with their own records; and a made agent is hired again by its own id and no other.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentKey } from '../evm/agentKey.js';

vi.mock('../auth/privy.js', () => ({
  UnauthorizedError: class extends Error {
    readonly status = 401;
  },
  verifyToken: vi.fn(),
}));
vi.mock('../db/index.js', () => ({ one: vi.fn(), query: vi.fn(), tx: vi.fn(), pool: {} }));
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
// Each agent's budget, as the chain would answer it (2026-09-25).
vi.mock('../evm/delegation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../evm/delegation.js')>()),
  readAgentBudget: vi.fn(async () => 25),
}));
vi.mock('../routes/wallet-context.js', () => ({
  currentWallet: vi.fn(),
  requireWallet: vi.fn(),
  NoWalletError: class extends Error {},
}));
vi.mock('./leaderboard.js', () => ({
  agentRecords: vi.fn(async () => new Map()),
  NO_TRADES: { pnl30d: 0, win: 0, trades: 0, metric: 'No trades yet' },
}));

const { one, query } = await import('../db/index.js');
const { append } = await import('../audit/log.js');
const { currentWallet } = await import('../routes/wallet-context.js');
const { agentRecords } = await import('./leaderboard.js');
const { agents, MAX_CUSTOM_AGENTS } = await import('./routes.js');
const { errorResponse } = await import('../http/errors.js');

const app = new Hono();
app.onError(errorResponse);
app.route('/', agents);

const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

const MADE = { name: 'Dip Buyer', role: 'Buys ETH on red days', style: 'momentum-scout' };

/** The row an INSERT … RETURNING * gives back, made from what was inserted. */
const inserted = (_text: string, params: unknown[] = []) => ({
  id: params[0],
  wallet_id: params[1],
  persona_id: params[2],
  name: params[3],
  role: params[4],
  style: params[5],
  tone: params[6],
  risk_limits: JSON.parse(String(params[7])),
  hired: true,
  created_at: new Date('2026-09-16T00:00:00Z'),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentWallet).mockResolvedValue({ id: 'wallet-1' } as never);
  vi.mocked(query).mockResolvedValue([]);
  vi.mocked(one).mockImplementation(async (text: string, params?: unknown[]) =>
    /SELECT address FROM wallets/.test(text)
      ? ({ address: '0x5c702B0E062850551E10F4827018e2670E9183d7' } as never)
      : (inserted(text, params) as never),
  );
});

describe('making an agent', () => {
  it('is a row of its own: its own persona id, its name and mandate, and the persona it follows', async () => {
    const res = await post('/agents/custom', { ...MADE, riskLimits: { maxUsdPerDay: 50 } });

    expect(res.status).toBe(201);
    const [sql, params] = vi.mocked(one).mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain('INSERT INTO agents');
    expect(params).toEqual([
      expect.any(String),
      'wallet-1',
      `custom:${params[0]}`,
      'Dip Buyer',
      'Buys ETH on red days',
      'momentum-scout',
      'dry',
      '{"maxUsdPerDay":50}',
    ]);
    expect(await res.json()).toMatchObject({
      personaId: `custom:${params[0]}`,
      name: 'Dip Buyer',
      role: 'Buys ETH on red days',
      custom: true,
      style: 'momentum-scout',
      hired: true,
      riskLimits: { maxUsdPerDay: 50 },
    });
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ walletId: 'wallet-1', action: 'Made Dip Buyer', kind: 'risk' }));
  });

  it("refuses a name one of the four has, or another agent on the wallet has, whatever the case", async () => {
    expect((await post('/agents/custom', { ...MADE, name: 'momentum SCOUT' })).status).toBe(409);
    vi.mocked(query).mockResolvedValue([{ name: 'Dip Buyer', persona_id: 'custom:abc' }]);
    const res = await post('/agents/custom', { ...MADE, name: 'DIP BUYER' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'name_taken' });
    expect(one).not.toHaveBeenCalled();
  });

  it('answers a name a racing request took first as taken, not as a failure', async () => {
    vi.mocked(one).mockRejectedValue(Object.assign(new Error('duplicate key value'), { code: '23505' }));

    const res = await post('/agents/custom', MADE);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'name_taken' });
  });

  it(`refuses an agent past the ${MAX_CUSTOM_AGENTS}th of the wallet's own`, async () => {
    vi.mocked(query).mockResolvedValue(
      Array.from({ length: MAX_CUSTOM_AGENTS }, (_, i) => ({ name: `Agent ${i}`, persona_id: `custom:${i}` })),
    );

    const res = await post('/agents/custom', MADE);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'too_many_agents' });
  });

  it('refuses a persona that is not one of the four, a name too short, and a limit nothing enforces', async () => {
    for (const body of [
      { ...MADE, style: 'custom:abc' },
      { ...MADE, name: 'X' },
      { ...MADE, riskLimits: { maxUsdPerWeek: 10 } },
      { ...MADE, extra: true },
    ]) {
      expect((await post('/agents/custom', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(one).not.toHaveBeenCalled();
  });

  it('makes nothing without a wallet', async () => {
    vi.mocked(currentWallet).mockResolvedValue(undefined);

    expect((await post('/agents/custom', MADE)).status).toBe(400);
    expect(one).not.toHaveBeenCalled();
  });
});

describe('the roster', () => {
  it('lists the four, then the agents this wallet made, each with its own record', async () => {
    vi.mocked(query).mockResolvedValue([
      { id: 'row-ed', wallet_id: 'wallet-1', persona_id: 'earnings-desk', name: 'Earnings Desk', hired: true, tone: 'dry', risk_limits: {}, role: null, style: null, created_at: new Date() },
      { id: 'row-db', wallet_id: 'wallet-1', persona_id: 'custom:row-db', name: 'Dip Buyer', hired: true, tone: 'dry', risk_limits: {}, role: 'Buys ETH on red days', style: 'momentum-scout', created_at: new Date() },
    ]);
    vi.mocked(agentRecords).mockResolvedValue(
      new Map([['custom:row-db', { pnl30d: 3.5, win: 100, trades: 1, metric: '100% win rate' }]]),
    );

    const rows = (await (await app.request('/agents')).json()) as { name: string; custom: boolean; trades: number }[];

    expect(rows.map((r) => r.name)).toEqual(['Momentum Scout', 'Earnings Desk', 'Yield Keeper', 'Drawdown Guard', 'Dip Buyer']);
    expect(rows[4]).toMatchObject({ custom: true, role: 'Buys ETH on red days', style: 'momentum-scout', trades: 1, metric: '100% win rate' });
    expect(rows.slice(0, 4).every((r) => r.custom === false)).toBe(true);

    // Each agent that exists on this wallet carries its on-chain key and the budget the chain holds for it; a persona
    // nobody hired has no row, so nothing to budget.
    const byName = new Map((rows as unknown as { name: string; onChainKey: string | null; budgetUsd: number | null }[]).map((r) => [r.name, r]));
    expect(byName.get('Earnings Desk')).toMatchObject({ onChainKey: agentKey('row-ed'), budgetUsd: 25 });
    expect(byName.get('Dip Buyer')).toMatchObject({ onChainKey: agentKey('row-db'), budgetUsd: 25 });
    expect(byName.get('Momentum Scout')).toMatchObject({ onChainKey: null, budgetUsd: null });
  });

  it('hires a made agent again by its own persona id, and reads another as missing', async () => {
    vi.mocked(one).mockResolvedValueOnce({
      id: 'row-db',
      wallet_id: 'wallet-1',
      persona_id: 'custom:row-db',
      name: 'Dip Buyer',
      hired: true,
      tone: 'dry',
      risk_limits: {},
      role: 'Buys ETH on red days',
      style: 'momentum-scout',
      created_at: new Date(),
    } as never);
    const hired = await post('/agents', { personaId: 'custom:row-db' });
    expect(hired.status).toBe(200);
    expect(vi.mocked(one).mock.calls[0]![1]).toEqual(['wallet-1', 'custom:row-db']);

    vi.mocked(one).mockResolvedValueOnce(undefined as never);
    expect((await post('/agents', { personaId: 'custom:someone-else' })).status).toBe(404);
  });
});
