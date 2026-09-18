/**
 * The withdrawal allowlist, held by the executor (PLAN.md 4.9).
 *
 * Withdrawals go only to an address the owner put on this list, and an address cannot receive anything until
 * `COOLING_OFF_HOURS` after it was added. The list used to live on the phone, with the phone's own clock deciding
 * when the wait was over — and the cooling-off exists for the case where someone else is holding that phone. Now the
 * rows are here and both ends of the wait are the database's `now()`: written into `usable_at` when an address is
 * added, compared with it at every check. Nothing a client sends can move either.
 *
 * Three things read it:
 *   - the app, immediately before it asks the owner's wallet for a signature (`POST /withdrawal-addresses/check`);
 *   - the executor, before it prepares any transfer to an address (`POST /withdrawals/prepare-all`);
 *   - the record of a signed withdrawal, which says whether its destination was usable (`POST /withdrawals/record`).
 *
 * Every addition and removal is written to the audit trail in the same transaction as the row, and pushed to the
 * owner's devices: a cooling-off only protects someone who hears about the new address while it is still running.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getAddress, isAddress, zeroAddress } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { one, query, tx } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { append } from '../audit/log.js';
import { send } from '../notifications/push.js';

/** How long a new address waits before anything may be sent to it. A constant, not a setting — docs/SECURITY.md §7. */
export const COOLING_OFF_HOURS = 24;
export const COOLING_OFF_SECONDS = COOLING_OFF_HOURS * 3_600;

/**
 * The most live addresses one wallet keeps on one chain.
 *
 * More than anyone has places they keep money, and few enough that a client stuck in a loop — this repo has shipped a
 * `useEffect` that did exactly that — cannot fill the table and the trail with thousands of rows.
 */
export const MAX_ADDRESSES = 20;

/** The longest label migration 022 accepts. */
export const MAX_LABEL = 40;

export type WithdrawalAddress = {
  address: string;
  label: string;
  /** Milliseconds, by the database's clock. */
  addedAt: number;
  usableAt: number;
  /** `usable_at <= now()`, decided by the database when the row was read. */
  usable: boolean;
};

export type BookRefusal = { status: 'blocked'; reason: string; detail: string; entry?: WithdrawalAddress };

type Row = { address: string; label: string; added_at: Date; usable_at: Date; usable: boolean };

const COLUMNS = `address, label, added_at, usable_at, usable_at <= now() AS usable`;
const LIVE = `wallet_id = $1 AND chain = ${THIS_CHAIN} AND removed_at IS NULL`;

const shape = (r: Row): WithdrawalAddress => ({
  address: r.address,
  label: r.label,
  addedAt: new Date(r.added_at).getTime(),
  usableAt: new Date(r.usable_at).getTime(),
  usable: r.usable,
});

const refuse = (reason: string, detail: string, entry?: WithdrawalAddress): BookRefusal => ({
  status: 'blocked',
  reason,
  detail,
  ...(entry ? { entry } : {}),
});

/** A moment as the trail and the refusals say it: to the minute, and the same wherever the reader is. */
export function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** What someone pasted, as an address: trimmed, and `0X` read as the `0x` it means. */
export function normalise(address: string): string {
  const t = address.trim();
  return t.startsWith('0X') ? `0x${t.slice(2)}` : t;
}

export function isSolanaAddress(address: string): boolean {
  const t = address.trim();
  if (t.length < 32 || t.length > 44) return false;
  try {
    new PublicKey(t);
    return true;
  } catch {
    return false;
  }
}

export function isEvmAddress(address: string): boolean {
  const t = normalise(address);
  return isAddress(t, { strict: false });
}

/** Check if string is a valid EVM or Solana address depending on active chain */
export function isValidAddress(address: string, chain?: string): boolean {
  const t = normalise(address);
  const active = chain ?? process.env.XORR_CHAIN ?? process.env.EXPO_PUBLIC_XORR_CHAIN ?? '';
  if (active.startsWith('solana-')) {
    return isSolanaAddress(t);
  }
  return isEvmAddress(t);
}

/** Canonical format of address (checksummed for EVM, base58 for Solana) */
export function formatAddress(address: string, chain?: string): string {
  const t = normalise(address);
  const active = chain ?? process.env.XORR_CHAIN ?? process.env.EXPO_PUBLIC_XORR_CHAIN ?? '';
  if (active.startsWith('solana-')) {
    return t;
  }
  return isEvmAddress(t) ? getAddress(t) : t;
}

/** A cooling-off as the trail says it. The fork proof's short one is written as what it was, not rounded to hours. */
function span(seconds: number): string {
  return seconds % 3_600 === 0 ? `${seconds / 3_600} hours` : `${seconds} seconds`;
}

/**
 * One writer per wallet's book at a time.
 *
 * The duplicate check and the count are reads, and the insert that follows depends on both. Without this, two adds
 * sent together both see room and both see no duplicate; the unique index would still stop the second copy of one
 * address, but not a twenty-first address arriving beside a twentieth.
 */
async function lockBook(client: PoolClient, walletId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`withdrawal-addresses:${walletId}`]);
}

/**
 * This wallet's live addresses on this chain, oldest first, with the database's clock beside them.
 *
 * One statement, so `serverTime` is the moment every `usable` flag was decided at. The app says "usable in 3 h" from
 * those two numbers alone and never from its own clock.
 */
export async function listAddresses(walletId: string): Promise<{ serverTime: number; addresses: WithdrawalAddress[] }> {
  const rows = await query<Partial<Row> & { now: Date }>(
    `WITH clock AS (SELECT now() AS now)
     SELECT clock.now, a.address, a.label, a.added_at, a.usable_at, a.usable_at <= clock.now AS usable
       FROM clock
       LEFT JOIN withdrawal_addresses a
         ON a.wallet_id = $1 AND a.chain = ${THIS_CHAIN} AND a.removed_at IS NULL
      ORDER BY a.added_at ASC`,
    [walletId],
  );
  return {
    serverTime: new Date(rows[0]!.now).getTime(),
    addresses: rows.filter((r): r is Row & { now: Date } => typeof r.address === 'string').map(shape),
  };
}

export type DestinationVerdict =
  | { usable: true; address: string; label: string; usableAt: number }
  | { usable: false; reason: 'not_allowlisted'; detail: string }
  | { usable: false; reason: 'cooling_off'; detail: string; address: string; label: string; usableAt: number };

/**
 * May anything be sent to `address` from this wallet, right now?
 *
 * The one question every withdrawal path asks, answered by the database's clock at the moment it is asked — not by
 * the list a screen loaded a minute ago, which is what the app used to act on.
 */
export async function destinationStatus(walletId: string, address: string): Promise<DestinationVerdict> {
  const raw = normalise(address);
  if (!isValidAddress(raw)) {
    return { usable: false, reason: 'not_allowlisted', detail: 'That is not an address, so nothing can be sent to it.' };
  }
  const formatted = formatAddress(raw);
  const row = await one<Row>(
    `SELECT ${COLUMNS} FROM withdrawal_addresses WHERE ${LIVE} AND (address = $2 OR lower(address) = lower($2))`,
    [walletId, formatted],
  );
  if (!row) {
    return {
      usable: false,
      reason: 'not_allowlisted',
      detail: `${formatted} is not on your withdrawal allowlist, so nothing can be sent to it. An address you add becomes usable ${COOLING_OFF_HOURS} hours later.`,
    };
  }
  const entry = shape(row);
  if (!entry.usable) {
    return {
      usable: false,
      reason: 'cooling_off',
      detail: `${entry.label} (${entry.address}) is still cooling off. Nothing can be sent to it before ${utc(entry.usableAt)}, by the executor's clock.`,
      address: entry.address,
      label: entry.label,
      usableAt: entry.usableAt,
    };
  }
  return { usable: true, address: entry.address, label: entry.label, usableAt: entry.usableAt };
}

export type AddOutcome = { status: 'added'; entry: WithdrawalAddress } | BookRefusal;

/**
 * Put an address on the list. It becomes usable `coolingOffSeconds` from now, by the database's clock.
 *
 * @param coolingOffSeconds Always the constant, from every caller but one. `fork/prove-withdrawal.ts` cannot wait a
 *   day to show the database's clock letting an address through, so it passes a few seconds — through this INSERT
 *   rather than a copy of it, so the statement it proves is this one. The route passes nothing, and its test pins the
 *   86 400. The audit row says the span that was actually used.
 */
export async function addAddress(
  walletId: string,
  input: { label: string; address: string },
  coolingOffSeconds: number = COOLING_OFF_SECONDS,
): Promise<AddOutcome> {
  const label = input.label.trim();
  const raw = input.address;
  if (!isValidAddress(raw)) {
    const isSolana = (process.env.XORR_CHAIN ?? '').startsWith('solana-');
    return refuse(
      'invalid_address',
      isSolana
        ? 'That is not a Solana address. It should be a base58 public key.'
        : 'That is not a Base address. It should start 0x and be 42 characters.',
    );
  }
  const address = formatAddress(raw);
  if (address === zeroAddress || address === '11111111111111111111111111111111') {
    return refuse('zero_address', 'That is the zero or system address. Anything sent there is gone for good, so it cannot be a destination.');
  }
  if (label.length === 0 || label.length > MAX_LABEL) {
    return refuse('invalid_label', `Name the address in 1 to ${MAX_LABEL} characters.`);
  }
  if (!(coolingOffSeconds > 0)) throw new Error('A cooling-off is a positive number of seconds.');

  const out = await tx(async (client): Promise<AddOutcome> => {
    await lockBook(client, walletId);
    const existing = await client.query<Row>(
      `SELECT ${COLUMNS} FROM withdrawal_addresses WHERE ${LIVE} AND (address = $2 OR lower(address) = lower($2))`,
      [walletId, address],
    );
    if (existing.rows[0]) {
      const entry = shape(existing.rows[0]);
      /*
       * Refused, with the clock left alone.
       *
       * Adding an address that is already waiting must not restart its wait — a double tap would otherwise keep an
       * entry pending for as long as someone kept tapping — and it certainly must not end it.
       */
      return refuse(
        'already_listed',
        `${address} is already on your allowlist as ${entry.label}${entry.usable ? '' : `, usable from ${utc(entry.usableAt)}`}.`,
        entry,
      );
    }
    const live = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM withdrawal_addresses WHERE ${LIVE}`, [
      walletId,
    ]);
    if ((live.rows[0]?.n ?? 0) >= MAX_ADDRESSES) {
      return refuse('limit_reached', `Your allowlist already holds ${MAX_ADDRESSES} addresses. Remove one to add another.`);
    }

    const inserted = await client.query<Row>(
      `INSERT INTO withdrawal_addresses (id, wallet_id, address, label, usable_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::double precision))
       RETURNING ${COLUMNS}`,
      [randomUUID(), walletId, address, label, coolingOffSeconds],
    );
    const entry = shape(inserted.rows[0]!);
    await append(
      {
        walletId,
        agent: 'You',
        action: 'Withdrawal address added',
        detail: `${label} (${address}) can receive withdrawals from ${utc(entry.usableAt)}, ${span(coolingOffSeconds)} after it was added, by the executor's clock.`,
        kind: 'risk',
        payload: {
          address,
          label,
          addedAt: new Date(entry.addedAt).toISOString(),
          usableAt: new Date(entry.usableAt).toISOString(),
          coolingOffSeconds,
        },
      },
      client,
    );
    return { status: 'added', entry };
  });

  if (out.status === 'added') {
    void send(walletId, {
      title: 'A withdrawal address was added',
      body: `${out.entry.label} can receive withdrawals from ${utc(out.entry.usableAt)}. If you did not add it, remove it before then.`,
      route: '/allowlist',
      // Not in PUSH_KINDS, so there is no switch to mute it: the cooling-off is only worth its wait if this arrives.
      kind: 'allowlist-changed',
    }).catch(() => undefined);
  }
  return out;
}

export type RemoveOutcome = { status: 'removed'; address: string; label: string } | BookRefusal;

/** Take an address off the list, effective at once. Adding it again later starts a new cooling-off from zero. */
export async function removeAddress(walletId: string, address: string): Promise<RemoveOutcome> {
  const raw = normalise(address);
  if (!isValidAddress(raw)) {
    return refuse('not_listed', 'That is not an address, so it is not on your allowlist.');
  }
  const formatted = formatAddress(raw);
  const out = await tx(async (client): Promise<RemoveOutcome> => {
    await lockBook(client, walletId);
    const removed = await client.query<{ address: string; label: string }>(
      `UPDATE withdrawal_addresses SET removed_at = now()
        WHERE ${LIVE} AND (address = $2 OR lower(address) = lower($2))
        RETURNING address, label`,
      [walletId, formatted],
    );
    const row = removed.rows[0];
    if (!row) return refuse('not_listed', `${formatted} is not on your allowlist.`);
    await append(
      {
        walletId,
        agent: 'You',
        action: 'Withdrawal address removed',
        detail: `${row.label} (${row.address}) can no longer receive withdrawals, from this moment. Adding it again starts a new ${COOLING_OFF_HOURS}-hour cooling-off.`,
        kind: 'risk',
        payload: { address: row.address, label: row.label },
      },
      client,
    );
    return { status: 'removed', address: row.address, label: row.label };
  });

  if (out.status === 'removed') {
    void send(walletId, {
      title: 'A withdrawal address was removed',
      body: `${out.label} can no longer receive withdrawals.`,
      route: '/allowlist',
      kind: 'allowlist-changed',
    }).catch(() => undefined);
  }
  return out;
}
