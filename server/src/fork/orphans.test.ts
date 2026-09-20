/**
 * Taking a rebuilt fork's orphaned fills back out of the book (docs/qa/ENDPOINTS.md E096), with the database and the
 * node stood in for.
 *
 * Each case writes the rows a recorder writes — a strategy's buy, a limit fill, a close, a swap — and checks that what
 * comes out is exactly what went in, and that whatever cannot come out exactly is left alone, with its reason.
 */
import { readFileSync } from 'node:fs';
import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
vi.mock('../db/index.js', () => ({ query: vi.fn(), one: vi.fn(), tx: vi.fn(), pool: {} }));

const { append } = await import('../audit/log.js');
const { applyReconciliation, isOnChain, planReconciliation, reconcile, RECONCILED_ERROR } = await import('./orphans.js');
const { assertXLayerFork } = await import('./guard.js');
type RecordedFill = import('./orphans.js').RecordedFill;
type DisposalRow = import('./orphans.js').DisposalRow;

const WALLET = 'wallet-1';
const DAY = '2026-09-13';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const fill = (over: Partial<RecordedFill> & { runId: string }): RecordedFill => ({
  walletId: WALLET,
  kind: 'dca',
  symbol: 'WETH',
  side: 'buy',
  units: 0.002,
  usd: 5,
  signature: hash(1),
  day: DAY,
  ...over,
});
const disposal = (over: Partial<DisposalRow> & { id: string; runId: string }): DisposalRow => ({
  symbol: 'WETH',
  units: 0.5,
  proceedsUsd: 1_240.5,
  costUsd: 1_000,
  realisedUsd: 240.5,
  basisKnown: true,
  ...over,
});
const WETH = { id: 'pos-weth', walletId: WALLET, symbol: 'WETH' };
const CBBTC = { id: 'pos-cbbtc', walletId: WALLET, symbol: 'CBBTC' };

beforeEach(() => {
  vi.mocked(append).mockClear();
});

describe('whether the node has a transaction', () => {
  const H = hash(7);
  const notMined = async () => {
    throw new TransactionReceiptNotFoundError({ hash: H });
  };

  it('is yes for a receipt, yes for a transaction still pending, and no only when the node has neither', async () => {
    const mined = { getTransactionReceipt: vi.fn(async () => ({ status: 'success' })), getTransaction: vi.fn() };
    expect(await isOnChain(H, mined)).toBe(true);
    expect(mined.getTransaction).not.toHaveBeenCalled();

    expect(await isOnChain(H, { getTransactionReceipt: notMined, getTransaction: async () => ({ hash: H }) })).toBe(true);
    expect(
      await isOnChain(H, {
        getTransactionReceipt: notMined,
        getTransaction: async () => {
          throw new TransactionNotFoundError({ hash: H });
        },
      }),
    ).toBe(false);
  });

  it('throws when the node could not be asked, rather than calling the transaction missing', async () => {
    const down = {
      getTransactionReceipt: async () => {
        throw new Error('fetch failed');
      },
      getTransaction: vi.fn(),
    };
    await expect(isOnChain(H, down)).rejects.toThrow('fetch failed');
    expect(down.getTransaction).not.toHaveBeenCalled();
  });
});

describe('the chain it will touch', () => {
  const env = { XORR_CHAIN: 'xlayer-fork', FORK_RPC: 'http://127.0.0.1:8555', DATABASE_URL: 'postgres://localhost/xorr_fork' };
  const node = (client: string, chainId: string) => async (method: string) => (method === 'web3_clientVersion' ? client : chainId);

  it('is an anvil fork of X Layer mainnet, with the node and the database named on purpose — and nothing else', async () => {
    await expect(assertXLayerFork(env, node('anvil/v1.3.1', '0xc4'))).resolves.toBeUndefined();
    await expect(assertXLayerFork({ ...env, XORR_CHAIN: 'xlayer-testnet' }, node('anvil', '0xc4'))).rejects.toThrow('xlayer-fork');
    await expect(assertXLayerFork({ ...env, XORR_CHAIN: 'xlayer' }, node('anvil', '0xc4'))).rejects.toThrow('xlayer-fork');
    await expect(assertXLayerFork({ ...env, FORK_RPC: '' }, node('anvil', '0xc4'))).rejects.toThrow('FORK_RPC');
    await expect(assertXLayerFork({ ...env, DATABASE_URL: '' }, node('anvil', '0xc4'))).rejects.toThrow('DATABASE_URL');
    await expect(assertXLayerFork(env, node('Geth/v1.14.0', '0xc4'))).rejects.toThrow('not anvil');
    await expect(assertXLayerFork(env, node('anvil/v1.3.1', '0x7a0'))).rejects.toThrow('chain 1952, not a fork of X Layer (196)');
  });

  it('is checked against the command line before anything that reads a .env is loaded', () => {
    // The database module loads `dotenv/config`. The guard imports nothing, and the script's only static imports are the
    // guard and viem, so what it checks is what the person running it named — never what a `.env` supplied.
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source('./guard.ts')).not.toMatch(/^import /m);
    const statics = [...source('./reconcile-orphans.ts').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(statics.sort()).toEqual(['./guard.js', 'viem', 'viem/chains']);
  });
});

describe('what comes out', () => {
  it('a strategy buy: its dollars off its day, its units and cost off the position', () => {
    const plan = planReconciliation({
      orphans: [fill({ runId: 'r1' }), fill({ runId: 'r2', usd: 8, units: 0.0032, signature: hash(2) })],
      disposals: [],
      swapLegs: [],
      positions: [WETH, CBBTC],
    });
    expect(plan.unreversible).toEqual([]);
    expect(plan.reversed.map((f) => f.runId)).toEqual(['r1', 'r2']);
    expect(plan.spend).toEqual([{ walletId: WALLET, day: DAY, usd: 13 }]);
    expect(plan.positions).toHaveLength(1);
    expect(plan.positions[0]).toMatchObject({ positionId: 'pos-weth', costUsd: -13, realisedUsd: 0, unitsSold: 0, proceedsUsd: 0 });
    expect(plan.positions[0]!.units).toBeCloseTo(-0.0052, 12);
  });

  it('a limit fill: a buy of what arrived, against the day’s spend', () => {
    const plan = planReconciliation({
      orphans: [fill({ runId: 'lop', kind: 'limit', units: 0.01, usd: 25 })],
      disposals: [],
      swapLegs: [],
      positions: [WETH],
    });
    expect(plan.spend).toEqual([{ walletId: WALLET, day: DAY, usd: 25 }]);
    expect(plan.positions[0]).toMatchObject({ units: -0.01, costUsd: -25 });
  });

  it('a supply: its dollars off its day, and no position at all', () => {
    const plan = planReconciliation({
      orphans: [fill({ runId: 'aave', kind: 'yield-rotation', symbol: 'USDC', side: 'supply', units: 100, usd: 100 })],
      disposals: [],
      swapLegs: [],
      positions: [],
    });
    expect(plan.reversed).toHaveLength(1);
    expect(plan.spend).toEqual([{ walletId: WALLET, day: DAY, usd: 100 }]);
    expect(plan.positions).toEqual([]);
  });

  it('a sale with a basis: its disposals deleted, exactly what they record put back, and nothing spent', () => {
    const plan = planReconciliation({
      orphans: [fill({ runId: 'close', kind: 'close', side: 'sell', units: 0.5, usd: 1_240.5 })],
      disposals: [disposal({ id: 'd1', runId: 'close' }), disposal({ id: 'other', runId: 'someone-else' })],
      swapLegs: [],
      positions: [WETH],
    });
    expect(plan.spend).toEqual([]);
    expect(plan.disposalIds).toEqual(['d1']);
    expect(plan.positions).toEqual([
      {
        positionId: 'pos-weth',
        walletId: WALLET,
        symbol: 'WETH',
        units: 0.5,
        costUsd: 1_000,
        realisedUsd: -240.5,
        unitsSold: -0.5,
        proceedsUsd: -1_240.5,
        unbasedUnits: 0,
      },
    ]);
  });

  it('a sale larger than the book: the part with a basis put back, the part without taken off unbased units', () => {
    // 1.5 sold against 1 held at $2,000: $3,000 of the proceeds against that basis, $1,500 against none.
    const plan = planReconciliation({
      orphans: [fill({ runId: 'over', kind: 'momentum', side: 'sell', units: 1.5, usd: 4_500 })],
      disposals: [
        disposal({ id: 'based', runId: 'over', units: 1, proceedsUsd: 3_000, costUsd: 2_000, realisedUsd: 1_000 }),
        disposal({ id: 'unbased', runId: 'over', units: 0.5, proceedsUsd: 1_500, costUsd: 0, realisedUsd: 0, basisKnown: false }),
      ],
      swapLegs: [],
      positions: [WETH],
    });
    expect(plan.positions[0]).toMatchObject({
      units: 1,
      costUsd: 2_000,
      realisedUsd: -1_000,
      unitsSold: -1.5,
      proceedsUsd: -4_500,
      unbasedUnits: -0.5,
    });
    expect(plan.disposalIds).toEqual(['based', 'unbased']);
  });

  it('a buy and the close that sold it, together: the position moves as if neither happened', () => {
    const plan = planReconciliation({
      orphans: [
        fill({ runId: 'buy', units: 0.5, usd: 1_000 }),
        fill({ runId: 'close', kind: 'close', side: 'sell', units: 0.5, usd: 1_240.5, signature: hash(2) }),
      ],
      disposals: [disposal({ id: 'd1', runId: 'close' })],
      swapLegs: [],
      positions: [WETH],
    });
    expect(plan.positions[0]).toMatchObject({ units: 0, costUsd: 0, realisedUsd: -240.5, unitsSold: -0.5, proceedsUsd: -1_240.5 });
    expect(plan.spend).toEqual([{ walletId: WALLET, day: DAY, usd: 1_000 }]);
  });

  it('a swap: the sale of what it paid with, and the buy of what it received', () => {
    const plan = planReconciliation({
      orphans: [fill({ runId: 'swap', kind: 'swap', side: 'sell', units: 0.5, usd: 1_240.5 })],
      disposals: [disposal({ id: 'd1', runId: 'swap' })],
      swapLegs: [{ runId: 'swap', symbol: 'CBBTC', units: 0.012, usd: 1_240.5 }],
      positions: [WETH, CBBTC],
    });
    expect(plan.spend).toEqual([]);
    expect(plan.positions).toHaveLength(2);
    expect(plan.positions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ positionId: 'pos-weth', units: 0.5, costUsd: 1_000, realisedUsd: -240.5 }),
        expect.objectContaining({ positionId: 'pos-cbbtc', units: -0.012, costUsd: -1_240.5, realisedUsd: 0 }),
      ]),
    );
  });

  it('matches a position however the book spelled it', () => {
    const plan = planReconciliation({
      orphans: [fill({ runId: 'r1', symbol: 'weth' })],
      disposals: [],
      swapLegs: [],
      positions: [WETH],
    });
    expect(plan.positions[0]).toMatchObject({ positionId: 'pos-weth' });
  });
});

describe('what is left for a person, with its reason', () => {
  it('a sale that booked no basis — and every other orphan of that token in the wallet, with its spend', () => {
    const plan = planReconciliation({
      orphans: [
        fill({ runId: 'buy' }),
        fill({ runId: 'flatten', kind: 'close', side: 'sell', units: 2, usd: 5_000, signature: hash(2) }),
        fill({ runId: 'btc', symbol: 'CBBTC', units: 0.0001, usd: 6, signature: hash(3) }),
      ],
      disposals: [disposal({ id: 'd1', runId: 'flatten', units: 2, costUsd: 0, realisedUsd: 0, basisKnown: false })],
      swapLegs: [],
      positions: [WETH, CBBTC],
    });
    expect(plan.unreversible.map((u) => [u.fill.runId, u.why])).toEqual([
      ['buy', expect.stringContaining('another orphaned fill of WETH')],
      ['flatten', expect.stringContaining('no cost basis')],
    ]);
    // Another token in the same wallet still comes out.
    expect(plan.reversed.map((f) => f.runId)).toEqual(['btc']);
    expect(plan.spend).toEqual([{ walletId: WALLET, day: DAY, usd: 6 }]);
    expect(plan.disposalIds).toEqual([]);
  });

  it('a portfolio rebalance leg, which leaves every token of its wallet — but not a supply, which holds none', () => {
    const plan = planReconciliation({
      orphans: [
        fill({ runId: 'leg', kind: 'rebalance', symbol: 'PORTFOLIO' }),
        fill({ runId: 'buy', signature: hash(2) }),
        fill({ runId: 'aave', kind: 'yield-rotation', symbol: 'USDC', side: 'supply', usd: 50, signature: hash(3) }),
        fill({ runId: 'elsewhere', walletId: 'wallet-2', signature: hash(4) }),
      ],
      disposals: [],
      swapLegs: [],
      positions: [WETH, { id: 'pos-2', walletId: 'wallet-2', symbol: 'WETH' }],
    });
    expect(plan.unreversible.map((u) => u.fill.runId)).toEqual(['leg', 'buy']);
    expect(plan.reversed.map((f) => f.runId)).toEqual(['aave', 'elsewhere']);
  });

  it('a swap without the trail row that says what it received', () => {
    const plan = planReconciliation({
      orphans: [fill({ runId: 'swap', kind: 'swap', side: 'sell', units: 0.5 })],
      disposals: [disposal({ id: 'd1', runId: 'swap' })],
      swapLegs: [],
      positions: [WETH],
    });
    expect(plan.unreversible).toEqual([{ fill: expect.objectContaining({ runId: 'swap' }), why: expect.stringContaining('trail row') }]);
    expect(plan.disposalIds).toEqual([]);
  });

  it('a token the book spells two ways, or holds no position in', () => {
    const twice = planReconciliation({
      orphans: [fill({ runId: 'r1' })],
      disposals: [],
      swapLegs: [],
      positions: [WETH, { id: 'pos-weth-lower', walletId: WALLET, symbol: 'weth' }],
    });
    expect(twice.unreversible[0]!.why).toContain('2 ways');
    const none = planReconciliation({ orphans: [fill({ runId: 'r1' })], disposals: [], swapLegs: [], positions: [] });
    expect(none.unreversible[0]!.why).toContain('no WETH position');
    expect([twice.spend, none.spend]).toEqual([[], []]);
  });

  it('a run with no side, a signature that is not a hash, or no recorded dollars', () => {
    const plan = planReconciliation({
      orphans: [
        fill({ runId: 'old', side: null }),
        fill({ runId: 'solana', symbol: 'CBBTC', signature: '5YpYv-base58' }),
        fill({ runId: 'blank', symbol: 'CBBTC', usd: null, signature: hash(2) }),
      ],
      disposals: [],
      swapLegs: [],
      positions: [WETH, CBBTC],
    });
    expect(plan.reversed).toEqual([]);
    expect(plan.unreversible.map((u) => u.why)).toEqual([
      expect.stringContaining('before fills carried a side'),
      expect.stringContaining('not a transaction hash'),
      expect.stringContaining('without its units'),
    ]);
  });
});

type Statement = { text: string; params: unknown[] };

function recorder(answer: (s: Statement) => { rows?: unknown[]; rowCount?: number } = () => ({})) {
  const statements: Statement[] = [];
  const client = {
    query: vi.fn(async (text: string, params: unknown[] = []) => {
      const s = { text, params };
      statements.push(s);
      const a = answer(s);
      return { rows: a.rows ?? [], rowCount: a.rowCount ?? 1 };
    }),
  };
  return { client: client as never, statements };
}

describe('writing a plan', () => {
  const plan = () =>
    planReconciliation({
      orphans: [
        fill({ runId: 'buy', units: 0.5, usd: 1_000 }),
        fill({ runId: 'close', kind: 'close', side: 'sell', units: 0.5, usd: 1_240.5, signature: hash(2) }),
      ],
      disposals: [disposal({ id: 'd1', runId: 'close' })],
      swapLegs: [],
      positions: [WETH],
    });

  it('marks each run, puts back the spend and the position, deletes the disposals, and writes one trail row per wallet', async () => {
    const { client, statements } = recorder();
    await applyReconciliation(client, plan());

    const marked = statements.filter((s) => /UPDATE strategy_runs/.test(s.text));
    expect(marked.map((s) => s.params)).toEqual([
      ['buy', RECONCILED_ERROR],
      ['close', RECONCILED_ERROR],
    ]);
    expect(marked.every((s) => /status = 'failed'/.test(s.text) && /AND status = 'filled'/.test(s.text))).toBe(true);
    expect(statements.find((s) => /UPDATE daily_spend/.test(s.text))!.params).toEqual([WALLET, DAY, 1_000]);
    expect(statements.find((s) => /DELETE FROM daily_spend/.test(s.text))!.text).toContain('spent_usd = 0');
    const position = statements.find((s) => /UPDATE positions/.test(s.text))!;
    expect(position.text).toContain(`chain = current_setting('xorr.chain_key')`);
    expect(position.params).toEqual(['pos-weth', 0, 0, -240.5, -0.5, -1_240.5, 0]);
    expect(statements.find((s) => /DELETE FROM disposals/.test(s.text))!.params).toEqual([['d1']]);

    expect(append).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(append).mock.calls[0]![0];
    expect(entry).toMatchObject({
      walletId: WALLET,
      kind: 'risk',
      action: 'Took 2 fills the chain does not have out of the book',
      payload: { reconciled: true, runIds: ['buy', 'close'], signatures: [hash(1), hash(2)] },
    });
    // Words for a person: no network, venue or environment named.
    expect(`${entry.action} ${entry.detail ?? ''}`).not.toMatch(/fork|1inch|base|anvil|railway/i);
  });

  it('stops at a run that is no longer filled, before writing anything else', async () => {
    const { client, statements } = recorder((s) => (/UPDATE strategy_runs/.test(s.text) ? { rowCount: 0 } : {}));
    await expect(applyReconciliation(client, plan())).rejects.toThrow('changed while this ran');
    expect(statements).toHaveLength(1);
    expect(append).not.toHaveBeenCalled();
  });
});

describe('a reconciliation', () => {
  const ROWS = [
    { run_id: 'on-chain', wallet_id: WALLET, kind: 'dca', symbol: 'WETH', side: 'buy', units: '0.002', usd: '5', signature: hash(1), day: DAY },
    { run_id: 'orphan', wallet_id: WALLET, kind: 'dca', symbol: 'WETH', side: 'buy', units: '0.0032', usd: '8', signature: hash(2), day: DAY },
    { run_id: 'odd', wallet_id: WALLET, kind: 'dca', symbol: 'WETH', side: 'buy', units: '1', usd: '1', signature: 'not-a-hash', day: DAY },
  ];
  const chain = {
    getTransactionReceipt: vi.fn(async ({ hash: h }: { hash: Hex }) => {
      if (h === hash(1)) return { status: 'success' };
      throw new TransactionReceiptNotFoundError({ hash: h });
    }),
    getTransaction: vi.fn(async ({ hash: h }: { hash: Hex }) => {
      throw new TransactionNotFoundError({ hash: h });
    }),
  };
  const database = () =>
    recorder((s) => {
      if (/r\.status = 'filled' AND r\.signature IS NOT NULL/.test(s.text)) return { rows: ROWS };
      if (/FOR UPDATE OF r/.test(s.text)) return { rows: ROWS.filter((r) => (s.params[0] as string[]).includes(r.run_id)) };
      if (/FROM positions/.test(s.text)) return { rows: [{ id: 'pos-weth', wallet_id: WALLET, symbol: 'WETH' }] };
      return {};
    });

  it('asks the node before opening a transaction, plans under locks, and a dry run rolls back what apply commits', async () => {
    const dry = database();
    const lines: string[] = [];
    const plan = await reconcile({ client: dry.client, chain, apply: false, out: (l) => lines.push(l) });
    expect(plan.reversed.map((f) => f.runId)).toEqual(['orphan']);
    expect(dry.statements.find((s) => /FOR UPDATE OF r/.test(s.text))!.params).toEqual([['orphan']]);
    expect(dry.statements.find((s) => /FROM positions/.test(s.text))!.text).toContain("side = 'long'");
    const verbs = dry.statements.map((s) => s.text.trim().split(/\s+/)[0]);
    expect(verbs.indexOf('BEGIN')).toBeGreaterThan(0);
    expect(verbs.at(-1)).toBe('ROLLBACK');
    expect(dry.statements.some((s) => /^(UPDATE|DELETE)/.test(s.text.trim()))).toBe(false);
    expect(lines[0]).toBe('3 filled run(s) on this chain: 1 not on the node, 1 without a transaction hash to look up.');
    expect(lines.some((l) => l.includes('unchecked odd'))).toBe(true);

    const wet = database();
    await reconcile({ client: wet.client, chain, apply: true, out: () => undefined });
    expect(wet.statements.some((s) => /UPDATE strategy_runs/.test(s.text))).toBe(true);
    expect(wet.statements.at(-1)!.text).toBe('COMMIT');
  });

  it('throws before opening a transaction when the node cannot be asked, having written nothing', async () => {
    const down = { getTransactionReceipt: vi.fn(async () => Promise.reject(new Error('socket hang up'))), getTransaction: vi.fn() };
    const db = database();
    await expect(reconcile({ client: db.client, chain: down, apply: true, out: () => undefined })).rejects.toThrow('socket hang up');
    expect(db.statements.map((s) => s.text.trim().split(/\s+/)[0])).toEqual(['SELECT']);
  });
});
