/**
 * Two properties, both about not crying wolf.
 *
 * A sweep runs every thirty seconds. If it sent one notification per sweep for as long as an
 * action was pending, a holder would turn notifications off and lose the ones that matter — so the
 * claim row is written before the push and each holder is told exactly once per action.
 *
 * And the chain announces a multiplier, not a label. Calling a dividend a split, or announcing an
 * all-clear from a mint we could not read, would both be claims nobody made.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

const QUERY = vi.hoisted(() => vi.fn(async (_sql: string, _params?: unknown[]) => [] as unknown[]));
vi.mock('../db/index.js', () => ({ query: QUERY }));

const AUDIT = vi.hoisted(() => ({
  append: vi.fn(async (_entry: { kind: string; walletId: string }) => ({}) as never),
}));
vi.mock('../audit/log.js', () => AUDIT);

const PUSH = vi.hoisted(() => ({ send: vi.fn(async () => ({ sent: 1, skipped: 0, errors: [] })) }));
vi.mock('../notifications/push.js', () => PUSH);

vi.mock('../solana/connection.js', () => ({ connection: {} }));

const SPL = vi.hoisted(() => ({ getMint: vi.fn() }));
vi.mock('@solana/spl-token', async (orig) => ({
  ...(await orig<typeof import('@solana/spl-token')>()),
  ...SPL,
}));

const SCALE = vi.hoisted(() => ({ readScaledUiConfig: vi.fn() }));
vi.mock('../solana/balances.js', async (orig) => ({
  ...(await orig<typeof import('../solana/balances.js')>()),
  ...SCALE,
}));

const { pendingAction, sweepCorporateActions, describeAction, NOTICE_WINDOW_MS } = await import(
  './corporate-actions.js'
);

const NOW = Date.parse('2026-09-17T00:00:00Z');
const inHours = (h: number) => new Date(NOW + h * 3600_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  QUERY.mockResolvedValue([]);
  SPL.getMint.mockResolvedValue({ decimals: 8, tlvData: Buffer.alloc(0) });
});

describe('reading what the mint has announced', () => {
  it('finds a split scheduled inside the notice window', async () => {
    SCALE.readScaledUiConfig.mockReturnValue({
      multiplier: 1,
      effectiveAt: inHours(-100),
      pending: { multiplier: 4, effectiveAt: inHours(24) },
    });

    const a = (await pendingAction('NVDAx', {} as never, NOW))!;
    expect(a.factor).toBeCloseTo(4, 12);
    expect(a.reading).toBe('split');
    expect(a.effectiveAt).toBe(inHours(24));
  });

  it('reads a small step as a reinvested dividend, not a split', async () => {
    SCALE.readScaledUiConfig.mockReturnValue({
      multiplier: 1.0017,
      effectiveAt: inHours(-100),
      pending: { multiplier: 1.0037, effectiveAt: inHours(12) },
    });

    const a = (await pendingAction('NVDAx', {} as never, NOW))!;
    expect(a.reading).toBe('reinvested-dividend');
  });

  it('says nothing for an action too far out to be news', async () => {
    SCALE.readScaledUiConfig.mockReturnValue({
      multiplier: 1,
      effectiveAt: inHours(-100),
      pending: { multiplier: 4, effectiveAt: new Date(NOW + NOTICE_WINDOW_MS + 3600_000).toISOString() },
    });
    expect(await pendingAction('NVDAx', {} as never, NOW)).toBeNull();
  });

  it('says nothing once the action is already in force', async () => {
    SCALE.readScaledUiConfig.mockReturnValue({
      multiplier: 1,
      effectiveAt: inHours(-100),
      pending: { multiplier: 4, effectiveAt: inHours(-1) },
    });
    expect(await pendingAction('NVDAx', {} as never, NOW)).toBeNull();
  });

  it('says nothing — not all-clear — when the mint cannot be read', async () => {
    SPL.getMint.mockRejectedValue(new Error('RPC down'));
    // Null means "no announcement to pass on", and the sweep sends nothing. It is never rendered
    // as a claim that nothing is scheduled.
    expect(await pendingAction('NVDAx', {} as never, NOW)).toBeNull();
  });

  it('says nothing when the mint has no pending change', async () => {
    SCALE.readScaledUiConfig.mockReturnValue({ multiplier: 1.0017, effectiveAt: inHours(-100) });
    expect(await pendingAction('NVDAx', {} as never, NOW)).toBeNull();
  });
});

describe('what a holder is told', () => {
  it('explains that a split changes the count, not the value', () => {
    const { title, body } = describeAction({
      symbol: 'NVDAx', mint: 'M', currentMultiplier: 1, newMultiplier: 4,
      factor: 4, effectiveAt: inHours(24), reading: 'split',
    });
    expect(title).toMatch(/NVDAx split/);
    expect(body).toMatch(/worth the same either side/);
  });

  it('explains that a dividend grows the holding without new tokens', () => {
    const { body } = describeAction({
      symbol: 'NVDAx', mint: 'M', currentMultiplier: 1, newMultiplier: 1.002,
      factor: 1.002, effectiveAt: inHours(12), reading: 'reinvested-dividend',
    });
    expect(body).toMatch(/reinvest a dividend/);
    expect(body).toMatch(/the tokens you own do not change/);
  });
});

describe('telling each holder once', () => {
  beforeEach(() => {
    SCALE.readScaledUiConfig.mockReturnValue({
      multiplier: 1,
      effectiveAt: inHours(-100),
      pending: { multiplier: 4, effectiveAt: inHours(24) },
    });
  });

  it('notifies a holder whose claim was new', async () => {
    QUERY.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM positions')) return [{ wallet_id: 'w1' }];
      if (sql.includes('INSERT INTO corporate_action_notices')) return [{ id: '1' }];
      return [];
    });

    const out = await sweepCorporateActions({} as never, NOW);
    const nvda = out.find((o) => o.action.symbol === 'NVDAx')!;
    expect(nvda.walletsNotified).toEqual(['w1']);
    expect(PUSH.send).toHaveBeenCalledTimes(out.length);
    expect(AUDIT.append).toHaveBeenCalled();
  });

  it('sends nothing to a holder already told about this exact action', async () => {
    QUERY.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM positions')) return [{ wallet_id: 'w1' }];
      // The unique key already holds a row: ON CONFLICT DO NOTHING returns none.
      if (sql.includes('INSERT INTO corporate_action_notices')) return [];
      return [];
    });

    const out = await sweepCorporateActions({} as never, NOW);
    expect(PUSH.send).not.toHaveBeenCalled();
    expect(out.find((o) => o.action.symbol === 'NVDAx')!.alreadyTold).toBe(1);
  });

  it('writes the audit entry even when the push fails', async () => {
    QUERY.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM positions')) return [{ wallet_id: 'w1' }];
      if (sql.includes('INSERT INTO corporate_action_notices')) return [{ id: '1' }];
      return [];
    });
    PUSH.send.mockRejectedValue(new Error('no devices'));

    await sweepCorporateActions({} as never, NOW);
    // A notification that did not arrive must still leave a record.
    expect(AUDIT.append).toHaveBeenCalled();
  });

  it('files a dividend as yield and a split as risk', async () => {
    QUERY.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM positions')) return [{ wallet_id: 'w1' }];
      if (sql.includes('INSERT INTO corporate_action_notices')) return [{ id: '1' }];
      return [];
    });

    await sweepCorporateActions({} as never, NOW);
    expect(AUDIT.append.mock.calls[0]![0]).toMatchObject({ kind: 'risk' });

    vi.clearAllMocks();
    SCALE.readScaledUiConfig.mockReturnValue({
      multiplier: 1,
      effectiveAt: inHours(-100),
      pending: { multiplier: 1.002, effectiveAt: inHours(24) },
    });
    QUERY.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM positions')) return [{ wallet_id: 'w1' }];
      if (sql.includes('INSERT INTO corporate_action_notices')) return [{ id: '1' }];
      return [];
    });
    await sweepCorporateActions({} as never, NOW);
    expect(AUDIT.append.mock.calls[0]![0]).toMatchObject({ kind: 'yield' });
  });

  it('tells nobody when no wallet holds the token', async () => {
    QUERY.mockResolvedValue([]);
    const out = await sweepCorporateActions({} as never, NOW);
    expect(PUSH.send).not.toHaveBeenCalled();
    expect(out.every((o) => o.walletsNotified.length === 0)).toBe(true);
  });
});
