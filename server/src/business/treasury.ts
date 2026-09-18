/**
 * A business treasury (PLAN.md 4.14): a company's money, which the bot trades inside limits an operator sets.
 *
 * The workflow, as `routes/business.ts` runs it:
 *   1. An operator — a signed-in person — creates the treasury. Privy mints a server wallet owned by this deployment's key
 *      quorum with the deployment's policy attached, and the executor registers it as an owner like any other wallet.
 *   2. On a test network the faucet funds it, network fees included.
 *   3. The operator grants the bot a daily cap for some days. The treasury signs the approvals and the grant itself,
 *      through Privy and under the policy, and the grant is recorded from its own event (`delegation/record.ts`).
 *   4. The bot buys inside that grant through `placeOrder`, the one path in this executor that moves money.
 *   5. The operator revokes, and every trade after it is refused on-chain.
 *   6. At any time the operator can ask Privy to sign a transfer out of the treasury, and watch Privy refuse.
 *
 * Nobody holds the treasury's key — not the operator, not this server. What anyone can make it sign is what the policy
 * names: approve the delegation, grant this executor's key, revoke. A compromised executor or operator session can at worst
 * let the bot trade the cap at an allowlisted venue; the money cannot be sent anywhere.
 *
 * Never where money is real. A treasury here is a test-network wallet, and nothing should move real funds because a
 * business was set up.
 */
import { randomUUID } from 'node:crypto';
import {
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  isAddressEqual,
  maxUint256,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { one, pool, tx } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { append, list as listAudit } from '../audit/log.js';
import { POLICY_NAME, createPolicyWallet, ensurePolicy, getPolicy, getPrivyWallet, rpcAsWallet } from '../auth/privyPolicy.js';
import { recordGrant, recordRevoke, type Recorded } from '../delegation/record.js';
import { chainAllowance } from '../evm/allowances.js';
import { ADDRESSES, APPROVABLE_TOKENS, CHAIN_KEY, SETTLEMENT_VENUES, chain } from '../evm/chains.js';
import { publicClient } from '../evm/client.js';
import {
  DELEGATION_ABI,
  DELEGATION_ADDRESS,
  delegatePublicKey,
  readPolicy,
  usdToUnits,
  waitForReceipt,
  type OnChainPolicy,
} from '../evm/delegation.js';
import { readFaucetOffer, usdcOf } from '../evm/faucet.js';
import { dripGasIfNeeded } from '../evm/gasDrip.js';
import { moneyOn } from '../evm/money.js';
import { humanFailure } from '../executor/failure.js';
import { money, placeOrder } from '../executor/order.js';
import { ChainReadFailed, readChain } from '../http/chain-read.js';
import { log } from '../http/request-id.js';
import { claimFaucet } from '../routes/faucet.js';
import type { WalletRow } from '../routes/wallet-context.js';
import { TreasuryRefused, transactAsTreasury } from './treasurySigner.js';

export type TreasuryRow = {
  id: string;
  operator_user_id: string;
  wallet_id: string;
  privy_wallet_id: string;
  name: string;
  created_at: Date;
  /** From its `wallets` row. */
  address: string;
};

export type TreasuryPermission =
  | { state: 'none' }
  | { state: 'live' | 'stopped' | 'expired'; dailyCapUsd: number; remainingUsd: number; expiresAt: number };

export type TreasuryView = {
  id: string;
  name: string;
  address: Address;
  createdAt: number;
  /** What Privy holds and enforces for this wallet, read from Privy now. */
  privy: {
    walletId: string;
    ownerId: string | null;
    policyId: string | null;
    policyName: string | null;
    policyOwnerId: string | null;
    rules: number;
  };
  balances: { usdc: number; eth: number };
  /** The bot's permission on this treasury, read from the chain now. */
  permission: TreasuryPermission;
  /** Whether this network's faucet can send test funds now; null when that could not be read. */
  fundable: boolean | null;
  /** The treasury's own trail, newest first. */
  activity: { at: number; action: string; detail: string; tx: string | null }[];
};

export type TreasuryAnswer = { status: 200 | 404 | 409 | 500 | 502; body: Record<string, unknown> };

/** Privy did not answer a read the treasury's standing depends on: an upstream failure, as a chain read is. */
export class PrivyUnreadable extends Error {
  constructor(what: string, cause: unknown) {
    super(`Privy did not answer about ${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PrivyUnreadable';
  }
}

const USDC_DECIMALS = 6;
/** A USDC allowance of this many days of the cap, as a person's grant sets (`src/wallet/grantPlan.ts`). */
const SETTLEMENT_APPROVAL_DAYS = 30n;
/** Where an allowance still counts as unlimited: a token may take a little off a max approval as it is spent. */
const UNLIMITED = maxUint256 / 2n;
const DAY_SEC = 86_400n;
/** The gas a refused transfer is asked to be signed with. It is never sent, so it is never spent. */
const PROBE_GAS = 100_000n;

/** What a treasury is filed under in `wallets.user_id`: never the operator's own DID (migration 026). */
export const treasuryUserId = (operatorUserId: string) => `treasury:${operatorUserId}`;

/** The operator's treasury on this chain. */
export async function findTreasury(operatorUserId: string): Promise<TreasuryRow | undefined> {
  return one<TreasuryRow>(
    `SELECT t.id, t.operator_user_id, t.wallet_id, t.privy_wallet_id, t.name, t.created_at, w.address
       FROM business_treasuries t JOIN wallets w ON w.id = t.wallet_id
      WHERE t.operator_user_id = $1 AND t.chain = ${THIS_CHAIN}`,
    [operatorUserId],
  );
}

async function walletOf(t: TreasuryRow): Promise<WalletRow> {
  const w = await one<WalletRow>(`SELECT * FROM wallets WHERE id = $1`, [t.wallet_id]);
  if (!w) throw new Error(`The treasury's wallet row ${t.wallet_id} is missing.`);
  return w;
}

function refusedHere(): TreasuryAnswer | undefined {
  if (moneyOn(CHAIN_KEY) !== 'real') return undefined;
  return {
    status: 409,
    body: {
      error: 'real_money',
      message: 'A business treasury runs on a test network only, and this one settles real money. Nothing was done.',
    },
  };
}

const lockKey = (what: string) => `treasury:${CHAIN_KEY}:${what}`;

/**
 * One action at a time per treasury, across every executor sharing the database.
 *
 * A grant is up to four transactions from one account, each signed for the next nonce the chain gives. Two presses at once
 * would sign the same nonce and the chain would refuse one half way through, so the second is answered at once instead. A
 * session advisory lock, released with its connection if the process dies — as the faucet holds a claim.
 */
async function oneActionAtATime(key: string, run: () => Promise<TreasuryAnswer>): Promise<TreasuryAnswer> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key]);
    if (!rows[0]?.locked) {
      return { status: 409, body: { error: 'busy', message: 'The treasury is in the middle of something. Try again in a moment.' } };
    }
    try {
      return await run();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch((e: unknown) => {
        broken = e instanceof Error ? e : new Error(String(e));
      });
    }
  } finally {
    client.release(broken);
  }
}

/** The treasury as it stands after an action, read again, with a sentence saying what happened. */
async function answer(t: TreasuryRow, note: string, extra: Record<string, unknown> = {}): Promise<TreasuryAnswer> {
  return { status: 200, body: { ...extra, note, treasury: await treasuryView(t) } };
}

/** A step that did not happen, said as what it was: the policy refusing, or the chain or Privy failing. */
function failed(e: unknown, steps: unknown[]): TreasuryAnswer {
  if (e instanceof ChainReadFailed) throw e;
  if (e instanceof TreasuryRefused) {
    return { status: 409, body: { error: 'refused_by_policy', message: `Privy refused to sign it under the policy: ${e.message}`, steps } };
  }
  const raw = e instanceof Error ? e.message : String(e);
  log.warn(`[treasury] ${raw}`);
  return { status: 502, body: { error: 'treasury_failed', message: humanFailure(raw), raw: raw.slice(0, 400), steps } };
}

/** How long a record waits for the chain the executor reads to show what just landed. */
const READ_BACK_MS = 20_000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Record a transaction that landed once the chain the executor reads shows it.
 *
 * Privy's broadcast returns once Privy's node has the receipt, and the executor reads through its own node, which can be
 * a block behind. On Base Sepolia on 2026-09-15 the first treasury grant landed and was answered "Could not read your
 * permission from the chain just now", and its revoke landed and was refused as "still active on-chain": reads from a
 * node that had not reached the block. So the record waits, bounded, until the node is at the transaction's block and
 * the permission reads as the transaction left it, and a read that fails inside the record is asked once more. Nothing
 * the chain does not show is recorded: past the wait, the record refuses as it always did.
 */
async function recordWhenRead(hash: Hex, shows: () => Promise<boolean>, record: () => Promise<Recorded>): Promise<Recorded> {
  const receipt = await waitForReceipt(hash).catch(() => undefined);
  const deadline = Date.now() + READ_BACK_MS;
  while (receipt && Date.now() < deadline) {
    const head = await publicClient.getBlockNumber().catch(() => undefined);
    if (head !== undefined && head >= receipt.blockNumber && (await shows().catch(() => false))) break;
    await pause(1_000);
  }
  try {
    return await record();
  } catch (e) {
    if (!(e instanceof ChainReadFailed)) throw e;
    await pause(2_000);
    return record();
  }
}

/* ─────────────────────────────────────────────────────────────── 1. create */

export async function createTreasury(operatorUserId: string, name: string): Promise<TreasuryAnswer> {
  const refused = refusedHere();
  if (refused) return refused;
  return oneActionAtATime(lockKey(`create:${operatorUserId}`), async () => {
    const existing = await findTreasury(operatorUserId);
    if (existing) return answer(existing, 'This account already has a treasury here.');

    /*
     * Owned, or not made. A wallet under a policy no quorum owns is one the app secret alone could re-point at a wider
     * policy, and a treasury on those terms would be a promise rather than a control.
     */
    const policy = await ensurePolicy().catch((e: unknown) => {
      throw new PrivyUnreadable('the policy', e);
    });
    if (!policy.owner_id) {
      return {
        status: 409,
        body: {
          error: 'no_key_quorum',
          message: 'This deployment’s policy has no key quorum, so the app secret alone could change what a treasury may sign. Nothing was created.',
        },
      };
    }

    // Privy first, then the rows: a treasury recorded for a wallet Privy never made could sign nothing.
    const wallet = await createPolicyWallet();
    const address = getAddress(wallet.address);
    const walletId = randomUUID();
    await tx(async (client) => {
      await client.query(`INSERT INTO wallets (id, user_id, address, kind, cluster) VALUES ($1, $2, $3, 'treasury', $4)`, [
        walletId,
        treasuryUserId(operatorUserId),
        address,
        CHAIN_KEY,
      ]);
      await client.query(
        `INSERT INTO business_treasuries (id, operator_user_id, wallet_id, privy_wallet_id, name) VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), operatorUserId, walletId, wallet.id, name],
      );
      await append(
        {
          walletId,
          agent: 'operator',
          action: 'Treasury created',
          detail: `A Privy wallet under “${POLICY_NAME}”, owned by key quorum ${policy.owner_id}. It may approve the delegation, grant this executor and revoke; Privy refuses anything else.`,
          kind: 'risk',
          payload: { privyWalletId: wallet.id, policyIds: wallet.policy_ids, ownerId: wallet.owner_id },
        },
        client,
      );
    });

    // Base Sepolia's network fees come from the executor's faucet key; a fork's come with its test funds.
    if (moneyOn(CHAIN_KEY) === 'test') {
      const drip = await dripGasIfNeeded(address).catch((e: unknown) => ({
        sent: false as const,
        reason: e instanceof Error ? e.message : String(e),
      }));
      if (!drip.sent) log.warn(`[treasury] no gas sent to ${address}: ${drip.reason}`);
    }
    const created = await findTreasury(operatorUserId);
    if (!created) throw new Error(`The treasury for ${address} was written and cannot be read back.`);
    return answer(created, 'Created. Privy holds its key, under the policy.');
  });
}

/* ─────────────────────────────────────────────────────────────── 2. fund */

export async function fundTreasury(t: TreasuryRow): Promise<TreasuryAnswer> {
  const refused = refusedHere();
  if (refused) return refused;
  return oneActionAtATime(lockKey(t.id), async () => {
    // The faucet's own path: once a day per wallet, recorded in the treasury's trail, gas raised on a fork.
    const out = await claimFaucet(await walletOf(t));
    const sent = out.body as { status?: string; detail?: string; error?: string; usdc?: { amount?: number } };
    if (out.status !== 200) {
      return {
        status: out.status,
        body: {
          error: sent.status === 'blocked' ? 'faucet_refused' : 'faucet_failed',
          message: sent.detail ?? sent.error ?? 'Nothing was sent.',
          faucet: out.body,
        },
      };
    }
    return answer(t, `Added ${money(sent.usdc?.amount ?? 0)} of test USDC.`, { faucet: out.body });
  });
}

/* ─────────────────────────────────────────────────────────────── 3. grant */

/** The tokens a grant approves here: every one the bot may need to pull, that has code on this chain. */
async function tokensHere(): Promise<{ symbol: string; address: Address }[]> {
  const codes = await readChain('which tokens exist here', () =>
    Promise.all(APPROVABLE_TOKENS.map((t) => publicClient.getCode({ address: t.address }))),
  );
  return APPROVABLE_TOKENS.filter((_, i) => (codes[i]?.length ?? 0) > 2).map((t) => ({ symbol: t.symbol, address: t.address }));
}

export async function grantBot(t: TreasuryRow, dailyCapUsd: number, days: number): Promise<TreasuryAnswer> {
  const refused = refusedHere();
  if (refused) return refused;
  return oneActionAtATime(lockKey(t.id), async () => {
    const owner = getAddress(t.address);
    const send = (to: Address, data: Hex) => transactAsTreasury({ privyWalletId: t.privy_wallet_id, from: owner, to, data });

    // The treasury pays its own network fees. With none, the first approval would fail at the node after Privy signed it.
    const wei = await readChain('the treasury’s gas', () => publicClient.getBalance({ address: owner }));
    if (wei === 0n) {
      return { status: 409, body: { error: 'needs_gas', message: 'The treasury has no ETH for network fees yet. Add test funds first.' } };
    }

    const cap = usdToUnits(dailyCapUsd);
    const steps: { call: string; tx: Hex | null; detail: string }[] = [];
    try {
      // Approvals first and the grant last: stopped half way, the bot can pull nothing.
      for (const token of await tokensHere()) {
        const settlement = token.address.toLowerCase() === ADDRESSES.usdc.toLowerCase();
        const wanted = settlement ? cap * SETTLEMENT_APPROVAL_DAYS : maxUint256;
        const has = await chainAllowance(token.address, owner, DELEGATION_ADDRESS);
        if (has !== undefined && has >= (settlement ? wanted : UNLIMITED)) {
          steps.push({ call: `approve ${token.symbol}`, tx: null, detail: 'already approved' });
          continue;
        }
        const { hash } = await send(
          token.address,
          encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [DELEGATION_ADDRESS, wanted] }),
        );
        steps.push({ call: `approve ${token.symbol}`, tx: hash, detail: settlement ? `${SETTLEMENT_APPROVAL_DAYS} days of the cap` : 'unlimited' });
      }

      // Expiry by the chain's clock, which the contract compares against: a fork keeps its own time.
      const block = await readChain('the chain’s time', () => publicClient.getBlock());
      const expiresAt = block.timestamp + BigInt(days) * DAY_SEC;
      const { hash } = await send(
        DELEGATION_ADDRESS,
        encodeFunctionData({
          abi: DELEGATION_ABI,
          functionName: 'grant',
          args: [delegatePublicKey, cap, expiresAt, [...SETTLEMENT_VENUES]],
        }),
      );
      steps.push({ call: 'grant', tx: hash, detail: `${money(dailyCapUsd)} a day for ${days} days` });

      const expiresAtMs = Number(expiresAt) * 1000;
      const recorded = await recordWhenRead(
        hash,
        async () => {
          const p = await readPolicy(owner);
          return (
            !!p && !p.revoked && isAddressEqual(p.delegate, delegatePublicKey) && p.dailyCapUsd === dailyCapUsd && p.expiresAt === expiresAtMs
          );
        },
        () => recordGrant({ id: t.wallet_id, address: owner }, hash),
      );
      if (recorded.status !== 200) {
        return {
          status: 502,
          body: {
            error: 'grant_not_recorded',
            message: `The grant landed in ${hash} and could not be recorded: ${String(recorded.body.message ?? recorded.body.error)}`,
            steps,
          },
        };
      }
      return answer(t, `The bot may trade up to ${money(dailyCapUsd)} a day for ${days} days.`, { steps, tx: hash });
    } catch (e) {
      return failed(e, steps);
    }
  });
}

/* ─────────────────────────────────────────────────────────────── 4. trade */

export async function buyForTreasury(t: TreasuryRow, symbol: string, usd: number): Promise<TreasuryAnswer> {
  const refused = refusedHere();
  if (refused) return refused;
  return oneActionAtATime(lockKey(t.id), async () => {
    const order = await placeOrder(await walletOf(t), symbol, usd, `Treasury · ${money(usd)} of ${symbol}`);
    if (!order.placed) return { status: 409, body: { error: order.refusal.reason, message: order.refusal.detail } };
    const o = order.outcome;
    if (o.status === 'filled') {
      return answer(t, `Bought ${o.units.toFixed(4)} ${symbol} at ${money(o.price)}.`, { orderId: order.orderId, outcome: o, tx: o.signature });
    }
    const message =
      o.status === 'blocked' ? o.detail : o.status === 'failed' ? o.error : o.status === 'watch' ? 'Watched, not traded.' : 'Nothing was bought.';
    const status = o.status === 'failed' && /timeout|ECONN|fetch failed|429|5\d\d/i.test(o.raw) ? 502 : 409;
    return { status, body: { error: o.status, message, orderId: order.orderId, outcome: o } };
  });
}

/* ─────────────────────────────────────────────────────────────── 5. revoke */

export async function revokeBot(t: TreasuryRow): Promise<TreasuryAnswer> {
  const refused = refusedHere();
  if (refused) return refused;
  return oneActionAtATime(lockKey(t.id), async () => {
    const owner = getAddress(t.address);
    const policy = await readChain('the treasury’s permission', () => readPolicy(owner));
    if (!policy || policy.revoked) {
      return { status: 409, body: { error: 'nothing_to_stop', message: 'The bot holds no live permission on this treasury.' } };
    }
    try {
      const { hash } = await transactAsTreasury({
        privyWalletId: t.privy_wallet_id,
        from: owner,
        to: DELEGATION_ADDRESS,
        data: encodeFunctionData({ abi: DELEGATION_ABI, functionName: 'revoke' }),
      });
      const recorded = await recordWhenRead(
        hash,
        async () => {
          const p = await readPolicy(owner);
          return !p || p.revoked;
        },
        () => recordRevoke({ id: t.wallet_id, address: owner }, hash),
      );
      if (recorded.status !== 200) {
        return {
          status: 502,
          body: {
            error: 'revoke_not_recorded',
            message: `The revoke landed in ${hash} and could not be recorded: ${String(recorded.body.message ?? recorded.body.error)}`,
            tx: hash,
          },
        };
      }
      return answer(t, 'Stopped. The bot can no longer trade this treasury.', { tx: hash });
    } catch (e) {
      return failed(e, []);
    }
  });
}

/* ─────────────────────────────────────────────────────────────── 6. the refusal, seen */

/**
 * Ask Privy to sign a transfer of the treasury's USDC to `to`, and report what Privy did.
 *
 * Asked to SIGN, never to send, on every chain: were Privy ever to sign it, the bytes are dropped here and nothing
 * reaches a chain. Only a policy refusal is a proof. An answer that is neither — Privy down, a malformed request — says so,
 * because "it failed" is not "it was refused", and a probe that cannot tell them apart proves nothing.
 */
export async function proveRefusal(t: TreasuryRow, to: Address): Promise<TreasuryAnswer> {
  const refused = refusedHere();
  if (refused) return refused;
  const owner = getAddress(t.address);
  const [usdcRaw, nonce, fees] = await readChain('the treasury', () =>
    Promise.all([
      usdcOf(owner),
      publicClient.getTransactionCount({ address: owner, blockTag: 'pending' }),
      publicClient.estimateFeesPerGas(),
    ]),
  );
  // Everything it holds, or one USDC when it holds none: the size of the ask is not what the policy weighs.
  const amount = usdcRaw > 0n ? usdcRaw : 10n ** BigInt(USDC_DECIMALS);
  const usd = money(Number(formatUnits(amount, USDC_DECIMALS)));
  try {
    await rpcAsWallet(t.privy_wallet_id, {
      method: 'eth_signTransaction',
      params: {
        transaction: {
          to: ADDRESSES.usdc,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
          value: '0x0',
          chain_id: chain.id,
          nonce,
          gas_limit: toHex(PROBE_GAS),
          max_fee_per_gas: toHex(fees.maxFeePerGas),
          max_priority_fee_per_gas: toHex(fees.maxPriorityFeePerGas),
          type: 2,
        },
      },
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (!/policy violation/i.test(detail)) {
      return { status: 502, body: { error: 'privy_undecided', message: `Privy did not decide either way: ${detail.slice(0, 300)}` } };
    }
    await append({
      walletId: t.wallet_id,
      agent: 'operator',
      action: 'Transfer out refused',
      detail: `Asked to sign ${usd} of USDC to ${to}, Privy refused under the policy. Nothing was signed or sent.`,
      kind: 'block',
      payload: { to, amountRaw: amount.toString(), privy: detail.slice(0, 300) },
    });
    return answer(t, `Privy refused to sign a transfer of ${usd} out of the treasury.`, { proven: true, privy: detail.slice(0, 300) });
  }
  log.error(`[treasury] Privy signed a transfer out of ${owner} under the policy. It was not sent.`);
  return {
    status: 500,
    body: {
      error: 'policy_signed_transfer',
      message: 'Privy signed a transfer out of the treasury. Nothing was sent, and the policy needs looking at.',
      proven: false,
    },
  };
}

/* ─────────────────────────────────────────────────────────────── reading it */

function permissionOf(p: OnChainPolicy | null, now = Date.now()): TreasuryPermission {
  if (!p) return { state: 'none' };
  const state = p.revoked ? 'stopped' : p.expiresAt <= now ? 'expired' : 'live';
  return { state, dailyCapUsd: p.dailyCapUsd, remainingUsd: p.remainingTodayUsd, expiresAt: p.expiresAt };
}

async function privyStanding(walletId: string): Promise<TreasuryView['privy']> {
  try {
    const wallet = await getPrivyWallet(walletId);
    const policyId = wallet.policy_ids[0] ?? null;
    const policy = policyId ? await getPolicy(policyId) : undefined;
    return {
      walletId,
      ownerId: wallet.owner_id ?? null,
      policyId,
      policyName: policy?.name ?? null,
      policyOwnerId: policy?.owner_id ?? null,
      rules: policy?.rules.length ?? 0,
    };
  } catch (e) {
    throw new PrivyUnreadable('the treasury’s wallet', e);
  }
}

/** The treasury as it stands: Privy's account of the wallet, the chain's of the money and the permission, and its trail. */
export async function treasuryView(t: TreasuryRow): Promise<TreasuryView> {
  const owner = getAddress(t.address);
  const [privy, [usdcRaw, wei, policy], fundable, trail] = await Promise.all([
    privyStanding(t.privy_wallet_id),
    readChain('the treasury', () => Promise.all([usdcOf(owner), publicClient.getBalance({ address: owner }), readPolicy(owner)])),
    moneyOn(CHAIN_KEY) === 'real' ? false : readFaucetOffer().then((o) => o.available, () => null),
    listAudit(t.wallet_id, 8),
  ]);
  return {
    id: t.id,
    name: t.name,
    address: owner,
    createdAt: new Date(t.created_at).getTime(),
    privy,
    balances: { usdc: Number(formatUnits(usdcRaw, USDC_DECIMALS)), eth: Number(formatEther(wei)) },
    permission: permissionOf(policy),
    fundable,
    activity: trail.map((r) => ({ at: new Date(r.at).getTime(), action: r.action, detail: r.detail, tx: r.signature })),
  };
}
