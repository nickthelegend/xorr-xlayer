/**
 * GET /history (PLAN.md 3.14) — with the chain, the database and 1inch stood in for.
 *
 * The delegation contract's `Spent` and `Closed` events for this owner alone, over a bounded window, newest first; each
 * joined to the run that recorded its transaction when there is one, and listed when there is not; the token and the
 * dollars from the registry, never guessed; each block's time read once; a failed log read a 502 with the provider's
 * reason; and on Base, 1inch's history beside the chain's — never in place of it, and never twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, keccak256, toEventSelector, toHex } from 'viem';
import type { WalletRow } from './wallet-context.js';

const h = vi.hoisted(() => ({
  chain: 'base-fork',
  delegation: '0x6c5528Fd8E74a047A85bAb413856A9239E73540e',
  getBlockNumber: vi.fn(),
  getLogs: vi.fn(),
  getBlock: vi.fn(),
}));

// Exactly what the route reads from the chain: the head, the contract's logs (through the real `getLogsPaged`), blocks.
vi.mock('../evm/client.js', () => ({
  publicClient: { getBlockNumber: h.getBlockNumber, getLogs: h.getLogs, getBlock: h.getBlock },
}));
vi.mock('../evm/chains.js', () => ({
  get CHAIN_KEY() {
    return h.chain;
  },
  get IS_BASE_MAINNET_STATE() {
    return h.chain === 'base' || h.chain === 'base-fork';
  },
  AAVE_V3_POOL: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  // This chain's settlement USDC is Base Sepolia's: Circle's other deployment, absent from the all-mainnet registry.
  ADDRESSES: {
    oneInchRouter: '0x111111125421cA6dc452d289314280a0f8842A65',
    usdcBase: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  explorerTx: (hash: string) => `fork:${hash}`,
}));
vi.mock('../evm/delegation.js', () => ({
  get DELEGATION_ADDRESS() {
    return h.delegation;
  },
}));
vi.mock('../venues/oneinch.js', () => ({
  SETTLEMENT_SYMBOL: 'USDC',
  TOKENS: {
    USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  },
}));
// Our Aqua book, configured lowercase as the deployment has it; no SwapVM book on this chain.
vi.mock('../venues/aqua.js', () => ({ bookAddress: () => '0x74e1283711106a5844eb20760c7cb6405933c54f' }));
vi.mock('../venues/swapvm.js', () => ({ swapVmBookAddress: () => undefined }));
vi.mock('../venues/history.js', () => ({ oneinchHistory: vi.fn() }));
vi.mock('../db/index.js', () => ({ query: vi.fn() }));
vi.mock('./wallet-context.js', () => ({ requireWallet: vi.fn() }));
vi.mock('../http/request-id.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  currentRequestId: () => 'req-1',
}));

// Read once, at import: the default window and page size, whatever this machine's environment says.
vi.stubEnv('HISTORY_LOOKBACK_BLOCKS', undefined);
vi.stubEnv('LOG_WINDOW_BLOCKS', undefined);
const { query } = await import('../db/index.js');
const { requireWallet } = await import('./wallet-context.js');
const { oneinchHistory } = await import('../venues/history.js');
const { CLOSED_EVENT, SPENT_EVENT, historyRoutes } = await import('./history.js');

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
const DELEGATE = '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5';
const ROUTER = '0x111111125421cA6dc452d289314280a0f8842A65';
/** The Aqua book as a log carries it: checksummed, where the deployment configures it lowercase. */
const BOOK = getAddress('0x74e1283711106a5844eb20760c7cb6405933c54f');
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const WETH = '0x4200000000000000000000000000000000000006';
const HEAD = 30_000_000n;
const wallet = { id: 'wallet-1', address: OWNER } as unknown as WalletRow;

/** A transaction hash, one per n. */
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

type Decoded = {
  eventName: 'Spent' | 'Closed';
  args: { owner: string; delegate: string; venue: string; token: string; amount: bigint; spentToday?: bigint };
  blockNumber: bigint;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
};
type At = { venue?: string; tx?: number; log?: number };

/** A log as viem decodes the contract's events. */
const spent = (hash: string, blockNumber: bigint, token: string, amount: bigint, at: At = {}): Decoded => ({
  eventName: 'Spent',
  args: { owner: OWNER, delegate: DELEGATE, venue: at.venue ?? ROUTER, token, amount, spentToday: amount },
  blockNumber,
  transactionHash: hash,
  transactionIndex: at.tx ?? 0,
  logIndex: at.log ?? 0,
});
const closed = (hash: string, blockNumber: bigint, token: string, amount: bigint, at: At = {}): Decoded => ({
  eventName: 'Closed',
  args: { owner: OWNER, delegate: DELEGATE, venue: at.venue ?? ROUTER, token, amount },
  blockNumber,
  transactionHash: hash,
  transactionIndex: at.tx ?? 0,
  logIndex: at.log ?? 0,
});

type LogQuery = { address: string; event: { name: string }; args?: { owner?: string }; fromBlock: bigint; toBlock: bigint };

/** The contract's history, answered the way a node answers `eth_getLogs`: by address, event, owner topic and range. */
function chainHas(logs: Decoded[]) {
  h.getLogs.mockImplementation(async (q: LogQuery) =>
    logs.filter(
      (l) =>
        q.address === h.delegation &&
        l.eventName === q.event.name &&
        l.args.owner.toLowerCase() === q.args?.owner?.toLowerCase() &&
        l.blockNumber >= q.fromBlock &&
        l.blockNumber <= q.toBlock,
    ),
  );
}

/** Two seconds a block, as on Base. */
const timeOf = (block: bigint) => 1_789_000_000n + (block - (HEAD - 9_000n)) * 2n;
const iso = (block: bigint) => new Date(Number(timeOf(block)) * 1000).toISOString();
const ascending = (xs: bigint[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const blocksRead = () => ascending(h.getBlock.mock.calls.map(([q]) => (q as { blockNumber: bigint }).blockNumber));

type Item = {
  kind: string;
  txHash: string;
  block: number;
  at: string | null;
  venue: string | null;
  token: { symbol: string; decimals: number; address: string } | null;
  amount: string | null;
  usd: number | null;
  run?: Record<string, unknown>;
  oneinch?: Record<string, unknown>;
  explorer: string;
};
type Body = {
  owner: string;
  chain: string;
  source: string;
  window: { fromBlock: number; toBlock: number; since: string | null };
  unavailable: { source: string; reason: string } | null;
  items: Item[];
  error?: string;
  message?: string;
  reason?: string;
  requestId?: string;
};

async function get(path = '/history'): Promise<{ status: number; body: Body }> {
  const res = await historyRoutes.request(path);
  return { status: res.status, body: (await res.json()) as Body };
}

beforeEach(() => {
  h.chain = 'base-fork';
  h.delegation = '0x6c5528Fd8E74a047A85bAb413856A9239E73540e';
  h.getBlockNumber.mockReset().mockResolvedValue(HEAD);
  h.getLogs.mockReset();
  h.getBlock
    .mockReset()
    .mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, timestamp: timeOf(blockNumber) }));
  chainHas([]);
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(requireWallet).mockReset().mockResolvedValue(wallet);
  vi.mocked(oneinchHistory).mockReset();
});

describe('what it reads', () => {
  it("is the contract's own events, by the signatures the Solidity declares, with owner, delegate and venue indexed", () => {
    expect(toEventSelector(SPENT_EVENT)).toBe(keccak256(toHex('Spent(address,address,address,address,uint256,uint256)')));
    expect(toEventSelector(CLOSED_EVENT)).toBe(keccak256(toHex('Closed(address,address,address,address,uint256)')));
    expect(SPENT_EVENT.inputs.map((i) => i.indexed)).toEqual([true, true, true, false, false, false]);
    expect(CLOSED_EVENT.inputs.map((i) => i.indexed)).toEqual([true, true, true, false, false]);
  });

  it("asks the delegation contract for this owner's events alone, over the last 9,000 blocks with no gaps, and not 1inch off Base", async () => {
    const { status, body } = await get();

    expect(status).toBe(200);
    const asked = h.getLogs.mock.calls.map(([q]) => q as LogQuery);
    expect(new Set(asked.map((q) => q.address))).toEqual(new Set([h.delegation]));
    for (const event of [SPENT_EVENT, CLOSED_EVENT]) {
      const windows = asked.filter((q) => q.event === event);
      expect(windows.length, event.name).toBeGreaterThan(0);
      expect(windows[0]!.fromBlock, event.name).toBe(HEAD - 9_000n);
      expect(windows.at(-1)!.toBlock, event.name).toBe(HEAD);
      for (const [i, q] of windows.entries()) {
        expect(q.args, event.name).toEqual({ owner: OWNER });
        if (i > 0) expect(q.fromBlock, event.name).toBe(windows[i - 1]!.toBlock + 1n);
      }
    }
    expect(oneinchHistory).not.toHaveBeenCalled();
    // An empty history says which window it is empty in, and since when.
    expect(body).toEqual({
      owner: OWNER,
      chain: 'base-fork',
      source: 'chain',
      window: { fromBlock: Number(HEAD - 9_000n), toBlock: Number(HEAD), since: iso(HEAD - 9_000n) },
      unavailable: null,
      items: [],
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('each settlement', () => {
  it('is listed newest first, with the token the registry gives its address, and dollars only where the amount is dollars', async () => {
    chainHas([
      spent(tx(1), HEAD - 300n, USDC, 25_000_000n),
      closed(tx(2), HEAD - 100n, WETH, 10_000_000_000_000_000n, { venue: BOOK }),
      spent(tx(3), HEAD - 200n, SEPOLIA_USDC, 1_500_000n),
    ]);

    const { body } = await get();

    expect(body.items).toEqual([
      {
        kind: 'closed',
        txHash: tx(2),
        block: Number(HEAD - 100n),
        at: iso(HEAD - 100n),
        venue: 'aqua',
        token: { symbol: 'WETH', decimals: 18, address: WETH },
        amount: '10000000000000000',
        // What a sold asset was worth is not on chain, and today's price would date it wrong.
        usd: null,
        explorer: `fork:${tx(2)}`,
      },
      {
        kind: 'spent',
        txHash: tx(3),
        block: Number(HEAD - 200n),
        at: iso(HEAD - 200n),
        venue: '1inch',
        // Sepolia's USDC is not in the registry, and it is still USDC.
        token: { symbol: 'USDC', decimals: 6, address: SEPOLIA_USDC },
        amount: '1500000',
        usd: 1.5,
        explorer: `fork:${tx(3)}`,
      },
      {
        kind: 'spent',
        txHash: tx(1),
        block: Number(HEAD - 300n),
        at: iso(HEAD - 300n),
        venue: '1inch',
        token: { symbol: 'USDC', decimals: 6, address: USDC },
        amount: '25000000',
        usd: 25,
        explorer: `fork:${tx(1)}`,
      },
    ]);
  });

  it('keeps a token the registry does not know raw (no symbol, no decimal point, no dollars) and an unknown venue as its address', async () => {
    const TOKEN = '0x00000000000000000000000000000000000000d1';
    const VENUE = '0x00000000000000000000000000000000000000E2';
    chainHas([closed(tx(4), HEAD - 50n, TOKEN, 123n, { venue: VENUE })]);

    const { body } = await get();

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ kind: 'closed', token: null, amount: '123', usd: null, venue: VENUE });
  });

  it('orders events in one block by transaction, then by log', async () => {
    chainHas([
      spent(tx(5), HEAD - 10n, USDC, 1n, { tx: 1, log: 3 }),
      closed(tx(6), HEAD - 10n, WETH, 1n, { tx: 4, log: 9 }),
      spent(tx(6), HEAD - 10n, USDC, 2n, { tx: 4, log: 8 }),
    ]);

    const { body } = await get();

    expect(body.items.map((i) => [i.kind, i.txHash])).toEqual([
      ['closed', tx(6)],
      ['spent', tx(6)],
      ['spent', tx(5)],
    ]);
  });
});

describe('the run behind a settlement', () => {
  it("is joined by transaction from this wallet's runs on this chain, and an event with no run is listed all the same", async () => {
    chainHas([
      spent(tx(1), HEAD - 300n, USDC, 25_000_000n),
      closed(tx(2), HEAD - 100n, WETH, 10_000_000_000_000_000n, { venue: BOOK }),
    ]);
    vi.mocked(query).mockResolvedValue([
      { signature: tx(2), kind: 'exit-rules', symbol: 'WETH', venue: 'aqua', side: 'sell', units: '0.010000000', usd: '24.93' },
    ] as never);

    const { body } = await get();

    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    expect(sql).toContain('FROM strategy_runs r');
    expect(sql).toContain('JOIN strategies s ON s.id = r.strategy_id');
    expect(sql).toContain('s.wallet_id = $1');
    expect(sql).toContain(`s.chain = current_setting('xorr.chain_key')`);
    expect(sql).toContain(`r.chain = current_setting('xorr.chain_key')`);
    expect(sql).toContain('lower(r.signature) = ANY($2::text[])');
    expect(params).toEqual(['wallet-1', [tx(2), tx(1)]]);

    expect(body.items[0]!.run).toEqual({ kind: 'exit-rules', symbol: 'WETH', venue: 'aqua', side: 'sell', units: 0.01, usd: 24.93 });
    // No run recorded this transaction. The chain says it happened, so it is history.
    expect(body.items[1]).toMatchObject({ kind: 'spent', txHash: tx(1) });
    expect(body.items[1]).not.toHaveProperty('run');
  });

  it('asks only about the transactions it lists, and a run whose transaction emitted nothing here is not history', async () => {
    chainHas([
      spent(tx(1), HEAD - 100n, USDC, 1_000_000n),
      spent(tx(2), HEAD - 200n, USDC, 2_000_000n),
      spent(tx(3), HEAD - 300n, USDC, 3_000_000n),
    ]);
    vi.mocked(query).mockResolvedValue([
      { signature: tx(99), kind: 'dca', symbol: 'WETH', venue: '1inch', side: 'buy', units: '0.004', usd: '10' },
      { signature: tx(2), kind: 'dca', symbol: 'WETH', venue: '1inch', side: 'buy', units: '0.0008', usd: '2' },
    ] as never);

    const { body } = await get('/history?limit=2');

    expect(vi.mocked(query).mock.calls[0]![1]).toEqual(['wallet-1', [tx(1), tx(2)]]);
    expect(body.items.map((i) => [i.txHash, i.run?.symbol ?? null])).toEqual([
      [tx(1), null],
      [tx(2), 'WETH'],
    ]);
    expect(JSON.stringify(body)).not.toContain(tx(99));
  });
});

describe('block times', () => {
  it("reads each distinct block once, the window's first included, however many events it holds", async () => {
    chainHas([
      spent(tx(1), HEAD - 10n, USDC, 1n, { tx: 1 }),
      closed(tx(2), HEAD - 10n, WETH, 1n, { tx: 2 }),
      spent(tx(3), HEAD - 20n, USDC, 1n),
    ]);

    const { body } = await get();

    expect(blocksRead()).toEqual([HEAD - 9_000n, HEAD - 20n, HEAD - 10n]);
    expect(body.items.map((i) => i.at)).toEqual([iso(HEAD - 10n), iso(HEAD - 10n), iso(HEAD - 20n)]);
  });

  it('leaves a time it could not read as null, and still lists the settlement', async () => {
    chainHas([spent(tx(1), HEAD - 10n, USDC, 1n)]);
    h.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => {
      if (blockNumber === HEAD - 10n) throw new Error('timeout');
      return { number: blockNumber, timestamp: timeOf(blockNumber) };
    });

    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ kind: 'spent', txHash: tx(1), at: null, usd: 0.000001 });
  });
});

describe('the request', () => {
  it('refuses a limit that is not a number, before reading anything', async () => {
    const { status, body } = await get('/history?limit=many');

    expect(status).toBe(400);
    expect(body.error).toBe('bad_limit');
    expect(h.getBlockNumber).not.toHaveBeenCalled();
    expect(h.getLogs).not.toHaveBeenCalled();
  });

  it('answers 503 when no delegation contract is configured, rather than an empty history, and reads nothing', async () => {
    h.delegation = '0x0000000000000000000000000000000000000000';

    const { status, body } = await get();

    expect(status).toBe(503);
    expect(body.error).toBe('not_configured');
    expect(h.getBlockNumber).not.toHaveBeenCalled();
  });

  it("answers a failed log read with 502 and the provider's reason, never an empty history", async () => {
    h.getLogs.mockRejectedValue(
      Object.assign(
        new Error('HTTP request failed.\n\nStatus: 429\nURL: https://base-sepolia.example.com/v2/SECRET-KEY\nRequest body: {}'),
        { shortMessage: 'HTTP request failed.', details: 'Too Many Requests' },
      ),
    );

    const { status, body } = await get();

    expect(status).toBe(502);
    expect(body).toEqual({
      error: 'chain_read_failed',
      message: "Could not read this wallet's settlements from the chain just now: HTTP request failed. Too Many Requests",
      reason: 'HTTP request failed. Too Many Requests',
      requestId: 'req-1',
    });
    expect(JSON.stringify(body)).not.toContain('SECRET-KEY');
    expect(query).not.toHaveBeenCalled();
  });

  it('cuts a URL out of a reason that carries one, since an RPC URL can carry its key', async () => {
    h.getBlockNumber.mockRejectedValue(new Error('fetch failed for https://base-sepolia.example.com/v2/SECRET-KEY'));

    const { status, body } = await get();

    expect(status).toBe(502);
    expect(body.reason).toBe('fetch failed');
    expect(JSON.stringify(body)).not.toContain('SECRET-KEY');
  });
});

/** A 1inch History API event, in the shape `venues/history.ts` reads. */
function oneinchEvent(
  hash: string,
  block: bigint,
  over: { status?: string; type?: string; actions?: object[] } = {},
) {
  return {
    id: `event-${hash.slice(-4)}`,
    timeMs: Number(timeOf(block)) * 1000 + 250,
    address: OWNER.toLowerCase(),
    type: 0,
    rating: 'reliable',
    direction: 'out',
    eventOrderInTransaction: 0,
    details: {
      txHash: hash,
      chainId: 8453,
      blockNumber: Number(block),
      blockTimeSec: Number(timeOf(block)),
      status: over.status ?? 'completed',
      type: over.type ?? 'Transfer',
      tokenActions: over.actions ?? [],
      fromAddress: OWNER.toLowerCase(),
      toAddress: ROUTER.toLowerCase(),
      nonce: 7,
      orderInBlock: 0,
      feeInSmallestNative: '21000000000',
    },
  };
}

const movement = (token: string, from: string, to: string, amount: string) => ({
  chainId: '8453',
  address: token.toLowerCase(),
  standard: 'ERC20',
  fromAddress: from.toLowerCase(),
  toAddress: to.toLowerCase(),
  amount,
  direction: from.toLowerCase() === OWNER.toLowerCase() ? 'Out' : 'In',
});

describe('on Base mainnet', () => {
  beforeEach(() => {
    h.chain = 'base';
  });

  it("adds 1inch's history beside the chain's: its own rows, no second copy of a settlement, nothing that did not go through", async () => {
    chainHas([spent(tx(1), HEAD - 300n, USDC, 25_000_000n)]);
    vi.mocked(oneinchHistory).mockResolvedValue([
      // A swap signed outside the app: USDC paid, WETH received.
      oneinchEvent(tx(10), HEAD - 50n, {
        type: 'SwapExactInput',
        actions: [movement(USDC, OWNER, ROUTER, '40000000'), movement(WETH, ROUTER, OWNER, '16000000000000000')],
      }),
      // Only received: the row stands for what arrived.
      oneinchEvent(tx(12), HEAD - 60n, {
        actions: [movement(WETH, '0x00000000000000000000000000000000000000c3', OWNER, '5000000000000000')],
      }),
      // Reverted: it settled nothing.
      oneinchEvent(tx(11), HEAD - 40n, { status: 'failed' }),
      // The contract's own settlement, which 1inch indexed too.
      oneinchEvent(tx(1), HEAD - 300n, { type: 'SwapExactInput', actions: [movement(USDC, OWNER, h.delegation, '25000000')] }),
    ] as never);

    const { status, body } = await get('/history?limit=5000');

    expect(status).toBe(200);
    // The limit is held to its ceiling before anyone is asked.
    expect(oneinchHistory).toHaveBeenCalledWith(OWNER, 200);
    expect(body.source).toBe('chain+1inch');
    expect(body.unavailable).toBeNull();
    expect(body.items.map((i) => [i.kind, i.txHash])).toEqual([
      ['1inch', tx(10)],
      ['1inch', tx(12)],
      ['spent', tx(1)],
    ]);
    expect(body.items[0]).toEqual({
      kind: '1inch',
      txHash: tx(10),
      block: Number(HEAD - 50n),
      at: iso(HEAD - 50n),
      venue: '1inch',
      token: { symbol: 'USDC', decimals: 6, address: USDC },
      amount: '40000000',
      usd: 40,
      oneinch: { type: 'SwapExactInput', direction: 'out' },
      explorer: `fork:${tx(10)}`,
    });
    expect(body.items[1]).toMatchObject({
      token: { symbol: 'WETH', decimals: 18, address: WETH },
      amount: '5000000000000000',
      usd: null,
      oneinch: { type: 'Transfer', direction: 'in' },
    });
    // 1inch's rows carry their own time: only the chain's blocks are read, and only its transactions looked up.
    expect(blocksRead()).toEqual([HEAD - 9_000n, HEAD - 300n]);
    expect(vi.mocked(query).mock.calls[0]![1]).toEqual(['wallet-1', [tx(1)]]);
  });

  it("keeps the chain's history when 1inch cannot be read, and says what is missing and why", async () => {
    chainHas([spent(tx(1), HEAD - 300n, USDC, 25_000_000n)]);
    vi.mocked(oneinchHistory).mockRejectedValue(
      new Error('422 Unprocessable Entity for https://api.1inch.dev/history/v2.0/history/0x95a0/events?chainId=8453&limit=50'),
    );

    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body.source).toBe('chain');
    expect(body.unavailable).toEqual({ source: '1inch', reason: '422 Unprocessable Entity' });
    expect(body.items.map((i) => i.txHash)).toEqual([tx(1)]);
  });
});
