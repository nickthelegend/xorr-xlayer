/**
 * GET /history (PLAN.md 3.14) — with the chain and the database stood in for.
 *
 * The delegation contract's `Spent` and `Closed` events for this owner alone, over a bounded window, newest first; each
 * joined to the run that recorded its transaction when there is one, and listed when there is not; the token and the
 * dollars from the registry, never guessed; the venue named as `strategy_runs.venue` names it (uniswap-v3, okx-dex,
 * aave); each block's time read once; and a failed log read a 502 with the provider's reason. The chain is the only
 * source, on every X Layer network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, toEventSelector, toHex } from 'viem';
import type { WalletRow } from './wallet-context.js';

const h = vi.hoisted(() => ({
  chain: 'xlayer-fork',
  delegation: '0x6c5528Fd8E74a047A85bAb413856A9239E73540e',
  getBlockNumber: vi.fn(),
  getLogs: vi.fn(),
  getBlock: vi.fn(),
}));

// Exactly what the route reads from the chain: the head, the contract's logs (through the real `getLogsPaged`), blocks.
vi.mock('../evm/client.js', () => ({
  /*
   * `getCode` is what `deploymentBlock` bisects on, and the answer decides where the scan starts. Here the contract
   * has code at every height, so the search bottoms out at 0 and the window is the route's own lower bound — the
   * 9,000 blocks these tests are about. Left off entirely, the search saw a client with no `getCode` at all, which
   * once meant "the search failed, fall back to 9,000" and now means "head", and every one of these read nothing.
   */
  publicClient: {
    getBlockNumber: h.getBlockNumber,
    getLogs: h.getLogs,
    getBlock: h.getBlock,
    getCode: async () => '0x60',
  },
}));
vi.mock('../evm/chains.js', () => ({
  get CHAIN_KEY() {
    return h.chain;
  },
  get IS_MAINNET_STATE() {
    return h.chain === 'xlayer' || h.chain === 'xlayer-fork';
  },
  // Aave v3's X Layer pool where mainnet state is; the testnet has no lending pool, so it is null there.
  get AAVE_V3_POOL() {
    return h.chain === 'xlayer' || h.chain === 'xlayer-fork' ? '0xE3F3Caefdd7180F884c01E57f65Df979Af84f116' : null;
  },
  // Mainnet and its fork settle in mainnet USDC through Uniswap v3; the testnet's USDC is Circle's other deployment,
  // absent from the all-mainnet registry, and it has no Uniswap router.
  get ADDRESSES() {
    return h.chain === 'xlayer-testnet'
      ? { uniswapRouter: null, usdc: '0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3' }
      : { uniswapRouter: '0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA', usdc: '0xB6CEceAB302E2E4948951eE7843FC24E92933061' };
  },
  explorerTx: (hash: string) => `fork:${hash}`,
}));
vi.mock('../evm/delegation.js', () => ({
  get DELEGATION_ADDRESS() {
    return h.delegation;
  },
}));
vi.mock('../venues/tokens.js', () => ({
  SETTLEMENT_SYMBOL: 'USDC',
  // The registry, at X Layer mainnet's addresses.
  TOKENS: {
    USDC: { address: '0xB6CEceAB302E2E4948951eE7843FC24E92933061', decimals: 6 },
    WETH: { address: '0x5A77f1443D16ee5761d310e38b62f77f726bC71c', decimals: 18 },
  },
}));
// OKX DEX's router on X Layer, as `venues/okxdex.ts` checksums it.
vi.mock('../venues/okxdex.js', () => ({ OKX_ROUTER: '0x7c5bEE2a8091C3ef39072f64F18Fac913060AEaF' }));
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
const { CLOSED_EVENT, SPENT_EVENT, historyRoutes } = await import('./history.js');

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
const DELEGATE = '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5';
/** Uniswap v3's SwapRouter02 on X Layer. */
const ROUTER = '0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA';
/** OKX DEX's router, as a log carries it: lowercase, where the executor checksums it. */
const OKX = '0x7c5bee2a8091c3ef39072f64f18fac913060aeaf';
const AAVE = '0xE3F3Caefdd7180F884c01E57f65Df979Af84f116';
const USDC = '0xB6CEceAB302E2E4948951eE7843FC24E92933061';
const TESTNET_USDC = '0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3';
const WETH = '0x5A77f1443D16ee5761d310e38b62f77f726bC71c';
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

/** Two seconds a block. */
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
  h.chain = 'xlayer-fork';
  h.delegation = '0x6c5528Fd8E74a047A85bAb413856A9239E73540e';
  h.getBlockNumber.mockReset().mockResolvedValue(HEAD);
  h.getLogs.mockReset();
  h.getBlock
    .mockReset()
    .mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, timestamp: timeOf(blockNumber) }));
  chainHas([]);
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(requireWallet).mockReset().mockResolvedValue(wallet);
});

describe('what it reads', () => {
  it("is the contract's own events, by the signatures the Solidity declares, with owner, delegate and venue indexed", () => {
    expect(toEventSelector(SPENT_EVENT)).toBe(keccak256(toHex('Spent(address,address,address,address,uint256,uint256)')));
    expect(toEventSelector(CLOSED_EVENT)).toBe(keccak256(toHex('Closed(address,address,address,address,uint256)')));
    expect(SPENT_EVENT.inputs.map((i) => i.indexed)).toEqual([true, true, true, false, false, false]);
    expect(CLOSED_EVENT.inputs.map((i) => i.indexed)).toEqual([true, true, true, false, false]);
  });

  it("asks the delegation contract for this owner's events alone, over the last 9,000 blocks with no gaps", async () => {
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
    // An empty history says which window it is empty in, and since when.
    expect(body).toEqual({
      owner: OWNER,
      chain: 'xlayer-fork',
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
      closed(tx(2), HEAD - 100n, WETH, 10_000_000_000_000_000n, { venue: OKX }),
      spent(tx(3), HEAD - 200n, USDC, 1_500_000n, { venue: AAVE }),
    ]);

    const { body } = await get();

    expect(body.items).toEqual([
      {
        kind: 'closed',
        txHash: tx(2),
        block: Number(HEAD - 100n),
        at: iso(HEAD - 100n),
        venue: 'okx-dex',
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
        venue: 'aave',
        token: { symbol: 'USDC', decimals: 6, address: USDC },
        amount: '1500000',
        usd: 1.5,
        explorer: `fork:${tx(3)}`,
      },
      {
        kind: 'spent',
        txHash: tx(1),
        block: Number(HEAD - 300n),
        at: iso(HEAD - 300n),
        venue: 'uniswap-v3',
        token: { symbol: 'USDC', decimals: 6, address: USDC },
        amount: '25000000',
        usd: 25,
        explorer: `fork:${tx(1)}`,
      },
    ]);
  });

  it("on the testnet, reads this chain's own USDC as USDC, and names Aave only where its pool exists", async () => {
    h.chain = 'xlayer-testnet';
    chainHas([spent(tx(3), HEAD - 200n, TESTNET_USDC, 1_500_000n, { venue: AAVE })]);

    const { body } = await get();

    expect(body.chain).toBe('xlayer-testnet');
    expect(body.items).toEqual([
      expect.objectContaining({
        // The testnet's USDC is not in the registry, and it is still USDC.
        token: { symbol: 'USDC', decimals: 6, address: TESTNET_USDC },
        usd: 1.5,
        // No Aave pool on the testnet: the address stays an address.
        venue: AAVE,
      }),
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
      closed(tx(2), HEAD - 100n, WETH, 10_000_000_000_000_000n, { venue: OKX }),
    ]);
    vi.mocked(query).mockResolvedValue([
      { signature: tx(2), kind: 'exit-rules', symbol: 'WETH', venue: 'okx-dex', side: 'sell', units: '0.010000000', usd: '24.93' },
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

    expect(body.items[0]!.run).toEqual({ kind: 'exit-rules', symbol: 'WETH', venue: 'okx-dex', side: 'sell', units: 0.01, usd: 24.93 });
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
      { signature: tx(99), kind: 'dca', symbol: 'WETH', venue: 'uniswap-v3', side: 'buy', units: '0.004', usd: '10' },
      { signature: tx(2), kind: 'dca', symbol: 'WETH', venue: 'uniswap-v3', side: 'buy', units: '0.0008', usd: '2' },
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
        new Error('HTTP request failed.\n\nStatus: 429\nURL: https://xlayer-testnet.example.com/v2/SECRET-KEY\nRequest body: {}'),
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
    h.getBlockNumber.mockRejectedValue(new Error('fetch failed for https://xlayer-testnet.example.com/v2/SECRET-KEY'));

    const { status, body } = await get();

    expect(status).toBe(502);
    expect(body.reason).toBe('fetch failed');
    expect(JSON.stringify(body)).not.toContain('SECRET-KEY');
  });
});

describe('on X Layer mainnet', () => {
  it('reads the chain alone, and lists each settlement once', async () => {
    h.chain = 'xlayer';
    chainHas([spent(tx(1), HEAD - 300n, USDC, 25_000_000n)]);

    const { status, body } = await get('/history?limit=5000');

    expect(status).toBe(200);
    expect(body.source).toBe('chain');
    expect(body.unavailable).toBeNull();
    expect(body.items.map((i) => [i.kind, i.txHash, i.venue])).toEqual([['spent', tx(1), 'uniswap-v3']]);
    expect(blocksRead()).toEqual([HEAD - 9_000n, HEAD - 300n]);
    expect(vi.mocked(query).mock.calls[0]![1]).toEqual(['wallet-1', [tx(1)]]);
  });
});
