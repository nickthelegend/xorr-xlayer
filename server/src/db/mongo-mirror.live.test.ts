/**
 * LIVE — the MongoDB copy against a real Postgres and a real Atlas cluster (owner request, 2026-09-13).
 *
 * A scratch Postgres database is made holding every kind of value the copy treats specially — a uint256 numeric, a
 * bigint past 53 bits, two rows a microsecond apart under one composite key, jsonb, bytea, an array, nulls, and a table
 * with no primary key holding duplicate rows — and copied into a scratch Atlas database. Then Postgres changes (a row
 * updated, one deleted, a table dropped) and the copy runs again; then MongoDB is edited behind the copy's back, and
 * the re-check has to notice. Both scratch databases are dropped at the end.
 *
 * Run: LIVE=1 npx vitest run mongo-mirror.live
 * Needs DATABASE_URL — a Postgres this test may create a database on — and MONGODB_URI (both read from the repo-root
 * .env by the vitest config).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Binary, Decimal128, MongoClient } from 'mongodb';
import { mirrorToMongo, verifyMirror } from './mongo-mirror.js';

const ADMIN_URL = process.env.DATABASE_URL;
const MONGODB_URI = process.env.MONGODB_URI;
const RUN = Boolean(process.env.LIVE && ADMIN_URL && MONGODB_URI);
const NAME = `xorr_mirror_live_${randomBytes(4).toString('hex')}`;
const UINT256_MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
const FIRST_TICK = '2026-09-09 23:14:00.465123+00';
const SECOND_TICK = '2026-09-09 23:14:00.465124+00';

describe.skipIf(!RUN)('the MongoDB copy, against real Postgres and Atlas', () => {
  let admin: pg.Client | undefined;
  let pool: pg.Pool | undefined;
  let mongo: MongoClient | undefined;
  const copy = () =>
    mirrorToMongo({ connect: () => pool!.connect(), mongoUri: MONGODB_URI!, database: NAME, source: `live test ${NAME}` });

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${NAME}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${NAME}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await pool.query(`
      CREATE TABLE typed (
        id bigserial PRIMARY KEY, amount numeric(78, 0), price numeric(20, 8), big bigint, at timestamptz NOT NULL,
        day date, payload jsonb, raw bytea, tags text[], note text
      );
      CREATE TABLE ticks (symbol text, at timestamptz, price numeric(20, 8), PRIMARY KEY (symbol, at));
      CREATE TABLE loose (label text, n integer);
    `);
    await pool.query(
      `INSERT INTO typed (amount, price, big, at, day, payload, raw, tags, note) VALUES
         ($1, 2519.74, 9007199254740993, $2, '2026-09-09', '{"venue": "lop", "n": [1, 2.5]}', '\\xbeef', ARRAY['a', 'b'], NULL),
         (0, 0.00000001, -1, '2026-09-10 00:00:00+00', NULL, NULL, NULL, '{}', 'second')`,
      [UINT256_MAX, FIRST_TICK],
    );
    await pool.query(`INSERT INTO ticks VALUES ('WETH', $1, 2519.74), ('WETH', $2, 2519.75)`, [FIRST_TICK, SECOND_TICK]);
    await pool.query(`INSERT INTO loose VALUES ('same', 1), ('same', 1), ('other', 2)`);
    mongo = new MongoClient(MONGODB_URI!, { serverSelectionTimeoutMS: 20_000 });
    await mongo.connect();
  }, 180_000);

  afterAll(async () => {
    await mongo?.db(NAME).dropDatabase().catch(() => undefined);
    await mongo?.close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await admin?.query(`DROP DATABASE IF EXISTS ${NAME}`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  }, 180_000);

  it('copies every table and every kind of value, and the copy re-checks from MongoDB alone', async () => {
    const run = await copy();
    expect(run.tables.map((t) => [t.table, t.rows])).toEqual([
      ['loose', 3],
      ['ticks', 2],
      ['typed', 2],
    ]);
    const db = mongo!.db(NAME);
    expect((await verifyMirror(db)).map((c) => [c.table, c.counted, c.digestMatches])).toEqual([
      ['loose', 3, true],
      ['ticks', 2, true],
      ['typed', 2, true],
    ]);

    const first = await db.collection('typed').findOne({ note: null }, { promoteLongs: false });
    expect(first?.amount).toBe(UINT256_MAX);
    expect(first?.price).toBeInstanceOf(Decimal128);
    expect(String(first?.big)).toBe('9007199254740993');
    expect((first?.at as Date).toISOString()).toBe('2026-09-09T23:14:00.465Z');
    expect(first?.day).toBe('2026-09-09');
    expect(first?.payload).toEqual({ venue: 'lop', n: [1, 2.5] });
    expect(first?.raw).toBeInstanceOf(Binary);
    expect(first?.tags).toEqual(['a', 'b']);

    // A microsecond apart: two documents, two keys, and one millisecond date between them.
    const ticks = await db.collection('ticks').find({}).sort({ '_id.at': 1 }).toArray();
    expect(ticks.map((t) => (t._id as unknown as { at: string }).at)).toEqual([FIRST_TICK, SECOND_TICK]);
    expect(await db.collection('loose').countDocuments()).toBe(3);
  }, 300_000);

  it('follows Postgres on the next run: an update, a delete and a dropped table', async () => {
    await pool!.query(`UPDATE ticks SET price = 2600 WHERE at = $1`, [SECOND_TICK]);
    await pool!.query(`DELETE FROM typed WHERE note = 'second'`);
    await pool!.query(`DROP TABLE loose`);
    const run = await copy();
    expect(run.tables.map((t) => [t.table, t.rows])).toEqual([
      ['ticks', 2],
      ['typed', 1],
    ]);
    const db = mongo!.db(NAME);
    const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
    expect(collections).toEqual(['_mirror', '_mirror_runs', 'ticks', 'typed']);
    expect((await verifyMirror(db)).map((c) => [c.table, c.digestMatches])).toEqual([
      ['ticks', true],
      ['typed', true],
    ]);
    const updated = await db.collection('ticks').findOne({ '_id.at': SECOND_TICK });
    expect(String(updated?.price)).toBe('2600.00000000');
  }, 300_000);

  it('notices a copy edited behind its back', async () => {
    const db = mongo!.db(NAME);
    await db.collection('ticks').updateOne({ '_id.at': FIRST_TICK }, { $set: { price: Decimal128.fromString('1') } });
    const checks = await verifyMirror(db);
    expect(checks.find((c) => c.table === 'ticks')?.digestMatches).toBe(false);
    expect(checks.find((c) => c.table === 'typed')?.digestMatches).toBe(true);
  }, 180_000);
});
