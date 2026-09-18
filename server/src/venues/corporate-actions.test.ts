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

const QUERY = vi.hoisted(() => vi.fn(async (_sql: string, _params?: unknown[]) => [] as unknown[]));
vi.mock('../db/index.js', () => ({ query: QUERY }));

const AUDIT = vi.hoisted(() => ({
  append: vi.fn(async (_entry: { kind: string; walletId: string }) => ({}) as never),
}));
vi.mock('../audit/log.js', () => AUDIT);

const PUSH = vi.hoisted(() => ({ send: vi.fn(async () => ({ sent: 1, skipped: 0, errors: [] })) }));
vi.mock('../notifications/push.js', () => PUSH);

/*
 * The X Layer multiplier reader, replaced whole: what the token says (current + scheduled) and what
 * our own observation history holds are the two inputs, and each case sets them.
 */
const MULT = vi.hoisted(() => ({
  readMultiplier: vi.fn(),
  recentObservations: vi.fn(async (_mint: string, _limit?: number) => [] as unknown[]),
}));
vi.mock('./multiplier.js', () => MULT);

/** A reading as `readMultiplier` returns it, with an optional schedule. */
function reading(multiplier: number, pending?: { multiplier: number; effectiveAt: string }) {
  return {
    symbol: 'NVDAx',
    wrapper: '0xwrapper',
    raw: '0xraw',
    decimals: 18,
    multiplier,
    exact: String(multiplier),
    pending: pending
      ? { ...pending, exact: String(pending.multiplier), effectiveAtMs: Date.parse(pending.effectiveAt) }
      : null,
  };
}

const { pendingAction, observedAction, sweepCorporateActions, describeAction, NOTICE_WINDOW_MS } = await import(
  './corporate-actions.js'
);

const NOW = Date.parse('2026-09-17T00:00:00Z');
const inHours = (h: number) => new Date(NOW + h * 3600_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  QUERY.mockResolvedValue([]);
  MULT.readMultiplier.mockResolvedValue(reading(1));
  MULT.recentObservations.mockResolvedValue([]);
});

describe('reading what the token has scheduled', () => {
  it('finds a split scheduled inside the notice window', async () => {
    MULT.readMultiplier.mockResolvedValue(reading(1, { multiplier: 4, effectiveAt: inHours(24) }));

    const a = (await pendingAction('NVDAx', NOW))!;
    expect(a.factor).toBeCloseTo(4, 12);
    expect(a.reading).toBe('split');
    expect(a.effectiveAt).toBe(inHours(24));
  });

  it('reads a small step as a reinvested dividend, not a split', async () => {
    MULT.readMultiplier.mockResolvedValue(reading(1.0017, { multiplier: 1.0037, effectiveAt: inHours(12) }));

    const a = (await pendingAction('NVDAx', NOW))!;
    expect(a.reading).toBe('reinvested-dividend');
  });

  it('says nothing for an action too far out to be news', async () => {
    MULT.readMultiplier.mockResolvedValue(reading(1, { multiplier: 4, effectiveAt: new Date(NOW + NOTICE_WINDOW_MS + 3600_000).toISOString() }));
    expect(await pendingAction('NVDAx', NOW)).toBeNull();
  });

  it('says nothing once the action is already in force', async () => {
    MULT.readMultiplier.mockResolvedValue(reading(1, { multiplier: 4, effectiveAt: inHours(-1) }));
    expect(await pendingAction('NVDAx', NOW)).toBeNull();
  });

  it('says nothing — not all-clear — when the token cannot be read', async () => {
    MULT.readMultiplier.mockRejectedValue(new Error('RPC down'));
    // Null means "no announcement to pass on", and the sweep sends nothing. It is never rendered
    // as a claim that nothing is scheduled.
    expect(await pendingAction('NVDAx', NOW)).toBeNull();
  });

  it('says nothing when the token has no pending change', async () => {
    MULT.readMultiplier.mockResolvedValue(reading(1.0017));
    expect(await pendingAction('NVDAx', NOW)).toBeNull();
  });
});

describe('what a holder is told', () => {
  it('explains that a split changes the count, not the value', () => {
    const { title, body } = describeAction({
      symbol: 'NVDAx', mint: 'M', currentMultiplier: 1, newMultiplier: 4,
      factor: 4, effectiveAt: inHours(24), reading: 'split', source: 'scheduled',
    });
    expect(title).toMatch(/NVDAx split/);
    expect(body).toMatch(/worth the same either side/);
  });

  it('explains that a dividend grows the holding without new tokens', () => {
    const { body } = describeAction({
      symbol: 'NVDAx', mint: 'M', currentMultiplier: 1, newMultiplier: 1.002,
      factor: 1.002, effectiveAt: inHours(12), reading: 'reinvested-dividend', source: 'scheduled',
    });
    expect(body).toMatch(/reinvest a dividend/);
    expect(body).toMatch(/the tokens you own do not change/);
  });
});

describe('telling each holder once', () => {
  beforeEach(() => {
    MULT.readMultiplier.mockResolvedValue(reading(1, { multiplier: 4, effectiveAt: inHours(24) }));
  });

  it('notifies a holder whose claim was new', async () => {
    QUERY.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM positions')) return [{ wallet_id: 'w1' }];
      if (sql.includes('INSERT INTO corporate_action_notices')) return [{ id: '1' }];
      return [];
    });

    const out = await sweepCorporateActions(NOW);
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

    const out = await sweepCorporateActions(NOW);
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

    await sweepCorporateActions(NOW);
    // A notification that did not arrive must still leave a record.
    expect(AUDIT.append).toHaveBeenCalled();
  });

  it('files a dividend as yield and a split as risk', async () => {
    QUERY.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM positions')) return [{ wallet_id: 'w1' }];
      if (sql.includes('INSERT INTO corporate_action_notices')) return [{ id: '1' }];
      return [];
    });

    await sweepCorporateActions(NOW);
    expect(AUDIT.append.mock.calls[0]![0]).toMatchObject({ kind: 'risk' });

    vi.clearAllMocks();
    MULT.readMultiplier.mockResolvedValue(reading(1, { multiplier: 1.002, effectiveAt: inHours(24) }));
    QUERY.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM positions')) return [{ wallet_id: 'w1' }];
      if (sql.includes('INSERT INTO corporate_action_notices')) return [{ id: '1' }];
      return [];
    });
    await sweepCorporateActions(NOW);
    expect(AUDIT.append.mock.calls[0]![0]).toMatchObject({ kind: 'yield' });
  });

  it('tells nobody when no wallet holds the token', async () => {
    QUERY.mockResolvedValue([]);
    const out = await sweepCorporateActions(NOW);
    expect(PUSH.send).not.toHaveBeenCalled();
    expect(out.every((o) => o.walletsNotified.length === 0)).toBe(true);
  });
});

/*
 * An issuer can also apply a multiplier at once, with no schedule. Then our own observation history
 * is the only evidence, and it must be two real readings that differ — never one reading, never a
 * failed read, and never a change so old it is no longer news.
 */
describe('a change the observations show', () => {
  const obs = (multiplier: number, hoursAgo: number) => ({
    multiplier,
    effectiveAt: inHours(-hoursAgo),
    observedAt: inHours(-hoursAgo),
  });

  it('reads a split from the last two observations, dated when we first saw it', async () => {
    MULT.recentObservations.mockResolvedValue([obs(2, 1), obs(1, 200)]);
    const a = (await observedAction('NVDAx', NOW))!;
    expect(a).toMatchObject({ source: 'observed', reading: 'split', currentMultiplier: 1, newMultiplier: 2 });
    expect(a.factor).toBeCloseTo(2, 12);
    expect(a.effectiveAt).toBe(inHours(-1));
    expect(describeAction(a).body).toMatch(/seen on chain by/);
  });

  it('says nothing from a single observation — one value is not a change', async () => {
    MULT.recentObservations.mockResolvedValue([obs(2, 1)]);
    expect(await observedAction('NVDAx', NOW)).toBeNull();
  });

  it('says nothing once the change is older than the window', async () => {
    MULT.recentObservations.mockResolvedValue([obs(2, NOTICE_WINDOW_MS / 3600_000 + 1), obs(1, 500)]);
    expect(await observedAction('NVDAx', NOW)).toBeNull();
  });

  it('says nothing — not all-clear — when the history cannot be read', async () => {
    MULT.recentObservations.mockRejectedValue(new Error('db down'));
    expect(await observedAction('NVDAx', NOW)).toBeNull();
  });

  it('claims an observed change against any notice for the same multiplier nearby', async () => {
    MULT.recentObservations.mockImplementation(async (mint: string) =>
      mint === (await import('./xstocks.js')).XSTOCKS.NVDAx!.address ? [obs(1.002, 1), obs(1, 200)] : [],
    );
    QUERY.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM positions')) return [{ wallet_id: 'w1' }];
      if (sql.includes('INSERT INTO corporate_action_notices')) return [{ id: '1' }];
      return [];
    });

    const out = await sweepCorporateActions(NOW);
    const nvda = out.find((o) => o.action.symbol === 'NVDAx' && o.action.source === 'observed')!;
    expect(nvda.walletsNotified).toEqual(['w1']);
    const insert = QUERY.mock.calls.find(([sql]) => sql.includes('INSERT INTO corporate_action_notices'))!;
    // An action we announced ahead of time reappears in the observations once it applies.
    expect(insert[0]).toMatch(/NOT EXISTS/);
    expect(AUDIT.append.mock.calls[0]![0]).toMatchObject({ kind: 'yield' });
  });
});
