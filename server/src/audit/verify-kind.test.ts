/**
 * A fork and an edit are not the same accusation.
 *
 * `verify` returned one flat `ok:false` for both, so `/verify` reported "chain broken at entry 2"
 * — rows forking after a concurrency race that has since been fixed and cannot be repaired — in
 * exactly the words it would use for someone having altered a record. The loud claim was made
 * quiet by sharing its alarm with a harmless, documented artefact.
 *
 * The database is not needed to prove the distinction: `verify` reads rows and re-hashes them, so
 * the rows are supplied directly.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const rows: Record<string, unknown>[] = [];
vi.mock('../db/index.js', () => ({
  query: async () => rows,
  one: async () => undefined,
  tx: async (fn: (c: unknown) => unknown) => fn({}),
}));

const { verify, hashEntry } = await import('./log.js');
const GENESIS = '0'.repeat(64);

/** Build a well-formed row that commits to `prev`. */
function row(seq: number, prev: string, action = `entry ${seq}`) {
  const base = {
    prev_hash: prev,
    wallet_id: 'w1',
    at: new Date(1_700_000_000_000 + seq).toISOString(),
    agent: 'test',
    action,
    detail: '',
    amount: '0',
    kind: 'trade',
    signature: null,
    payload: null,
  };
  const hash = hashEntry({
    prevHash: base.prev_hash,
    walletId: base.wallet_id,
    at: base.at,
    agent: base.agent,
    action: base.action,
    detail: base.detail,
    amount: base.amount,
    kind: base.kind,
    signature: base.signature,
    payload: base.payload,
  });
  return { ...base, seq: String(seq), hash };
}

beforeEach(() => {
  rows.length = 0;
});

describe('verify says which property failed', () => {
  it('an unbroken trail passes with nothing to report', async () => {
    const a = row(1, GENESIS);
    const b = row(2, a.hash);
    rows.push(a, b);
    const r = await verify('w1');
    expect(r).toMatchObject({ ok: true, checked: 2, intact: 2, kind: undefined });
  });

  it('two rows claiming one predecessor is a LINK break, not tampering', async () => {
    // Exactly what the pre-lock race wrote: both writers read the same tail.
    const a = row(1, GENESIS);
    const b = row(2, a.hash);
    const c = row(3, a.hash, 'the racing sibling');
    rows.push(a, b, c);
    const r = await verify('w1');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('link');
    expect(r.brokenAtSeq).toBe('3');
    // Every row is individually untouched, and saying so is the point.
    expect(r.intact).toBe(3);
  });

  it('a row that does not hash to its own contents is CONTENT — the alarm', async () => {
    const a = row(1, GENESIS);
    const b = row(2, a.hash);
    b.action = 'edited after the fact';
    rows.push(a, b);
    const r = await verify('w1');
    expect(r.kind).toBe('content');
    expect(r.brokenAtSeq).toBe('2');
    expect(r.intact).toBe(1);
  });

  it('tampering outranks a fork when both are present', async () => {
    // A link break must never mask an edit — that is the failure worth knowing about.
    const a = row(1, GENESIS);
    const forked = row(2, 'ff'.repeat(32));
    const edited = row(3, forked.hash);
    edited.detail = 'changed';
    rows.push(a, forked, edited);
    const r = await verify('w1');
    expect(r.kind).toBe('content');
  });

  it('content is checked past the first break, not abandoned at it', async () => {
    const a = row(1, GENESIS);
    const forked = row(2, 'ee'.repeat(32));
    const good = row(3, forked.hash);
    rows.push(a, forked, good);
    const r = await verify('w1');
    // All three still hash to themselves; the old loop returned before it could know.
    expect(r.intact).toBe(3);
    expect(r.kind).toBe('link');
  });

  /*
   * The tally is the difference between "this broke once, months ago" and "this is still
   * breaking". `/verify` reported only the first break, so those two read identically on screen.
   */
  it('counts every fork, not only the first, and names the newest', async () => {
    const a = row(1, GENESIS);
    const forked = row(2, 'ee'.repeat(32));
    const good = row(3, forked.hash);
    const forkedAgain = row(4, 'dd'.repeat(32));
    rows.push(a, forked, good, forkedAgain);
    const r = await verify('w1');
    expect(r.linkBreaks).toBe(2);
    expect(r.brokenAtSeq).toBe('2');
    expect(r.lastBreakSeq).toBe('4');
  });

  it('reports a single old fork as one break with nothing after it', async () => {
    const a = row(1, GENESIS);
    const forked = row(2, 'ee'.repeat(32));
    rows.push(a, forked, row(3, forked.hash), row(4, row(3, forked.hash).hash));
    const r = await verify('w1');
    expect(r.linkBreaks).toBe(1);
    expect(r.lastBreakSeq).toBe('2');
  });

  it('an unbroken chain has no breaks to count', async () => {
    const a = row(1, GENESIS);
    const b = row(2, a.hash);
    rows.push(a, b);
    const r = await verify('w1');
    expect(r.ok).toBe(true);
    expect(r.linkBreaks).toBe(0);
    expect(r.lastBreakSeq).toBeUndefined();
  });
});
