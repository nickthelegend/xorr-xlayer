/**
 * Filling against a maker's SwapVM program.
 *
 * `XorrSwapVMBook` was written, deployed and covered by ten fork tests, and the running executor
 * never called it — the README said "Contract only" for exactly that reason. This is the module
 * that makes it a venue rather than an artefact.
 *
 * ## What SwapVM is, as it matters here
 *
 * An Aqua book quotes from a curve the book contract evaluates. A SwapVM book ships a **program**:
 * the maker compiles the terms of their offer — a deadline, a slippage floor, a fee, a salt — into
 * bytecode that the SwapVM router executes at fill time. The rules are enforced inside the VM
 * rather than trusted to whoever submits the fill, which is the whole point and the reason the
 * deadline in `XorrSwapVMBook` really does expire.
 *
 * ## Why discovery looks like Aqua's
 *
 * Because it IS Aqua's. A SwapVM maker still ships to Aqua for the inventory; what differs is the
 * `app` on the shipped strategy — the SwapVM ROUTER, not our book — and the payload, which decodes
 * as an `ISwapVM.Order` rather than an Aqua curve tuple. So the same `Shipped`/`Docked` log walk
 * finds them, filtered on a different app.
 *
 * Every parameter on those events is non-indexed and the order is `(maker, app, hash, strategy)`.
 * That cost real time to establish once: a wrong ABI returns `[]`, which is indistinguishable from
 * "no books are open". The lesson is inherited here rather than relearned.
 */
import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters, type Address, type Hex } from 'viem';
import { log } from '../http/request-id.js';
import { publicClient, delegateAccount } from '../evm/client.js';
import { getLogsPaged } from '../evm/logs.js';
import { AQUA_EVENTS, aquaAddress, replayPositions } from './aqua.js';
import { DELEGATION_ABI, DELEGATION_ADDRESS } from '../evm/delegation.js';

/**
 * The official 1inch SwapVM router on Base — the Aqua "app" a SwapVM book is shipped under.
 *
 * Overridable because the fork bootstrap can point at a different deployment, and hardcoding an
 * address that moves is how a venue silently stops being found.
 */
const SWAP_VM: Address =
  (process.env.SWAPVM_ADDRESS as Address) ?? '0x111111338c5091E8440b67B168bAe16a668AC0De';

/** Our book contract, deployed by `fork-bootstrap`. Absent on a chain where it was never deployed. */
export function swapVmBookAddress(): Address | undefined {
  const a = process.env.SWAPVM_BOOK_ADDRESS;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as Address) : undefined;
}

/**
 * The `ISwapVM.Order` layout — three fields, exactly as the interface declares it.
 *
 * This described FOUR: `(address maker, address receiver, uint256 makerTraits, bytes program)`.
 * The real struct in `lib/swap-vm/src/interfaces/ISwapVM.sol` is
 *
 *     struct Order { address maker; MakerTraits traits; bytes data; }
 *
 * with `type MakerTraits is uint256`. Everything a taker needs is packed INTO `traits` by
 * `MakerTraitsLib.build` — the receiver, the hook flags and their targets — which is why there is no
 * separate `receiver` field to name.
 *
 * The wrong shape decoded silently rather than throwing: an ABI decoder handed a 3-field payload
 * and a 4-field layout reads the `bytes` offset as `makerTraits` and comes back with
 * `makerTraits: 96, program: '0x'`. `openPrograms()` then treated the result as a valid order and
 * `delegatedFillArgs` reverted on it — and the catch above logs that as "another app's payload",
 * which is exactly what it looks like. That is why SwapVM never filled: not a missing maker, a
 * layout that could not have worked if one had existed.
 *
 * Found by writing `live-swapvm.ts` and watching `shipArgs` revert on an order the book itself had
 * just built.
 */
const ORDER_TUPLE = parseAbiParameters('(address maker, uint256 traits, bytes data)');

export type SwapVmOrder = {
  maker: Address;
  /** `MakerTraits`, a packed uint256: receiver, hook flags and their targets all live in here. */
  traits: bigint;
  /** The shipped program bytecode the router executes at fill time. */
  data: Hex;
};

export function decodeOrder(encoded: Hex): SwapVmOrder {
  const [o] = decodeAbiParameters(ORDER_TUPLE, encoded);
  return o as SwapVmOrder;
}

export function encodeOrder(order: SwapVmOrder): Hex {
  return encodeAbiParameters(ORDER_TUPLE, [order] as never);
}

const BOOK_ABI = [
  {
    type: 'function',
    name: 'delegatedFillArgs',
    stateMutability: 'view',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: [
          { name: 'maker', type: 'address' },
          { name: 'traits', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
      { name: 'principal', type: 'address' },
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
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

/** RPCs cap `eth_getLogs` at 10k blocks; asking for more is a silent empty result. */
const LOOKBACK_BLOCKS = BigInt(process.env.SWAPVM_LOOKBACK_BLOCKS ?? 9_000);

/** Every SwapVM program still shipped, newest state wins. */
export async function openPrograms(): Promise<{ order: SwapVmOrder; hash: Hex }[]> {
  const head = await publicClient.getBlockNumber();
  const fromBlock = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
  const aqua = aquaAddress();

  /*
   * Sequential, not `Promise.all`. These endpoints rate-limit as well as range-limit, and firing
   * both paged scans at once trades one refusal for the other.
   */
  const shipped = await getLogsPaged({ address: aqua, event: AQUA_EVENTS[0], fromBlock, toBlock: head });
  const docked = await getLogsPaged({ address: aqua, event: AQUA_EVENTS[1], fromBlock, toBlock: head });

  // Aqua is shared liquidity: these logs carry every app's books. Ours are the ones whose app is
  // the SwapVM router — that is what distinguishes a program from an ordinary Aqua curve.
  const isSwapVm = (a: unknown) => String(a).toLowerCase() === SWAP_VM.toLowerCase();
  const events = [
    ...shipped.filter((l) => isSwapVm(l.args.app)).map((l) => ({ l, open: true })),
    ...docked.filter((l) => isSwapVm(l.args.app)).map((l) => ({ l, open: false })),
  ].sort(
    (a, b) => Number(a.l.blockNumber! - b.l.blockNumber!) || Number(a.l.logIndex! - b.l.logIndex!),
  );

  // Per maker and hash, as Aqua keeps them: keyed by hash alone, anyone could close or reopen a program here.
  const out: { order: SwapVmOrder; hash: Hex }[] = [];
  for (const { hash, maker, encoded } of replayPositions(events)) {
    let order: SwapVmOrder;
    try {
      order = decodeOrder(encoded);
    } catch {
      // A payload we cannot decode is another app's, or a version we do not speak. Not an error.
      continue;
    }
    // Only the position the router reads: the one shipped by the maker the order names.
    if (order.maker.toLowerCase() !== maker) continue;
    out.push({ order, hash });
  }
  return out;
}

export type SwapVmFill = {
  token: Address;
  venue: Address;
  amount: bigint;
  data: Hex;
  /** What the owner receives; `minOut` below is the floor `spend()` holds their balance to. */
  tokenOut: Address;
  order: SwapVmOrder;
  hash: Hex;
  /**
   * The floor the program is bound to, in OUT-token units.
   *
   * A SwapVM maker does not quote a price: the router computes the fill at execution and the
   * bytecode enforces a minimum below which it reverts. That floor is the only number this venue
   * actually promises, so it is the only one worth reporting — and it is exposed here rather than
   * left as a local so a comparison surface can name it without recomputing the arithmetic and
   * risking a second, drifting implementation of it.
   */
  minOut: bigint;
  /**
   * What the program delivers for exactly this fill (PLAN.md 3.20). The dry run of `spend()` executes the fill,
   * and `spend()` returns the venue's own return data — `fillForDelegation`'s amount out. Undefined when that
   * came back empty or undecodable; the floor is then all that is known.
   */
  expectedOut?: bigint;
};

/** The amount out a venue call returned through `spend()`, or undefined when there is none to read. */
function deliveredBy(result: Hex | undefined): bigint | undefined {
  if (!result || result === '0x') return undefined;
  try {
    return decodeAbiParameters([{ type: 'uint256' }], result)[0];
  } catch {
    return undefined;
  }
}

/**
 * Build a fill against a shipped program.
 *
 * `undefined` when there is nothing to fill against, which is the ordinary case and not an error —
 * the caller routes to Aqua or the aggregator. A discovery FAILURE is logged, because "no programs
 * are shipped" and "the log query broke" are the same answer to the caller otherwise, and that
 * indistinguishability is what once hid a wrong block window behind a working aggregator fill.
 */
export async function buildSwapVmFill(params: {
  owner: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Fraction below the quote the fill may still accept, e.g. 0.005 for 0.5%. */
  slippage: number;
  /** What the taker expects out, from whatever quoted this trade. */
  quotedOut: bigint;
}): Promise<SwapVmFill | undefined> {
  const book = swapVmBookAddress();
  if (!book) return undefined;

  let programs: Awaited<ReturnType<typeof openPrograms>>;
  try {
    programs = await openPrograms();
  } catch (e) {
    log.warn(
      `[swapvm] could not read programs from ${aquaAddress()}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
  if (programs.length === 0) return undefined;

  const minOut = (params.quotedOut * BigInt(Math.round((1 - params.slippage) * 1_000_000))) / 1_000_000n;
  if (minOut <= 0n) return undefined;

  const candidates: SwapVmFill[] = [];
  for (const p of programs) {
    /*
     * Ask the BOOK to compute the call, rather than encoding it here.
     *
     * `delegatedFillArgs` is a view on the contract that will execute the fill, so what it returns
     * is what that contract will accept. Building the calldata in TypeScript would be a second
     * implementation of the same encoding, free to drift from the first.
     */
    const args = await publicClient
      .readContract({
        address: book,
        abi: BOOK_ABI,
        functionName: 'delegatedFillArgs',
        args: [p.order, params.owner, params.tokenIn, params.tokenOut, params.amountIn, minOut],
      })
      .catch(() => undefined);
    if (!args) continue;

    const [token, venue, amount, data] = args;

    /*
     * Simulate the real `spend()` before offering this program to the settlement path.
     *
     * `delegatedFillArgs` is an ENCODER. It is a pure view that returns calldata for any order it
     * is handed, including one that cannot fill, so "the view returned bytes" says nothing about
     * whether the trade would go through. This function used to return the first program it could
     * encode, and the first program on Aqua is not the first program that still has inventory.
     *
     * That cost a real fill: a maker whose strategy had been superseded was still `Shipped` in
     * Aqua's logs, so it was still discovered, and the fill reverted three frames deep with
     * `SafeBalancesForTokenNotInActiveStrategy`. Worse than the revert is what follows it — the
     * caller prefers a SwapVM plan over the aggregator, so a stale program does not degrade to a
     * worse fill, it loses the trade entirely.
     *
     * So the test is the transaction itself, from the delegate that will send it. A candidate that
     * cannot fill is skipped and the loop moves on; if none can, the caller routes to 1inch, which
     * is the correct outcome rather than a failure.
     */
    const dryRun = await publicClient
      .simulateContract({
        account: delegateAccount,
        address: DELEGATION_ADDRESS,
        abi: DELEGATION_ABI,
        functionName: 'spend',
        args: [params.owner, token, venue, amount, params.tokenOut, minOut, data],
      })
      .then((r) => ({ fillable: true as const, result: r.result as Hex | undefined }))
      .catch(() => ({ fillable: false as const, result: undefined }));
    if (!dryRun.fillable) continue;

    candidates.push({
      token,
      venue,
      amount,
      data,
      tokenOut: params.tokenOut,
      order: p.order,
      hash: p.hash,
      minOut,
      expectedOut: deliveredBy(dryRun.result),
    });
  }

  /*
   * The program that delivers the most, not the first one that can fill (PLAN.md 3.20) — the rule `buildAquaFill`
   * already applies to books. Several programs can be open at once and discovery order says nothing about price: a
   * program's price moves with every fill against its curve, so the first one shipped is often the one most traded
   * against. A program whose dry run returned nothing to read is ranked by its floor, the least it can deliver.
   */
  const delivers = (f: SwapVmFill) => f.expectedOut ?? f.minOut;
  candidates.sort((a, b) => (delivers(b) > delivers(a) ? 1 : delivers(b) < delivers(a) ? -1 : 0));
  return candidates[0];
}
