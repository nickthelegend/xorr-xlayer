/**
 * Copy a Postgres database into MongoDB Atlas, verified row by row, then re-check the copy from MongoDB alone.
 *
 *   npm run mirror:mongo                     copy DATABASE_URL into MONGO_MIRROR_DB (xorr_local unless set)
 *   npm run mirror:mongo -- --verify-only    re-check MONGO_MIRROR_DB without copying anything — how the executors'
 *                                            own copies (xorr_base_sepolia, xorr_base_fork) are checked from outside
 *                                            Railway, where their databases cannot be reached
 *
 * Reads MONGODB_URI and DATABASE_URL from the environment, falling back to the repo-root `.env`, and prints neither.
 * Exits non-zero when any table does not match.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { MongoClient } from 'mongodb';
import { mirrorToMongo, verifyMirror } from './mongo-mirror.js';

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set.');
  process.exit(1);
}
const database = process.env.MONGO_MIRROR_DB || 'xorr_local';
const verifyOnly = process.argv.includes('--verify-only');

if (!verifyOnly) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const { hostname, pathname } = new URL(url);
  const source = `postgres ${hostname}/${pathname.slice(1)}`;
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const run = await mirrorToMongo({ connect: () => pool.connect(), mongoUri: MONGODB_URI, database, source });
    console.log(
      `copied ${source} → ${database}: ${run.tables.length} tables, ${run.rows} rows, ` +
        `${run.finishedAt.getTime() - run.startedAt.getTime()} ms, every table's hashes agreeing`,
    );
  } finally {
    await pool.end();
  }
}

const mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 20_000, appName: 'xorr-mirror-verify' });
await mongo.connect();
try {
  const checks = await verifyMirror(mongo.db(database));
  if (checks.length === 0) {
    console.log(`${database} holds no copy.`);
    process.exitCode = 1;
  } else {
    const bad = checks.filter((c) => !c.digestMatches);
    const newest = checks.reduce((t, c) => (c.syncedAt > t ? c.syncedAt : t), checks[0]!.syncedAt);
    console.log(
      `${database}: ${checks.length} tables, ${checks.reduce((s, c) => s + c.counted, 0)} documents, ` +
        `${bad.length} not matching what Postgres had · copied from ${checks[0]!.source} at ${newest.toISOString()}`,
    );
    for (const c of checks) {
      console.log(`  ${c.digestMatches ? 'ok  ' : 'FAIL'} ${c.table.padEnd(22)} ${String(c.counted).padStart(7)} of ${c.rows}`);
    }
    process.exitCode = bad.length === 0 ? 0 : 1;
  }
} finally {
  await mongo.close();
}
