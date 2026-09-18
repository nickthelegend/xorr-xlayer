/**
 * "Withdraw everything" — PLAN.md 4.9.
 *
 * Getting every dollar out is three transactions signed by two different parties, and their order is
 * not a preference:
 *
 *   1. Sell every position into USDC. The executor does this as the delegate, through
 *      `/positions/close` — the exit a daily cap cannot block — and the proceeds land in the owner's
 *      own wallet.
 *   2. Exit Aave. The owner signs this: the bot was never given the receipt token, so it cannot. The
 *      calldata comes from `/yield/withdraw-calldata` and is checked here before it is signed.
 *   3. Send the USDC to an allowlisted address. The owner signs a transfer of the whole balance that
 *      the executor prepared — only something reading the chain knows that balance to the unit —
 *      after the executor's own check that the address is usable, and after this file checks that the
 *      transfer moves exactly that amount to exactly that address.
 *
 * Each step waits for the one before it and none is skipped: a sale that failed leaves a position the
 * send cannot include, and an Aave exit that has not landed leaves USDC the send cannot see. So the
 * first failure stops the run with its reason, and everything after it stays unstarted rather than
 * half-done.
 *
 * Pure apart from the calls it is handed, so the ordering — the part that can cost someone money — is
 * tested without a wallet, a server or a chain.
 */
import {
  decodeFunctionData,
  erc20Abi,
  isAddress,
  isAddressEqual,
  maxUint256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { money, quantity, shortAddress } from '@/format';
import { errorText } from '@/data/apiError';
import { expiryState } from '@/state/derived';
import { humanWalletError } from './walletError';
import type {
  AavePosition,
  AaveWithdrawCall,
  CloseOutcome,
  PrepareOutcome,
  PreparedWithdrawal,
  RecordOutcome,
  SellPreview,
} from '@/data/withdrawals';

/**
 * The Aave v3 Pool on Base.
 *
 * Written here rather than taken from the executor: it is the one contract an exit from Aave may be
 * addressed to, and a signature is too late a place to learn that the executor thought otherwise.
 */
export const AAVE_V3_POOL: Address = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';

const POOL_ABI = parseAbi(['function withdraw(address asset, uint256 amount, address to) returns (uint256)']);

export type StepKey = 'sell' | 'aave' | 'send';
export type StepStatus = 'waiting' | 'running' | 'done' | 'failed';
/** One thing a step did: a sale, an exit, a transfer — or a position it left, and why. */
export type StepLine = { tone: 'done' | 'left' | 'failed'; text: string; txHash?: string };
export type Step = { key: StepKey; title: string; status: StepStatus; detail?: string; lines: StepLine[] };

/* The running card's titles are the plan's, word for word: the plan said "savings" while this said "Aave". */
const TITLES: Readonly<Record<StepKey, string>> = {
  sell: 'Sell every position',
  aave: 'Take your USDC out of savings',
  send: 'Send your USDC',
};
const ORDER: readonly StepKey[] = ['sell', 'aave', 'send'];

export function initialSteps(): Step[] {
  return ORDER.map((key) => ({ key, title: TITLES[key], status: 'waiting', lines: [] }));
}

/**
 * Why the bot cannot sell right now — or undefined when it can, or when the permission has not been read.
 *
 * A sale goes through `closePosition`, which checks what `spend` checks (`contracts/src/XorrDelegation.sol`):
 * the caller is the delegate the owner named, the policy is not revoked, and it has not expired. "Stop all
 * agents" revokes it, so after a stop every sale reverts — and "withdraw everything" found that out one
 * transaction into the run, and "sell everything" one leg at a time. It is said before the button instead.
 *
 * From the permission as the chain answers it, never the stored `killed` flag, which drifts from the chain
 * whenever anything happens outside this session — the reason Safety reads `revoked` whenever there is a
 * permission to read. Undefined claims nothing: a read that has not landed is not a stopped permission.
 */
export function sellBlocked(
  permission: { revoked: boolean; expiresAt?: number; delegateIsCurrent?: boolean } | null | undefined,
  now: number = Date.now(),
): string | undefined {
  if (permission === undefined) return undefined;
  if (permission === null) return 'Selling needs the bot’s permission, and there is none.';
  if (permission.revoked) return 'Selling needs the bot’s permission, and it is stopped.';
  if (expiryState(permission.expiresAt, now) === 'expired') return 'Selling needs the bot’s permission, and it has ended.';
  // A grant to a key the executor no longer signs with: `closePosition` refuses it as `NotDelegate`.
  if (permission.delegateIsCurrent === false) return 'Selling needs the bot’s permission, and it is disconnected.';
  return undefined;
}

export type WithdrawEverythingDeps = {
  /** The owner's own address, from their wallet — what every call they sign must pay back to. */
  owner: Address;
  /** A usable address on their allowlist, which they chose. */
  destination: { address: string; label: string };
  sellPreview: () => Promise<SellPreview>;
  close: (symbol: string) => Promise<CloseOutcome>;
  aavePosition: () => Promise<AavePosition>;
  aaveWithdrawCall: () => Promise<AaveWithdrawCall>;
  prepareAll: (to: string, token: string) => Promise<PrepareOutcome>;
  /** The owner's wallet: sends `data` to `to` and returns the transaction hash. */
  sign: (to: Address, data: Hex) => Promise<Hex>;
  record: (txHash: Hex) => Promise<RecordOutcome>;
};

/** A decode that fails is undefined rather than thrown: calldata that does not decode is refused, not crashed on. */
function tryDecode<T>(decode: () => T): T | undefined {
  try {
    return decode();
  } catch {
    return undefined;
  }
}

/**
 * Why an Aave exit must not be signed, or undefined when it is exactly the exit asked for.
 *
 * Worded as savings, the plan's word: these sentences are shown on the running card (PLAN.md O3).
 */
export function aaveExitProblem(call: AaveWithdrawCall, owner: Address): string | undefined {
  if (!isAddress(call.to) || !isAddressEqual(call.to, AAVE_V3_POOL)) {
    return `The savings withdrawal was addressed to ${call.to}, not the savings pool, so it was not signed.`;
  }
  const args = tryDecode(() => decodeFunctionData({ abi: POOL_ABI, data: call.data }).args);
  if (!args) return 'The savings withdrawal did not decode as a withdrawal, so it was not signed.';
  const [, amount, to] = args;
  if (!isAddressEqual(to, owner)) {
    return `The savings withdrawal would have paid ${to}, not your wallet, so it was not signed.`;
  }
  if (amount !== maxUint256) {
    return 'The savings withdrawal was for part of your savings, not all of it, so it was not signed.';
  }
  return undefined;
}

/** Why a prepared transfer must not be signed, or undefined when it moves exactly what it says to exactly where. */
export function transferProblem(prepared: PreparedWithdrawal, destination: string): string | undefined {
  const { call, token } = prepared;
  if (!isAddress(call.to) || !isAddress(token.address) || !isAddressEqual(call.to, token.address)) {
    return `The transfer was addressed to ${call.to}, not the ${token.symbol} contract, so it was not signed.`;
  }
  const decoded = tryDecode(() => decodeFunctionData({ abi: erc20Abi, data: call.data }));
  if (!decoded) return 'The transfer did not decode, so it was not signed.';
  if (decoded.functionName !== 'transfer') {
    return `The call was ${decoded.functionName}, not a transfer, so it was not signed.`;
  }
  const [to, amount] = decoded.args;
  if (!isAddress(destination) || !isAddressEqual(to, destination)) {
    return `The transfer would have gone to ${to}, not the address you chose, so it was not signed.`;
  }
  if (amount === 0n || amount !== BigInt(prepared.amountRaw)) {
    return 'The transfer does not move the amount it was prepared for, so it was not signed.';
  }
  return undefined;
}

type Outcome = { ok: boolean; detail: string };
type Note = (line: StepLine) => void;

/** A wallet failure in words: a cancelled sheet reads as a cancellation, not as an error. */
async function signed(deps: WithdrawEverythingDeps, to: Address, data: Hex): Promise<Hex> {
  try {
    return await deps.sign(to, data);
  } catch (e) {
    throw new Error(humanWalletError(e));
  }
}

/** A transaction the owner signed, read back by the executor: landed, or the reason it did not. */
function unconfirmed(recorded: RecordOutcome, what: string): string | undefined {
  return recorded.status === 'confirmed' ? undefined : `${what} did not go through: ${recorded.detail}`;
}

async function sell(deps: WithdrawEverythingDeps, note: Note): Promise<Outcome> {
  const preview = await deps.sellPreview();
  // Both absent for a wallet the executor has no row for — which has nothing to leave behind.
  const skipped = preview.skipped ?? [];
  const dust =
    skipped.length > 0 && preview.dustBelowUsd !== undefined
      ? ` ${skipped.join(', ')} ${skipped.length === 1 ? 'stays' : 'stay'}: worth under ${money(preview.dustBelowUsd)}, less than the gas to sell.`
      : '';
  if (preview.legs.length === 0) return { ok: true, detail: `Nothing to sell.${dust}` };

  let sold = 0;
  for (const leg of preview.legs) {
    const out = await deps.close(leg.symbol);
    if (out.status === 'closed') {
      sold += 1;
      note({ tone: 'done', text: `Sold ${quantity(out.units)} ${out.symbol} for ${money(out.usd)}`, txHash: out.txHash });
      continue;
    }
    // Gone since the preview, or worth less than the gas to sell: nothing here left to sell, which is this step's goal.
    if (out.status === 'blocked' && (out.reason === 'not_held' || out.reason === 'dust')) {
      note({ tone: 'left', text: `${leg.symbol}: ${out.detail ?? out.reason}` });
      continue;
    }
    const reason = out.status === 'blocked' ? (out.detail ?? out.reason) : out.error;
    note({ tone: 'failed', text: `${leg.symbol} was not sold: ${reason}` });
    return { ok: false, detail: `${leg.symbol} could not be sold, so nothing after it was started. ${reason}` };
  }
  return { ok: true, detail: `${sold === 1 ? 'One position' : `${sold} positions`} sold into USDC.${dust}` };
}

async function exitAave(deps: WithdrawEverythingDeps, note: Note): Promise<Outcome> {
  const position = await deps.aavePosition();
  if (!position.available) {
    // Not the executor's `reason`, which names the pool and its address: the card says savings.
    return { ok: true, detail: 'Nothing to take out: savings aren’t available here.' };
  }
  if (!(position.suppliedUsd > 0)) return { ok: true, detail: 'Nothing in savings.' };

  const call = await deps.aaveWithdrawCall();
  const problem = aaveExitProblem(call, deps.owner);
  if (problem) return { ok: false, detail: problem };

  const hash = await signed(deps, call.to as Address, call.data);
  const recorded = await deps.record(hash);
  const failed = unconfirmed(recorded, 'The savings withdrawal');
  if (failed || recorded.status !== 'confirmed') return { ok: false, detail: failed ?? '' };

  const amount = recorded.aave ? `${recorded.aave.amount} USDC` : money(position.suppliedUsd);
  note({ tone: 'done', text: `Withdrew ${amount} from savings`, txHash: hash });
  return { ok: true, detail: 'Back in your wallet.' };
}

async function send(deps: WithdrawEverythingDeps, note: Note): Promise<Outcome> {
  const prepared = await deps.prepareAll(deps.destination.address, 'USDC');
  if (prepared.status !== 'prepared') return { ok: false, detail: prepared.detail };
  const problem = transferProblem(prepared, deps.destination.address);
  if (problem) return { ok: false, detail: problem };

  const hash = await signed(deps, prepared.call.to as Address, prepared.call.data);
  const recorded = await deps.record(hash);
  const failed = unconfirmed(recorded, 'The transfer');
  if (failed) return { ok: false, detail: failed };

  note({
    tone: 'done',
    text: `Sent ${prepared.amount} ${prepared.token.symbol} to ${prepared.destination.label}`,
    txHash: hash,
  });
  return { ok: true, detail: `At ${prepared.destination.label}, ${shortAddress(prepared.destination.address)}.` };
}

const RUN: Readonly<Record<StepKey, (deps: WithdrawEverythingDeps, note: Note) => Promise<Outcome>>> = {
  sell,
  aave: exitAave,
  send,
};

/**
 * Run the three steps in order, reporting every change through `onChange`.
 *
 * `ok` is true only when all three finished. On a failure the failed step carries the reason, and the
 * steps after it are still `waiting` — which is the truth about them: they never began.
 */
export async function withdrawEverything(
  deps: WithdrawEverythingDeps,
  onChange: (steps: Step[]) => void,
): Promise<{ ok: boolean; steps: Step[] }> {
  let steps = initialSteps();
  const update = (key: StepKey, patch: (step: Step) => Partial<Step>) => {
    steps = steps.map((s) => (s.key === key ? { ...s, ...patch(s) } : s));
    onChange(steps);
  };

  for (const key of ORDER) {
    update(key, () => ({ status: 'running' }));
    let outcome: Outcome;
    try {
      outcome = await RUN[key](deps, (line) => update(key, (s) => ({ lines: [...s.lines, line] })));
    } catch (e) {
      // The executor's own sentence when it wrote one; a wallet failure has already been put into words.
      outcome = { ok: false, detail: errorText(e) };
    }
    update(key, () => ({ status: outcome.ok ? 'done' : 'failed', detail: outcome.detail }));
    if (!outcome.ok) return { ok: false, steps };
  }
  return { ok: true, steps };
}
