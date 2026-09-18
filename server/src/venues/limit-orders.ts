/**
 * 1inch Limit Order Protocol orders, taken through the permission (PLAN.md 3.15).
 *
 * ## What an order is here
 *
 * A maker signs an EIP-712 `Order` off chain: sell `makingAmount` of one token for `takingAmount` of another, with
 * the terms — who may take it, until when, under which nonce — packed into one `makerTraits` word. Signing moves
 * nothing. The protocol lives inside the 1inch AggregationRouterV6, the contract every aggregator fill already goes
 * through, and it moves the maker's tokens only when someone fills the signed order.
 *
 * Posting an order to 1inch's public orderbook is a mainnet action, so it is not done. Orders are published to this
 * executor instead and filled with `fillOrderArgs` against the router on the chain the executor settles on.
 *
 * ## Why the taker is the delegation, and why the fill names a target
 *
 * An owner takes an order through `XorrDelegation.spend()`, like every other buy: the contract pulls exactly the
 * order's taking amount of USDC, approves the router for exactly that, calls it, and requires the owner's WETH to
 * rise by at least the order's making amount. The router takes the USDC from its caller, which is the delegation, so
 * the maker's WETH has to be sent somewhere else. `fillOrder` pays `msg.sender`: the WETH would land in a contract
 * that holds nothing between trades and the output check would refuse it. `fillOrderArgs` with `ARGS_HAS_TARGET`
 * names the owner in the first 20 bytes of `args`.
 *
 * Every layout below was checked against the deployed router on a Base fork (`fork/prove-limit-order.ts`), not
 * recalled. A wrong bit in a traits word does not throw here; on chain it fills differently or reverts with a name.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  compactSignatureToSignature,
  concat,
  encodeFunctionData,
  erc20Abi,
  hashTypedData,
  hexToBigInt,
  pad,
  parseCompactSignature,
  parseSignature,
  recoverAddress,
  signatureToCompactSignature,
  size,
  type Address,
  type ContractFunctionParameters,
  type Hex,
} from 'viem';
import { publicClient } from '../evm/client.js';
import { ADDRESSES } from '../evm/chains.js';

/** The AggregationRouterV6, which carries Limit Order Protocol v4. It is already on every grant's venue list. */
export const LOP_ROUTER: Address = ADDRESSES.oneInchRouter;

/** The router's EIP-712 domain, exactly as its `eip712Domain()` answers on Base. */
export function limitOrderDomain(chainId: number) {
  return { name: '1inch Aggregation Router', version: '6', chainId, verifyingContract: LOP_ROUTER } as const;
}

/** `OrderLib._LIMIT_ORDER_TYPEHASH`: the four addresses are `address` in the type string and uint256 in calldata. */
export const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'makerAsset', type: 'address' },
    { name: 'takerAsset', type: 'address' },
    { name: 'makingAmount', type: 'uint256' },
    { name: 'takingAmount', type: 'uint256' },
    { name: 'makerTraits', type: 'uint256' },
  ],
} as const;

export type LimitOrder = {
  salt: bigint;
  maker: Address;
  /** Who is paid the taking amount. The router pays the maker when this is zero; this executor requires the maker. */
  receiver: Address;
  makerAsset: Address;
  takerAsset: Address;
  makingAmount: bigint;
  takingAmount: bigint;
  makerTraits: bigint;
};

/** What a maker signs, and what the router hashes. One definition, so signing and checking cannot drift apart. */
export function limitOrderTypedData(order: LimitOrder, chainId: number) {
  return { domain: limitOrderDomain(chainId), types: ORDER_TYPES, primaryType: 'Order', message: order } as const;
}

export function hashLimitOrder(order: LimitOrder, chainId: number): Hex {
  return hashTypedData(limitOrderTypedData(order, chainId));
}

/* ─────────────────────────────────────────────────────────────── maker traits */

/** `MakerTraitsLib` flags, high bits of the word. */
export const MAKER_TRAITS = {
  NO_PARTIAL_FILLS: 1n << 255n,
  ALLOW_MULTIPLE_FILLS: 1n << 254n,
  PRE_INTERACTION: 1n << 252n,
  POST_INTERACTION: 1n << 251n,
  NEED_CHECK_EPOCH_MANAGER: 1n << 250n,
  HAS_EXTENSION: 1n << 249n,
  USE_PERMIT2: 1n << 248n,
  UNWRAP_WETH: 1n << 247n,
} as const;

const UINT40_MAX = (1n << 40n) - 1n;
/** The allowed sender is the low 80 bits of an address, not the whole address. */
const ALLOWED_SENDER_MASK = (1n << 80n) - 1n;
const EXPIRATION_OFFSET = 80n;
const NONCE_OFFSET = 120n;
const SERIES_OFFSET = 160n;

/**
 * Pack an order's terms. Refuses a value wider than its field rather than letting it spill into the next one: an
 * expiration a bit too large would otherwise become part of the nonce.
 */
export function buildMakerTraits(p: {
  /** Unix seconds; zero never expires. */
  expiration: bigint;
  nonce: bigint;
  series?: bigint;
  /** Only this address may take the order. Absent: anyone. */
  allowedSender?: Address;
  noPartialFills?: boolean;
  allowMultipleFills?: boolean;
}): bigint {
  const series = p.series ?? 0n;
  for (const [name, value] of [
    ['expiration', p.expiration],
    ['nonce', p.nonce],
    ['series', series],
  ] as const) {
    if (value < 0n || value > UINT40_MAX) throw new Error(`The ${name} ${value} does not fit the 40 bits MakerTraits gives it.`);
  }
  let traits = (p.expiration << EXPIRATION_OFFSET) | (p.nonce << NONCE_OFFSET) | (series << SERIES_OFFSET);
  if (p.allowedSender) traits |= hexToBigInt(p.allowedSender) & ALLOWED_SENDER_MASK;
  if (p.noPartialFills) traits |= MAKER_TRAITS.NO_PARTIAL_FILLS;
  if (p.allowMultipleFills) traits |= MAKER_TRAITS.ALLOW_MULTIPLE_FILLS;
  return traits;
}

export type MakerTraits = {
  /** The low 80 bits of the only address that may take the order; zero for anyone. */
  allowedSender: bigint;
  expiration: bigint;
  nonce: bigint;
  series: bigint;
  noPartialFills: boolean;
  allowMultipleFills: boolean;
  preInteraction: boolean;
  postInteraction: boolean;
  needCheckEpochManager: boolean;
  hasExtension: boolean;
  usePermit2: boolean;
  unwrapWeth: boolean;
  /** `MakerTraitsLib.useBitInvalidator`: a nonce bit is spent unless the order allows both partial and multiple fills. */
  usesBitInvalidator: boolean;
};

export function readMakerTraits(traits: bigint): MakerTraits {
  const flag = (bit: bigint) => (traits & bit) !== 0n;
  const noPartialFills = flag(MAKER_TRAITS.NO_PARTIAL_FILLS);
  const allowMultipleFills = flag(MAKER_TRAITS.ALLOW_MULTIPLE_FILLS);
  return {
    allowedSender: traits & ALLOWED_SENDER_MASK,
    expiration: (traits >> EXPIRATION_OFFSET) & UINT40_MAX,
    nonce: (traits >> NONCE_OFFSET) & UINT40_MAX,
    series: (traits >> SERIES_OFFSET) & UINT40_MAX,
    noPartialFills,
    allowMultipleFills,
    preInteraction: flag(MAKER_TRAITS.PRE_INTERACTION),
    postInteraction: flag(MAKER_TRAITS.POST_INTERACTION),
    needCheckEpochManager: flag(MAKER_TRAITS.NEED_CHECK_EPOCH_MANAGER),
    hasExtension: flag(MAKER_TRAITS.HAS_EXTENSION),
    usePermit2: flag(MAKER_TRAITS.USE_PERMIT2),
    unwrapWeth: flag(MAKER_TRAITS.UNWRAP_WETH),
    usesBitInvalidator: noPartialFills || !allowMultipleFills,
  };
}

/* ─────────────────────────────────────────────────────────────── taker traits */

/** `TakerTraitsLib` flags. */
export const TAKER_TRAITS = {
  /** `amount` is the making amount. Clear: `amount` is the taking amount. */
  MAKER_AMOUNT: 1n << 255n,
  UNWRAP_WETH: 1n << 254n,
  SKIP_ORDER_PERMIT: 1n << 253n,
  USE_PERMIT2: 1n << 252n,
  /** The first 20 bytes of `args` are the address the maker asset is sent to. */
  ARGS_HAS_TARGET: 1n << 251n,
} as const;

const ARGS_EXTENSION_LENGTH_OFFSET = 224n;
const ARGS_INTERACTION_LENGTH_OFFSET = 200n;
const UINT24_MAX = (1n << 24n) - 1n;

/**
 * `TakerTraitsLib._AMOUNT_MASK`: the low 184 bits, not 185.
 *
 * The literal is nine zero bytes and 46 hex digits of f. The fork proof confirms it both ways: a threshold with bit
 * 184 set fills as though the bit were absent, and one with bit 183 set is refused as `MakingAmountTooLow`.
 */
export const THRESHOLD_MASK = (1n << 184n) - 1n;

export function buildTakerTraits(p: {
  /**
   * With `amount` as the taking amount: the least the maker must deliver, `MakingAmountTooLow` below it. With
   * `MAKER_AMOUNT`: the most the taker pays, `TakingAmountTooHigh` above it. Zero checks nothing.
   */
  threshold: bigint;
  argsHasTarget?: boolean;
  makerAmount?: boolean;
  extensionLength?: number;
  interactionLength?: number;
}): bigint {
  if (p.threshold < 0n || p.threshold > THRESHOLD_MASK) {
    throw new Error(`The threshold ${p.threshold} does not fit the 184 bits TakerTraits gives it.`);
  }
  const extension = BigInt(p.extensionLength ?? 0);
  const interaction = BigInt(p.interactionLength ?? 0);
  if (extension < 0n || extension > UINT24_MAX || interaction < 0n || interaction > UINT24_MAX) {
    throw new Error('An args length does not fit the 24 bits TakerTraits gives it.');
  }
  let traits = p.threshold | (extension << ARGS_EXTENSION_LENGTH_OFFSET) | (interaction << ARGS_INTERACTION_LENGTH_OFFSET);
  if (p.argsHasTarget) traits |= TAKER_TRAITS.ARGS_HAS_TARGET;
  if (p.makerAmount) traits |= TAKER_TRAITS.MAKER_AMOUNT;
  return traits;
}

/* ─────────────────────────────────────────────────────────────── signatures */

/** Half the secp256k1 order. 1inch's `ECDSA.recover` refuses a larger `s`, so this executor does too, before storing. */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * A signature as the router takes it: `r` and `vs`, the EIP-2098 compact form. Accepts the 65-byte form a wallet's
 * `signTypedData` returns, or the 64-byte form already compacted.
 */
export function compactSignature(signature: Hex): { r: Hex; vs: Hex } {
  const bytes = size(signature);
  const highS = new Error('The signature has a high s value, which the router refuses.');
  let compact: { r: Hex; yParityAndS: Hex };
  if (bytes === 65) {
    const parsed = parseSignature(signature);
    /*
     * Checked before compacting. The compact form keeps `s` in 255 bits and puts the parity in the top one, so a high
     * `s` compacts into a different, low number: the check after it would pass, and the router would recover someone
     * else. Found by this module's own test.
     */
    if (hexToBigInt(parsed.s) > HALF_N) throw highS;
    compact = signatureToCompactSignature(parsed);
  } else if (bytes === 64) {
    compact = parseCompactSignature(signature);
    if ((hexToBigInt(compact.yParityAndS) & ((1n << 255n) - 1n)) > HALF_N) throw highS;
  } else {
    throw new Error(`A signature is 64 or 65 bytes, not ${bytes}.`);
  }
  return { r: pad(compact.r, { size: 32 }), vs: pad(compact.yParityAndS, { size: 32 }) };
}

/** The 64-byte `r ‖ vs`, which is what is stored: one shape in the table whichever form the maker sent. */
export function compactSignatureHex(signature: Hex): Hex {
  const { r, vs } = compactSignature(signature);
  return concat([r, vs]);
}

export async function recoverOrderSigner(order: LimitOrder, signature: Hex, chainId: number): Promise<Address> {
  const { r, vs } = compactSignature(signature);
  return recoverAddress({
    hash: hashLimitOrder(order, chainId),
    signature: compactSignatureToSignature({ r, yParityAndS: vs }),
  });
}

/* ─────────────────────────────────────────────────────────────── the router */

/** `IOrderMixin.Order` in calldata. `Address` is a uint256 type there, so every field is one. */
const ORDER_COMPONENTS = [
  { name: 'salt', type: 'uint256' },
  { name: 'maker', type: 'uint256' },
  { name: 'receiver', type: 'uint256' },
  { name: 'makerAsset', type: 'uint256' },
  { name: 'takerAsset', type: 'uint256' },
  { name: 'makingAmount', type: 'uint256' },
  { name: 'takingAmount', type: 'uint256' },
  { name: 'makerTraits', type: 'uint256' },
] as const;

/** The router's refusals on a fill, so a dry run through `spend()` comes back with a name rather than four bytes. */
export const LOP_ERRORS = [
  { type: 'error', name: 'BadSignature', inputs: [] },
  { type: 'error', name: 'InvalidatedOrder', inputs: [] },
  { type: 'error', name: 'BitInvalidatedOrder', inputs: [] },
  { type: 'error', name: 'OrderExpired', inputs: [] },
  { type: 'error', name: 'PrivateOrder', inputs: [] },
  { type: 'error', name: 'MakingAmountTooLow', inputs: [] },
  { type: 'error', name: 'TakingAmountTooHigh', inputs: [] },
  { type: 'error', name: 'TakingAmountExceeded', inputs: [] },
  { type: 'error', name: 'PartialFillNotAllowed', inputs: [] },
  { type: 'error', name: 'SwapWithZeroAmount', inputs: [] },
  { type: 'error', name: 'TransferFromMakerToTakerFailed', inputs: [] },
  { type: 'error', name: 'TransferFromTakerToMakerFailed', inputs: [] },
  { type: 'error', name: 'WrongSeriesNonce', inputs: [] },
  { type: 'error', name: 'EnforcedPause', inputs: [] },
] as const;

/** Selectors checked present in the deployed router's bytecode: 0xf497df75, 0x802b2ef1, 0x143e86a7. */
export const LOP_ABI = [
  {
    type: 'function',
    name: 'fillOrderArgs',
    stateMutability: 'payable',
    inputs: [
      { name: 'order', type: 'tuple', components: ORDER_COMPONENTS },
      { name: 'r', type: 'bytes32' },
      { name: 'vs', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
      { name: 'takerTraits', type: 'uint256' },
      { name: 'args', type: 'bytes' },
    ],
    outputs: [
      { name: 'makingAmount', type: 'uint256' },
      { name: 'takingAmount', type: 'uint256' },
      { name: 'orderHash', type: 'bytes32' },
    ],
  },
  {
    type: 'function',
    name: 'hashOrder',
    stateMutability: 'view',
    inputs: [{ name: 'order', type: 'tuple', components: ORDER_COMPONENTS }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  /**
   * The second argument is the NONCE, whatever the interface calls it: `BitInvalidatorLib.checkSlot` shifts it right
   * by eight itself. Passing the slot number reads the wrong word for any nonce of 256 or more, which the fork proof
   * shows with nonce 1,000,003.
   */
  {
    type: 'function',
    name: 'bitInvalidatorForOrder',
    stateMutability: 'view',
    inputs: [
      { name: 'maker', type: 'address' },
      { name: 'slot', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  ...LOP_ERRORS,
] as const;

/** The order as the router's calldata spells it. */
export function orderArg(order: LimitOrder) {
  return {
    salt: order.salt,
    maker: hexToBigInt(order.maker),
    receiver: hexToBigInt(order.receiver),
    makerAsset: hexToBigInt(order.makerAsset),
    takerAsset: hexToBigInt(order.takerAsset),
    makingAmount: order.makingAmount,
    takingAmount: order.takingAmount,
    makerTraits: order.makerTraits,
  };
}

/** What `XorrDelegation.spend()` is called with, in the same shape as an Aqua or SwapVM fill. */
export type LimitOrderFill = {
  /** The token the delegation pulls from the owner: the order's taker asset. */
  token: Address;
  venue: Address;
  /** Exactly the order's taking amount. The router takes this much, and the approval is for this much. */
  amount: bigint;
  data: Hex;
  /** The order's maker asset, which the owner receives. */
  tokenOut: Address;
  /** The whole making amount: the floor `spend()` holds the owner's balance to. */
  minOut: bigint;
};

/**
 * Take the whole order for `owner`.
 *
 * `amount` is the taking amount because `MAKER_AMOUNT` is clear, and then the router computes the making amount from
 * it: the whole order for its whole taking amount. The threshold is the making amount, so the router itself refuses
 * to deliver less (`MakingAmountTooLow`), and `spend()` checks the same figure again against the owner's balance.
 */
export function buildLimitOrderFill(p: { order: LimitOrder; signature: Hex; owner: Address }): LimitOrderFill {
  const { r, vs } = compactSignature(p.signature);
  const data = encodeFunctionData({
    abi: LOP_ABI,
    functionName: 'fillOrderArgs',
    args: [
      orderArg(p.order),
      r,
      vs,
      p.order.takingAmount,
      buildTakerTraits({ threshold: p.order.makingAmount, argsHasTarget: true }),
      // The target, and nothing after it: no extension, no interaction.
      p.owner,
    ],
  });
  return {
    token: p.order.takerAsset,
    venue: LOP_ROUTER,
    amount: p.order.takingAmount,
    data,
    tokenOut: p.order.makerAsset,
    minOut: p.order.makingAmount,
  };
}

/* ─────────────────────────────────────────────────────────────── on chain */

/** Whether this nonce's bit is set in the word `bitInvalidatorForOrder` returned: a fill or a cancel spent it. */
export function nonceSpent(word: bigint, nonce: bigint): boolean {
  return ((word >> (nonce & 0xffn)) & 1n) === 1n;
}

/** What the chain says about one order. `undefined` is a read that failed, never a guess. */
export type OrderOnChain = {
  invalidated: boolean | undefined;
  makerBalance: bigint | undefined;
  makerAllowance: bigint | undefined;
};

/**
 * The chain's clock, and each order's nonce, maker balance and allowance to the router, in one multicall.
 *
 * Only for orders that spend a nonce bit, which is every order this executor stores. A failed call leaves its field
 * undefined; a failed block or multicall throws, and the caller says the chain could not be read.
 */
export async function readOrdersOnChain(orders: LimitOrder[]): Promise<{ now: bigint; states: OrderOnChain[] }> {
  const block = await publicClient.getBlock();
  if (orders.length === 0) return { now: block.timestamp, states: [] };
  // Widened, as in `readPolicyAndVenues`: two ABIs in one batch, typed back below by position.
  const contracts: ContractFunctionParameters[] = orders.flatMap((o) => [
    {
      address: LOP_ROUTER,
      abi: LOP_ABI,
      functionName: 'bitInvalidatorForOrder',
      args: [o.maker, readMakerTraits(o.makerTraits).nonce],
    },
    { address: o.makerAsset, abi: erc20Abi, functionName: 'balanceOf', args: [o.maker] },
    { address: o.makerAsset, abi: erc20Abi, functionName: 'allowance', args: [o.maker, LOP_ROUTER] },
  ]);
  const results = (await publicClient.multicall({ allowFailure: true, contracts })) as {
    status: 'success' | 'failure';
    result?: unknown;
  }[];
  const read = (i: number): bigint | undefined => {
    const r = results[i];
    return r?.status === 'success' && typeof r.result === 'bigint' ? r.result : undefined;
  };
  const states = orders.map((o, i) => {
    const word = read(i * 3);
    return {
      invalidated: word === undefined ? undefined : nonceSpent(word, readMakerTraits(o.makerTraits).nonce),
      makerBalance: read(i * 3 + 1),
      makerAllowance: read(i * 3 + 2),
    };
  });
  return { now: block.timestamp, states };
}

export type OrderStatus = 'open' | 'filled' | 'invalidated' | 'expired' | 'unfunded' | 'unknown';

/**
 * Whether an order can be taken now, and the sentence that says why not.
 *
 * `fillable` is null when a read failed: an order that cannot be checked is neither offered nor written off.
 */
export function judgeOrder(p: {
  order: LimitOrder;
  /** The chain's clock, in seconds. The router compares against `block.timestamp`, not ours. */
  now: bigint;
  onChain: OrderOnChain;
  /** Set when this executor filled it. */
  filledAt?: Date | null;
}): { status: OrderStatus; fillable: boolean | null; detail: string } {
  const { order, now, onChain } = p;
  if (p.filledAt) return { status: 'filled', fillable: false, detail: 'Taken through this executor.' };
  if (onChain.invalidated === true) {
    return {
      status: 'invalidated',
      fillable: false,
      detail: 'Its nonce is spent on chain: it was filled elsewhere or cancelled by its maker.',
    };
  }
  const { expiration } = readMakerTraits(order.makerTraits);
  // `MakerTraitsLib.isExpired`: strictly after the expiration second.
  if (expiration !== 0n && expiration < now) {
    return { status: 'expired', fillable: false, detail: 'Past its expiry on the chain’s clock.' };
  }
  if (onChain.invalidated === undefined || onChain.makerBalance === undefined || onChain.makerAllowance === undefined) {
    return { status: 'unknown', fillable: null, detail: 'Its state could not be read from the chain just now.' };
  }
  if (onChain.makerBalance < order.makingAmount || onChain.makerAllowance < order.makingAmount) {
    return {
      status: 'unfunded',
      fillable: false,
      detail: 'The maker no longer holds, or no longer lets the router take, what the order sells.',
    };
  }
  return { status: 'open', fillable: true, detail: 'Fillable now.' };
}

/** The name of the custom error a simulated or sent call reverted with, when the ABI knew it. */
export function revertName(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
}

/** The router's refusals, as a person taking an order would need them said. */
export const LOP_REFUSALS: Readonly<Record<string, string>> = {
  BadSignature: 'The router does not accept the order’s signature, so it was not taken.',
  InvalidatedOrder: 'The order was already filled or cancelled on chain.',
  BitInvalidatedOrder: 'The order was already filled or cancelled on chain.',
  OrderExpired: 'The order has expired.',
  PrivateOrder: 'Its maker allowed only someone else to take this order.',
  MakingAmountTooLow: 'The order would deliver less than its full size, so it was not taken.',
  PartialFillNotAllowed: 'The order would deliver less than its full size, so it was not taken.',
  TakingAmountExceeded: 'The order would deliver less than its full size, so it was not taken.',
  TransferFromMakerToTakerFailed: 'The maker no longer holds, or no longer lets the router take, what the order sells.',
  TransferFromTakerToMakerFailed: 'The router could not collect your USDC for the order.',
  EnforcedPause: 'The 1inch router is paused, so no order can be filled.',
};
