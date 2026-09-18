/**
 * The audit trail, re-hashed on this device and held against the head the chain holds (FEATURES.md #12).
 *
 * `/audit/anchor` says whether the trail still agrees with what the chain was told — and it is the executor saying it,
 * about its own rows, with its own code, relaying its own read of the contract. The anchor was built so that answer
 * would not need trusting, and a screen that only repeats the executor's verdict puts the trust straight back. So the
 * phone does the comparison itself: the rows from the executor's export, hashed here, against the head read from the
 * contract through the build's own RPC.
 *
 * The hashing is a copy of `server/src/audit/log.ts`, not an import of it: that file reaches `pg` and `node:crypto`, and
 * a phone has neither. A copy is only safe while something notices the moment it stops matching, so
 * `anchorCheck.test.ts` hashes the same rows with both and fails on any difference — the arrangement `publicPaths.ts`
 * has with the server's list, for the same reason.
 */
import { sha256, stringToBytes } from 'viem';

/** What the first row of a trail points at. `GENESIS` in server/src/audit/log.ts. */
export const GENESIS = '0'.repeat(64);

/**
 * `canonical` from server/src/audit/log.ts, unchanged: JSON with object keys sorted, recursively.
 *
 * Unchanged means unchanged. The sort compares UTF-16 code units with `<`, not code points and not a locale, so a key
 * beginning with an emoji sorts before one beginning with "ﬁ" — and a "better" comparison here would hash every such
 * payload differently from the row that was written.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export type EntryFields = {
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
};

/**
 * `hashEntry` from server/src/audit/log.ts: SHA-256 over the canonical JSON of the row's fields, as lowercase hex.
 *
 * Node hashes a string as its UTF-8 bytes, and `stringToBytes` is UTF-8 too. The two could only part ways on a lone
 * surrogate, which never reaches the encoder: `canonical` builds the body out of `JSON.stringify`, and that writes a lone
 * surrogate as a `\ud800` escape, in ASCII.
 */
export function hashEntry(input: EntryFields): string {
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
  return sha256(stringToBytes(body)).slice(2);
}

/**
 * One row of `GET /activity/export?format=json`: `audit_log` as `pg` reads it, written out by `JSON.stringify`.
 *
 * So `seq` is a string (BIGSERIAL) and `at` is the ISO string of the `Date` pg made of the TIMESTAMPTZ. The export also
 * carries the executor's own verdict on its chain (`verified`), which nothing here reads.
 */
export type TrailRow = {
  seq: string;
  wallet_id: string;
  at: string;
  agent: string;
  action: string;
  detail: string;
  amount: string;
  kind: string;
  signature: string | null;
  payload: unknown;
  prev_hash: string;
  hash: string;
};

/**
 * A row's hash from its own fields, recomputed the way `verify()` in server/src/audit/log.ts recomputes it.
 *
 * The stored `hash` is never read. It is the executor's claim about the row, and the point is not to need it.
 */
export function rehashRow(row: TrailRow): string {
  return hashEntry({
    prevHash: row.prev_hash,
    walletId: row.wallet_id,
    at: new Date(row.at).toISOString(),
    agent: row.agent,
    action: row.action,
    detail: row.detail,
    amount: row.amount,
    kind: row.kind,
    signature: row.signature,
    payload: row.payload,
  });
}

const TEXT_FIELDS = ['wallet_id', 'at', 'agent', 'action', 'detail', 'amount', 'kind', 'prev_hash'] as const;

/** Whether a value is a row this can hash. Anything else is a trail that did not read, and gets no verdict. */
function isTrailRow(value: unknown): value is TrailRow {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.seq === 'string' &&
    /^\d+$/.test(row.seq) &&
    TEXT_FIELDS.every((field) => typeof row[field] === 'string') &&
    (row.signature === null || typeof row.signature === 'string') &&
    // `toISOString` throws on a date it cannot read; an unreadable row is not a mismatch.
    !Number.isNaN(Date.parse(row.at as string))
  );
}

/** What the contract's `latest()` holds, in numbers. */
export type OnChainAnchor = { head: string; entryCount: number; at: number; blockNo: number };

export type TrailCheck =
  /** The row at the anchored position re-hashes to the head, and links back to the first entry. */
  | { result: 'match'; blockNo: number; entryCount: number; newer: number; uncovered: number }
  /** The rows do not produce what the chain holds. `held`: how many rows the trail has. */
  | { result: 'mismatch'; blockNo: number; entryCount: number; newer: number; held: number }
  /** Nothing to compare: no anchor, or rows that did not read as a trail. */
  | { result: 'unchecked'; reason: 'not-anchored' | 'unreadable' };

/**
 * What the rows prove about the anchor, if anything.
 *
 * Two things have to hold, and the second is the one that is easy to skip:
 *
 *   1. The row at the anchored position hashes, here, to the head the chain holds. Position, not "any row with that
 *      hash": the anchor commits to a count as well as a hash, and a trail with a row slipped in or taken out in front
 *      of it has the right row in the wrong place. `agreement()` in server/src/audit/anchor.ts asks the same question
 *      the same way (`OFFSET entryCount - 1`).
 *
 *   2. That row links back to the first entry through rows this trail holds, each re-hashed here. The one row alone
 *      would pass a trail whose older rows were edited and given fresh hashes: the anchored row still hashes to the
 *      head, because the head commits to its predecessor's OLD hash — which no row produces any more. That is the edit
 *      the anchor exists to expose, and the executor's own walk calls it a fork, "damage, not an edit", because the
 *      edited row's stored hash agrees with its new contents.
 *
 * The walk follows `prev_hash` rather than assuming each row points at the one before it, because on some trails one
 * does not. Two appends that raced before the advisory lock in `append` both claimed the same predecessor, so the trail
 * forks and one of the pair is an ancestor of nothing written after it. Following the pointers keeps that from reading
 * as a mismatch — the head still commits, exactly, to every row it reaches — and counts the rows it does not reach
 * instead of claiming them.
 *
 * Rows after the anchored position are not the anchor's to judge. They are counted, not checked.
 */
export function checkTrail(rows: readonly unknown[], anchor: OnChainAnchor | null): TrailCheck {
  if (!anchor) return { result: 'unchecked', reason: 'not-anchored' };
  if (!rows.every(isTrailRow)) return { result: 'unchecked', reason: 'unreadable' };

  // The export is in sequence already. Position is the whole question, so it is not left to the export to keep.
  const ordered = [...rows].sort((a, b) => {
    const x = BigInt(a.seq);
    const y = BigInt(b.seq);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  if (ordered.some((row, i) => i > 0 && BigInt(row.seq) === BigInt(ordered[i - 1]!.seq))) {
    return { result: 'unchecked', reason: 'unreadable' };
  }

  const count = anchor.entryCount;
  const held = ordered.length;
  const newer = Math.max(0, held - count);
  const mismatch: TrailCheck = { result: 'mismatch', blockNo: anchor.blockNo, entryCount: count, newer, held };
  if (!Number.isSafeInteger(count) || count < 1 || count > held) return mismatch;

  const hashes = ordered.slice(0, count).map(rehashRow);
  if (hashes[count - 1] !== anchor.head.replace(/^0x/i, '').toLowerCase()) return mismatch;

  /*
   * Where each hash sits, so a pointer finds the row it names. Two rows can share a hash in principle — the same entry
   * appended twice in one millisecond — and the walk takes the latest of them that comes before where it stands.
   */
  const positions = new Map<string, number[]>();
  hashes.forEach((hash, i) => {
    const seen = positions.get(hash);
    if (seen) seen.push(i);
    else positions.set(hash, [i]);
  });

  let at = count - 1;
  let reached = 1;
  for (;;) {
    const pointer = ordered[at]!.prev_hash;
    if (pointer === GENESIS) break;
    const before = (positions.get(pointer) ?? []).filter((i) => i < at).pop();
    // The head commits to a row this trail no longer produces: changed, or gone.
    if (before === undefined) return mismatch;
    at = before;
    reached += 1;
  }
  return { result: 'match', blockNo: anchor.blockNo, entryCount: count, newer, uncovered: count - reached };
}

/**
 * `XorrAuditAnchor.latest`, the one read the device makes. The same entry as `ANCHOR_ABI` in
 * server/src/audit/anchor.ts, which the test holds it to.
 */
export const LATEST_ANCHOR_ABI = [
  {
    type: 'function',
    name: 'latest',
    stateMutability: 'view',
    inputs: [
      { name: 'anchorer', type: 'address' },
      { name: 'subject', type: 'address' },
    ],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'head', type: 'bytes32' },
          { name: 'entryCount', type: 'uint64' },
          { name: 'at', type: 'uint64' },
          { name: 'blockNo', type: 'uint64' },
        ],
      },
    ],
  },
] as const;

/** `latest()` as the contract answers it. A zero head is "never anchored": `anchor()` refuses to write one. */
export function anchorFromChain(raw: {
  head: string;
  entryCount: bigint;
  at: bigint;
  blockNo: bigint;
}): OnChainAnchor | null {
  if (/^0x0{64}$/i.test(raw.head)) return null;
  return {
    head: raw.head,
    entryCount: Number(raw.entryCount),
    at: Number(raw.at),
    blockNo: Number(raw.blockNo),
  };
}

export type CheckWords = { title: string; line: string; tone: 'up' | 'down' | 'quiet' };

const figure = (n: number) => n.toLocaleString('en-US');
const entries = (n: number) => `${figure(n)} ${n === 1 ? 'entry' : 'entries'}`;

/**
 * The result in words: one title, one line.
 *
 * "The chain", never a network's name — a fork build anchors to a fork, and the anchor screen names the network in
 * exactly one place already. And no word for "repair": a trail that does not match can be reported, never mended.
 */
export function checkWords(check: TrailCheck): CheckWords {
  switch (check.result) {
    case 'match': {
      const line = [`Anchored at block ${figure(check.blockNo)}.`];
      if (check.newer > 0) line.push(`${entries(check.newer)} since.`);
      if (check.uncovered > 0) {
        line.push(`${check.uncovered === 1 ? '1 earlier entry is' : `${figure(check.uncovered)} earlier entries are`} not covered.`);
      }
      return { title: 'Matches the chain', line: line.join(' '), tone: 'up' };
    }
    case 'mismatch':
      return {
        title: 'Does not match the chain',
        line:
          check.held < check.entryCount
            ? `Anchored at block ${figure(check.blockNo)} with ${entries(check.entryCount)}. The trail has ${figure(check.held)}.`
            : `Anchored at block ${figure(check.blockNo)}.`,
        tone: 'down',
      };
    case 'unchecked':
      return {
        title: 'Couldn’t check',
        line: check.reason === 'not-anchored' ? 'Nothing is anchored yet.' : 'The trail did not read cleanly.',
        tone: 'quiet',
      };
  }
}
