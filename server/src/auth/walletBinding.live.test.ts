/**
 * A wallet row is never moved from one user to another — against a real Postgres.
 *
 * LIVE because it writes to the database at DATABASE_URL: `LIVE=1 npx vitest run walletBinding.live`.
 * It uses addresses and user ids it generates itself and deletes exactly those rows afterwards.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { pool, query } from '../db/index.js';
import { bindWallet } from './walletBinding.js';

const address = getAddress(`0x${randomBytes(20).toString('hex')}`);
const alice = `did:privy:live-test-${randomUUID()}`;
const mallory = `did:privy:live-test-${randomUUID()}`;

/** Addresses the race test creates, deleted with the rest. */
const raced: string[] = [];

afterAll(async () => {
  await query(`DELETE FROM wallets WHERE address = ANY($1)`, [[address, ...raced]]);
  await pool.end();
});

describe('bindWallet', () => {
  it('inserts a wallet the first time and reports it as new', async () => {
    const first = await bindWallet({ id: randomUUID(), userId: alice, address, kind: 'embedded', cluster: 'live-test' });
    expect(first.status).toBe('bound');
    expect(first.status === 'bound' && first.inserted).toBe(true);
  });

  it('touches the same row for the same user, and says it was not new', async () => {
    const again = await bindWallet({ id: randomUUID(), userId: alice, address, kind: 'embedded', cluster: 'live-test' });
    expect(again.status).toBe('bound');
    expect(again.status === 'bound' && again.inserted).toBe(false);
  });

  it('refuses to move the row to a different user — the takeover', async () => {
    const taken = await bindWallet({ id: randomUUID(), userId: mallory, address, kind: 'connected', cluster: 'live-test' });
    expect(taken.status).toBe('owned_by_another_user');
    const rows = await query<{ user_id: string; kind: string }>(`SELECT user_id, kind FROM wallets WHERE address = $1`, [
      address,
    ]);
    expect(rows).toEqual([{ user_id: alice, kind: 'embedded' }]);
  });

  /*
   * The race the gas drip depends on (PLAN.md 1.8).
   *
   * The drip fires when `inserted` is true, so "once per wallet" is exactly "one insert wins". Eight
   * first connects at once, as an app retrying on a slow network would send them.
   */
  it('lets exactly one of eight simultaneous first connects insert — so the drip fires once', async () => {
    const fresh = getAddress(`0x${randomBytes(20).toString('hex')}`);
    raced.push(fresh);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        bindWallet({ id: randomUUID(), userId: alice, address: fresh, kind: 'embedded', cluster: 'live-test' }),
      ),
    );
    expect(results.every((r) => r.status === 'bound')).toBe(true);
    expect(results.filter((r) => r.status === 'bound' && r.inserted)).toHaveLength(1);
  });
});
