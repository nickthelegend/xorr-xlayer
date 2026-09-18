/**
 * `XorrSwapVMBook` was deployed, covered by ten fork tests, and never called by the running
 * executor — an artefact rather than a venue. These tests cover the module that changes that, and
 * specifically the two things that made the Aqua equivalent hard to get right.
 *
 * **Discovery is a filter on someone else's logs.** Aqua is shared liquidity: `Shipped`/`Docked`
 * carry every app's books. A SwapVM program is distinguished only by its `app` being the SwapVM
 * router. Filtering on the wrong thing returns `[]`, which is indistinguishable from "nothing is
 * shipped" — the failure that once hid a broken block window behind a working aggregator fill.
 *
 * **The last event for a hash decides.** A book can be shipped, docked and shipped again.
 */
process.env.ONEINCH_API_KEY ??= 'test-key';
process.env.XORR_CHAIN ??= 'xlayer-testnet';
process.env.SWAPVM_BOOK_ADDRESS ??= '0x6cc8379b893d0239392720368f901b56c0f51e53';

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { encodeAbiParameters, parseAbiParameters } from 'viem';

const getLogs = vi.fn();
const readContract = vi.fn();
const getBlockNumber = vi.fn(async () => 1_000_000n);
/** The dry run of `spend()` that decides whether a discovered program can actually fill. */
const simulateContract = vi.fn(async (..._a: unknown[]): Promise<{ request: object; result?: unknown }> => ({ request: {} }));

vi.mock('../evm/client.js', () => ({
  publicClient: {
    getLogs: (...a: unknown[]) => getLogs(...a),
    readContract: (...a: unknown[]) => readContract(...a),
    getBlockNumber: () => getBlockNumber(),
    simulateContract: (...a: unknown[]) => simulateContract(...a),
  },
  delegateAccount: { address: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5' },
  walletClient: {},
}));

const { openPrograms, buildSwapVmFill, encodeOrder, decodeOrder, swapVmBookAddress } = await import(
  './swapvm.js'
);

const SWAP_VM = '0x111111338c5091E8440b67B168bAe16a668AC0De';
const OTHER_APP = '0xff0845130ca2b077c0cdf964d162fb00e869c199';
const MAKER = '0x02a54677000000000000000000000000000000aa';
/** Anyone else — Aqua lets any address ship any bytes under any app. */
const STRANGER = '0x0000000000000000000000000000000000005742';

/**
 * `ISwapVM.Order` — three fields. It used to be built here with four, matching a wrong ORDER_TUPLE,
 * and the round-trip test below passed because it encoded and decoded through the SAME wrong
 * layout. Self-consistency is not agreement with the chain, which is what the assertion added
 * below now pins.
 */
const order = (data: `0x${string}` = '0xdeadbeef') => ({
  maker: MAKER as `0x${string}`,
  traits: 1n,
  data,
});

/** A `Shipped`/`Docked` log as viem decodes it: every parameter non-indexed. */
const evt = (app: string, hash: string, strategy: string, block: bigint, logIndex: number, maker: string = MAKER) => ({
  args: { maker, app, strategyHash: hash, strategy },
  blockNumber: block,
  logIndex,
});

/**
 * Answer by EVENT, not by call order.
 *
 * `mockResolvedValueOnce` twice assumed discovery makes exactly two `eth_getLogs` calls, which is
 * an implementation detail — and it stopped being true the moment the scan started paging the
 * range into windows the provider will serve. Dispatching on the event says what the test means
 * ("these books were shipped, those were docked") and survives however many requests that takes.
 */
function byEvent(shipped: unknown[], docked: unknown[]) {
  getLogs.mockImplementation(async (args: { event?: { name?: string } }) =>
    args?.event?.name === 'Docked' ? docked : shipped,
  );
}

beforeEach(() => {
  getLogs.mockReset();
  readContract.mockReset();
  simulateContract.mockReset();
  simulateContract.mockResolvedValue({ request: {} });
});

describe('the order round-trips through the wire format', () => {
  it('encodes and decodes without losing the program', () => {
    const o = order('0xc0ffee');
    const back = decodeOrder(encodeOrder(o));
    expect(back.maker.toLowerCase()).toBe(MAKER.toLowerCase());
    expect(back.data).toBe('0xc0ffee');
    expect(back.traits).toBe(1n);
  });

  /*
   * The assertion the old test was missing.
   *
   * A round trip through our own encoder proves the encoder agrees with the decoder and nothing
   * more — both were wrong together for as long as this file has existed, describing a four-field
   * order against a three-field struct. What matters is agreeing with the CHAIN, so this pins the
   * layout against the interface: `struct Order { address maker; MakerTraits traits; bytes data; }`
   * in lib/swap-vm/src/interfaces/ISwapVM.sol, where `type MakerTraits is uint256`.
   *
   * Decoding a payload encoded to the real three-field shape is the check. Under the old layout it
   * came back `traits: 96n` — an ABI offset read as a value — with an empty program, which is
   * exactly what `delegatedFillArgs` reverted on.
   */
  it('matches the three-field struct the contract declares', () => {
    const real = encodeAbiParameters(
      parseAbiParameters('(address maker, uint256 traits, bytes data)'),
      [{ maker: MAKER as `0x${string}`, traits: 7n, data: '0xbeef' }] as never,
    );
    const back = decodeOrder(real);
    expect(back.maker.toLowerCase()).toBe(MAKER.toLowerCase());
    expect(back.traits).toBe(7n);
    expect(back.data).toBe('0xbeef');
  });
});

describe('discovery filters on the SwapVM app, not ours', () => {
  it('finds a shipped program', async () => {
    const enc = encodeOrder(order());
    byEvent([evt(SWAP_VM, '0xaa', enc, 10n, 0)], []);
    const found = await openPrograms();
    expect(found).toHaveLength(1);
    expect(found[0]!.hash).toBe('0xaa');
    expect(found[0]!.order.data).toBe('0xdeadbeef');
  });

  it('ignores books shipped under another app — Aqua is shared liquidity', async () => {
    const enc = encodeOrder(order());
    byEvent([evt(OTHER_APP, '0xbb', enc, 10n, 0)], []);
    expect(await openPrograms()).toHaveLength(0);
  });

  it('the LAST event for a hash decides, so a docked book is closed', async () => {
    const enc = encodeOrder(order());
    byEvent([evt(SWAP_VM, '0xcc', enc, 10n, 0)], [evt(SWAP_VM, '0xcc', enc, 20n, 0)]);
    expect(await openPrograms()).toHaveLength(0);
  });

  it('a re-shipped book is open again', async () => {
    const enc = encodeOrder(order());
    byEvent([evt(SWAP_VM, '0xdd', enc, 10n, 0), evt(SWAP_VM, '0xdd', enc, 30n, 0)], [evt(SWAP_VM, '0xdd', enc, 20n, 0)]);
    expect(await openPrograms()).toHaveLength(1);
  });

  /*
   * A position is a maker's, as Aqua keeps it (found writing PLAN.md 3.8's tests). Keyed by hash alone, a
   * stranger's logs for a maker's program could close it for every fill, or reopen one the maker had docked.
   */
  it("a stranger who ships a maker's program and docks it does not close the maker's", async () => {
    const enc = encodeOrder(order());
    byEvent(
      [evt(SWAP_VM, '0xd1', enc, 10n, 0), evt(SWAP_VM, '0xd1', enc, 20n, 0, STRANGER)],
      [evt(SWAP_VM, '0xd1', enc, 30n, 0, STRANGER)],
    );
    expect((await openPrograms()).map((p) => p.hash)).toEqual(['0xd1']);
  });

  it("a stranger re-shipping a docked program's bytes does not reopen it", async () => {
    const enc = encodeOrder(order());
    byEvent(
      [evt(SWAP_VM, '0xd2', enc, 10n, 0), evt(SWAP_VM, '0xd2', enc, 30n, 0, STRANGER)],
      [evt(SWAP_VM, '0xd2', enc, 20n, 0)],
    );
    expect(await openPrograms()).toHaveLength(0);
  });

  it('a program shipped by anyone but the maker it names is not listed', async () => {
    byEvent([evt(SWAP_VM, '0xd3', encodeOrder(order()), 10n, 0, STRANGER)], []);
    expect(await openPrograms()).toHaveLength(0);
  });

  it('an undecodable payload is skipped, not thrown', async () => {
    // Another version, or another app's encoding. Not an error.
    byEvent([evt(SWAP_VM, '0xee', '0x1234', 10n, 0)], []);
    expect(await openPrograms()).toHaveLength(0);
  });
});

describe('building the fill', () => {
  const params = {
    owner: '0x95A0b368588713011a15f4b1041423f31B08e615' as `0x${string}`,
    tokenIn: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
    tokenOut: '0x4200000000000000000000000000000000000006' as `0x${string}`,
    amountIn: 100_000_000n,
    slippage: 0.003,
    quotedOut: 1_000_000_000_000_000_000n,
  };

  it('asks the BOOK to compute the call, and applies the minimum out', async () => {
    byEvent([evt(SWAP_VM, '0xaa', encodeOrder(order()), 10n, 0)], []);
    readContract.mockResolvedValue([params.tokenIn, swapVmBookAddress(), params.amountIn, '0xcafe']);

    const fill = await buildSwapVmFill(params);
    expect(fill?.data).toBe('0xcafe');
    // 0.3% below the quote — computed here, enforced inside the VM.
    const call = readContract.mock.calls[0]![0] as { args: unknown[] };
    expect(call.args[5]).toBe(997_000_000_000_000_000n);
    // Encoding the calldata in TypeScript would be a second implementation free to drift from the
    // contract that has to accept it.
    expect(call.args[1]).toBe(params.owner);
  });

  it('keeps what the dry run says the program delivers, beside the floor (PLAN.md 3.20)', async () => {
    byEvent([evt(SWAP_VM, '0xaa', encodeOrder(order()), 10n, 0)], []);
    readContract.mockResolvedValue([params.tokenIn, swapVmBookAddress(), params.amountIn, '0xcafe']);
    // `spend()` returns the venue's own return data: `fillForDelegation`'s amount out.
    simulateContract.mockResolvedValueOnce({
      request: {},
      result: encodeAbiParameters(parseAbiParameters('uint256'), [1_004_000_000_000_000_000n]),
    });

    const fill = await buildSwapVmFill(params);
    expect(fill?.expectedOut).toBe(1_004_000_000_000_000_000n);
    expect(fill?.minOut).toBe(997_000_000_000_000_000n);
  });

  it('leaves the delivered amount unknown when the dry run returns nothing to read', async () => {
    byEvent([evt(SWAP_VM, '0xaa', encodeOrder(order()), 10n, 0)], []);
    readContract.mockResolvedValue([params.tokenIn, swapVmBookAddress(), params.amountIn, '0xcafe']);

    const fill = await buildSwapVmFill(params);
    expect(fill).toBeDefined();
    expect(fill?.expectedOut).toBeUndefined();
  });

  it('returns undefined when nothing is shipped — the ordinary case, not an error', async () => {
    byEvent([], []);
    expect(await buildSwapVmFill(params)).toBeUndefined();
  });

  it('returns undefined when discovery itself fails, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getLogs.mockRejectedValue(new Error('rpc exploded'));
    expect(await buildSwapVmFill(params)).toBeUndefined();
    // "Nothing shipped" and "the query broke" are the same answer to the caller unless one speaks.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  /*
   * Discovery finds every program still shipped; it cannot tell which ones still have inventory.
   * A maker whose strategy was superseded stays `Shipped` in Aqua's logs forever, and the encoder
   * happily builds calldata for it — so without this filter the settlement path would prefer a
   * dead program over the aggregator and lose the trade outright.
   */
  it('skips a program whose fill would revert, and takes the next one', async () => {
    byEvent(
      [
        evt(SWAP_VM, '0xaa', encodeOrder(order('0xdead')), 10n, 0),
        evt(SWAP_VM, '0xbb', encodeOrder(order('0xbeef')), 11n, 0),
      ],
      [],
    );
    readContract
      .mockResolvedValueOnce([params.tokenIn, swapVmBookAddress(), params.amountIn, '0xstale'])
      .mockResolvedValueOnce([params.tokenIn, swapVmBookAddress(), params.amountIn, '0xlive']);
    simulateContract
      .mockRejectedValueOnce(new Error('SafeBalancesForTokenNotInActiveStrategy'))
      .mockResolvedValueOnce({ request: {} });

    const fill = await buildSwapVmFill(params);
    expect(fill?.data).toBe('0xlive');
    expect(fill?.hash).toBe('0xbb');
  });

  it('takes the program whose dry run delivers the most, not the first that can fill (PLAN.md 3.20)', async () => {
    byEvent(
      [
        evt(SWAP_VM, '0xaa', encodeOrder(order('0xaaaa')), 10n, 0),
        evt(SWAP_VM, '0xbb', encodeOrder(order('0xbbbb')), 11n, 0),
      ],
      [],
    );
    readContract
      .mockResolvedValueOnce([params.tokenIn, swapVmBookAddress(), params.amountIn, '0xf1'])
      .mockResolvedValueOnce([params.tokenIn, swapVmBookAddress(), params.amountIn, '0xb2']);
    simulateContract
      .mockResolvedValueOnce({ request: {}, result: encodeAbiParameters(parseAbiParameters('uint256'), [998_000_000_000_000_000n]) })
      .mockResolvedValueOnce({ request: {}, result: encodeAbiParameters(parseAbiParameters('uint256'), [1_004_000_000_000_000_000n]) });

    const fill = await buildSwapVmFill(params);
    expect(fill?.data).toBe('0xb2');
    expect(fill?.hash).toBe('0xbb');
    expect(fill?.expectedOut).toBe(1_004_000_000_000_000_000n);
  });

  it('returns undefined when no discovered program can fill, so the caller routes to 1inch', async () => {
    byEvent([evt(SWAP_VM, '0xaa', encodeOrder(order()), 10n, 0)], []);
    readContract.mockResolvedValue([params.tokenIn, swapVmBookAddress(), params.amountIn, '0xcafe']);
    simulateContract.mockRejectedValue(new Error('TakerTraitsInsufficientMinOutputAmount'));

    expect(await buildSwapVmFill(params)).toBeUndefined();
  });

  it('simulates as the delegate that will send it, against the real spend()', async () => {
    byEvent([evt(SWAP_VM, '0xaa', encodeOrder(order()), 10n, 0)], []);
    readContract.mockResolvedValue([params.tokenIn, swapVmBookAddress(), params.amountIn, '0xcafe']);

    await buildSwapVmFill(params);
    const sim = simulateContract.mock.calls[0]?.[0] as {
      functionName: string;
      account: { address: string };
      args: unknown[];
    };
    // Simulating anything else would prove a different transaction than the one we send.
    expect(sim.functionName).toBe('spend');
    expect(sim.account.address).toBe('0xC38f38f45463f77bD823FebE16b15714Eb98c8A5');
    // The output the owner must receive and its floor ride with the call (PLAN.md 1.4), so the dry
    // run is held to the same rule as the transaction.
    expect(sim.args[4]).toBe(params.tokenOut);
    expect(sim.args[5]).toBe(997_000_000_000_000_000n);
    expect(sim.args[6]).toBe('0xcafe');
  });

  it('refuses a zero minimum rather than filling at any price', async () => {
    byEvent([evt(SWAP_VM, '0xaa', encodeOrder(order()), 10n, 0)], []);
    expect(await buildSwapVmFill({ ...params, quotedOut: 0n })).toBeUndefined();
  });
});
