/**
 * The device's copy of the trail's hashing, held to the executor's (FEATURES.md #12).
 *
 * `anchorCheck.ts` copies `canonical` and `hashEntry` out of server/src/audit/log.ts, because a phone cannot import them.
 * A copy that drifted would not fail loudly. It would say "Does not match the chain" about a trail nobody touched — the
 * most alarming sentence the anchor screen has, said wrongly — so the same values go through both, including the shapes
 * that trip hashing up: text outside ASCII, nulls, keys in another order, numbers JSON rewrites.
 *
 * The trails here are built the way the executor builds them: hashed in `append` from the values in memory, stored
 * through Postgres (JSONB hands keys back in its own order, TIMESTAMPTZ comes back a `Date`), and exported through
 * `JSON.stringify`. So the device's answer is held to the hash each row was written with, not to a second run of the
 * same code.
 *
 * Invisible and look-alike characters are written as `\u{…}` escapes, so the test says which character it means.
 */
import { describe, expect, it, vi } from 'vitest';
import { canonical as serverCanonical, hashEntry as serverHashEntry } from '../../server/src/audit/log';
import { ANCHOR_ABI } from '../../server/src/audit/anchor';
import {
  GENESIS,
  LATEST_ANCHOR_ABI,
  anchorFromChain,
  canonical,
  checkTrail,
  checkWords,
  hashEntry,
  rehashRow,
  type EntryFields,
  type OnChainAnchor,
  type TrailCheck,
  type TrailRow,
} from './anchorCheck';

/*
 * `anchor.ts` makes the executor's delegate key as it loads, and with no key configured that means writing a new one to
 * disk. Only its ABI is wanted here, so the key and its clients are stood in for, as server/src/audit/anchor.test.ts does.
 */
vi.mock('../../server/src/evm/client.js', () => ({
  publicClient: {},
  walletClient: {},
  delegateAccount: { address: '0x00000000000000000000000000000000000000A1' },
}));

type Entry = {
  agent: string;
  action: string;
  detail: string;
  amount?: string;
  kind: 'trade' | 'risk' | 'block' | 'yield';
  signature?: string;
  payload?: Record<string, unknown>;
};

const WALLET = 'b6c1e0f2-7d4a-4c1b-9f3e-2a8d5c7e9b10';
const BLOCK = 41_234_567;

/** Three people joined by zero-width joiners, each one a surrogate pair. */
const FAMILY = '\u{1F469}\u{200D}\u{1F469}\u{200D}\u{1F467}';
/** Two regional indicators, which render as one flag. */
const FLAG = '\u{1F1FA}\u{1F1F8}';
/** An "e" and a combining acute accent: two code points that draw exactly like the one below, and hash differently. */
const E_COMBINING = 'e\u{301}';
const E_PRECOMPOSED = '\u{E9}';

const ENTRIES: Entry[] = [
  { agent: 'xorr', action: 'Wallet connected', detail: '', kind: 'risk' },
  {
    agent: 'Momentum Scout',
    action: 'Bought 0.105 WETH',
    detail: 'Breakout above the 20-day high',
    // U+2212, the way the trail writes a negative.
    amount: '−$370.02',
    kind: 'trade',
    signature: '0x5f1d7e3c9a2b4d6f8e0c1a3b5d7f9e1c3a5b7d9f1e3c5a7b9d1f3e5c7a9b1d3f',
    payload: { strategyId: 's1', runId: 'r1', venue: '1inch', fill: { usd: 370.02, units: 0.105, price: 3524 } },
  },
  {
    agent: 'Earnings Desk',
    action: 'Skipped NVDAx',
    detail: `spread 0.42% > your 0.25% limit — 日本語, مرحبا, नमस्ते, ${FAMILY} ${FLAG}`,
    kind: 'block',
    payload: {
      reason: 'spread',
      limits: [0.25, null, { z: 1, a: [] }],
      note: null,
      // Keys a naive sort orders differently: a ligature above the surrogates, integers, and nothing at all.
      '\u{FB01}': 'ligature',
      '\u{1F600}': 'emoji',
      '10': 'ten',
      '9': 'nine',
      '': 'empty',
    },
  },
  {
    agent: 'Yield',
    action: 'Moved idle cash',
    detail: `${E_COMBINING} is not ${E_PRECOMPOSED}; a line\u{2028}separator; a tab\t"quoted" \\ and /`,
    amount: '$1,000.00',
    kind: 'yield',
    payload: { apy: 0.0412, whole: 1.0, tiny: 5e-7, huge: 1e21, negativeZero: -0, flags: [true, false], deep: { er: { est: 'ok' } } },
  },
  { agent: 'xorr', action: 'Stopped all agents', detail: 'Stopped by you', kind: 'risk', signature: '0xabc', payload: { by: 'owner' } },
];

/** What Postgres JSONB hands back: the same data, keys in its own order — shorter first, then by bytes. */
function jsonb(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonb);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.length - b.length || Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(([k, v]) => [k, jsonb(v)]),
  );
}

/**
 * A trail as the executor writes, stores and exports it.
 *
 * `parents[i]` is the position of the row that row `i` names as its predecessor, -1 for none. Left out, each row names the
 * one before it; the forks that racing appends left behind are what an ordinary loop cannot build.
 */
function trail(entries: Entry[], parents?: number[]): { rows: TrailRow[]; written: string[] } {
  const written: string[] = [];
  const stored = entries.map((e, i) => {
    const parent = parents ? parents[i]! : i - 1;
    const prevHash = parent < 0 ? GENESIS : written[parent]!;
    // `append` stamps `new Date().toISOString()`.
    const at = new Date(Date.UTC(2026, 8, 14, 9, 0, i, i * 7)).toISOString();
    const amount = e.amount ?? '';
    const signature = e.signature ?? null;
    const payload = e.payload ?? {};
    const hash = serverHashEntry({
      prevHash,
      walletId: WALLET,
      at,
      agent: e.agent,
      action: e.action,
      detail: e.detail,
      amount,
      kind: e.kind,
      signature,
      payload,
    });
    written.push(hash);
    return {
      // `pg` reads BIGSERIAL as a string and TIMESTAMPTZ as a `Date`.
      seq: String(i + 1),
      wallet_id: WALLET,
      at: new Date(at),
      agent: e.agent,
      action: e.action,
      detail: e.detail,
      amount,
      kind: e.kind,
      signature,
      // `append` stores `JSON.stringify(payload)`, and `pg` parses what JSONB gives back.
      payload: jsonb(JSON.parse(JSON.stringify(payload))),
      prev_hash: prevHash,
      hash,
    };
  });
  // `exportTrail(walletId, 'json')`, and the phone reading it.
  const body = JSON.stringify({ walletId: WALLET, verified: { ok: true }, rows: stored }, null, 2);
  return { rows: (JSON.parse(body) as { rows: TrailRow[] }).rows, written };
}

const anchorAt = (written: string[], entryCount: number): OnChainAnchor => ({
  head: `0x${written[entryCount - 1]}`,
  entryCount,
  at: 1_789_300_000,
  blockNo: BLOCK,
});

describe('the device hashes exactly as the executor does', () => {
  it('writes canonical JSON character for character as the executor does', () => {
    const values: unknown[] = [
      null,
      true,
      false,
      0,
      -0,
      42,
      1.5,
      0.1 + 0.2,
      1e21,
      5e-7,
      Number.MAX_SAFE_INTEGER + 2,
      Number.NaN,
      '',
      'plain',
      '−$370.02',
      '日本語',
      FAMILY,
      E_COMBINING,
      E_PRECOMPOSED,
      '\u{2028}\u{2029}',
      '\u{0}\u{1F}',
      '\u{D800} lone',
      '"\\/',
      [],
      [3, 1, 2],
      [null, undefined, 1],
      {},
      { b: 1, a: 2 },
      { a: undefined, b: null },
      { '10': 1, '9': 2, a: 3, '': 4 },
      { '\u{FB01}': 1, '\u{1F600}': 2, Z: 3, a: 4 },
      JSON.parse('{"__proto__": {"x": 1}, "constructor": 2}'),
      { nested: { z: [{ y: 1, x: 2 }], a: { c: 3, b: 4 } } },
    ];
    for (const value of values) expect(canonical(value), String(JSON.stringify(value))).toBe(serverCanonical(value));
  });

  it('gives every row the executor’s hash, whatever is in it', () => {
    const base: EntryFields = {
      prevHash: GENESIS,
      walletId: WALLET,
      at: '2026-09-14T09:00:00.000Z',
      agent: 'xorr',
      action: 'Bought',
      detail: '',
      amount: '',
      kind: 'trade',
      signature: null,
      payload: {},
    };
    const variants: Partial<EntryFields>[] = [
      {},
      { signature: '0xabc' },
      { signature: '' },
      { payload: null },
      { payload: undefined },
      { payload: { b: [1, { d: null, c: FLAG }], a: E_PRECOMPOSED } },
      { detail: `spread 0.42% > your 0.25% limit — 日本語 ${FAMILY}` },
      { amount: '−$370.02' },
      { agent: E_COMBINING, action: E_PRECOMPOSED },
      { detail: 'a lone \u{D83D} surrogate' },
      { detail: 'line\u{2028}separator\nnewline\ttab "quote" \\ slash' },
    ];
    for (const variant of variants) {
      const input = { ...base, ...variant };
      expect(hashEntry(input), JSON.stringify(variant)).toBe(serverHashEntry(input));
    }
    // The two e's are different text, and the hash says so.
    expect(hashEntry({ ...base, agent: E_COMBINING })).not.toBe(hashEntry({ ...base, agent: E_PRECOMPOSED }));
    // A missing signature and a missing payload are committed to as empty, on both sides.
    expect(hashEntry({ ...base, signature: '' })).toBe(hashEntry(base));
    expect(hashEntry({ ...base, payload: null })).toBe(hashEntry(base));
  });

  it('is not moved by the order of a payload’s keys', () => {
    const base = { ...anchorFields(), payload: { runId: 'r1', strategyId: 's1', fill: { usd: 1, price: 2 } } };
    const reordered = { ...base, payload: { fill: { price: 2, usd: 1 }, strategyId: 's1', runId: 'r1' } };
    expect(hashEntry(reordered)).toBe(hashEntry(base));
    expect(hashEntry(reordered)).toBe(serverHashEntry(base));
  });

  it('re-hashes every exported row to the hash it was written with', () => {
    const { rows, written } = trail(ENTRIES);
    expect(rows.map(rehashRow)).toEqual(written);
  });

  it('reads the contract with the executor’s own ABI for `latest`', () => {
    expect(LATEST_ANCHOR_ABI).toEqual(ANCHOR_ABI.filter((f) => f.name === 'latest'));
  });
});

/** A plain row's fields, for the tests that only vary one thing. */
function anchorFields(): EntryFields {
  return {
    prevHash: GENESIS,
    walletId: WALLET,
    at: '2026-09-14T09:00:00.000Z',
    agent: 'Momentum Scout',
    action: 'Bought 0.105 WETH',
    detail: 'Breakout',
    amount: '−$370.02',
    kind: 'trade',
    signature: null,
    payload: {},
  };
}

describe('what the rows prove about the anchor', () => {
  it('matches when the anchored head is the newest row', () => {
    const { rows, written } = trail(ENTRIES);
    expect(checkTrail(rows, anchorAt(written, 5))).toEqual({
      result: 'match',
      blockNo: BLOCK,
      entryCount: 5,
      newer: 0,
      uncovered: 0,
    });
  });

  it('reads the head however the chain spells it', () => {
    const { rows, written } = trail(ENTRIES);
    expect(checkTrail(rows, { ...anchorAt(written, 5), head: `0x${written[4]!.toUpperCase()}` }).result).toBe('match');
  });

  it('holds an older anchor to the row at its position, and counts the rows since', () => {
    const { rows, written } = trail(ENTRIES);
    expect(checkTrail(rows, anchorAt(written, 3))).toEqual({
      result: 'match',
      blockNo: BLOCK,
      entryCount: 3,
      newer: 2,
      uncovered: 0,
    });
  });

  it('never reads the hashes the executor stored', () => {
    const { rows, written } = trail(ENTRIES);
    const blanked = rows.map((row) => ({ ...row, hash: 'f'.repeat(64) }));
    expect(checkTrail(blanked, anchorAt(written, 5)).result).toBe('match');
  });

  it('does not match when a row under the anchor was edited', () => {
    const { rows, written } = trail(ENTRIES);
    const edited = rows.map((row, i) => (i === 1 ? { ...row, amount: '−$37.02' } : row));
    expect(checkTrail(edited, anchorAt(written, 5))).toMatchObject({ result: 'mismatch', blockNo: BLOCK });
  });

  it('does not match an edited row given a fresh hash, which the executor’s own walk calls a fork', () => {
    const { rows, written } = trail(ENTRIES);
    const edited = rows.map((row, i) => (i === 1 ? { ...row, detail: 'Nothing to see' } : row));
    edited[1] = { ...edited[1]!, hash: rehashRow(edited[1]!) };
    // The anchored row alone still hashes to the head, so comparing it and nothing else would pass this trail.
    expect(rehashRow(edited[4]!)).toBe(written[4]);
    expect(checkTrail(edited, anchorAt(written, 5)).result).toBe('mismatch');
  });

  it('leaves an edit after the anchor to the trail’s own check', () => {
    const { rows, written } = trail(ENTRIES);
    const edited = rows.map((row, i) => (i === 4 ? { ...row, detail: 'changed later' } : row));
    expect(checkTrail(edited, anchorAt(written, 3))).toMatchObject({ result: 'match', newer: 2 });
  });

  it('does not match when rows under the anchor are gone', () => {
    const { rows, written } = trail(ENTRIES);
    const missing = rows.filter((_, i) => i !== 1);
    expect(checkTrail(missing, anchorAt(written, 5))).toEqual({
      result: 'mismatch',
      blockNo: BLOCK,
      entryCount: 5,
      newer: 0,
      held: 4,
    });
    // Under an older anchor too: the row at its position is now a different row.
    expect(checkTrail(missing, anchorAt(written, 3)).result).toBe('mismatch');
    expect(checkTrail([], anchorAt(written, 5))).toMatchObject({ result: 'mismatch', held: 0 });
  });

  it('does not match when a row is slipped in under the anchor, however well it is hashed', () => {
    const { rows, written } = trail(ENTRIES);
    const forged: TrailRow = { ...rows[0]!, seq: '0', action: 'Deposit', detail: 'backdated', prev_hash: GENESIS };
    forged.hash = rehashRow(forged);
    expect(checkTrail([forged, ...rows], anchorAt(written, 5)).result).toBe('mismatch');
  });

  it('puts the export back in sequence, by number, before it counts positions', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ ...ENTRIES[i % ENTRIES.length]!, detail: `run ${i}` }));
    const { rows, written } = trail(twelve);
    // As text, "10" sorts before "9", which would put a different row at every position past the ninth.
    expect(checkTrail([...rows].reverse(), anchorAt(written, 12)).result).toBe('match');
  });

  it('matches through a fork two racing appends left, and counts the entry the head does not reach', () => {
    // Rows 2 and 3 both claim row 1, as two appends did before the advisory lock; row 4 follows row 3.
    const { rows, written } = trail(ENTRIES, [-1, 0, 0, 2, 3]);
    expect(checkTrail(rows, anchorAt(written, 5))).toEqual({
      result: 'match',
      blockNo: BLOCK,
      entryCount: 5,
      newer: 0,
      uncovered: 1,
    });
    // The fork at entry 2: both first appends claimed genesis.
    const second = trail(ENTRIES, [-1, -1, 1, 2, 3]);
    expect(checkTrail(second.rows, anchorAt(second.written, 5))).toMatchObject({ result: 'match', uncovered: 1 });
  });

  it('does not match an edit on the line through a fork, and does not vouch for the entry off it', () => {
    const { rows, written } = trail(ENTRIES, [-1, 0, 0, 2, 3]);
    const onTheLine = rows.map((row, i) => (i === 0 ? { ...row, detail: 'rewritten' } : row));
    expect(checkTrail(onTheLine, anchorAt(written, 5)).result).toBe('mismatch');
    // The orphan is outside what the head commits to, which is why it is counted rather than claimed.
    const offTheLine = rows.map((row, i) => (i === 1 ? { ...row, detail: 'rewritten' } : row));
    expect(checkTrail(offTheLine, anchorAt(written, 5))).toMatchObject({ result: 'match', uncovered: 1 });
  });

  it('checks nothing when nothing is anchored', () => {
    const { rows } = trail(ENTRIES);
    expect(checkTrail(rows, null)).toEqual({ result: 'unchecked', reason: 'not-anchored' });
  });

  it('gives no verdict on rows that do not read as a trail', () => {
    const { rows, written } = trail(ENTRIES);
    const anchor = anchorAt(written, 5);
    const without = (row: TrailRow, field: string) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== field));
    const unreadable: unknown[][] = [
      rows.map((row, i) => (i === 2 ? { ...row, at: 'yesterday' } : row)),
      rows.map((row, i) => (i === 2 ? { ...row, seq: 'three' } : row)),
      // Two rows claiming one position.
      rows.map((row, i) => (i === 2 ? { ...row, seq: '2' } : row)),
      rows.map((row, i) => (i === 2 ? { ...row, signature: undefined } : row)),
      rows.map((row, i) => (i === 2 ? without(row, 'wallet_id') : row)),
      [...rows, null],
    ];
    for (const broken of unreadable) {
      expect(checkTrail(broken, anchor)).toEqual({ result: 'unchecked', reason: 'unreadable' });
    }
  });

  it('does not match a count the trail cannot hold', () => {
    const { rows, written } = trail(ENTRIES);
    expect(checkTrail(rows, { ...anchorAt(written, 5), entryCount: 0 }).result).toBe('mismatch');
  });
});

describe('the contract’s answer', () => {
  it('is "never anchored" when the head is zero', () => {
    expect(anchorFromChain({ head: `0x${'0'.repeat(64)}`, entryCount: 0n, at: 0n, blockNo: 0n })).toBeNull();
  });

  it('is read as numbers', () => {
    expect(anchorFromChain({ head: '0xab', entryCount: 12n, at: 1_789_300_000n, blockNo: 41_234_567n })).toEqual({
      head: '0xab',
      entryCount: 12,
      at: 1_789_300_000,
      blockNo: 41_234_567,
    });
  });
});

describe('the result, in words', () => {
  it('names the block a match was anchored at, and what the head does not cover', () => {
    expect(checkWords({ result: 'match', blockNo: BLOCK, entryCount: 5, newer: 0, uncovered: 0 })).toEqual({
      title: 'Matches the chain',
      line: 'Anchored at block 41,234,567.',
      tone: 'up',
    });
    expect(checkWords({ result: 'match', blockNo: 7, entryCount: 5, newer: 1, uncovered: 0 }).line).toBe(
      'Anchored at block 7. 1 entry since.',
    );
    expect(checkWords({ result: 'match', blockNo: 7, entryCount: 5, newer: 1_204, uncovered: 2 }).line).toBe(
      'Anchored at block 7. 1,204 entries since. 2 earlier entries are not covered.',
    );
    expect(checkWords({ result: 'match', blockNo: 7, entryCount: 5, newer: 0, uncovered: 1 }).line).toBe(
      'Anchored at block 7. 1 earlier entry is not covered.',
    );
  });

  it('says what is missing when the chain holds more entries than the trail', () => {
    expect(checkWords({ result: 'mismatch', blockNo: 7, entryCount: 12, newer: 0, held: 10 })).toEqual({
      title: 'Does not match the chain',
      line: 'Anchored at block 7 with 12 entries. The trail has 10.',
      tone: 'down',
    });
    expect(checkWords({ result: 'mismatch', blockNo: 7, entryCount: 3, newer: 2, held: 5 }).line).toBe(
      'Anchored at block 7.',
    );
  });

  it('never dresses a trail it could not check as a result, and offers no repair in any of them', () => {
    const all: TrailCheck[] = [
      { result: 'match', blockNo: 7, entryCount: 5, newer: 3, uncovered: 1 },
      { result: 'mismatch', blockNo: 7, entryCount: 12, newer: 0, held: 10 },
      { result: 'unchecked', reason: 'not-anchored' },
      { result: 'unchecked', reason: 'unreadable' },
    ];
    for (const check of all) {
      const words = checkWords(check);
      if (check.result === 'unchecked') expect(words).toMatchObject({ title: 'Couldn’t check', tone: 'quiet' });
      expect(`${words.title} ${words.line}`).not.toMatch(/repair|restore|!/i);
    }
  });
});
