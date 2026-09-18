/**
 * The audit trail — PLAN.md 12.11, closing [G28].
 *
 * screens.md calls this "the compliance artifact", so it is built like one:
 *   - APPEND-ONLY, enforced by a database trigger, not by convention.
 *   - HASH-CHAINED: every row commits to the previous row's hash, so a single edited or deleted
 *     row breaks verification for everything after it.
 *   - One row per ACTION *and per NON-ACTION*. The "Skipped NVDAx / spread 0.42% > your 0.25%
 *     limit" row on screen 15 is the most trust-building pixel in the app, and it only exists
 *     because blocks are logged as first-class events.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { one, pool, query, tx } from '../db/index.js';

export type AuditKind = 'trade' | 'risk' | 'block' | 'yield';

export type AuditEntry = {
  walletId: string;
  agent: string;
  action: string;
  detail: string;
  amount?: string;
  kind: AuditKind;
  signature?: string;
  payload?: Record<string, unknown>;
};

export type AuditRow = {
  seq: string;
  wallet_id: string;
  at: Date;
  agent: string;
  action: string;
  detail: string;
  amount: string;
  kind: AuditKind;
  signature: string | null;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
};

const GENESIS = '0'.repeat(64);

/**
 * Canonical JSON: object keys sorted, recursively.
 *
 * Postgres JSONB does not preserve key order — it normalises objects internally — so hashing
 * `JSON.stringify(payload)` produces one digest on write and a different one on read, and the
 * chain fails to verify for reasons that have nothing to do with tampering. Sorting keys on both
 * sides makes the digest depend on the DATA rather than on how the database happened to store it.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** The committed content of a row. Changing any field changes the hash. */
export function hashEntry(input: {
  prevHash: string;
  walletId: string;
  at: string;
  agent: string;
  action: string;
  detail: string;
  amount: string;
  kind: string;
  signature: string | null;
  payload: unknown;
}): string {
  const body = canonical([
    input.prevHash,
    input.walletId,
    input.at,
    input.agent,
    input.action,
    input.detail,
    input.amount,
    input.kind,
    input.signature ?? '',
    input.payload ?? {},
  ]);
  return createHash('sha256').update(body).digest('hex');
}

async function lastHash(walletId: string, client?: PoolClient): Promise<string> {
  const sql = `SELECT hash FROM audit_log WHERE wallet_id = $1 ORDER BY seq DESC LIMIT 1`;
  const rows = client
    ? (await client.query<{ hash: string }>(sql, [walletId])).rows
    : await query<{ hash: string }>(sql, [walletId]);
  return rows[0]?.hash ?? GENESIS;
}

/**
 * Only one append per wallet at a time.
 *
 * `lastHash` reads the tail and `append` then writes a row committing to it — a read-modify-write
 * with nothing in between. Two appends for the same wallet in flight together both read the same
 * tail and both write rows claiming it as their predecessor, so the second one's `prev_hash` no
 * longer matches the first one's `hash` and the chain is broken from that point on, permanently.
 *
 * It is not hypothetical and it is not rare: a fill writes a position and an audit row, the
 * scheduler and a manual run can overlap, and `/verify` on a real wallet reported
 * **"chain broken at entry 2"** — the tamper-evidence claim failing for a reason that had nothing
 * to do with tampering.
 *
 * A transaction-scoped advisory lock keyed on the wallet serialises them. It costs one round trip
 * on a path that already writes, releases automatically when the transaction ends however it ends,
 * and is per wallet, so two users never wait on each other.
 */
async function lockWallet(walletId: string, client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [walletId]);
}

export async function append(entry: AuditEntry, client?: PoolClient): Promise<AuditRow> {
  /*
   * The read and the write have to be in ONE transaction, or the lock protects nothing.
   *
   * Most callers already pass a client because they are writing the fill and the audit row
   * together; the ones that do not get a transaction opened for them here.
   */
  if (!client) return tx((c) => append(entry, c));
  await lockWallet(entry.walletId, client);
  const prevHash = await lastHash(entry.walletId, client);
  const at = new Date().toISOString();
  const amount = entry.amount ?? '';
  const signature = entry.signature ?? null;
  const payload = entry.payload ?? {};
  const hash = hashEntry({
    prevHash,
    walletId: entry.walletId,
    at,
    agent: entry.agent,
    action: entry.action,
    detail: entry.detail,
    amount,
    kind: entry.kind,
    signature,
    payload,
  });

  const sql = `
    INSERT INTO audit_log (wallet_id, at, agent, action, detail, amount, kind, signature, payload, prev_hash, hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *`;
  const params = [
    entry.walletId,
    at,
    entry.agent,
    entry.action,
    entry.detail,
    amount,
    entry.kind,
    signature,
    JSON.stringify(payload),
    prevHash,
    hash,
  ];
  const rows = client
    ? (await client.query<AuditRow>(sql, params)).rows
    : await query<AuditRow>(sql, params);
  return rows[0]!;
}

export async function list(walletId: string, limit = 200): Promise<AuditRow[]> {
  return query<AuditRow>(
    `SELECT * FROM audit_log WHERE wallet_id = $1 ORDER BY seq DESC LIMIT $2`,
    [walletId, limit],
  );
}

/**
 * Verify the chain. Returns the first break, if any — which is what makes the export defensible:
 * anyone can re-run this over the exported file and see for themselves.
 */
export type VerifyResult = {
  ok: boolean;
  brokenAtSeq?: string;
  checked: number;
  /**
   * WHICH property failed, because they are not the same claim.
   *
   * `content` — a row's stored hash does not match its own fields. Something edited the trail.
   * That is tampering, and it is the alarm this whole structure exists to raise.
   *
   * `link` — a row does not point at its predecessor. Rows fork instead of forming a line. That
   * is what the pre-lock `append` race produced: two writers read the same tail and both claimed
   * it. It is damage, it is permanent because the trail is append-only by design, and it is not
   * evidence that anyone altered a record.
   *
   * The check reported both as one flat failure, so "chain broken at entry 2" read exactly like
   * "someone edited your audit log". Different facts deserve different words.
   */
  kind?: 'link' | 'content';
  /** Rows whose own contents still hash to their stored hash, break or no break. */
  intact: number;
  /**
   * How many link breaks there are, and where the LAST one is.
   *
   * `brokenAtSeq` names the first, which was the only number reported — and on a trail carrying
   * one old fork, "forks at entry 2" is indistinguishable from "forks at entry 2 and is still
   * forking today". That is the difference between damage that was contained and damage that is
   * ongoing, and it was the one thing the walk would not say.
   *
   * The advisory lock in `append` is what stopped it. This is how a reader confirms that, instead
   * of taking it on faith.
   */
  linkBreaks: number;
  /** Seq of the most recent link break, when there is one. */
  lastBreakSeq?: string;
};

export async function verify(walletId: string): Promise<VerifyResult> {
  const rows = await query<AuditRow>(
    `SELECT * FROM audit_log WHERE wallet_id = $1 ORDER BY seq ASC`,
    [walletId],
  );
  let prev = GENESIS;
  let brokenAtSeq: string | undefined;
  let kind: 'link' | 'content' | undefined;
  let intact = 0;
  let linkBreaks = 0;
  let lastBreakSeq: string | undefined;

  for (const r of rows) {
    const expected = hashEntry({
      prevHash: r.prev_hash,
      walletId: r.wallet_id,
      at: new Date(r.at).toISOString(),
      agent: r.agent,
      action: r.action,
      detail: r.detail,
      amount: r.amount,
      kind: r.kind,
      signature: r.signature,
      payload: r.payload,
    });

    /*
     * Content is checked for EVERY row, not up to the first break.
     *
     * The loop used to return at the first mismatch of either sort, so one link break hid the
     * tamper state of every row after it — the one question the trail exists to answer, left
     * unanswered by the lesser fault. Content tampering also outranks a link break: if both are
     * present, the alarm is the one that gets reported.
     */
    if (expected === r.hash) intact += 1;
    else if (kind !== 'content') {
      kind = 'content';
      brokenAtSeq = r.seq;
    }

    /*
     * Every link break is counted, not only the first.
     *
     * `kind`/`brokenAtSeq` still name the first one, because that is where the line stops being
     * one line. The tally is what says whether the damage is historical or current.
     */
    if (r.prev_hash !== prev) {
      linkBreaks += 1;
      lastBreakSeq = r.seq;
      if (kind === undefined) {
        kind = 'link';
        brokenAtSeq = r.seq;
      }
    }
    prev = r.hash;
  }

  return { ok: kind === undefined, brokenAtSeq, checked: rows.length, kind, intact, linkBreaks, lastBreakSeq };
}

const CSV_COLUMNS = [
  'seq',
  'at',
  'agent',
  'action',
  'detail',
  'amount',
  'kind',
  'signature',
  'prev_hash',
  'hash',
] as const;

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportTrail(walletId: string, format: 'csv' | 'json'): Promise<string> {
  const rows = await query<AuditRow>(
    `SELECT * FROM audit_log WHERE wallet_id = $1 ORDER BY seq ASC`,
    [walletId],
  );
  const check = await verify(walletId);
  if (format === 'json') {
    return JSON.stringify({ walletId, verified: check, rows }, null, 2);
  }
  const header = CSV_COLUMNS.join(',');
  const body = rows
    .map((r) => CSV_COLUMNS.map((c) => csvCell((r as unknown as Record<string, unknown>)[c])).join(','))
    .join('\n');
  // The verification result travels with the file, so the recipient does not have to trust us.
  const footer = `\n# chain_verified=${check.ok} rows=${check.checked}`;
  return `${header}\n${body}${footer}`;
}

export { pool, one, GENESIS };
