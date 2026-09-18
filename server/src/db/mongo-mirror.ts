/**
 * A copy of this database in MongoDB Atlas, checked row by row (owner request, 2026-09-13).
 *
 * Postgres is the database the executor reads and writes, and it stays that: settlement, the spend tally, idempotency
 * and the audit chain all lean on its transactions and constraints. MongoDB holds a mirror of every table — one
 * collection per table, one document per row, the primary key as `_id` — refreshed by the executor on a schedule
 * (`routes/mirror.ts`), so the data is also where the owner asked for it.
 *
 * A refresh reads every table inside one REPEATABLE READ snapshot, so the copy is of one moment rather than of a
 * database moving underneath it. Each table is written to `<table>__incoming`, read back, and hashed on both sides:
 * every row becomes a canonical JSON of its column values, and the sorted row hashes from Postgres and from MongoDB
 * must agree before the collection replaces the previous copy. A table that does not agree leaves the last good copy
 * in place and fails the run loudly. `_mirror` records, per table, the row count, the columns and their Postgres
 * types, and the digest, so the copy can be re-checked later from MongoDB alone (`verifyMirror`); `_mirror_runs`
 * keeps every run, failed ones included.
 *
 * Values keep their meaning: bigint as Int64; numeric as Decimal128 where that holds it exactly — a uint256 such as a
 * limit order's traits does not fit 34 digits, and stays an exact decimal string; json as embedded documents; bytea as
 * binary. Timestamps become dates, and a MongoDB date carries milliseconds where Postgres keeps microseconds: the
 * fields are compared to the millisecond, and a primary key keeps the timestamp's exact text instead, because two rows
 * a microsecond apart are two rows — `price_observations` has them, and the first copy collapsed them onto one `_id`.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { Binary, Decimal128, Long, MongoClient, type Db } from 'mongodb';

/** Postgres type ids this copy treats specially. */
export const OID = {
  bytea: 17,
  int8: 20,
  text: 25,
  json: 114,
  date: 1082,
  timestamp: 1114,
  timestamptz: 1184,
  interval: 1186,
  numeric: 1700,
  jsonb: 3802,
} as const;

export type MirrorColumn = { name: string; oid: number };

export type TableCopy = {
  table: string;
  rows: number;
  primaryKey: string[];
  columns: MirrorColumn[];
  /** sha256 over the sorted row hashes; the same for Postgres and MongoDB, or the table was not replaced. */
  digest: string;
  ms: number;
};

export type MirrorRun = {
  database: string;
  source: string;
  startedAt: Date;
  finishedAt: Date;
  tables: TableCopy[];
  rows: number;
};

const BATCH = 1000;

/**
 * Parsers for this read only. The pool's global parsers are the executor's, and changing them would change every query
 * it runs. Dates, timestamps and intervals come back as their text: nothing is shifted into this machine's time zone on
 * the way, and nothing is rounded before it is decided what may be rounded.
 */
const RAW_TEXT = new Set<number>([OID.date, OID.timestamp, OID.timestamptz, OID.interval]);
const readTypes = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    RAW_TEXT.has(oid) ? (value: string) => value : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

const TABLES_SQL = `
  SELECT c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
   ORDER BY 1`;

const PRIMARY_KEY_SQL = `
  SELECT a.attname AS name
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
   WHERE i.indrelid = ('public.' || quote_ident($1))::regclass AND i.indisprimary
   ORDER BY array_position(i.indkey::int2[], a.attnum)`;

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A decimal in one spelling: no exponent, no leading or trailing zeros. `1.50`, `1.5E+0` and `001.5` are all `1.5`. */
export function canonicalDecimal(text: string): string {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return text; // NaN and Infinity keep their spelling
  const sign = m[1];
  let digits = `${m[2]}${m[3] ?? ''}`;
  let point = m[2]!.length + (m[4] ? Number(m[4]) : 0);
  const leading = /^0*/.exec(digits)![0].length;
  digits = digits.slice(leading).replace(/0+$/, '');
  point -= leading;
  if (digits === '') return '0';
  const out =
    point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${'0'.repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return sign === '-' ? `-${out}` : out;
}

/** Decimal128 when it holds the value exactly; the exact decimal text when it cannot. */
function toDecimal(text: string): Decimal128 | string {
  try {
    const d = Decimal128.fromString(text);
    if (canonicalDecimal(d.toString()) === canonicalDecimal(text)) return d;
  } catch {
    // More significant digits than Decimal128's 34.
  }
  return text;
}

/** A zone-less Postgres timestamp is UTC as stored. */
function timestampOf(text: string): Date | string {
  const d = new Date(`${text.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? text : d; // 'infinity' stays text
}

/**
 * A timestamptz as Postgres prints it — `2026-09-09 23:14:00.465123+00` — as a date. The copy's session prints in UTC.
 * An offset with seconds (a pre-1900 local mean time) or `infinity` stays text rather than being read approximately.
 */
export function timestamptzOf(text: string): Date | string {
  const m = /^(\d{4,}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?(:\d{2})?$/.exec(text);
  if (!m || m[5]) return text;
  const d = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4] ?? '00'}`);
  return Number.isNaN(d.getTime()) ? text : d;
}

/** One column value as MongoDB should hold it. */
export function toBson(oid: number, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (oid) {
    case OID.int8:
      return Long.fromString(String(value));
    case OID.numeric:
      return toDecimal(String(value));
    case OID.timestamp:
      return timestampOf(String(value));
    case OID.timestamptz:
      return timestamptzOf(String(value));
    case OID.bytea:
      return new Binary(value as Buffer);
    default:
      return value;
  }
}

/** JSON-able, with dates as ISO text. */
function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Decimal128 || value instanceof Long) return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

/** One column value as both sides can agree on it, whichever side it was read from. */
function comparable(oid: number, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (oid) {
    case OID.int8:
      return String(value);
    case OID.numeric:
      return canonicalDecimal(String(value));
    case OID.timestamp:
    case OID.timestamptz: {
      const d =
        value instanceof Date ? value : oid === OID.timestamp ? timestampOf(String(value)) : timestamptzOf(String(value));
      return d instanceof Date ? d.toISOString() : d;
    }
    case OID.bytea:
      return Buffer.from(value instanceof Binary ? value.buffer : (value as Buffer)).toString('hex');
    default:
      return plain(value);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
    .join(',')}}`;
}

/** A row's hash, the same whether the row was read from Postgres or its document from MongoDB. */
export function rowHash(columns: MirrorColumn[], row: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalJson(columns.map((c) => [c.name, comparable(c.oid, row[c.name])])))
    .digest('hex');
}

export const digestOf = (hashes: string[]) => createHash('sha256').update([...hashes].sort().join('\n')).digest('hex');

/**
 * What a table's rows become: every column as a BSON value, and the primary key as `_id` — one column's value, or an
 * object of several. A key keeps a timestamp's exact text, because a date would round two rows a microsecond apart onto
 * one `_id`. A table without a primary key gets MongoDB's own ids.
 */
export function documentMaker(columns: MirrorColumn[], primaryKey: string[]) {
  const oidOf = new Map(columns.map((c) => [c.name, c.oid]));
  const keyPart = (name: string, row: Record<string, unknown>): unknown => {
    const oid = oidOf.get(name) ?? OID.text;
    return oid === OID.timestamp || oid === OID.timestamptz ? String(row[name]) : toBson(oid, row[name]);
  };
  return (row: Record<string, unknown>): Record<string, unknown> => {
    const doc: Record<string, unknown> = {};
    if (primaryKey.length === 1) doc._id = keyPart(primaryKey[0]!, row);
    else if (primaryKey.length > 1) doc._id = Object.fromEntries(primaryKey.map((k) => [k, keyPart(k, row)]));
    for (const c of columns) doc[c.name] = toBson(c.oid, row[c.name]);
    return doc;
  };
}

/** How many of `a` have no partner in `b`, counting duplicates. */
function unmatched(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const h of b) counts.set(h, (counts.get(h) ?? 0) + 1);
  let n = 0;
  for (const h of a) {
    const c = counts.get(h) ?? 0;
    if (c > 0) counts.set(h, c - 1);
    else n++;
  }
  return n;
}

async function copyTable(pgc: pg.PoolClient, db: Db, table: string): Promise<TableCopy> {
  const t0 = Date.now();
  const ident = quoteIdent(table);
  const { fields } = await pgc.query({ text: `SELECT * FROM ${ident} LIMIT 0`, types: readTypes });
  const columns: MirrorColumn[] = fields.map((f) => ({ name: f.name, oid: f.dataTypeID }));
  const primaryKey = (await pgc.query<{ name: string }>(PRIMARY_KEY_SQL, [table])).rows.map((r) => r.name);
  const documentOf = documentMaker(columns, primaryKey);

  const staging = `${table}__incoming`;
  await db.collection(staging).drop().catch(() => undefined);
  const incoming = await db.createCollection(staging);

  const sourceHashes: string[] = [];
  await pgc.query(`DECLARE mirror_rows NO SCROLL CURSOR FOR SELECT * FROM ${ident}`);
  try {
    for (;;) {
      const { rows } = await pgc.query<Record<string, unknown>>({ text: `FETCH ${BATCH} FROM mirror_rows`, types: readTypes });
      if (rows.length === 0) break;
      for (const row of rows) sourceHashes.push(rowHash(columns, row));
      await incoming.insertMany(rows.map(documentOf), { ordered: true });
      await yieldToLoop();
    }
  } finally {
    await pgc.query('CLOSE mirror_rows').catch(() => undefined);
  }

  // Read back what MongoDB now holds and hash it the same way: agreement is the proof, not the insert returning.
  const copiedHashes: string[] = [];
  for await (const doc of incoming.find({}, { projection: { _id: 0 } })) {
    copiedHashes.push(rowHash(columns, doc as Record<string, unknown>));
    if (copiedHashes.length % BATCH === 0) await yieldToLoop();
  }
  const digest = digestOf(sourceHashes);
  if (copiedHashes.length !== sourceHashes.length || digestOf(copiedHashes) !== digest) {
    const notCopied = unmatched(sourceHashes, copiedHashes);
    const notInPostgres = unmatched(copiedHashes, sourceHashes);
    await incoming.drop().catch(() => undefined);
    throw new Error(
      `${table}: MongoDB does not hold what Postgres does — ${sourceHashes.length} rows read, ${copiedHashes.length} copied, ` +
        `${notCopied} not copied exactly, ${notInPostgres} not in Postgres. The previous copy was left in place.`,
    );
  }
  await incoming.rename(table, { dropTarget: true });
  return { table, rows: sourceHashes.length, primaryKey, columns, digest, ms: Date.now() - t0 };
}

/**
 * Copy every table in `public` into the MongoDB database `database`, verified, as of one snapshot.
 *
 * `connect` hands over a Postgres connection the copy holds for its whole run; it is released at the end.
 */
export async function mirrorToMongo(opts: {
  connect: () => Promise<pg.PoolClient>;
  mongoUri: string;
  database: string;
  /** Where the rows came from, as a label — never a connection string. */
  source: string;
}): Promise<MirrorRun> {
  const startedAt = new Date();
  const mongo = new MongoClient(opts.mongoUri, { serverSelectionTimeoutMS: 20_000, appName: 'xorr-mirror' });
  await mongo.connect();
  const db = mongo.db(opts.database);
  const tables: TableCopy[] = [];
  let pgc: pg.PoolClient | undefined;
  try {
    pgc = await opts.connect();
    await pgc.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Timestamps printed in UTC and dates in ISO order, whatever the pool's sessions are set to.
    await pgc.query(`SET LOCAL TimeZone = 'UTC'`);
    await pgc.query(`SET LOCAL DateStyle = 'ISO, MDY'`);
    const names = (await pgc.query<{ name: string }>(TABLES_SQL)).rows.map((r) => r.name);
    for (const name of names) tables.push(await copyTable(pgc, db, name));
    await pgc.query('COMMIT');

    // A table gone from Postgres is gone from the copy; the bookkeeping collections start with an underscore.
    const kept = new Set(names);
    for (const c of await db.listCollections({}, { nameOnly: true }).toArray()) {
      if (!c.name.startsWith('_') && !kept.has(c.name)) await db.collection(c.name).drop();
    }

    const finishedAt = new Date();
    const rows = tables.reduce((sum, t) => sum + t.rows, 0);
    const records = db.collection<{ _id: string }>('_mirror');
    if (tables.length > 0) {
      await records.bulkWrite(
        tables.map((t) => ({
          replaceOne: {
            filter: { _id: t.table },
            replacement: { ...t, source: opts.source, syncedAt: finishedAt },
            upsert: true,
          },
        })),
      );
    }
    await records.deleteMany({ _id: { $nin: names } });
    await db.collection('_mirror_runs').insertOne({ source: opts.source, startedAt, finishedAt, ok: true, tables: tables.length, rows });
    return { database: opts.database, source: opts.source, startedAt, finishedAt, tables, rows };
  } catch (e) {
    await pgc?.query('ROLLBACK').catch(() => undefined);
    await db
      .collection('_mirror_runs')
      .insertOne({
        source: opts.source,
        startedAt,
        finishedAt: new Date(),
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        tablesCopied: tables.length,
      })
      .catch(() => undefined);
    throw e;
  } finally {
    pgc?.release();
    await mongo.close().catch(() => undefined);
  }
}

export type MirrorCheck = {
  table: string;
  rows: number;
  counted: number;
  digestMatches: boolean;
  syncedAt: Date;
  source: string;
};

/**
 * Check a copy from MongoDB alone: every table `_mirror` lists still has its row count, and its documents still hash to
 * the digest Postgres had when it was copied.
 */
export async function verifyMirror(db: Db): Promise<MirrorCheck[]> {
  const out: MirrorCheck[] = [];
  const records = await db
    .collection<TableCopy & { _id: string; syncedAt: Date; source: string }>('_mirror')
    .find({})
    .sort({ _id: 1 })
    .toArray();
  for (const record of records) {
    const hashes: string[] = [];
    for await (const doc of db.collection(record.table).find({}, { projection: { _id: 0 } })) {
      hashes.push(rowHash(record.columns, doc as Record<string, unknown>));
    }
    out.push({
      table: record.table,
      rows: record.rows,
      counted: hashes.length,
      digestMatches: hashes.length === record.rows && digestOf(hashes) === record.digest,
      syncedAt: record.syncedAt,
      source: record.source,
    });
  }
  return out;
}
