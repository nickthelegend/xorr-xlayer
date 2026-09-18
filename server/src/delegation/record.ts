/**
 * A permission, recorded from the transaction that made it or ended it (PLAN.md 4.8).
 *
 * The bodies of `POST /delegation/record` and `POST /delegation/revoke`, moved here as they were, so that a business
 * treasury's grant and revoke (PLAN.md 4.14) are held to exactly the rules a person's are. Two copies of "is this hash the
 * grant it claims to be" would become two sets of rules the first time one of them was fixed.
 *
 * A refusal comes back as `{ status: 400, body }`, the answer the routes gave. A chain read that fails still throws
 * `ChainReadFailed`, which every route answers 502.
 */
import { randomUUID } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { tx } from '../db/index.js';
import { append } from '../audit/log.js';
import { oncePerTransaction } from '../audit/once.js';
import { explorerTx } from '../evm/chains.js';
import { publicClient } from '../evm/client.js';
import {
  DELEGATION_ADDRESS,
  delegatePublicKey,
  grantInLogs,
  readPolicy,
  readPolicyAndVenues,
  revokeInLogs,
  waitForReceipt,
} from '../evm/delegation.js';
import { readChain } from '../http/chain-read.js';

/** The wallet a permission belongs to: its row, and the address that signed. */
export type PermissionOwner = { id: string; address: string };

export type Recorded = { status: 200 | 400; body: Record<string, unknown> };

const refusal = (error: string, message: string): Recorded => ({ status: 400, body: { error, message } });

/** Record a grant the owner already signed, so the audit trail has it. */
export async function recordGrant(w: PermissionOwner, txHash: Hex): Promise<Recorded> {
  const owner = w.address as Address;

  /*
   * Wait for the transaction the client says it sent, THEN read the chain.
   *
   * `eth_sendTransaction` returns as soon as the tx is broadcast, so reading the policy straight
   * away raced the block: the grant was genuinely on its way, the read came back empty, and the
   * record was refused with "not granted on-chain" — for a grant that landed a second later. The
   * trust model is unchanged; we still believe only what the chain says, we just let it say it.
   *
   * THE HASH HAS TO EXIST. This was `.catch(() => undefined)`, so a transaction that was never
   * mined — or never sent — was swallowed, and the policy read that followed passed on the
   * strength of some EARLIER real grant. The result: any well-formed 32-byte string was written
   * into the append-only trail as "Trading permission granted", carrying a block-explorer link to
   * a transaction the chain has never heard of. Proven with
   * `0x1234…1234`, which the app accepted and `cast tx` reports as "tx not found".
   *
   * A trail whose entries cannot be checked is the one thing this trail may not be, and it cannot
   * be repaired afterwards — so the check belongs before the write, not after it.
   */
  const receipt = await waitForReceipt(txHash).catch(() => undefined);
  if (!receipt) {
    return refusal(
      'tx_not_found',
      'That transaction is not on this chain. Nothing was recorded — the trail only carries ' +
        'hashes that can be looked up.',
    );
  }
  if (receipt.status !== 'success') {
    return refusal('tx_reverted', 'That transaction failed on-chain, so it granted nothing.');
  }

  /*
   * What THIS transaction granted, from its own logs (PLAN.md 4.8).
   *
   * Existing and succeeding was the whole test, and the record was then made of whatever policy the
   * wallet held — so an approval's hash, or another wallet's grant, went into the trail as "Trading
   * permission granted". `grantInLogs` holds the hash to a `Granted` event from the delegation
   * contract, for this wallet, naming this executor's key, and each refusal says which it was not.
   */
  const found = grantInLogs(receipt.logs, {
    contract: DELEGATION_ADDRESS,
    owner,
    delegate: delegatePublicKey,
  });
  if (!found.ok) return refusal(found.error, found.message);
  const { grant } = found;

  /*
   * Still the permission in force, and the venues it allows; and the block's time, which is when
   * the grant took effect.
   *
   * The event says what was granted then. A grant revoked or replaced since is not what the wallet
   * holds now, and recording it as the permission — with the current venue list beside it — would
   * describe one that no longer exists. The venues are the contract's answer rather than the list
   * the app asked for: the question `allowedVenues` asks, `isVenueAllowed` for every venue this app
   * routes through, put in the same multicall as the policy (PLAN.md 2.5).
   */
  const [{ policy, venues }, block] = await readChain('your permission', () =>
    Promise.all([readPolicyAndVenues(owner), publicClient.getBlock({ blockNumber: receipt.blockNumber })]),
  );
  if (!policy || policy.revoked) {
    // Trust the CHAIN, not the client's claim that it signed something.
    return refusal('not_granted_on_chain', 'No active policy found on-chain.');
  }
  if (
    policy.delegate.toLowerCase() !== grant.delegate.toLowerCase() ||
    policy.dailyCapUsd !== grant.dailyCapUsd ||
    policy.expiresAt !== grant.expiresAt
  ) {
    return refusal(
      'grant_superseded',
      'That grant has since been replaced on-chain by another, so it is not the permission in ' +
        'force. Nothing was recorded.',
    );
  }
  // The chain keeps a grant's expiry but not its start. Resume re-grants for `expires_at -
  // granted_at` (PLAN.md 4.7), so the start is recorded from the block that carried the event.
  const grantedAt = new Date(Number(block.timestamp) * 1000);

  /*
   * Once per transaction (PLAN.md X76): the row and the trail entry in one transaction, and neither again for a hash the
   * trail already carries — a retried POST, or a second press while the first waited on the chain, recorded one grant as
   * two. A repeat answers as the first did.
   */
  const written = await tx((client) =>
    oncePerTransaction(client, { walletId: w.id, action: 'Trading permission granted', signature: txHash }, async () => {
      await client.query(
        `INSERT INTO delegations (id, wallet_id, owner_pubkey, delegate_pubkey, daily_cap_usd, expires_at, venue_allowlist, grant_signature, granted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          randomUUID(),
          w.id,
          w.address,
          grant.delegate,
          grant.dailyCapUsd,
          new Date(grant.expiresAt),
          venues,
          txHash,
          grantedAt,
        ],
      );
      await append(
        {
          walletId: w.id,
          agent: 'xorr',
          action: 'Trading permission granted',
          detail: `Up to $${grant.dailyCapUsd.toLocaleString('en-US')} a day, expiring ${new Date(grant.expiresAt).toDateString()}.`,
          kind: 'risk',
          signature: txHash,
          payload: { explorer: explorerTx(txHash) },
        },
        client,
      );
    }),
  );

  return {
    status: 200,
    body: { ok: true, ...policy, venueAllowlist: venues, grantedAt: grantedAt.getTime(), alreadyRecorded: !written },
  };
}

/** Record a revoke the owner already signed. */
export async function recordRevoke(w: PermissionOwner, txHash?: Hex): Promise<Recorded> {
  // A read that fails is a 502 (PLAN.md 1.7), never the answer "not revoked".
  const policy = await readChain('your permission', () => readPolicy(w.address as Address));
  if (policy && !policy.revoked) {
    return refusal('still_active', 'The policy is still active on-chain. Sign the revoke first.');
  }

  /*
   * If a hash is offered, it has to be real — the same rule as `/delegation/record`.
   *
   * The chain check above is what authorises the revoke, so an unverified hash could not fake one.
   * But the hash is written into the append-only trail as this entry's signature, and an entry
   * carrying an explorer link to a transaction that does not exist is exactly as unusable as one
   * that faked the event. The hash is optional; a hash that cannot be looked up is not.
   *
   * Nor one that did something else (PLAN.md 4.8). Existing was the whole test, so a reverted
   * transaction, an approval or another wallet's revoke could be carried as the signature of this
   * wallet's stop. It has to be a successful transaction with a `Revoked` log from the delegation,
   * for this wallet — `revokeInLogs`, the rule a grant is held to.
   */
  if (txHash) {
    const receipt = await waitForReceipt(txHash).catch(() => undefined);
    if (!receipt) {
      return refusal(
        'tx_not_found',
        'That transaction is not on this chain. Nothing was recorded — the trail only carries ' +
          'hashes that can be looked up.',
      );
    }
    if (receipt.status !== 'success') {
      return refusal('tx_reverted', 'That transaction failed on-chain, so it revoked nothing.');
    }
    const found = revokeInLogs(receipt.logs, { contract: DELEGATION_ADDRESS, owner: w.address as Address });
    if (!found.ok) return refusal(found.error, found.message);
  }

  await tx(async (client) => {
    const stop = async () => {
      // This chain's rows (migration 023): a revoke here says nothing about a grant on another chain.
      await client.query(
        `UPDATE delegations SET revoked=true, revoke_signature=$2
          WHERE wallet_id=$1 AND revoked=false AND chain = current_setting('xorr.chain_key')`,
        [w.id, txHash ?? null],
      );
      await append(
        {
          walletId: w.id,
          agent: 'xorr',
          action: 'All agents stopped',
          detail: 'Permission revoked on-chain. Open positions are untouched.',
          kind: 'risk',
          signature: txHash,
        },
        client,
      );
    };
    // Once per transaction (PLAN.md X76). A revoke reported without a hash has nothing to be written once by.
    if (txHash) {
      await oncePerTransaction(client, { walletId: w.id, action: 'All agents stopped', signature: txHash }, stop);
    } else {
      await stop();
    }
  });

  return { status: 200, body: { revoked: true, ownerPubkey: w.address, dailyCapUsd: 0 } };
}
