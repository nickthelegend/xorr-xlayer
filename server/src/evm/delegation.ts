/**
 * The delegation adapter — reads and writes XorrDelegation.
 *
 * The chain is the source of truth for what the bot may spend. Our database caches it for display,
 * and every enforcement decision re-reads the contract rather than trusting that cache.
 */
import {
  parseUnits,
  formatUnits,
  parseEventLogs,
  type Address,
  type ContractFunctionParameters,
  type Hex,
  type Log,
  type TransactionReceipt,
} from 'viem';
import { publicClient, walletClient, delegateAccount } from './client.js';
import { markBroadcast } from '../http/request-id.js';
import { ADDRESSES, SETTLEMENT_VENUES } from './chains.js';
import 'dotenv/config';

export const DELEGATION_ADDRESS = (process.env.DELEGATION_ADDRESS ??
  '0x0000000000000000000000000000000000000000') as Address;

/** USDC has 6 decimals; the app's caps are dollar figures. */
export const USD_DECIMALS = 6;

export const DELEGATION_ABI = [
  {
    type: 'function',
    name: 'grant',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'delegate', type: 'address' },
      { name: 'dailyCap', type: 'uint256' },
      { name: 'expiresAt', type: 'uint64' },
      { name: 'venues', type: 'address[]' },
    ],
    outputs: [],
  },
  { type: 'function', name: 'revoke', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  /*
   * `tokenOut` and `minOut` bind the trade's output to the owner (PLAN.md 1.4): the contract
   * measures the owner's `tokenOut` balance across the venue call and reverts unless it rose by at
   * least `minOut`. Before this, the router's receiver was whatever the calldata said, and the
   * delegate wrote the calldata.
   */
  {
    type: 'function',
    name: 'spend',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'venue', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'tokenOut', type: 'address' },
      { name: 'minOut', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ name: 'result', type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'closePosition',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'venue', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'tokenOut', type: 'address' },
      { name: 'minOut', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ name: 'result', type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'SETTLEMENT_TOKEN',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'policyOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [
      { name: 'delegate', type: 'address' },
      { name: 'dailyCap', type: 'uint256' },
      { name: 'expiresAt', type: 'uint64' },
      { name: 'revoked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'remainingToday',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'isVenueAllowed',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'venue', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'spentToday',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'isVenueAllowed',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'venue', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },

  /*
   * The two events an owner's own transaction leaves (PLAN.md 4.8), so a hash the app reports is
   * checked for what it did rather than only for whether it succeeded. See `grantInLogs`.
   */
  {
    type: 'event',
    name: 'Granted',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'delegate', type: 'address', indexed: true },
      { name: 'dailyCap', type: 'uint256', indexed: false },
      { name: 'expiresAt', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Revoked',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'delegate', type: 'address', indexed: true },
    ],
  },

  /*
   * The contract's own errors, so a refusal arrives as a sentence.
   *
   * These were missing, and viem can only decode a revert it has the ABI for — so a policy whose
   * delegate is someone else came back as `reverted with the following signature: 0x1db3b859 …
   * Unable to decode`, four bytes and an apology, on the one path where the contract had already
   * said exactly what was wrong. `humanFailure` turns a named error into something a user can act
   * on; it cannot name what it was never given.
   */
  { type: 'error', name: 'NotDelegate', inputs: [] },
  { type: 'error', name: 'PolicyRevoked', inputs: [] },
  { type: 'error', name: 'PolicyExpired', inputs: [] },
  { type: 'error', name: 'VenueNotAllowed', inputs: [{ name: 'venue', type: 'address' }] },
  {
    type: 'error',
    name: 'DailyCapExceeded',
    inputs: [
      { name: 'requested', type: 'uint256' },
      { name: 'remaining', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'VenueCallFailed', inputs: [] },
  { type: 'error', name: 'InvalidTokenOut', inputs: [] },
  { type: 'error', name: 'ZeroMinOut', inputs: [] },
  {
    type: 'error',
    name: 'OutputNotReceived',
    inputs: [
      { name: 'received', type: 'uint256' },
      { name: 'minOut', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'SettlementTokenNotClosable', inputs: [] },
  /** Our books' refusal of a delegated fill that names anyone but the owner, bubbled through `spend`. */
  {
    type: 'error',
    name: 'RecipientNotActiveOwner',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'activeOwner', type: 'address' },
    ],
  },
  /*
   * The VENUE's errors, so viem can decode what `spend` bubbles up.
   *
   * `spend` forwards a venue revert rather than masking it, which is right — but the ABI listed
   * only this contract's own errors, so viem answered a real 1inch slippage revert with
   *
   *   Unable to decode signature "0x064a4ec6" as it was not found on the provided ABI
   *
   * The information was on the wire and thrown away at the last step. These are 1inch's, not
   * ours; they belong here because this is the ABI the call is decoded against.
   */
  {
    type: 'error',
    name: 'ReturnAmountIsNotEnough',
    inputs: [
      { name: 'result', type: 'uint256' },
      { name: 'minReturn', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'ZeroReturnAmount', inputs: [] },
  { type: 'error', name: 'SafeTransferFromFailed', inputs: [] },
] as const;

export type OnChainPolicy = {
  delegate: Address;
  dailyCapUsd: number;
  expiresAt: number;
  revoked: boolean;
  remainingTodayUsd: number;
  spentTodayUsd: number;
};

export function usdToUnits(usd: number): bigint {
  return parseUnits(usd.toFixed(USD_DECIMALS), USD_DECIMALS);
}
export function unitsToUsd(units: bigint): number {
  return Number(formatUnits(units, USD_DECIMALS));
}

/** The three reads a permission is made of. */
function policyCalls(owner: Address) {
  return [
    { address: DELEGATION_ADDRESS, abi: DELEGATION_ABI, functionName: 'policyOf', args: [owner] },
    { address: DELEGATION_ADDRESS, abi: DELEGATION_ABI, functionName: 'remainingToday', args: [owner] },
    { address: DELEGATION_ADDRESS, abi: DELEGATION_ABI, functionName: 'spentToday', args: [owner] },
  ] as const;
}

/**
 * Read the live policy. Never trust our own database for an enforcement decision.
 *
 * One `eth_call` through Multicall3 rather than three (PLAN.md 2.4): every balance, limit check and
 * run paid three round trips for one permission. `allowFailure: false` keeps the old contract — any
 * read that fails throws, so a failure can never come back as "no permission".
 */
export async function readPolicy(owner: Address): Promise<OnChainPolicy | null> {
  const [policy, remaining, spent] = await publicClient.multicall({
    allowFailure: false,
    contracts: policyCalls(owner),
  });
  return toPolicy(policy, remaining, spent);
}

/**
 * The permission and the venues it allows, in one read (PLAN.md 2.5).
 *
 * The permission screen asked for the policy, then for the venue list — four calls in two rounds for
 * one screen. A failed read throws, as in `readPolicy`: an empty venue list must only ever mean the
 * user allowed nothing.
 */
export async function readPolicyAndVenues(
  owner: Address,
): Promise<{ policy: OnChainPolicy | null; venues: Address[] }> {
  // Widened on purpose: these are different functions of one ABI, which viem's per-call inference
  // cannot hold in a single array. Each result is typed back below by its position.
  const contracts: ContractFunctionParameters[] = [
    ...policyCalls(owner),
    ...SETTLEMENT_VENUES.map((venue) => ({
      address: DELEGATION_ADDRESS,
      abi: DELEGATION_ABI,
      functionName: 'isVenueAllowed',
      args: [owner, venue],
    })),
  ];
  const results = (await publicClient.multicall({ allowFailure: false, contracts })) as unknown[];
  const [policy, remaining, spent, ...allowed] = results;
  return {
    policy: toPolicy(policy as PolicyTuple, remaining as bigint, spent as bigint),
    venues: SETTLEMENT_VENUES.filter((_, i) => allowed[i] === true) as Address[],
  };
}

type PolicyTuple = readonly [Address, bigint, bigint, boolean];

function toPolicy(policy: PolicyTuple, remaining: bigint, spent: bigint): OnChainPolicy | null {
  const [delegate, dailyCap, expiresAt, revoked] = policy;
  if (delegate === '0x0000000000000000000000000000000000000000') return null;

  return {
    delegate,
    dailyCapUsd: unitsToUsd(dailyCap),
    expiresAt: Number(expiresAt) * 1000,
    revoked,
    remainingTodayUsd: unitsToUsd(remaining),
    spentTodayUsd: unitsToUsd(spent),
  };
}

export async function isVenueAllowed(owner: Address, venue: Address): Promise<boolean> {
  return publicClient.readContract({
    address: DELEGATION_ADDRESS,
    abi: DELEGATION_ABI,
    functionName: 'isVenueAllowed',
    args: [owner, venue],
  });
}

/**
 * Spend as the delegate. This is the ONLY thing the executor's key can do with user capital, and
 * the contract rejects it the moment it breaches the cap, the expiry or the venue allowlist.
 */
/**
 * Head-room on the gas limit for a delegated call.
 *
 * The estimate is taken against the state as it is NOW, and the transaction executes at least one
 * block later. That gap is not free: a lending pool accrues interest on the way through and writes
 * a slot the estimate never priced, and a router's route can touch a pool whose tick has since
 * moved. Measured on a Base fork, an Aave withdraw estimated at 172,488 and used 177,503 — a 3%
 * shortfall, which is an out-of-gas revert, not a slow trade.
 *
 * An out-of-gas revert is the worst failure this executor can have, because it looks exactly like
 * the venue refusing the trade and tells the user nothing true. Gas is refunded when unused, so
 * the only cost of the head-room is a slightly higher balance requirement on the bot's own wallet.
 */
const GAS_HEADROOM_PCT = 30n;

function withHeadroom(estimate: bigint): bigint {
  return (estimate * (100n + GAS_HEADROOM_PCT)) / 100n;
}

/** What a trade must deliver to the owner: the token, and the least of it, in raw units. */
export type OutputFloor = { tokenOut: Address; minOut: bigint };

export async function spendAsDelegate(
  params: {
    owner: Address;
    token?: Address;
    venue?: Address;
    usd: number;
    data: Hex;
  } & OutputFloor,
): Promise<Hex> {
  const call = {
    account: delegateAccount,
    address: DELEGATION_ADDRESS,
    abi: DELEGATION_ABI,
    functionName: 'spend',
    args: [
      params.owner,
      params.token ?? ADDRESSES.usdcBase,
      params.venue ?? ADDRESSES.oneInchRouter,
      usdToUnits(params.usd),
      params.tokenOut,
      params.minOut,
      params.data,
    ],
  } as const;
  // Simulate first, so a policy violation is caught before anything is signed and surfaces as the
  // contract's own named error rather than as a mined failure.
  const { request } = await publicClient.simulateContract(call);
  const gas = withHeadroom(await publicClient.estimateContractGas(call));
  // Recorded before it is signed: from here on, a retry of the request that asked for this must replay, never send.
  await markBroadcast();
  return walletClient.writeContract({ ...request, gas });
}

/**
 * Which of this chain's venues this owner has actually allowed.
 *
 * The mapping is not enumerable on chain — by design, since an unbounded array in storage is a gas
 * trap — so this asks about each venue we could possibly route through. That is the honest shape
 * of the question anyway: the safety screen is telling the user what THIS app can do with their
 * permission, not auditing every address they have ever allowed.
 */
export async function allowedVenues(owner: Address): Promise<Address[]> {
  const results = await publicClient.multicall({
    allowFailure: false,
    contracts: SETTLEMENT_VENUES.map((venue) => ({
      address: DELEGATION_ADDRESS,
      abi: DELEGATION_ABI,
      functionName: 'isVenueAllowed' as const,
      args: [owner, venue] as const,
    })),
  });
  return SETTLEMENT_VENUES.filter((_, i) => results[i] === true) as Address[];
}

export const delegatePublicKey = delegateAccount.address;

/**
 * Wait for a transaction the client says it sent.
 *
 * The app reports a hash the moment the wallet broadcasts it, which is before any block contains
 * it. Reading contract state at that instant sees the world as it was, so a grant that is on its
 * way looks like a grant that never happened. Bounded, because a hash the chain never accepts must
 * not hold a request open forever — the caller treats a timeout as "not confirmed", which is the
 * honest answer.
 */
/**
 * Wait for a transaction, and say plainly when there is nothing to wait for.
 *
 * Three answers, because they are three different facts:
 *   `true`      mined and succeeded
 *   `false`     mined and reverted
 *   `undefined` the chain has never heard of it
 *
 * The last one used to arrive as a thrown timeout after the full thirty seconds, which is the
 * right wait for a transaction that is genuinely in the mempool and the wrong one for a string
 * somebody typed. So the mempool is asked first: a hash the node cannot find AT ALL is not
 * pending, it is absent, and thirty seconds will not make it appear.
 *
 * Deliberately not a shortcut around the check — a transaction that IS pending still gets the full
 * wait, because that is the case the wait exists for.
 */
export async function waitForTx(
  hash: Hex,
  timeoutMs = 30_000,
  lookupMs = 15_000,
): Promise<boolean | undefined> {
  const receipt = await waitForReceipt(hash, timeoutMs, lookupMs);
  return receipt ? receipt.status === 'success' : undefined;
}

/**
 * The same wait, with the receipt kept (PLAN.md 4.8).
 *
 * Whether a transaction succeeded is not what it did. `/delegation/record` has to see the logs to
 * know a hash is a grant — this wallet's, naming this executor — so the receipt the wait already
 * fetched is handed back instead of being reduced to a boolean. Undefined in exactly the cases
 * `waitForTx` reports as absent.
 */
export async function waitForReceipt(
  hash: Hex,
  timeoutMs = 30_000,
  lookupMs = 15_000,
): Promise<TransactionReceipt | undefined> {
  /*
   * Looked up for a few seconds, not once (2026-09-13).
   *
   * The app posts a hash the moment its wallet broadcasts — through Privy's RPC — and this asks a
   * different node, where the transaction can take a second or two to appear. Asking once turned
   * that propagation gap into "That transaction is not on this chain": a real $1,600 grant, signed
   * through the hosted app's permission screen, was refused by `/delegation/record` while it was
   * landing, and the screen stayed on the permission step as though it had failed. A hash still
   * unknown after `lookupMs` is absent, which keeps the check this function exists for.
   */
  const deadline = Date.now() + lookupMs;
  let known = await publicClient.getTransaction({ hash }).catch(() => undefined);
  while (!known && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    known = await publicClient.getTransaction({ hash }).catch(() => undefined);
  }
  if (!known) return undefined;

  return publicClient
    .waitForTransactionReceipt({ hash, timeout: timeoutMs, confirmations: 1 })
    .catch(() => undefined);
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What a grant set, read from the `Granted` event its transaction emitted. */
export type GrantEvent = {
  owner: Address;
  delegate: Address;
  dailyCapUsd: number;
  /** Unix ms, as `OnChainPolicy.expiresAt` is. */
  expiresAt: number;
};

export type GrantInLogs =
  | { ok: true; grant: GrantEvent }
  | {
      ok: false;
      error: 'no_grant_event' | 'grant_owner_mismatch' | 'grant_delegate_mismatch';
      message: string;
    };

/**
 * The grant a transaction made, read from its own logs (PLAN.md 4.8).
 *
 * `/delegation/record` checked that a hash was mined and succeeded, then read whatever policy the
 * wallet held. So any successful transaction passed — an approval, a transfer, another wallet's
 * grant — and went into the append-only trail as "Trading permission granted" on the strength of a
 * grant made some other time. The numbers recorded were the chain's; the claim that THIS
 * transaction made them was only the client's.
 *
 * Now the transaction has to say it:
 *   - a `Granted` log emitted BY the delegation contract. The same event from any other address is
 *     anyone's to emit, naming any owner they like;
 *   - for this owner. `grant` records `msg.sender`, so the owner in the event is whoever signed;
 *   - naming the key this executor signs with. A grant to another delegate is inert — `spend`
 *     checks the caller — and recording it would put a permission the bot cannot use in the trail.
 *
 * Cap and expiry come from the event, never from the request. Where one transaction granted more
 * than once, the last grant is the one in force, because a grant replaces the one before it.
 */
export function grantInLogs(
  logs: readonly Log[],
  expected: { contract: Address; owner: Address; delegate: Address },
): GrantInLogs {
  const granted = parseEventLogs({
    abi: DELEGATION_ABI,
    eventName: 'Granted',
    logs: logs.filter((l) => sameAddress(l.address, expected.contract)),
  });
  if (granted.length === 0) {
    return {
      ok: false,
      error: 'no_grant_event',
      message:
        'That transaction did not grant a permission through the xorr delegation contract, so it ' +
        'was not recorded.',
    };
  }
  const own = granted.filter((g) => sameAddress(g.args.owner, expected.owner));
  const last = own[own.length - 1];
  if (!last) {
    return {
      ok: false,
      error: 'grant_owner_mismatch',
      message: 'That grant was signed by a different wallet, so it was not recorded against this one.',
    };
  }
  if (!sameAddress(last.args.delegate, expected.delegate)) {
    return {
      ok: false,
      error: 'grant_delegate_mismatch',
      message:
        'That grant names a key this executor does not sign with, so the bot could never use it. ' +
        'It was not recorded.',
    };
  }
  return {
    ok: true,
    grant: {
      owner: last.args.owner,
      delegate: last.args.delegate,
      dailyCapUsd: unitsToUsd(last.args.dailyCap),
      expiresAt: Number(last.args.expiresAt) * 1000,
    },
  };
}

export type RevokeInLogs =
  | { ok: true }
  | { ok: false; error: 'no_revoke_event' | 'revoke_owner_mismatch'; message: string };

/**
 * Whether a transaction revoked this owner's permission, read from its own logs.
 *
 * `/delegation/revoke` is authorised by the chain — the policy has to read revoked — so a hash
 * cannot fake a stop. But the hash is written into the trail as that stop's signature, and an
 * approval, or another wallet's revoke, carried there is a record pointing at the wrong
 * transaction. So the rule for a grant applies: a `Revoked` log from the delegation, for this owner.
 */
export function revokeInLogs(
  logs: readonly Log[],
  expected: { contract: Address; owner: Address },
): RevokeInLogs {
  const revoked = parseEventLogs({
    abi: DELEGATION_ABI,
    eventName: 'Revoked',
    logs: logs.filter((l) => sameAddress(l.address, expected.contract)),
  });
  if (revoked.length === 0) {
    return {
      ok: false,
      error: 'no_revoke_event',
      message:
        'That transaction did not revoke a permission through the xorr delegation contract, so it ' +
        'was not recorded.',
    };
  }
  if (!revoked.some((r) => sameAddress(r.args.owner, expected.owner))) {
    return {
      ok: false,
      error: 'revoke_owner_mismatch',
      message: 'That revoke was signed by a different wallet, so it was not recorded against this one.',
    };
  }
  return { ok: true };
}

/**
 * Close a position: sell a held asset back to the settlement token.
 *
 * Separate from `spendAsDelegate` because the contract treats it separately, and for the same
 * reason: the daily cap is denominated in the settlement token, so routing a sell through `spend`
 * would measure 0.3e18 wei of WETH against a cap of 2000e6 USDC units. Worse, it would let a
 * spending limit silence a stop-loss — and a stop a limit can silence is not a stop.
 *
 * `amount` is in the SOLD token's own units, not dollars, which is why this cannot share a
 * signature with the spend path.
 */
export async function closeAsDelegate(
  params: {
    owner: Address;
    token: Address;
    venue: Address;
    amount: bigint;
    data: Hex;
  } & OutputFloor,
): Promise<Hex> {
  const call = {
    account: delegateAccount,
    address: DELEGATION_ADDRESS,
    abi: DELEGATION_ABI,
    functionName: 'closePosition',
    args: [params.owner, params.token, params.venue, params.amount, params.tokenOut, params.minOut, params.data],
  } as const;
  const { request } = await publicClient.simulateContract(call);
  const gas = withHeadroom(await publicClient.estimateContractGas(call));
  // Recorded before it is signed, as a spend is: a close that answers 502 after this is replayed, never sold twice.
  await markBroadcast();
  return walletClient.writeContract({ ...request, gas });
}
