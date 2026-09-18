/**
 * The withdrawal allowlist's rules, with the database stood in for (PLAN.md 4.9).
 *
 * What is pinned here is what the statements say, because the statements are where the decisions live: the wait is
 * `now()` plus the constant in the INSERT, usability is `usable_at <= now()` in the SELECT, and a removal is the UPDATE
 * that finds the live row. Whether Postgres then does what those statements say is `allowlist.live.test.ts`, against a
 * real one, and `fork/prove-withdrawal.ts`, against the running executor.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';

const h = vi.hoisted(() => ({
  statements: [] as { text: string; params: unknown[] }[],
  answer: (_text: string, _params: unknown[]): unknown[] => [],
}));

vi.mock('../db/index.js', () => {
  const run = async (text: string, params: unknown[] = []) => {
    h.statements.push({ text, params });
    const rows = h.answer(text, params);
    return { rows, rowCount: rows.length };
  };
  return {
    one: vi.fn(async (text: string, params: unknown[] = []) => (await run(text, params)).rows[0]),
    query: vi.fn(async (text: string, params: unknown[] = []) => (await run(text, params)).rows),
    tx: async (fn: (client: { query: typeof run }) => Promise<unknown>) => fn({ query: run }),
  };
});
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
vi.mock('../notifications/push.js', () => ({ send: vi.fn(async () => ({ sent: 0, skipped: 0, errors: [] })) }));

const { append } = await import('../audit/log.js');
const { send } = await import('../notifications/push.js');
const book = await import('./allowlist.js');

const WALLET = 'wallet-1';
const DEST = getAddress('0x95a0b368588713011a15f4b1041423f31b08e615');
const OTHER = getAddress('0x4200000000000000000000000000000000000006');
const HOUR = 3_600_000;
const ADDED = Date.UTC(2026, 8, 13, 9, 30);

type BookRow = { address: string; label: string; added_at: Date; usable_at: Date; usable: boolean };
const row = (over: Partial<BookRow> = {}): BookRow => ({
  address: DEST,
  label: 'Cold storage',
  added_at: new Date(ADDED),
  usable_at: new Date(ADDED + 24 * HOUR),
  usable: false,
  ...over,
});

const ran = (pattern: RegExp) => h.statements.filter((s) => pattern.test(s.text));
const isInsert = (text: string) => /^\s*INSERT INTO withdrawal_addresses/.test(text);
const isCount = (text: string) => /count\(\*\)/.test(text);

beforeEach(() => {
  h.statements.length = 0;
  h.answer = () => [];
  vi.mocked(append).mockClear();
  vi.mocked(send).mockClear();
});

describe('adding an address', () => {
  it('writes a wait of the full 24 hours, computed from the database clock, and says so in the trail', async () => {
    h.answer = (text) => (isInsert(text) ? [row()] : isCount(text) ? [{ n: 0 }] : []);
    const out = await book.addAddress(WALLET, { label: ' Cold storage ', address: DEST.toLowerCase() });

    expect(out).toEqual({
      status: 'added',
      entry: { address: DEST, label: 'Cold storage', addedAt: ADDED, usableAt: ADDED + 24 * HOUR, usable: false },
    });
    // The book is locked before it is read, so the duplicate check and the count cannot race another add.
    expect(h.statements[0]!.text).toMatch(/pg_advisory_xact_lock/);
    const [insert] = ran(/INSERT INTO withdrawal_addresses/);
    expect(insert!.text).toMatch(/now\(\) \+ make_interval\(secs => \$5::double precision\)/);
    expect(insert!.params).toEqual([expect.any(String), WALLET, DEST, 'Cold storage', 86_400]);

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: WALLET,
        kind: 'risk',
        action: 'Withdrawal address added',
        detail: expect.stringContaining('24 hours after it was added'),
      }),
      expect.anything(),
    );
    expect(send).toHaveBeenCalledWith(WALLET, expect.objectContaining({ kind: 'allowlist-changed', route: '/allowlist' }));
  });

  it('refuses an address already on the list, and leaves its clock exactly where it was', async () => {
    h.answer = (text) => (/^\s*SELECT address, label/.test(text) ? [row()] : []);
    const out = await book.addAddress(WALLET, { label: 'Again', address: DEST });

    expect(out).toMatchObject({ status: 'blocked', reason: 'already_listed', entry: { usableAt: ADDED + 24 * HOUR } });
    expect(ran(/INSERT|UPDATE/)).toHaveLength(0);
    expect(append).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('reads a 0X prefix and any casing as the one address it is', async () => {
    h.answer = (text) => (isInsert(text) ? [row()] : isCount(text) ? [{ n: 0 }] : []);
    await book.addAddress(WALLET, { label: 'Cold storage', address: `  0X${DEST.slice(2).toLowerCase()}  ` });

    const [duplicateCheck] = ran(/^\s*SELECT address, label/);
    expect(duplicateCheck!.text).toMatch(/lower\(address\) = lower\(\$2\)/);
    expect(ran(/INSERT INTO withdrawal_addresses/)[0]!.params[2]).toBe(DEST);
  });

  it('refuses what cannot be a destination before the database is asked anything', async () => {
    expect(await book.addAddress(WALLET, { label: 'Burn', address: '0x0000000000000000000000000000000000000000' })).toMatchObject({
      reason: 'zero_address',
    });
    // A Solana address, which the screen once required.
    expect(await book.addAddress(WALLET, { label: 'Old', address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' })).toMatchObject({
      reason: 'invalid_address',
    });
    expect(await book.addAddress(WALLET, { label: '   ', address: DEST })).toMatchObject({ reason: 'invalid_label' });
    expect(h.statements).toHaveLength(0);
  });

  it('keeps the list bounded', async () => {
    h.answer = (text) => (isCount(text) ? [{ n: book.MAX_ADDRESSES }] : []);
    expect(await book.addAddress(WALLET, { label: 'One more', address: DEST })).toMatchObject({ reason: 'limit_reached' });
    expect(ran(/INSERT/)).toHaveLength(0);
  });

  it('writes a shorter wait into the trail as exactly what it was', async () => {
    h.answer = (text) =>
      isInsert(text) ? [row({ usable_at: new Date(ADDED + 8_000) })] : isCount(text) ? [{ n: 0 }] : [];
    await book.addAddress(WALLET, { label: 'Cold storage', address: DEST }, 8);

    expect(ran(/INSERT INTO withdrawal_addresses/)[0]!.params[4]).toBe(8);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining('8 seconds after it was added') }),
      expect.anything(),
    );
    await expect(book.addAddress(WALLET, { label: 'Cold storage', address: DEST }, 0)).rejects.toThrow(/positive/);
  });
});

describe('removing an address', () => {
  it('takes effect in the statement that finds the live row, and says re-adding starts again', async () => {
    h.answer = (text) =>
      /^\s*UPDATE withdrawal_addresses SET removed_at = now\(\)/.test(text) ? [{ address: DEST, label: 'Cold storage' }] : [];
    const out = await book.removeAddress(WALLET, DEST.toLowerCase());

    expect(out).toEqual({ status: 'removed', address: DEST, label: 'Cold storage' });
    const [update] = ran(/UPDATE withdrawal_addresses/);
    expect(update!.text).toMatch(/removed_at IS NULL/);
    expect(update!.text).toMatch(/lower\(address\) = lower\(\$2\)/);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'risk',
        action: 'Withdrawal address removed',
        detail: expect.stringContaining('new 24-hour cooling-off'),
      }),
      expect.anything(),
    );
    expect(send).toHaveBeenCalledWith(WALLET, expect.objectContaining({ kind: 'allowlist-changed' }));
  });

  it('says so when there is nothing to remove, and writes nothing', async () => {
    expect(await book.removeAddress(WALLET, DEST)).toMatchObject({ status: 'blocked', reason: 'not_listed' });
    expect(append).not.toHaveBeenCalled();
  });
});

describe('whether an address is usable now', () => {
  it('is the database’s answer, for this chain, about a live row', async () => {
    h.answer = () => [row({ usable: false })];
    const pending = await book.destinationStatus(WALLET, DEST);

    expect(pending).toMatchObject({ usable: false, reason: 'cooling_off', label: 'Cold storage', usableAt: ADDED + 24 * HOUR });
    if (pending.usable) throw new Error('expected the address to be refused');
    expect(pending.detail).toContain(book.utc(ADDED + 24 * HOUR));
    const [select] = h.statements;
    expect(select!.text).toMatch(/usable_at <= now\(\) AS usable/);
    expect(select!.text).toMatch(/removed_at IS NULL/);
    expect(select!.text).toMatch(/chain = current_setting\('xorr.chain_key'\)/);
  });

  it('is usable once the database says its time has passed', async () => {
    h.answer = () => [row({ usable: true })];
    expect(await book.destinationStatus(WALLET, DEST)).toEqual({
      usable: true,
      address: DEST,
      label: 'Cold storage',
      usableAt: ADDED + 24 * HOUR,
    });
  });

  it('is not allowlisted when there is no live row, or no address at all', async () => {
    expect(await book.destinationStatus(WALLET, DEST)).toMatchObject({ usable: false, reason: 'not_allowlisted' });
    h.statements.length = 0;
    expect(await book.destinationStatus(WALLET, 'cold storage')).toMatchObject({ usable: false, reason: 'not_allowlisted' });
    expect(h.statements).toHaveLength(0);
  });
});

describe('the list', () => {
  it('carries the clock its flags were decided by, and is empty when it is empty', async () => {
    const now = new Date(ADDED + HOUR);
    h.answer = () => [{ now, address: null, label: null, added_at: null, usable_at: null, usable: null }];
    expect(await book.listAddresses(WALLET)).toEqual({ serverTime: ADDED + HOUR, addresses: [] });

    h.answer = () => [
      { now, ...row() },
      { now, ...row({ address: OTHER, label: 'Exchange', usable: true }) },
    ];
    const listed = await book.listAddresses(WALLET);
    expect(listed.serverTime).toBe(ADDED + HOUR);
    expect(listed.addresses.map((a) => [a.label, a.usable])).toEqual([
      ['Cold storage', false],
      ['Exchange', true],
    ]);
  });

  it('states a moment to the minute, in UTC', () => {
    expect(book.utc(Date.UTC(2026, 8, 14, 9, 30, 59))).toBe('2026-09-14 09:30 UTC');
  });
});
