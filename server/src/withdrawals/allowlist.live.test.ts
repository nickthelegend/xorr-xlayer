/**
 * The withdrawal allowlist against a real Postgres (PLAN.md 4.9): the database's clock decides when an address is
 * usable, removal is immediate, and adding an address back starts its wait again.
 *
 * LIVE because it writes to the database at DATABASE_URL: `LIVE=1 npx vitest run allowlist.live`. It creates its own
 * wallet row and deletes it afterwards, which takes its addresses with it. The audit rows it appends stay behind — the
 * trail is append-only by trigger, which is the point of it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { pool, query } from '../db/index.js';
import { bindWallet } from '../auth/walletBinding.js';
import { COOLING_OFF_HOURS, addAddress, destinationStatus, listAddresses, removeAddress } from './allowlist.js';

const fresh = () => getAddress(`0x${randomBytes(20).toString('hex')}`);
let walletId = '';

/** How long until the database's own clock reaches this address's `usable_at`, in milliseconds. */
async function untilUsable(address: string): Promise<number> {
  const rows = await query<{ wait: number }>(
    `SELECT greatest(0, ceil(extract(epoch FROM (usable_at - now())) * 1000))::int AS wait
       FROM withdrawal_addresses WHERE wallet_id = $1 AND address = $2 AND removed_at IS NULL`,
    [walletId, address],
  );
  return rows[0]!.wait;
}

beforeAll(async () => {
  const bound = await bindWallet({
    id: randomUUID(),
    userId: `did:privy:live-test-${randomUUID()}`,
    address: fresh(),
    kind: 'embedded',
    cluster: 'live-test',
  });
  if (bound.status !== 'bound') throw new Error('the test wallet could not be created');
  walletId = bound.row.id;
});

afterAll(async () => {
  await query(`DELETE FROM wallets WHERE id = $1`, [walletId]);
  await pool.end();
});

describe('the withdrawal allowlist, in Postgres', () => {
  const cold = fresh();
  let firstUsableAt = 0;

  it('holds a new address back for the full cooling-off, measured from the row the database wrote', async () => {
    const added = await addAddress(walletId, { label: 'Cold storage', address: cold.toLowerCase() });
    if (added.status !== 'added') throw new Error(`not added: ${JSON.stringify(added)}`);
    expect(added.entry.address).toBe(cold);
    expect(added.entry.usable).toBe(false);
    expect(added.entry.usableAt - added.entry.addedAt).toBe(COOLING_OFF_HOURS * 3_600_000);
    firstUsableAt = added.entry.usableAt;

    expect(await destinationStatus(walletId, cold)).toMatchObject({ usable: false, reason: 'cooling_off', usableAt: firstUsableAt });
  });

  it('refuses the same address again, in any spelling, without moving its clock', async () => {
    const again = await addAddress(walletId, { label: 'Again', address: `0X${cold.slice(2).toUpperCase()}` });
    expect(again).toMatchObject({ status: 'blocked', reason: 'already_listed', entry: { usableAt: firstUsableAt } });
    expect((await listAddresses(walletId)).addresses.filter((a) => a.address === cold)).toHaveLength(1);
  });

  it('lets an address through only once the database’s clock has passed its usable_at', async () => {
    const exchange = fresh();
    const added = await addAddress(walletId, { label: 'Exchange', address: exchange }, 2);
    if (added.status !== 'added') throw new Error(`not added: ${JSON.stringify(added)}`);
    expect(await destinationStatus(walletId, exchange)).toMatchObject({ usable: false, reason: 'cooling_off' });

    const wait = await untilUsable(exchange);
    await new Promise((resolve) => setTimeout(resolve, wait + 250));
    expect(await destinationStatus(walletId, exchange)).toMatchObject({ usable: true, label: 'Exchange' });

    const listed = await listAddresses(walletId);
    expect(listed.addresses.find((a) => a.address === exchange)?.usable).toBe(true);
    expect(listed.addresses.find((a) => a.address === cold)?.usable).toBe(false);
    expect(listed.serverTime).toBeGreaterThanOrEqual(added.entry.usableAt);

    // Removed, it is refused at once — no grace period, no cached answer.
    expect(await removeAddress(walletId, exchange.toLowerCase())).toMatchObject({ status: 'removed', label: 'Exchange' });
    expect(await destinationStatus(walletId, exchange)).toMatchObject({ usable: false, reason: 'not_allowlisted' });
    expect(await removeAddress(walletId, exchange)).toMatchObject({ status: 'blocked', reason: 'not_listed' });

    // Added back, it waits the whole cooling-off again, and the removed row is kept rather than revived.
    const back = await addAddress(walletId, { label: 'Exchange', address: exchange });
    if (back.status !== 'added') throw new Error(`not added back: ${JSON.stringify(back)}`);
    expect(back.entry.usable).toBe(false);
    expect(back.entry.usableAt - back.entry.addedAt).toBe(COOLING_OFF_HOURS * 3_600_000);
    expect(back.entry.usableAt).toBeGreaterThan(added.entry.usableAt);
    const rows = await query<{ removed: boolean }>(
      `SELECT removed_at IS NOT NULL AS removed FROM withdrawal_addresses WHERE wallet_id = $1 AND address = $2 ORDER BY added_at`,
      [walletId, exchange],
    );
    expect(rows.map((r) => r.removed)).toEqual([true, false]);
  });

  it('will not hold two live rows for one address, even written past the module', async () => {
    await expect(
      query(
        `INSERT INTO withdrawal_addresses (id, wallet_id, address, label, usable_at) VALUES ($1, $2, $3, 'Copy', now())`,
        [randomUUID(), walletId, cold.toLowerCase()],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('writes every change to the trail', async () => {
    const rows = await query<{ action: string; kind: string }>(
      `SELECT action, kind FROM audit_log WHERE wallet_id = $1 ORDER BY seq`,
      [walletId],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'Withdrawal address added',
      'Withdrawal address added',
      'Withdrawal address removed',
      'Withdrawal address added',
    ]);
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['risk']));
  });
});
