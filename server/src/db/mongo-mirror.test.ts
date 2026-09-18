/**
 * The MongoDB copy's value rules, without a database (`mongo-mirror.live.test.ts` runs the copy against real Postgres
 * and a real Atlas cluster).
 *
 * What is pinned here is what makes the row-by-row check honest: a row read from Postgres and its document read back
 * from MongoDB hash the same, any changed value hashes differently, numbers are never rounded into another number, and
 * two rows a microsecond apart stay two documents.
 */
import { describe, expect, it } from 'vitest';
import { Binary, Decimal128, Long } from 'mongodb';
import { OID, canonicalDecimal, digestOf, documentMaker, rowHash, timestamptzOf, toBson } from './mongo-mirror.js';

const UINT256_MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

describe('one spelling per decimal', () => {
  it('drops padding, exponents and signs of zero, and keeps what is not a number as written', () => {
    expect(canonicalDecimal('0.010000000')).toBe('0.01');
    expect(canonicalDecimal('1.000000000E-9')).toBe('0.000000001');
    expect(canonicalDecimal('1.5E+3')).toBe('1500');
    expect(canonicalDecimal('-0.50')).toBe('-0.5');
    expect(canonicalDecimal('123000')).toBe('123000');
    expect(canonicalDecimal('000.000')).toBe('0');
    expect(canonicalDecimal('.5')).toBe('0.5');
    expect(canonicalDecimal('NaN')).toBe('NaN');
  });
});

describe('what a value becomes in MongoDB', () => {
  it('keeps a numeric as Decimal128 where that is exact, and as its exact text where it is not', () => {
    const price = toBson(OID.numeric, '2519.740000');
    expect(price).toBeInstanceOf(Decimal128);
    expect(canonicalDecimal(String(price))).toBe('2519.74');
    // A limit order's traits are a uint256: 78 digits, more than Decimal128's 34.
    expect(toBson(OID.numeric, UINT256_MAX)).toBe(UINT256_MAX);
  });

  it('keeps a bigint as Int64 past the 53 bits a JavaScript number holds', () => {
    expect(toBson(OID.int8, '9007199254740993')).toEqual(Long.fromString('9007199254740993'));
  });

  it('reads a timestamptz as Postgres prints it, and leaves what it cannot read exactly as text', () => {
    expect((timestamptzOf('2026-09-09 23:14:00.465123+00') as Date).toISOString()).toBe('2026-09-09T23:14:00.465Z');
    expect((timestamptzOf('2026-09-10 04:44:00.5+05:30') as Date).toISOString()).toBe('2026-09-09T23:14:00.500Z');
    expect(timestamptzOf('infinity')).toBe('infinity');
    expect(timestamptzOf('1850-01-01 00:00:00+05:53:28')).toBe('1850-01-01 00:00:00+05:53:28');
  });

  it('keeps nulls as nulls and bytes as binary', () => {
    expect(toBson(OID.numeric, null)).toBeNull();
    expect(toBson(OID.bytea, Buffer.from('beef', 'hex'))).toBeInstanceOf(Binary);
  });
});

describe('a row and its document', () => {
  const columns = [
    { name: 'symbol', oid: OID.text },
    { name: 'at', oid: OID.timestamptz },
    { name: 'price', oid: OID.numeric },
    { name: 'traits', oid: OID.numeric },
    { name: 'seq', oid: OID.int8 },
    { name: 'payload', oid: OID.jsonb },
    { name: 'raw', oid: OID.bytea },
    { name: 'note', oid: OID.text },
  ];
  // As `pg` hands a row over with the copy's parsers: numerics and bigints as text, timestamps as their text.
  const row = {
    symbol: 'WETH',
    at: '2026-09-09 23:14:00.465123+00',
    price: '2519.740000',
    traits: UINT256_MAX,
    seq: '9007199254740993',
    payload: { venue: 'lop', amounts: [1, 2.5], nested: { ok: true } },
    raw: Buffer.from('beef', 'hex'),
    note: null,
  };
  const make = documentMaker(columns, ['symbol', 'at']);

  it('hash the same read from Postgres or from MongoDB', () => {
    const { _id, ...fields } = make(row);
    expect(_id).toEqual({ symbol: 'WETH', at: '2026-09-09 23:14:00.465123+00' });
    expect(fields.seq).toBeInstanceOf(Long);
    expect(fields.price).toBeInstanceOf(Decimal128);
    expect(fields.at).toBeInstanceOf(Date);
    expect(fields.raw).toBeInstanceOf(Binary);
    expect(rowHash(columns, fields)).toBe(rowHash(columns, row));
  });

  it('hash differently when any one value differs', () => {
    const base = rowHash(columns, row);
    expect(rowHash(columns, { ...row, price: '2519.75' })).not.toBe(base);
    expect(rowHash(columns, { ...row, traits: UINT256_MAX.replace(/5$/, '4') })).not.toBe(base);
    expect(rowHash(columns, { ...row, payload: { ...row.payload, venue: 'aqua' } })).not.toBe(base);
    expect(rowHash(columns, { ...row, note: '' })).not.toBe(base);
  });

  it('keeps two rows a microsecond apart as two keys, though their dates agree to the millisecond', () => {
    const a = make(row);
    const b = make({ ...row, at: '2026-09-09 23:14:00.465124+00' });
    expect(a._id).not.toEqual(b._id);
    expect(a.at).toEqual(b.at);
  });

  it('digest the same rows the same whatever order they were read in', () => {
    const hashes = [rowHash(columns, row), rowHash(columns, { ...row, symbol: 'USDC' })];
    expect(digestOf(hashes)).toBe(digestOf([...hashes].reverse()));
  });
});
