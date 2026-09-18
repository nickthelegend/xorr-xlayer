/**
 * The strategy routes over HTTP (docs/qa/ENDPOINTS.md E169, E171, E173), with the database, the chain and the executor
 * stood in for.
 */
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/index.js', () => ({ one: vi.fn(), query: vi.fn() }));
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
vi.mock('../auth/privy.js', () => ({
  UnauthorizedError: class extends Error {
    readonly status = 401;
  },
  verifyToken: vi.fn(),
}));
vi.mock('../executor/run.js', () => ({
  runStrategy: vi.fn(),
  CLOSE_ONLY_KINDS: new Set(['exit-rules']),
  EXECUTABLE_KINDS: new Set(['dca', 'momentum', 'exit-rules', 'rebalance', 'yield-rotation']),
  SELF_SIZING_KINDS: new Set(['exit-rules', 'rebalance']),
}));
vi.mock('../evm/delegation.js', () => ({ readPolicy: vi.fn() }));
vi.mock('../executor/order.js', () => ({ placeOrder: vi.fn() }));
vi.mock('../executor/swap.js', () => ({ placeSwap: vi.fn() }));
vi.mock('./wallet-context.js', () => ({
  currentWallet: vi.fn(),
  requireWallet: vi.fn(),
  NoWalletError: class extends Error {},
}));
vi.mock('../venues/stocks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../venues/stocks.js')>()),
  equitiesFunctional: vi.fn(async () => true),
}));

const { one, query } = await import('../db/index.js');
const { append } = await import('../audit/log.js');
const { currentWallet, requireWallet } = await import('./wallet-context.js');
const { readPolicy } = await import('../evm/delegation.js');
const { strategyRoutes } = await import('./strategies.js');
const { errorResponse } = await import('../http/errors.js');

const app = new Hono();
app.onError(errorResponse);
app.route('/', strategyRoutes);

const WALLET = { id: 'wallet-1', address: '0x95A0b368588713011a15f4b1041423f31B08e615' };
const CREATED = new Date('2026-09-13T20:40:17.211Z');

/** A strategy row as Postgres returns one. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 's-1',
  wallet_id: 'wallet-1',
  kind: 'dca',
  state: 'live',
  label: 'Weekly WETH',
  symbol: 'WETH',
  params: { usd: 10 },
  cadence: 'weekly',
  next_run_at: null,
  daily_allocation_usd: '10',
  created_at: CREATED,
  ...over,
});

async function call(path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await app.request(
    path,
    body === undefined
      ? undefined
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentWallet).mockResolvedValue(WALLET as never);
  vi.mocked(query).mockResolvedValue([]);
});

describe('GET /strategies (E171)', () => {
  it('says when each strategy was created, and gives an ended one no next run', async () => {
    const next = new Date('2026-09-20T09:00:00.000Z');
    vi.mocked(query).mockResolvedValue([
      row({ id: 's-live', next_run_at: next }),
      row({ id: 's-ended', state: 'ended', next_run_at: new Date('2026-09-12T17:58:21.980Z') }),
    ] as never);

    const first = await call('/strategies');
    expect(first.status).toBe(200);
    const [live, ended] = first.body as Record<string, unknown>[];
    expect(live).toMatchObject({ id: 's-live', nextRunAt: next.getTime(), createdAt: CREATED.getTime() });
    expect(ended).toMatchObject({ id: 's-ended', state: 'ended', createdAt: CREATED.getTime() });
    expect(ended).not.toHaveProperty('nextRunAt');

    // The same row read later was still created when it was created.
    expect((await call('/strategies')).body).toEqual(first.body);
  });

  it('is backed by a migration that clears the next run of every ended strategy, and touches nothing else', () => {
    const sql = readFileSync(new URL('../db/migrations/024-ended-strategies-have-no-next-run.sql', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('--') && line.trim())
      .join(' ');
    expect(sql).toBe("UPDATE strategies SET next_run_at = NULL WHERE state = 'ended' AND next_run_at IS NOT NULL;");
  });
});

describe('POST /strategies (E173)', () => {
  it('stores the symbol under the registry spelling, as the handler says it does', async () => {
    vi.mocked(requireWallet).mockResolvedValue(WALLET as never);
    vi.mocked(readPolicy).mockResolvedValue({
      delegate: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5',
      dailyCapUsd: 2_810,
      expiresAt: Date.now() + 86_400_000,
      revoked: false,
      remainingTodayUsd: 2_810,
      spentTodayUsd: 0,
    });
    vi.mocked(query).mockResolvedValue([{ sum: '0' }] as never);
    vi.mocked(one).mockImplementation((async (text: string, params: unknown[] = []) =>
      /INSERT INTO strategies/.test(text)
        ? row({ id: params[0], kind: params[2], state: params[3], label: params[4], symbol: params[5], cadence: params[7], next_run_at: params[8] })
        : undefined) as never);

    const r = await call('/strategies', {
      kind: 'dca',
      state: 'draft',
      label: 'qa draft',
      symbol: 'weth',
      params: { usd: 1 },
      cadence: 'weekly',
      dailyAllocationUsd: 1,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const insert = vi.mocked(one).mock.calls.find(([text]) => /INSERT INTO strategies/.test(String(text)))!;
    expect(insert[1]![5]).toBe('WETH');
    expect(r.body).toMatchObject({ symbol: 'WETH', state: 'draft' });
  });
});

describe('GET /runs', () => {
  it('refuses a limit that is not a number, by name and before reading anything', async () => {
    const r = await call('/runs?limit=abc');
    expect(r).toMatchObject({ status: 400, body: { error: 'bad_limit', detail: expect.stringContaining('200') } });
    expect(query).not.toHaveBeenCalled();
  });

  it('holds the limit to a whole number of runs from 1 to 200', async () => {
    for (const [path, limit] of [
      ['/runs', 100],
      ['/runs?limit=1.5', 1],
      ['/runs?limit=0', 1],
      ['/runs?limit=5000', 200],
    ] as const) {
      vi.mocked(query).mockClear();
      expect((await call(path)).status, path).toBe(200);
      expect(vi.mocked(query).mock.calls[0]![1], path).toEqual(['wallet-1', limit]);
    }
  });
});

/**
 * Pausing one strategy is not the kill switch.
 *
 * The kill switch revokes the delegation on chain and stops everything. This stops one row from
 * being selected by the scheduler, which reads only `live` and `watch`; the permission is untouched
 * and every other strategy goes on running. Two behaviours below used to make a pause quietly cost
 * money on the way back out.
 */
describe('POST /strategies/:id/pause and /resume', () => {
  /** Answers `one` with `current` for the SELECT and with the UPDATE's own parameters for the write. */
  function onRow(current: Record<string, unknown>) {
    vi.mocked(requireWallet).mockResolvedValue(WALLET as never);
    vi.mocked(one).mockImplementation((async (text: string, params: unknown[] = []) => {
      if (/UPDATE strategies/.test(text)) {
        return row({ ...current, state: params[2], paused_from: params[4], next_run_at: params[3] });
      }
      return row(current);
    }) as never);
  }

  const updateFor = () =>
    vi.mocked(one).mock.calls.find(([text]) => /UPDATE strategies/.test(String(text)))!;

  it('records which state the pause was taken out of', async () => {
    onRow({ state: 'watch', next_run_at: new Date('2126-01-01T09:00:00Z') });

    const r = await call('/strategies/s-1/pause', {});

    expect(r.status).toBe(200);
    // Written on the way in so the resume has something to read on the way out.
    expect(updateFor()[1]![4]).toBe('watch');
    expect(r.body).toMatchObject({ state: 'paused' });
  });

  it('resumes a watching strategy to watching, not to live', async () => {
    /*
     * `watch` exists to record what a strategy WOULD do and move nothing. Resuming it into `live`
     * handed it the ability to spend — nobody asked for that, and the row reads identically in the
     * list either way.
     */
    onRow({ state: 'paused', paused_from: 'watch', next_run_at: new Date('2126-01-01T09:00:00Z') });

    const r = await call('/strategies/s-1/resume', {});

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'watch' });
  });

  it('resumes a live one to live', async () => {
    onRow({ state: 'paused', paused_from: 'live', next_run_at: new Date('2126-01-01T09:00:00Z') });
    expect((await call('/strategies/s-1/resume', {})).body).toMatchObject({ state: 'live' });
  });

  it('resumes a row paused before the column existed to live', async () => {
    // Quietly demoting someone's live strategy to watch would be its own surprise.
    onRow({ state: 'paused', paused_from: null, next_run_at: new Date('2126-01-01T09:00:00Z') });
    expect((await call('/strategies/s-1/resume', {})).body).toMatchObject({ state: 'live' });
  });

  it('clears the record on the way out', async () => {
    onRow({ state: 'paused', paused_from: 'watch', next_run_at: new Date('2126-01-01T09:00:00Z') });
    await call('/strategies/s-1/resume', {});
    // The CASE in the UPDATE nulls it for any destination that is not `paused`.
    expect(String(updateFor()[0])).toMatch(/paused_from = CASE WHEN .* THEN .* ELSE NULL END/s);
  });

  it('does not let a resume spend immediately when the schedule is overdue', async () => {
    /*
     * `next_run_at` stays put while a strategy is paused, so a daily buy paused on Monday and
     * resumed on Friday is four days overdue: the next tick selects it, `periodKey` buckets it
     * under Friday rather than the Monday it was due, and a real buy settles seconds after a tap
     * that said "resume".
     */
    onRow({
      state: 'paused',
      paused_from: 'live',
      cadence: 'daily',
      next_run_at: new Date('2020-01-01T09:00:00Z'),
    });

    await call('/strategies/s-1/resume', {});

    const written = updateFor()[1]![3] as Date;
    expect(written.getTime()).toBeGreaterThan(Date.now());
  });

  it('leaves a due time the user set, when it is still ahead', async () => {
    const ahead = new Date('2126-01-01T09:00:00Z');
    onRow({ state: 'paused', paused_from: 'live', cadence: 'daily', next_run_at: ahead });

    await call('/strategies/s-1/resume', {});

    expect((updateFor()[1]![3] as Date).getTime()).toBe(ahead.getTime());
  });

  it('says on the trail that a pause is not the kill switch', async () => {
    onRow({ state: 'live', next_run_at: new Date('2126-01-01T09:00:00Z') });

    await call('/strategies/s-1/pause', {});

    const entry = vi.mocked(append).mock.calls.at(-1)![0] as { action: string; detail: string };
    expect(entry.action).toMatch(/^Paused /);
    // Someone reading this later must not be left thinking they had already pulled the kill switch.
    expect(entry.detail).toMatch(/permission is still live/i);
    expect(entry.detail).toMatch(/one strategy, not the bot/i);
  });

  it('says on the trail when a resume moved the schedule', async () => {
    onRow({
      state: 'paused',
      paused_from: 'live',
      cadence: 'daily',
      next_run_at: new Date('2020-01-01T09:00:00Z'),
    });

    await call('/strategies/s-1/resume', {});

    // A silent change to when someone's money moves reads as a bug the first time it surprises them.
    const entry = vi.mocked(append).mock.calls.at(-1)![0] as {
      detail: string;
      payload: Record<string, unknown>;
    };
    expect(entry.detail).toMatch(/moves to the next one rather than buying now/i);
    expect(entry.payload.nextRunMovedTo).toEqual(expect.any(String));
  });

  it('says nothing about the schedule when it did not move', async () => {
    onRow({
      state: 'paused',
      paused_from: 'live',
      cadence: 'daily',
      next_run_at: new Date('2126-01-01T09:00:00Z'),
    });

    await call('/strategies/s-1/resume', {});

    const entry = vi.mocked(append).mock.calls.at(-1)![0] as {
      detail: string;
      payload: Record<string, unknown>;
    };
    expect(entry.detail).not.toMatch(/overdue/i);
    expect(entry.payload).not.toHaveProperty('nextRunMovedTo');
  });

  it('answers another account’s strategy id exactly like a missing one', async () => {
    vi.mocked(requireWallet).mockResolvedValue(WALLET as never);
    vi.mocked(one).mockResolvedValue(undefined as never);

    // A permission error would confirm the row exists.
    expect(await call('/strategies/someone-elses/resume', {})).toMatchObject({
      status: 404,
      body: { error: 'not_found' },
    });
  });

  it('is backed by a migration that adds the column and backfills nothing', () => {
    const sql = readFileSync(new URL('../db/migrations/031-strategy-paused-from.sql', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('--') && line.trim())
      .join(' ');
    // Rows paused by firing an agent were all live, so the honest backfill is exactly the default.
    expect(sql).toBe('ALTER TABLE strategies ADD COLUMN IF NOT EXISTS paused_from TEXT;');
  });
});
