/**
 * Settling through Aqua, with the chain stood in for (PLAN.md 3.8).
 *
 * Three things a fill depends on, none of which throws when it is wrong: the strategy encoding hashes to the id
 * `XorrAquaBook` computes, `keccak256(abi.encode(strategy))`; replaying Aqua's `Shipped`/`Docked` logs leaves exactly
 * the books open on OUR app for the pair asked about; and `buildAquaFill` holds a fill to the book's own quote less
 * slippage, through the calldata the book computes — or answers undefined when no open book can serve the size.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  concat,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  toEventSelector,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import type { AquaStrategy } from './aqua.js';

const h = vi.hoisted(() => ({ getBlockNumber: vi.fn(), getLogs: vi.fn(), readContract: vi.fn() }));

// Exactly what discovery and the fill read: the head, Aqua's logs (through `getLogsPaged`), and the book's views.
vi.mock('../evm/client.js', () => ({
  publicClient: { getBlockNumber: h.getBlockNumber, getLogs: h.getLogs, readContract: h.readContract },
}));

// Read once, at import: the default 9,000-block window, whatever this machine's environment says.
vi.stubEnv('AQUA_LOOKBACK_BLOCKS', undefined);
const { AQUA_EVENTS, BOOK_ABI, buildAquaFill, decodeStrategy, encodeStrategy, openBooks, strategyHash } = await import(
  './aqua.js'
);

/** The official Aqua deployment: every app's `Shipped` and `Docked` are emitted here. */
const AQUA = '0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a';
/** Our XorrAquaBook, as the deployment configures it. */
const BOOK = '0x74e1283711106a5844eb20760c7cb6405933c54f';
/** Some other app on the same shared liquidity. */
const OTHER_APP = '0xff0845130ca2b077c0cdf964d162fb00e869c199';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
/** The taker whose delegated capital pays for the fill. */
const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
const MAKER = getAddress('0x364d7bbc139541e0e37450d527ae154b5c292581');
const OTHER_MAKER = getAddress('0x02a5467700000000000000000000000000000aa1');
/** Anyone else — Aqua lets any address ship any bytes under any app. */
const STRANGER = getAddress('0x0000000000000000000000000000000000005742');
const HEAD = 30_000_000n;

/** A WETH/USDC book at 2,500 USDC per WETH, as a raw price: (token1 raw per token0 raw) × 1e18. */
const WETH_USDC: AquaStrategy = {
  maker: MAKER,
  token0: WETH,
  token1: USDC,
  feeBps: 30n,
  maxDeviationBps: 200n,
  referencePrice: 2_500_000_000n,
  salt: keccak256(toHex('xorr/WETH-USDC/v1')),
};
/** A second maker quoting the same pair. */
const WETH_USDC_2: AquaStrategy = { ...WETH_USDC, maker: OTHER_MAKER, salt: keccak256(toHex('xorr/WETH-USDC/v2')) };
/** A book on another pair, with USDC as token0: 100,000 USDC per BTC is 1e15 raw. */
const USDC_CBBTC: AquaStrategy = {
  maker: MAKER,
  token0: USDC,
  token1: CBBTC,
  feeBps: 30n,
  maxDeviationBps: 200n,
  referencePrice: 1_000_000_000_000_000n,
  salt: keccak256(toHex('xorr/USDC-CBBTC/v1')),
};
/** Balances deep enough for anything asked here. */
const DEEP = [2_000_000_000_000_000_000n, 5_000_000_000n] as const;

/** `abi.encode(strategy)` built by hand from the struct: seven static fields, one 32-byte word each, in order. */
const abiEncode = (s: AquaStrategy): Hex =>
  concat([
    pad(s.maker),
    pad(s.token0),
    pad(s.token1),
    numberToHex(s.feeBps, { size: 32 }),
    numberToHex(s.maxDeviationBps, { size: 32 }),
    numberToHex(s.referencePrice, { size: 32 }),
    s.salt,
  ]).toLowerCase() as Hex;

/** The strategy id: `keccak256(abi.encode(strategy))` in the book, and the keccak of the shipped bytes in Aqua. */
const idOf = (s: AquaStrategy): Hex => keccak256(abiEncode(s));

type AquaLog = { eventName: 'Shipped' | 'Docked'; args: Record<string, unknown>; blockNumber: bigint; logIndex: number };
type LogAt = { logIndex?: number; app?: string; maker?: Address };

/**
 * A log as viem decodes Aqua's events: every parameter non-indexed, addresses checksummed — while our app is
 * configured lowercase, so every case also proves the app comparison ignores case.
 */
const shipped = (s: AquaStrategy, blockNumber: bigint, at: LogAt = {}, strategy: Hex = abiEncode(s)): AquaLog => ({
  eventName: 'Shipped',
  args: { maker: at.maker ?? s.maker, app: getAddress(at.app ?? BOOK), strategyHash: keccak256(strategy), strategy },
  blockNumber,
  logIndex: at.logIndex ?? 0,
});
const docked = (s: AquaStrategy, blockNumber: bigint, at: LogAt = {}): AquaLog => ({
  eventName: 'Docked',
  args: { maker: at.maker ?? s.maker, app: getAddress(at.app ?? BOOK), strategyHash: idOf(s) },
  blockNumber,
  logIndex: at.logIndex ?? 0,
});

/** Aqua's log history, answered the way a node answers `eth_getLogs`: by address, event and block range. */
function aquaLogs(logs: AquaLog[]) {
  h.getLogs.mockImplementation(
    async (q: { address: string; event: { name: string }; fromBlock: bigint; toBlock: bigint }) =>
      logs.filter(
        (l) =>
          q.address.toLowerCase() === AQUA.toLowerCase() &&
          l.eventName === q.event.name &&
          l.blockNumber >= q.fromBlock &&
          l.blockNumber <= q.toBlock,
      ),
  );
}

/** `fillForDelegation`, as `delegatedFillArgs` encodes it with `abi.encodeCall`. */
const FILL_ABI = parseAbi([
  'function fillForDelegation((address maker, address token0, address token1, uint256 feeBps, uint256 maxDeviationBps, uint256 referencePrice, bytes32 salt) strategy, address principal, bool zeroForOne, uint256 amountIn, uint256 amountOutMin) returns (uint256 amountOut)',
]);

/** How one book's views answer: its balances, its quote for the size asked, and whether its fill arguments build. */
type Views = { balances: readonly [bigint, bigint] | 'reverts'; quote?: bigint | 'reverts'; fillArgs?: 'reverts' };

/** Our book contract, answering for the strategies it holds and reverting for anything else. */
function bookAnswers(views: [AquaStrategy, Views][]) {
  const byId = new Map(views.map(([s, v]) => [idOf(s), v]));
  h.readContract.mockImplementation(
    async ({ address, functionName, args }: { address: string; functionName: string; args: readonly unknown[] }) => {
      const strategy = args[0] as AquaStrategy;
      const v = address.toLowerCase() === BOOK ? byId.get(idOf(strategy)) : undefined;
      if (!v) throw new Error('execution reverted: SafeBalancesForTokenNotInActiveStrategy');
      if (functionName === 'bookBalances') {
        if (v.balances === 'reverts') throw new Error('execution reverted');
        return v.balances;
      }
      if (functionName === 'quoteExactIn') {
        if (v.quote === undefined || v.quote === 'reverts') throw new Error('execution reverted: PriceOutsideBand');
        return v.quote;
      }
      if (functionName === 'delegatedFillArgs') {
        if (v.fillArgs === 'reverts') throw new Error('execution reverted: SafeBalancesForTokenNotInActiveStrategy');
        const [, principal, zeroForOne, amountIn, amountOutMin] = args as [AquaStrategy, Address, boolean, bigint, bigint];
        // `(tokenIn, address(this), amountIn, abi.encodeCall(this.fillForDelegation, (...)))`, as the contract returns.
        return [
          zeroForOne ? strategy.token0 : strategy.token1,
          BOOK,
          amountIn,
          encodeFunctionData({
            abi: FILL_ABI,
            functionName: 'fillForDelegation',
            args: [strategy, principal, zeroForOne, amountIn, amountOutMin],
          }),
        ];
      }
      throw new Error(`unexpected view ${functionName}`);
    },
  );
}

beforeEach(() => {
  h.getBlockNumber.mockReset().mockResolvedValue(HEAD);
  h.getLogs.mockReset();
  h.readContract.mockReset();
  aquaLogs([]);
  vi.stubEnv('AQUA_BOOK_ADDRESS', BOOK);
  // The official deployment, not whatever this machine points Aqua at.
  vi.stubEnv('AQUA_ADDRESS', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the strategy id', () => {
  it('survives an encode and decode round trip, extreme terms included', () => {
    expect(decodeStrategy(encodeStrategy(WETH_USDC))).toEqual(WETH_USDC);
    const extremes: AquaStrategy = {
      ...USDC_CBBTC,
      feeBps: 0n,
      maxDeviationBps: 0n,
      referencePrice: 2n ** 256n - 1n,
      salt: `0x${'ff'.repeat(32)}`,
    };
    expect(decodeStrategy(encodeStrategy(extremes))).toEqual(extremes);
  });

  it('is encoded as abi.encode of the static struct: seven 32-byte words in declaration order', () => {
    const encoded = encodeStrategy(WETH_USDC);
    expect(encoded).toBe(abiEncode(WETH_USDC));
    // No offset word: a struct of static fields is encoded in place.
    expect(encoded.length).toBe(2 + 7 * 64);
  });

  it('hashes to keccak256 of exactly that encoding, as XorrAquaBook.hashOf does', () => {
    expect(strategyHash(WETH_USDC)).toBe(keccak256(abiEncode(WETH_USDC)));
    // Every term is part of the id, so a book's terms cannot change under it.
    expect(strategyHash({ ...WETH_USDC, feeBps: 31n })).not.toBe(strategyHash(WETH_USDC));
    expect(strategyHash({ ...WETH_USDC, maker: OTHER_MAKER })).not.toBe(strategyHash(WETH_USDC));
  });

  it('reads the events and views by the signatures the Solidity declares', () => {
    expect(toEventSelector(AQUA_EVENTS[0])).toBe(keccak256(toHex('Shipped(address,address,bytes32,bytes)')));
    expect(toEventSelector(AQUA_EVENTS[1])).toBe(keccak256(toHex('Docked(address,address,bytes32)')));
    // IAqua indexes nothing; a decoder expecting an indexed parameter would read no log at all.
    expect(AQUA_EVENTS.flatMap((e) => (e.inputs as readonly { indexed: boolean }[]).map((i) => i.indexed))).toEqual(
      Array(7).fill(false),
    );

    const STRATEGY = '(address,address,address,uint256,uint256,uint256,bytes32)';
    const selectorOf = (name: string) => toFunctionSelector(BOOK_ABI.find((f) => f.name === name)!);
    const expected = (signature: string) => keccak256(toHex(signature)).slice(0, 10);
    expect(selectorOf('isOpen')).toBe(expected(`isOpen(${STRATEGY})`));
    expect(selectorOf('bookBalances')).toBe(expected(`bookBalances(${STRATEGY})`));
    expect(selectorOf('quoteExactIn')).toBe(expected(`quoteExactIn(${STRATEGY},bool,uint256)`));
    expect(selectorOf('delegatedFillArgs')).toBe(expected(`delegatedFillArgs(${STRATEGY},address,bool,uint256,uint256)`));
  });
});

describe("openBooks: replaying Aqua's logs", () => {
  it('finds nothing, and reads nothing, when this deployment has no book', async () => {
    for (const configured of ['', 'not-an-address']) {
      vi.stubEnv('AQUA_BOOK_ADDRESS', configured);
      expect(await openBooks({}), configured).toEqual([]);
    }
    expect(h.getBlockNumber).not.toHaveBeenCalled();
    expect(h.getLogs).not.toHaveBeenCalled();
    expect(h.readContract).not.toHaveBeenCalled();
  });

  it('scans Aqua itself, for both events, over the last 9,000 blocks with no gaps', async () => {
    await openBooks({});

    const queries = h.getLogs.mock.calls.map(
      ([q]) => q as { address: string; event: unknown; fromBlock: bigint; toBlock: bigint },
    );
    expect(new Set(queries.map((q) => q.address))).toEqual(new Set([AQUA]));
    for (const event of AQUA_EVENTS) {
      const windows = queries.filter((q) => q.event === event);
      expect(windows.length, event.name).toBeGreaterThan(0);
      expect(windows[0]!.fromBlock, event.name).toBe(HEAD - 9_000n);
      expect(windows.at(-1)!.toBlock, event.name).toBe(HEAD);
      for (let i = 1; i < windows.length; i += 1) {
        expect(windows[i]!.fromBlock, event.name).toBe(windows[i - 1]!.toBlock + 1n);
      }
    }
  });

  it('scans from genesis on a chain younger than the window', async () => {
    h.getBlockNumber.mockResolvedValue(5_000n);

    await openBooks({});

    expect((h.getLogs.mock.calls[0]![0] as { fromBlock: bigint }).fromBlock).toBe(0n);
  });

  it('finds a shipped book open, with the live balances its book contract reports', async () => {
    aquaLogs([shipped(WETH_USDC, HEAD - 100n)]);
    bookAnswers([[WETH_USDC, { balances: [2_000_000_000_000_000_000n, 5_000_000_000n] }]]);

    expect(await openBooks({})).toEqual([
      { strategy: WETH_USDC, hash: idOf(WETH_USDC), balance0: 2_000_000_000_000_000_000n, balance1: 5_000_000_000n },
    ]);
    expect(h.readContract).toHaveBeenCalledWith({
      address: BOOK,
      abi: BOOK_ABI,
      functionName: 'bookBalances',
      args: [WETH_USDC],
    });
  });

  it('treats a book shipped and then docked as closed, and does not read its balances', async () => {
    aquaLogs([shipped(WETH_USDC, HEAD - 300n), docked(WETH_USDC, HEAD - 200n)]);
    bookAnswers([[WETH_USDC, { balances: DEEP }]]);

    expect(await openBooks({})).toEqual([]);
    expect(h.readContract).not.toHaveBeenCalled();
  });

  it("lets the last event for a maker's strategy decide, whatever came before it", async () => {
    aquaLogs([shipped(WETH_USDC, HEAD - 300n), docked(WETH_USDC, HEAD - 200n), shipped(WETH_USDC, HEAD - 100n)]);
    bookAnswers([[WETH_USDC, { balances: DEEP }]]);

    expect((await openBooks({})).map((b) => b.hash)).toEqual([idOf(WETH_USDC)]);
  });

  /*
   * A position is a maker's, as Aqua keeps it (found writing PLAN.md 3.8's tests): anyone may ship any bytes
   * under any app, so a stranger's logs for a maker's strategy must neither hide the maker's book nor reopen a
   * docked one.
   */
  it("keeps a maker's book open when a stranger ships the same strategy and docks it", async () => {
    aquaLogs([
      shipped(WETH_USDC, HEAD - 300n),
      shipped(WETH_USDC, HEAD - 200n, { maker: STRANGER }),
      docked(WETH_USDC, HEAD - 100n, { maker: STRANGER }),
    ]);
    bookAnswers([[WETH_USDC, { balances: DEEP }]]);

    expect((await openBooks({})).map((b) => b.hash)).toEqual([idOf(WETH_USDC)]);
  });

  it('does not reopen a docked book when a stranger ships its bytes again', async () => {
    aquaLogs([
      shipped(WETH_USDC, HEAD - 300n),
      docked(WETH_USDC, HEAD - 200n),
      shipped(WETH_USDC, HEAD - 100n, { maker: STRANGER }),
    ]);
    bookAnswers([[WETH_USDC, { balances: DEEP }]]);

    expect(await openBooks({})).toEqual([]);
    expect(h.readContract).not.toHaveBeenCalled();
  });

  it('does not list a strategy shipped by anyone but the maker it names', async () => {
    aquaLogs([shipped(WETH_USDC, HEAD - 100n, { maker: STRANGER })]);
    bookAnswers([[WETH_USDC, { balances: DEEP }]]);

    expect(await openBooks({})).toEqual([]);
  });

  it('lets the later log index decide between two events in the same block', async () => {
    const block = HEAD - 10n;
    aquaLogs([
      // Shipped, then docked later in the block: closed.
      shipped(WETH_USDC, block, { logIndex: 4 }),
      docked(WETH_USDC, block, { logIndex: 9 }),
      // Docked, then shipped later in the block: open.
      shipped(USDC_CBBTC, block, { logIndex: 7 }),
      docked(USDC_CBBTC, block, { logIndex: 2 }),
    ]);
    bookAnswers([
      [WETH_USDC, { balances: DEEP }],
      [USDC_CBBTC, { balances: DEEP }],
    ]);

    expect((await openBooks({})).map((b) => b.hash)).toEqual([idOf(USDC_CBBTC)]);
  });

  it("ignores other apps' logs: their Shipped opens nothing here, and their Docked closes nothing here", async () => {
    aquaLogs([
      shipped(USDC_CBBTC, HEAD - 300n, { app: OTHER_APP }),
      shipped(WETH_USDC, HEAD - 200n),
      docked(WETH_USDC, HEAD - 100n, { app: OTHER_APP }),
    ]);
    bookAnswers([
      [WETH_USDC, { balances: DEEP }],
      [USDC_CBBTC, { balances: DEEP }],
    ]);

    expect((await openBooks({})).map((b) => b.hash)).toEqual([idOf(WETH_USDC)]);
  });

  it('filters to the pair asked about, in either token order and any address casing', async () => {
    aquaLogs([shipped(WETH_USDC, HEAD - 200n), shipped(USDC_CBBTC, HEAD - 100n)]);
    bookAnswers([
      [WETH_USDC, { balances: DEEP }],
      [USDC_CBBTC, { balances: DEEP }],
    ]);
    const pair = async (tokenA?: Address, tokenB?: Address) =>
      (await openBooks({ tokenA, tokenB })).map((b) => b.hash);

    expect(await pair(USDC, WETH)).toEqual([idOf(WETH_USDC)]);
    expect(await pair(WETH, USDC)).toEqual([idOf(WETH_USDC)]);
    expect(await pair(CBBTC.toLowerCase() as Address, USDC.toLowerCase() as Address)).toEqual([idOf(USDC_CBBTC)]);
    expect(await pair(WETH, CBBTC)).toEqual([]);
    expect(await pair()).toEqual([idOf(WETH_USDC), idOf(USDC_CBBTC)]);
  });

  it('leaves out a book whose balance read fails, and keeps the rest', async () => {
    aquaLogs([shipped(WETH_USDC, HEAD - 200n), shipped(USDC_CBBTC, HEAD - 100n)]);
    bookAnswers([
      [WETH_USDC, { balances: 'reverts' }],
      [USDC_CBBTC, { balances: [5_000_000_000n, 5_000_000n] }],
    ]);

    expect(await openBooks({})).toEqual([
      { strategy: USDC_CBBTC, hash: idOf(USDC_CBBTC), balance0: 5_000_000_000n, balance1: 5_000_000n },
    ]);
  });

  it('skips a shipped payload that does not decode as a strategy, rather than throwing', async () => {
    aquaLogs([shipped(WETH_USDC, HEAD - 200n, {}, '0x1234'), shipped(USDC_CBBTC, HEAD - 100n)]);
    bookAnswers([[USDC_CBBTC, { balances: DEEP }]]);

    expect((await openBooks({})).map((b) => b.hash)).toEqual([idOf(USDC_CBBTC)]);
  });
});

describe('buildAquaFill', () => {
  /** 100 USDC for WETH, at the scheduled 0.3% as a fraction — what settlement asks. */
  const BUY_WETH = { owner: OWNER, tokenIn: USDC, tokenOut: WETH, amountIn: 100_000_000n, slippage: 0.003 } as const;

  it('returns undefined, and reads nothing, when this deployment has no book', async () => {
    vi.stubEnv('AQUA_BOOK_ADDRESS', '');

    expect(await buildAquaFill(BUY_WETH)).toBeUndefined();
    expect(h.getBlockNumber).not.toHaveBeenCalled();
    expect(h.readContract).not.toHaveBeenCalled();
  });

  it("fills at the book's own quote less slippage, through the calldata the book computes", async () => {
    aquaLogs([shipped(WETH_USDC, HEAD - 100n)]);
    // 0.03995 WETH for 100 USDC.
    bookAnswers([[WETH_USDC, { balances: DEEP, quote: 39_950_000_000_000_000n }]]);
    // 0.03995 WETH less 0.3%.
    const minOut = 39_830_150_000_000_000n;

    const fill = await buildAquaFill(BUY_WETH);

    expect(fill).toEqual({
      token: USDC,
      venue: BOOK,
      amount: 100_000_000n,
      data: expect.stringMatching(/^0x[0-9a-f]+$/),
      quotedOut: 39_950_000_000_000_000n,
      tokenOut: WETH,
      minOut,
      strategy: WETH_USDC,
      hash: idOf(WETH_USDC),
    });
    // USDC is token1, so this pays token1 for token0 — on the quote and on the fill alike.
    expect(h.readContract).toHaveBeenCalledWith({
      address: BOOK,
      abi: BOOK_ABI,
      functionName: 'quoteExactIn',
      args: [WETH_USDC, false, 100_000_000n],
    });
    expect(h.readContract).toHaveBeenCalledWith({
      address: BOOK,
      abi: BOOK_ABI,
      functionName: 'delegatedFillArgs',
      args: [WETH_USDC, OWNER, false, 100_000_000n, minOut],
    });
    // What `spend()` forwards pays the owner, and holds the book to that same floor.
    expect(decodeFunctionData({ abi: FILL_ABI, data: fill!.data })).toEqual({
      functionName: 'fillForDelegation',
      args: [WETH_USDC, OWNER, false, 100_000_000n, minOut],
    });
  });

  it('pays token0 for token1 when the input is token0', async () => {
    aquaLogs([shipped(WETH_USDC, HEAD - 100n)]);
    // 24.925 USDC for 0.01 WETH.
    bookAnswers([[WETH_USDC, { balances: DEEP, quote: 24_925_000n }]]);

    const fill = await buildAquaFill({
      owner: OWNER,
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: 10_000_000_000_000_000n,
      slippage: 0.003,
    });

    expect(fill).toMatchObject({
      token: WETH,
      amount: 10_000_000_000_000_000n,
      quotedOut: 24_925_000n,
      tokenOut: USDC,
      minOut: 24_850_225n,
    });
    expect(h.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'quoteExactIn', args: [WETH_USDC, true, 10_000_000_000_000_000n] }),
    );
  });

  it('takes the book that returns the most, not the first one found', async () => {
    aquaLogs([shipped(WETH_USDC, HEAD - 200n), shipped(WETH_USDC_2, HEAD - 100n)]);
    bookAnswers([
      [WETH_USDC, { balances: DEEP, quote: 39_900_000_000_000_000n }],
      [WETH_USDC_2, { balances: DEEP, quote: 39_950_000_000_000_000n }],
    ]);

    const fill = await buildAquaFill(BUY_WETH);

    expect(fill?.hash).toBe(idOf(WETH_USDC_2));
    expect(fill?.quotedOut).toBe(39_950_000_000_000_000n);
    expect(fill?.minOut).toBe(39_830_150_000_000_000n);
  });

  it('returns undefined when no open book can serve the size — a zero quote, or one the price band refuses', async () => {
    aquaLogs([shipped(WETH_USDC, HEAD - 200n), shipped(WETH_USDC_2, HEAD - 100n)]);
    bookAnswers([
      [WETH_USDC, { balances: DEEP, quote: 0n }],
      [WETH_USDC_2, { balances: DEEP, quote: 'reverts' }],
    ]);

    expect(await buildAquaFill(BUY_WETH)).toBeUndefined();
    expect(h.readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: 'delegatedFillArgs' }));
  });

  it('skips a book whose fill arguments do not build, even when it quotes best', async () => {
    aquaLogs([shipped(WETH_USDC, HEAD - 200n), shipped(WETH_USDC_2, HEAD - 100n)]);
    bookAnswers([
      [WETH_USDC, { balances: DEEP, quote: 39_990_000_000_000_000n, fillArgs: 'reverts' }],
      [WETH_USDC_2, { balances: DEEP, quote: 39_950_000_000_000_000n }],
    ]);

    expect((await buildAquaFill(BUY_WETH))?.hash).toBe(idOf(WETH_USDC_2));
  });

  it('returns undefined when no open book trades the pair, without asking any book for a quote', async () => {
    aquaLogs([shipped(USDC_CBBTC, HEAD - 100n)]);
    bookAnswers([[USDC_CBBTC, { balances: DEEP, quote: 99_000n }]]);

    expect(await buildAquaFill(BUY_WETH)).toBeUndefined();
    expect(h.readContract).not.toHaveBeenCalled();
  });

  it('returns undefined when discovery fails, and says so rather than passing it off as "no books"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.getLogs.mockRejectedValue(new Error('fetch failed'));

    expect(await buildAquaFill(BUY_WETH)).toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain(`[aqua] could not read books from ${BOOK}: fetch failed`);
    warn.mockRestore();
  });
});
