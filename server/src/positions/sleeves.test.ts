import { describe, expect, it, vi, beforeEach } from 'vitest';

const queryMock = vi.fn<(sql: string, p?: unknown[]) => Promise<unknown[]>>();
const clientQuery = vi.fn<(sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>>(
  async () => ({ rows: [] }),
);

vi.mock('../db/index.js', () => ({ query: (sql: string, p?: unknown[]) => queryMock(sql, p) }));
vi.mock('../db/chain-scope.js', () => ({ THIS_CHAIN: `'solana-fork'` }));

const { recordSleeve, sleeveOf, sleevesFor } = await import('./sleeves.js');

const client = { query: clientQuery } as unknown as Parameters<typeof recordSleeve>[0];

const row = (over: Record<string, unknown> = {}) => ({
  source: 'strategy',
  source_id: 's1',
  source_label: 'Recurring buy',
  units: '4',
  cost_usd: '800',
  opened_at: new Date('2026-09-10T00:00:00Z'),
  ...over,
});

/** `sleevesFor` asks for the sleeves first and the position second. */
const answers = (sleeveRows: unknown[], heldUnits: string | null) =>
  queryMock.mockImplementation(async (sql: string) =>
    sql.includes('position_sleeves') ? sleeveRows : heldUnits === null ? [] : [{ units: heldUnits }],
  );

describe('recordSleeve', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds to the source own sleeve rather than creating a second one', async () => {
    await recordSleeve(client, {
      walletId: 'w1',
      symbol: 'NVDAc',
      units: 2,
      usd: 400,
      attribution: { source: 'strategy', id: 's1', label: 'Recurring buy' },
    });

    const [sql, params] = clientQuery.mock.calls[0] ?? [];
    expect(String(sql)).toContain('ON CONFLICT');
    expect(String(sql)).toContain('position_sleeves.units + EXCLUDED.units');
    expect(params).toEqual([
      expect.any(String),
      'w1',
      'NVDAc',
      'strategy',
      's1',
      'Recurring buy',
      2,
      400,
    ]);
  });

  /*
   * A source cannot have contributed less than nothing. `planExitRules` closes the WHOLE position,
   * so a strategy routinely sells more than it ever bought — the shortfall belongs in the
   * breakdown, not encoded as a negative sleeve nobody can read.
   */
  it('floors a sleeve at zero rather than letting it go negative', async () => {
    await recordSleeve(client, {
      walletId: 'w1',
      symbol: 'NVDAc',
      units: -99,
      usd: -99,
      attribution: { source: 'strategy', id: 's1', label: 'Exit' },
    });

    const [sql] = clientQuery.mock.calls[0] ?? [];
    expect(String(sql)).toContain('GREATEST(0, position_sleeves.units + EXCLUDED.units)');
    expect(String(sql)).toContain('GREATEST(0, position_sleeves.cost_usd + EXCLUDED.cost_usd)');
  });

  /* NULL is not equal to NULL in a unique index, so two manual fills would otherwise make two rows. */
  it('keys a source with no id of its own on the empty string', async () => {
    await recordSleeve(client, {
      walletId: 'w1',
      symbol: 'NVDAc',
      units: 1,
      usd: 100,
      attribution: { source: 'manual', id: null, label: 'Swap' },
    });

    const [sql, params] = clientQuery.mock.calls[0] ?? [];
    expect(String(sql)).toContain("coalesce(source_id, '')");
    expect((params as unknown[])[4]).toBeNull();
  });

  /* Renaming or deleting a strategy must not rewrite the attribution of a fill that happened. */
  it('refreshes the stored label rather than joining for it', async () => {
    await recordSleeve(client, {
      walletId: 'w1',
      symbol: 'NVDAc',
      units: 1,
      usd: 100,
      attribution: { source: 'strategy', id: 's1', label: 'Renamed' },
    });
    expect(String(clientQuery.mock.calls[0]?.[0])).toContain('source_label = EXCLUDED.source_label');
  });
});

describe('sleevesFor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports each source share and what they add up to', async () => {
    answers([row(), row({ source: 'agent', source_id: 'p1', source_label: 'Momentum Scout', units: '2', cost_usd: '420' })], '6');

    const out = await sleevesFor('w1', 'NVDAc');
    expect(out.sleeves).toHaveLength(2);
    expect(out.attributedUnits).toBe(6);
    expect(out.heldUnits).toBe(6);
    expect(out.unattributedUnits).toBe(0);
    expect(out.overAttributedUnits).toBe(0);
  });

  /*
   * Real and common: a wallet funded outside the app, or a position older than this ledger. Shown
   * as its own line rather than divided among the sleeves, because dividing it would be a guess
   * presented as a record.
   */
  it('reports units nobody claims instead of sharing them out', async () => {
    answers([row({ units: '4' })], '10');

    const out = await sleevesFor('w1', 'NVDAc');
    expect(out.attributedUnits).toBe(4);
    expect(out.unattributedUnits).toBe(6);
    // The sleeve keeps what it actually contributed — it is not inflated to cover the gap.
    expect(out.sleeves[0]?.units).toBe(4);
  });

  /* What an outside transfer OUT looks like from in here. Surfaced, not clamped away. */
  it('reports sources claiming more than the book holds', async () => {
    answers([row({ units: '10' })], '4');

    const out = await sleevesFor('w1', 'NVDAc');
    expect(out.overAttributedUnits).toBe(6);
    expect(out.unattributedUnits).toBe(0);
  });

  it('reads a symbol with no position at all as holding nothing', async () => {
    answers([], null);

    const out = await sleevesFor('w1', 'NVDAc');
    expect(out).toMatchObject({ heldUnits: 0, attributedUnits: 0, unattributedUnits: 0, overAttributedUnits: 0 });
    expect(out.sleeves).toEqual([]);
  });

  it('leaves dust sleeves out of the list', async () => {
    await sleevesFor('w1', 'NVDAc');
    const [sql] = queryMock.mock.calls.find(([s]) => s.includes('position_sleeves')) ?? [];
    expect(String(sql)).toContain('units > 0.000001');
  });

  it('survives a read that fails rather than taking the screen down with it', async () => {
    queryMock.mockRejectedValue(new Error('db down'));
    const out = await sleevesFor('w1', 'NVDAc');
    expect(out.sleeves).toEqual([]);
    expect(out.heldUnits).toBe(0);
  });
});

describe('sleeveOf', () => {
  beforeEach(() => vi.clearAllMocks());

  it('picks out one source own sleeve', async () => {
    answers([row(), row({ source: 'agent', source_id: 'p1', source_label: 'Momentum Scout', units: '2' })], '6');

    expect((await sleeveOf('w1', 'NVDAc', 'strategy', 's1'))?.label).toBe('Recurring buy');
    expect((await sleeveOf('w1', 'NVDAc', 'agent', 'p1'))?.units).toBe(2);
  });

  it('is null when that source has none', async () => {
    answers([row()], '4');
    expect(await sleeveOf('w1', 'NVDAc', 'basket', null)).toBeNull();
  });

  /* A source with no id must not match one that has an id, and the reverse. */
  it('does not confuse a null id with a present one', async () => {
    answers([row({ source: 'manual', source_id: null, source_label: 'Swap' })], '4');
    expect(await sleeveOf('w1', 'NVDAc', 'manual', null)).not.toBeNull();
    expect(await sleeveOf('w1', 'NVDAc', 'manual', 's1')).toBeNull();
  });
});
