/**
 * Limit orders built, hashed, signed and encoded (PLAN.md 3.15), with the chain stood in for.
 *
 * The hash is held to a value the deployed router computed, not to a second reading of EIP-712: an order that hashes
 * one way here and another on chain carries a signature the router refuses, and nothing in TypeScript would notice.
 * The traits and the calldata are held to the bit positions `fork/prove-limit-order.ts` confirmed against that router.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractFunctionRevertedError,
  decodeFunctionData,
  keccak256,
  parseSignature,
  serializeSignature,
  size,
  slice,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const h = vi.hoisted(() => ({ getBlock: vi.fn(), multicall: vi.fn() }));

// Exactly what the chain reads use: the clock, and one multicall.
vi.mock('../evm/client.js', () => ({ publicClient: { getBlock: h.getBlock, multicall: h.multicall } }));
vi.mock('../evm/chains.js', () => ({ ADDRESSES: { oneInchRouter: '0x111111125421cA6dc452d289314280a0f8842A65' } }));

const lop = await import('./limit-orders.js');

const ROUTER: Address = '0x111111125421cA6dc452d289314280a0f8842A65';
const WETH: Address = '0x4200000000000000000000000000000000000006';
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OWNER: Address = '0x95A0b368588713011a15f4b1041423f31B08e615';
const maker = privateKeyToAccount(keccak256(toHex('xorr/limit-orders/unit-test-maker')));
const stranger = privateKeyToAccount(keccak256(toHex('xorr/limit-orders/someone-else')));
/** secp256k1's group order. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** All or nothing, expiring at 1,900,000,000, nonce 300: the traits the recorded order carries. */
const TRAITS = 0x800000000000000000000000000000012c00713fb30000000000000000000000n;

const ORDER = {
  salt: 102030405060708090n,
  maker: maker.address,
  receiver: maker.address,
  makerAsset: WETH,
  takerAsset: USDC,
  makingAmount: 10n ** 16n,
  takingAmount: 25_000_000n,
  makerTraits: TRAITS,
};

/**
 * The deployed AggregationRouterV6's `hashOrder(ORDER)`, recorded on 2026-09-13 from an anvil fork of Base at block
 * 51244747, with each address passed as its uint256:
 *
 *   cast call 0x111111125421cA6dc452d289314280a0f8842A65 \
 *     "hashOrder((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))(bytes32)" \
 *     "(102030405060708090,<maker>,<maker>,<WETH>,<USDC>,10000000000000000,25000000,<TRAITS>)" \
 *     --rpc-url http://127.0.0.1:8549
 */
const ROUTER_HASH = '0x345e8eb4fdb71825ade8a35717db833c344e0fa60ddf9b63b17454ae178354f9';

const sign = (order = ORDER, by = maker) => by.signTypedData(lop.limitOrderTypedData(order, 8453));

beforeEach(() => {
  h.getBlock.mockReset();
  h.multicall.mockReset();
});

describe('the order hash', () => {
  it('is the one the deployed router computes', () => {
    // The recorded hash belongs to this maker; a changed test key would make it a different order.
    expect(maker.address).toBe('0x98ef01bF95BAA5Abe794afA5E9ca2D379a36ed82');
    expect(lop.hashLimitOrder(ORDER, 8453)).toBe(ROUTER_HASH);
  });

  it('is a different order on another chain, or with any field changed', () => {
    expect(lop.hashLimitOrder(ORDER, 84532)).not.toBe(ROUTER_HASH);
    expect(lop.hashLimitOrder({ ...ORDER, salt: ORDER.salt + 1n }, 8453)).not.toBe(ROUTER_HASH);
    expect(lop.hashLimitOrder({ ...ORDER, receiver: OWNER }, 8453)).not.toBe(ROUTER_HASH);
  });
});

describe('maker traits', () => {
  it('packs each field at its offset', () => {
    expect(lop.buildMakerTraits({ expiration: 1_900_000_000n, nonce: 300n, noPartialFills: true })).toBe(TRAITS);
    expect(lop.buildMakerTraits({ expiration: 1n, nonce: 0n })).toBe(1n << 80n);
    expect(lop.buildMakerTraits({ expiration: 0n, nonce: 1n })).toBe(1n << 120n);
    expect(lop.buildMakerTraits({ expiration: 0n, nonce: 0n, series: 1n })).toBe(1n << 160n);
    // Only the low 80 bits of an allowed sender are kept.
    expect(lop.buildMakerTraits({ expiration: 0n, nonce: 0n, allowedSender: OWNER })).toBe(BigInt(OWNER) & ((1n << 80n) - 1n));
  });

  it('names the flags at their bits', () => {
    expect(lop.MAKER_TRAITS).toEqual({
      NO_PARTIAL_FILLS: 1n << 255n,
      ALLOW_MULTIPLE_FILLS: 1n << 254n,
      PRE_INTERACTION: 1n << 252n,
      POST_INTERACTION: 1n << 251n,
      NEED_CHECK_EPOCH_MANAGER: 1n << 250n,
      HAS_EXTENSION: 1n << 249n,
      USE_PERMIT2: 1n << 248n,
      UNWRAP_WETH: 1n << 247n,
    });
  });

  it('reads back what was packed', () => {
    expect(lop.readMakerTraits(TRAITS)).toEqual({
      allowedSender: 0n,
      expiration: 1_900_000_000n,
      nonce: 300n,
      series: 0n,
      noPartialFills: true,
      allowMultipleFills: false,
      preInteraction: false,
      postInteraction: false,
      needCheckEpochManager: false,
      hasExtension: false,
      usePermit2: false,
      unwrapWeth: false,
      usesBitInvalidator: true,
    });
  });

  it('spends a nonce bit unless the order allows both partial and multiple fills', () => {
    const { NO_PARTIAL_FILLS, ALLOW_MULTIPLE_FILLS } = lop.MAKER_TRAITS;
    expect(lop.readMakerTraits(0n).usesBitInvalidator).toBe(true);
    expect(lop.readMakerTraits(NO_PARTIAL_FILLS | ALLOW_MULTIPLE_FILLS).usesBitInvalidator).toBe(true);
    expect(lop.readMakerTraits(ALLOW_MULTIPLE_FILLS).usesBitInvalidator).toBe(false);
  });

  it('refuses a value wider than its field instead of spilling into the next', () => {
    expect(() => lop.buildMakerTraits({ expiration: 1n << 40n, nonce: 0n })).toThrow(/40 bits/);
    expect(() => lop.buildMakerTraits({ expiration: 0n, nonce: -1n })).toThrow(/40 bits/);
  });
});

describe('taker traits', () => {
  it('names the flags and the args lengths at their bits', () => {
    expect(lop.TAKER_TRAITS).toEqual({
      MAKER_AMOUNT: 1n << 255n,
      UNWRAP_WETH: 1n << 254n,
      SKIP_ORDER_PERMIT: 1n << 253n,
      USE_PERMIT2: 1n << 252n,
      ARGS_HAS_TARGET: 1n << 251n,
    });
    expect(lop.buildTakerTraits({ threshold: 0n, extensionLength: 1 })).toBe(1n << 224n);
    expect(lop.buildTakerTraits({ threshold: 0n, interactionLength: 1 })).toBe(1n << 200n);
    expect(lop.buildTakerTraits({ threshold: 7n, argsHasTarget: true })).toBe((1n << 251n) | 7n);
    expect(lop.buildTakerTraits({ threshold: 0n, makerAmount: true })).toBe(1n << 255n);
  });

  it('keeps the threshold in the low 184 bits, as TakerTraitsLib._AMOUNT_MASK does', () => {
    expect(lop.THRESHOLD_MASK).toBe(0x000000000000000000ffffffffffffffffffffffffffffffffffffffffffffffn);
    expect(lop.buildTakerTraits({ threshold: lop.THRESHOLD_MASK })).toBe(lop.THRESHOLD_MASK);
    expect(() => lop.buildTakerTraits({ threshold: lop.THRESHOLD_MASK + 1n })).toThrow(/184 bits/);
    expect(() => lop.buildTakerTraits({ threshold: 0n, extensionLength: 1 << 24 })).toThrow(/24 bits/);
  });
});

describe('signatures', () => {
  it('recover the maker from the 65-byte form and the compact form alike', async () => {
    const signature = await sign();
    expect(size(signature)).toBe(65);
    const compact = lop.compactSignatureHex(signature);
    expect(size(compact)).toBe(64);
    expect(compact).toBe(`${lop.compactSignature(signature).r}${lop.compactSignature(signature).vs.slice(2)}`);
    expect(await lop.recoverOrderSigner(ORDER, signature, 8453)).toBe(maker.address);
    expect(await lop.recoverOrderSigner(ORDER, compact, 8453)).toBe(maker.address);
  });

  it('recover whoever signed, so a check against the maker means something', async () => {
    expect(await lop.recoverOrderSigner(ORDER, await sign(ORDER, stranger), 8453)).toBe(stranger.address);
  });

  it('are refused with a high s, which the router would refuse, and at any other length', async () => {
    const { r, s, yParity } = parseSignature(await sign());
    const highS = serializeSignature({ r, s: toHex(N - BigInt(s), { size: 32 }), yParity: yParity === 0 ? 1 : 0 });
    expect(() => lop.compactSignature(highS)).toThrow(/high s/);
    expect(() => lop.compactSignature(`0x${'11'.repeat(63)}`)).toThrow(/64 or 65 bytes/);
  });
});

describe('the fill', () => {
  it("is spend()'s arguments: the taking amount of USDC in, the whole making amount of WETH as the floor", async () => {
    const fill = lop.buildLimitOrderFill({ order: ORDER, signature: await sign(), owner: OWNER });
    expect({ ...fill, data: undefined }).toEqual({
      token: USDC,
      venue: ROUTER,
      amount: 25_000_000n,
      data: undefined,
      tokenOut: WETH,
      minOut: 10n ** 16n,
    });
  });

  it('calls fillOrderArgs with the whole order, the taking amount, the making amount as threshold and the owner as target', async () => {
    const signature = await sign();
    const { data } = lop.buildLimitOrderFill({ order: ORDER, signature, owner: OWNER });
    expect(slice(data, 0, 4)).toBe('0xf497df75');

    const decoded = decodeFunctionData({ abi: lop.LOP_ABI, data });
    expect(decoded.functionName).toBe('fillOrderArgs');
    const [order, r, vs, amount, takerTraits, args] = decoded.args as unknown as [
      Record<string, bigint>,
      Hex,
      Hex,
      bigint,
      bigint,
      Hex,
    ];
    // `Address` is a uint256 in the router's calldata.
    expect(order).toEqual({
      salt: ORDER.salt,
      maker: BigInt(maker.address),
      receiver: BigInt(maker.address),
      makerAsset: BigInt(WETH),
      takerAsset: BigInt(USDC),
      makingAmount: ORDER.makingAmount,
      takingAmount: ORDER.takingAmount,
      makerTraits: TRAITS,
    });
    expect({ r, vs }).toEqual(lop.compactSignature(signature));
    expect(amount).toBe(ORDER.takingAmount);
    expect(takerTraits).toBe(lop.TAKER_TRAITS.ARGS_HAS_TARGET | ORDER.makingAmount);
    expect(takerTraits & lop.TAKER_TRAITS.MAKER_AMOUNT).toBe(0n);
    // The target and nothing after it: 20 bytes, no extension, no interaction.
    expect(size(args)).toBe(20);
    expect(args.toLowerCase()).toBe(OWNER.toLowerCase());
  });
});

describe('on chain', () => {
  const nonce = 1_000_003n;
  const order = { ...ORDER, makerTraits: lop.buildMakerTraits({ expiration: 1_900_000_000n, nonce, noPartialFills: true }) };

  it('reads the bit the nonce names in the word the nonce names', () => {
    // `bitInvalidatorForOrder(maker, 1000003)` after that order filled on the fork: bit 67.
    const word = 0x80000000000000000n;
    expect(lop.nonceSpent(word, nonce)).toBe(true);
    expect(lop.nonceSpent(word, nonce - 1n)).toBe(false);
    expect(lop.nonceSpent(0n, nonce)).toBe(false);
  });

  it('asks the router by nonce, not slot, and leaves a failed read undefined rather than guessing', async () => {
    h.getBlock.mockResolvedValue({ timestamp: 1_800_000_000n });
    h.multicall.mockResolvedValue([
      { status: 'success', result: 0x80000000000000000n },
      { status: 'success', result: 10n ** 18n },
      { status: 'failure', error: new Error('execution reverted') },
    ]);

    const out = await lop.readOrdersOnChain([order]);

    const { contracts, allowFailure } = h.multicall.mock.calls[0]![0];
    expect(allowFailure).toBe(true);
    expect(contracts[0]).toMatchObject({ address: ROUTER, functionName: 'bitInvalidatorForOrder', args: [maker.address, nonce] });
    expect(contracts[1]).toMatchObject({ address: WETH, functionName: 'balanceOf', args: [maker.address] });
    expect(contracts[2]).toMatchObject({ address: WETH, functionName: 'allowance', args: [maker.address, ROUTER] });
    expect(out).toEqual({
      now: 1_800_000_000n,
      states: [{ invalidated: true, makerBalance: 10n ** 18n, makerAllowance: undefined }],
    });
  });

  it('reads only the clock when there is nothing to ask about', async () => {
    h.getBlock.mockResolvedValue({ timestamp: 5n });
    expect(await lop.readOrdersOnChain([])).toEqual({ now: 5n, states: [] });
    expect(h.multicall).not.toHaveBeenCalled();
  });
});

describe('judging an order', () => {
  const funded = { invalidated: false, makerBalance: 10n ** 16n, makerAllowance: 10n ** 16n };
  const judge = (over: Partial<Parameters<typeof lop.judgeOrder>[0]>) =>
    lop.judgeOrder({ order: ORDER, now: 1_800_000_000n, onChain: funded, ...over });

  it('is open when unspent, unexpired and funded — through its expiry second, as the router counts', () => {
    expect(judge({})).toMatchObject({ status: 'open', fillable: true });
    expect(judge({ now: 1_900_000_000n })).toMatchObject({ status: 'open', fillable: true });
    expect(judge({ now: 1_900_000_001n })).toMatchObject({ status: 'expired', fillable: false });
  });

  it('says taken here first, then spent, then expired', () => {
    expect(judge({ filledAt: new Date(), onChain: { ...funded, invalidated: true } }).status).toBe('filled');
    expect(judge({ now: 1_900_000_001n, onChain: { ...funded, invalidated: true } }).status).toBe('invalidated');
  });

  it('is unfunded when the maker holds or allows less than it sells', () => {
    expect(judge({ onChain: { ...funded, makerBalance: 10n ** 16n - 1n } })).toMatchObject({ status: 'unfunded', fillable: false });
    expect(judge({ onChain: { ...funded, makerAllowance: 0n } })).toMatchObject({ status: 'unfunded', fillable: false });
  });

  it('is neither offered nor written off when the chain could not be read', () => {
    expect(judge({ onChain: { ...funded, invalidated: undefined } })).toMatchObject({ status: 'unknown', fillable: null });
    expect(judge({ onChain: { ...funded, makerAllowance: undefined } })).toMatchObject({ status: 'unknown', fillable: null });
  });
});

describe('refusals', () => {
  it("name the router's revert, and say it in words", () => {
    const e = new ContractFunctionRevertedError({
      abi: lop.LOP_ABI,
      data: toFunctionSelector('BitInvalidatedOrder()'),
      functionName: 'fillOrderArgs',
    });
    expect(lop.revertName(e)).toBe('BitInvalidatedOrder');
    expect(lop.LOP_REFUSALS.BitInvalidatedOrder).toMatch(/already filled or cancelled/);
    expect(lop.revertName(new Error('fetch failed'))).toBeUndefined();
  });
});
