/**
 * Settling through 1inch Aqua — the taker side of our own book.
 *
 * ## Why this file exists
 *
 * `graph/decide.ts` has always been able to answer "route this through Aqua". It reads the Aqua
 * index, finds a maker book deep enough to fill the size, and returns
 * `{ venue: 'aqua', strategyHash, maker }`. And `runStrategy` **threw that answer away** — it used
 * `.act`, `.reason` and `.rationale`, and never read `.route`. Every fill went to the aggregator.
 * The venue decision, which is the entire point of joining two subgraphs, changed nothing.
 *
 * `XorrAquaBook.delegatedFillArgs` has been waiting for a caller the whole time: it returns exactly
 * `(token, venue, amount, data)` — the four arguments `XorrDelegation.spend()` takes. So the fill
 * goes through the same permission the user signed, with the cap, the expiry and the venue
 * allowlist all enforced by the contract rather than by us. The bot is a taker against a maker who
 * self-custodies; neither side has handed anyone their money.
 *
 * ## Discovery is a CHAIN read, not an index read
 *
 * The index is a convenience and it is sometimes not there — the Aqua subgraph has no Studio slug,
 * and on a fork there is no index at all. Making the route depend on it meant the Aqua path could
 * never execute in either environment, which is how it stayed unreachable for so long without
 * anyone noticing.
 *
 * So books are discovered from our own contract's `BookShipped` / `BookDocked` events and their
 * live balances re-read with `bookBalances`. The contract is the authority here as everywhere else;
 * the index, when it exists, only makes the search cheaper.
 */
import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
} from 'viem';
import { publicClient } from '../evm/client.js';
import { getLogsPaged } from '../evm/logs.js';
import { log } from '../http/request-id.js';

/** The book's own terms. Hashed to produce the Aqua strategy id, so they are immutable. */
export type AquaStrategy = {
  maker: Address;
  token0: Address;
  token1: Address;
  feeBps: bigint;
  maxDeviationBps: bigint;
  referencePrice: bigint;
  salt: Hex;
};

const STRATEGY_TUPLE = parseAbiParameters(
  '(address maker, address token0, address token1, uint256 feeBps, uint256 maxDeviationBps, uint256 referencePrice, bytes32 salt)',
);

/**
 * Aqua's OWN events, taken from `contracts/lib/aqua/src/interfaces/IAqua.sol`.
 *
 * Every parameter is NON-indexed and the order is `maker, app` — both of which I guessed wrong the
 * first time, and a wrong ABI does not throw: `getLogs` filters on a topic0 that nothing emits and
 * returns an empty array, which is indistinguishable from "no books". The signatures are copied
 * from the vendored interface rather than remembered.
 *
 * `Shipped` carries the strategy PREIMAGE, which is what makes chain-only discovery possible: the
 * terms come from the protocol's own log, not from a copy we kept.
 */
export const AQUA_EVENTS = [
  {
    type: 'event',
    name: 'Shipped',
    inputs: [
      { name: 'maker', type: 'address', indexed: false },
      { name: 'app', type: 'address', indexed: false },
      { name: 'strategyHash', type: 'bytes32', indexed: false },
      { name: 'strategy', type: 'bytes', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Docked',
    inputs: [
      { name: 'maker', type: 'address', indexed: false },
      { name: 'app', type: 'address', indexed: false },
      { name: 'strategyHash', type: 'bytes32', indexed: false },
    ],
  },
] as const;

export const BOOK_ABI = [
  {
    type: 'function',
    name: 'isOpen',
    stateMutability: 'view',
    inputs: [{ name: 'strategy', type: 'tuple', components: [
      { name: 'maker', type: 'address' },
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'feeBps', type: 'uint256' },
      { name: 'maxDeviationBps', type: 'uint256' },
      { name: 'referencePrice', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
    ] }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'bookBalances',
    stateMutability: 'view',
    inputs: [{ name: 'strategy', type: 'tuple', components: [
      { name: 'maker', type: 'address' },
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'feeBps', type: 'uint256' },
      { name: 'maxDeviationBps', type: 'uint256' },
      { name: 'referencePrice', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
    ] }],
    outputs: [
      { name: 'balance0', type: 'uint256' },
      { name: 'balance1', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'quoteExactIn',
    stateMutability: 'view',
    inputs: [
      { name: 'strategy', type: 'tuple', components: [
        { name: 'maker', type: 'address' },
        { name: 'token0', type: 'address' },
        { name: 'token1', type: 'address' },
        { name: 'feeBps', type: 'uint256' },
        { name: 'maxDeviationBps', type: 'uint256' },
        { name: 'referencePrice', type: 'uint256' },
        { name: 'salt', type: 'bytes32' },
      ] },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'delegatedFillArgs',
    stateMutability: 'view',
    inputs: [
      { name: 'strategy', type: 'tuple', components: [
        { name: 'maker', type: 'address' },
        { name: 'token0', type: 'address' },
        { name: 'token1', type: 'address' },
        { name: 'feeBps', type: 'uint256' },
        { name: 'maxDeviationBps', type: 'uint256' },
        { name: 'referencePrice', type: 'uint256' },
        { name: 'salt', type: 'bytes32' },
      ] },
      { name: 'principal', type: 'address' },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
    ],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'venue', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
  },
] as const;

/** The official Aqua deployment — the same address on every chain it ships to. */
export function aquaAddress(): Address {
  return (process.env.AQUA_ADDRESS as Address) ?? '0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a';
}

/** Our deployment, when there is one. Aqua is Base mainnet only. */
export function bookAddress(): Address | undefined {
  const a = process.env.AQUA_BOOK_ADDRESS;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as Address) : undefined;
}

export function strategyHash(s: AquaStrategy): Hex {
  return keccak256(encodeAbiParameters(STRATEGY_TUPLE, [s]));
}

/** Testing and diagnostics: the encoding the contract hashes, so both sides can be compared. */
export function encodeStrategy(s: AquaStrategy): Hex {
  return encodeAbiParameters(STRATEGY_TUPLE, [s]);
}

export function decodeStrategy(encoded: Hex): AquaStrategy {
  return decodeAbiParameters(STRATEGY_TUPLE, encoded)[0] as AquaStrategy;
}

/**
 * How far back to look for books, in blocks.
 *
 * Public Base RPCs — including the one anvil forks from — refuse `eth_getLogs` over more than
 * **10,000 blocks**. A 200,000-block window returned `-32614 eth_getLogs is limited to a 10,000
 * range`, the caller's `.catch` turned that into `undefined`, and every trade quietly went to the
 * aggregator with no Aqua fill and no error. A silent fallback is the exact failure this codebase
 * refuses everywhere else, and it was in the code meant to fix it.
 *
 * So: inside the limit by default, and overridable for a node that allows more. A book shipped
 * further back than this window is found through the Aqua index instead, which is what the index
 * is for — the chain scan exists so the path still works when the index does not.
 */
const LOOKBACK_BLOCKS = BigInt(process.env.AQUA_LOOKBACK_BLOCKS ?? 9_000);

/**
 * The open Aqua positions a replay of `Shipped`/`Docked` logs leaves — one per maker and strategy hash.
 *
 * Aqua keeps balances per maker, app and strategy hash, and anyone may ship any bytes under any app. Keyed by
 * the hash alone, a stranger who shipped a maker's strategy with nothing in it and then docked it closed that
 * maker's open book for every fill that looked, for the price of gas; and a stranger re-shipping a docked book's
 * bytes reopened it (found writing PLAN.md 3.8's tests). So the state is per (maker, hash): the last event for
 * that pair decides, and the bytes are the ones that maker shipped. Callers still check that the maker is the
 * one the payload names, because that is the only position the book contract or the SwapVM router reads.
 */
export function replayPositions(
  events: { l: { args: { maker?: unknown; strategyHash?: unknown; strategy?: unknown } }; open: boolean }[],
): { hash: Hex; maker: string; encoded: Hex }[] {
  const state = new Map<string, { hash: Hex; maker: string; open: boolean; encoded?: Hex }>();
  for (const { l, open } of events) {
    const hash = l.args.strategyHash as Hex;
    const maker = String(l.args.maker).toLowerCase();
    const key = `${maker}:${hash}`;
    const encoded = (l.args.strategy as Hex | undefined) ?? state.get(key)?.encoded;
    state.set(key, { hash, maker, open, encoded });
  }
  const out: { hash: Hex; maker: string; encoded: Hex }[] = [];
  for (const { hash, maker, open, encoded } of state.values()) {
    if (open && encoded) out.push({ hash, maker, encoded });
  }
  return out;
}

/** Every book still open on our app, with its live balances. Cheapest search first. */
export async function openBooks(params: {
  /** Restrict to books quoting this pair, in either direction. */
  tokenA?: Address;
  tokenB?: Address;
}): Promise<{ strategy: AquaStrategy; hash: Hex; balance0: bigint; balance1: bigint }[]> {
  const app = bookAddress();
  if (!app) return [];

  const head = await publicClient.getBlockNumber();
  const fromBlock = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
  const aqua = aquaAddress();

  /*
   * Sequential, not `Promise.all`. These endpoints rate-limit as well as range-limit, and firing
   * both paged scans at once trades one refusal for the other.
   */
  const shipped = await getLogsPaged({ address: aqua, event: AQUA_EVENTS[0], fromBlock, toBlock: head });
  const docked = await getLogsPaged({ address: aqua, event: AQUA_EVENTS[1], fromBlock, toBlock: head });

  /*
   * A book can be shipped, docked and shipped again, so the LAST event for a hash decides.
   * Ordering by block then log index is what makes "still open" mean the current state rather
   * than "was ever opened".
   *
   * Filtered to OUR app: Aqua is shared liquidity, so these logs carry every app's books.
   */
  const mine = (a: unknown) => String(a).toLowerCase() === app.toLowerCase();
  const events = [
    ...shipped.filter((l) => mine(l.args.app)).map((l) => ({ l, open: true })),
    ...docked.filter((l) => mine(l.args.app)).map((l) => ({ l, open: false })),
  ].sort((a, b) => Number(a.l.blockNumber! - b.l.blockNumber!) || Number(a.l.logIndex! - b.l.logIndex!));

  const out: { strategy: AquaStrategy; hash: Hex; balance0: bigint; balance1: bigint }[] = [];
  for (const { hash, maker, encoded } of replayPositions(events)) {
    let strategy: AquaStrategy;
    try {
      strategy = decodeStrategy(encoded);
    } catch {
      continue;
    }
    // Only the position the book reads: the one shipped by the maker the strategy names.
    if (strategy.maker.toLowerCase() !== maker) continue;
    if (params.tokenA && params.tokenB) {
      const pair = [strategy.token0.toLowerCase(), strategy.token1.toLowerCase()].sort().join('/');
      const want = [params.tokenA.toLowerCase(), params.tokenB.toLowerCase()].sort().join('/');
      if (pair !== want) continue;
    }
    const balances = await publicClient
      .readContract({ address: app, abi: BOOK_ABI, functionName: 'bookBalances', args: [strategy] })
      .catch(() => undefined);
    if (!balances) continue;
    out.push({ strategy, hash, balance0: balances[0], balance1: balances[1] });
  }
  return out;
}

export type AquaFill = {
  /** What `XorrDelegation.spend()` is called with. */
  token: Address;
  venue: Address;
  amount: bigint;
  data: Hex;
  /** What the book says the taker receives, before the minimum is applied. */
  quotedOut: bigint;
  /** What the owner receives, and the floor `spend()` holds their balance to (PLAN.md 1.4). */
  tokenOut: Address;
  minOut: bigint;
  strategy: AquaStrategy;
  hash: Hex;
};

/**
 * Build a fill against the deepest book that can serve this size.
 *
 * Returns `undefined` rather than throwing when no book can — the caller routes to the aggregator,
 * which is the correct outcome and not an error. A book that cannot fill the size is Aqua working:
 * a maker quotes what they hold.
 */
export async function buildAquaFill(params: {
  owner: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Fraction below the quote the fill may still accept, e.g. 0.005 for 0.5%. */
  slippage: number;
}): Promise<AquaFill | undefined> {
  const app = bookAddress();
  if (!app) return undefined;

  /*
   * A discovery failure is reported, not swallowed.
   *
   * The caller treats `undefined` as "no book can fill this", which is a legitimate and common
   * answer — and it is indistinguishable from "the log query failed" unless the failure says so.
   * That indistinguishability is what hid a broken 200,000-block window behind a working
   * aggregator fill.
   */
  let books: Awaited<ReturnType<typeof openBooks>>;
  try {
    books = await openBooks({ tokenA: params.tokenIn, tokenB: params.tokenOut });
  } catch (e) {
    log.warn(
      `[aqua] could not read books from ${app}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
  if (books.length === 0) return undefined;

  const candidates: AquaFill[] = [];
  for (const b of books) {
    // `zeroForOne` is "paying token0 to receive token1" — the direction our input implies.
    const zeroForOne = b.strategy.token0.toLowerCase() === params.tokenIn.toLowerCase();
    const quotedOut = await publicClient
      .readContract({
        address: app,
        abi: BOOK_ABI,
        functionName: 'quoteExactIn',
        args: [b.strategy, zeroForOne, params.amountIn],
      })
      .catch(() => 0n);
    // A book that quotes nothing for this size cannot fill it. The oracle band refuses too far
    // from the reference price, which is the check that makes a 24/7 book on a 24/5 asset safe.
    if (quotedOut === 0n) continue;

    const minOut =
      (quotedOut * BigInt(Math.round((1 - params.slippage) * 1_000_000))) / 1_000_000n;
    const args = await publicClient
      .readContract({
        address: app,
        abi: BOOK_ABI,
        functionName: 'delegatedFillArgs',
        args: [b.strategy, params.owner, zeroForOne, params.amountIn, minOut],
      })
      .catch(() => undefined);
    if (!args) continue;

    candidates.push({
      token: args[0],
      venue: args[1],
      amount: args[2],
      data: args[3],
      quotedOut,
      tokenOut: params.tokenOut,
      minOut,
      strategy: b.strategy,
      hash: b.hash,
    });
  }

  // Best execution: the book that returns the most, which is what a taker actually cares about.
  candidates.sort((a, b) => (b.quotedOut > a.quotedOut ? 1 : b.quotedOut < a.quotedOut ? -1 : 0));
  return candidates[0];
}
