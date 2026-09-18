/**
 * The MongoDB copy of this executor's database (owner request, 2026-09-13; `db/mongo-mirror.ts`).
 *
 *   GET  /ops/mirror   operator-only. Whether a copy is configured and running, and the last one: when, how many tables
 *                      and rows, the digest each table's Postgres and MongoDB hashes agreed on — or what stopped it.
 *   POST /ops/mirror   operator-only. Start a copy now, or join the one already running, and answer 202; GET says when
 *                      it is done.
 *
 * Postgres stays the executor's database. With `MONGODB_URI` and `MONGO_MIRROR_DB` set, the executor also copies it
 * into that Atlas database on a schedule — every `MONGO_MIRROR_INTERVAL_MIN` minutes, 30 unless set, never at 0. It
 * runs here rather than from anyone's laptop because the database has no public address: only services inside the
 * Railway project reach it, and this is the one holding its credentials.
 *
 * The destination has no default. The connection string also lives in the repo-root `.env`, which a local executor
 * loads, and a default such as `xorr_<chain>` would have that laptop copy its own database over the deployment's copy
 * of the same chain every half hour.
 *
 * One copy at a time. A tick while a copy runs joins it rather than taking a second snapshot.
 */
import { Hono } from 'hono';
import { requireScope } from '../auth/middleware.js';
import { pool } from '../db/index.js';
import { mirrorToMongo, type MirrorRun } from '../db/mongo-mirror.js';
import { CHAIN_KEY } from '../evm/chains.js';
import { log } from '../http/request-id.js';

/** Atlas refuses database names with these characters, and names longer than 38 bytes. */
const DATABASE_NAME = /^[A-Za-z0-9_-]{1,38}$/;
const MIRROR_DATABASE = process.env.MONGO_MIRROR_DB?.trim() ?? '';
const INTERVAL_MIN = Number(process.env.MONGO_MIRROR_INTERVAL_MIN ?? 30);

/** Why this deployment cannot copy, or undefined when it can. */
function notConfigured(): string | undefined {
  if (!process.env.MONGODB_URI) return 'MONGODB_URI is not set on this deployment, so there is nowhere to copy to.';
  if (!MIRROR_DATABASE) return 'MONGO_MIRROR_DB is not set: the copy only goes to a database named outright.';
  if (!DATABASE_NAME.test(MIRROR_DATABASE)) return `MONGO_MIRROR_DB "${MIRROR_DATABASE}" is not a database name Atlas accepts.`;
  return undefined;
}

export type MirrorSummary = {
  ok: boolean;
  database: string;
  startedAt: string;
  finishedAt: string;
  tables?: { table: string; rows: number; digest: string }[];
  rows?: number;
  error?: string;
};

let running: { startedAt: Date; promise: Promise<MirrorRun> } | undefined;
let last: MirrorSummary | undefined;

/** A driver error that quoted its connection string would publish the password; it never reaches a response or a log. */
function redact(message: string): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) return message;
  try {
    const password = decodeURIComponent(new URL(uri.replace(/^mongodb(\+srv)?:/, 'http:')).password);
    return password ? message.split(password).join('***') : message;
  } catch {
    return message;
  }
}

/** Start a copy, or hand back the one already running. Throws when this deployment cannot copy. */
export function startMirror(): { startedAt: Date; promise: Promise<MirrorRun> } {
  const reason = notConfigured();
  if (reason) throw new Error(reason);
  if (running) return running;
  const startedAt = new Date();
  const promise = mirrorToMongo({
    connect: () => pool.connect(),
    mongoUri: process.env.MONGODB_URI!,
    database: MIRROR_DATABASE,
    source: `executor ${CHAIN_KEY}`,
  })
    .then(
      (run) => {
        last = {
          ok: true,
          database: run.database,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt.toISOString(),
          tables: run.tables.map((t) => ({ table: t.table, rows: t.rows, digest: t.digest })),
          rows: run.rows,
        };
        log.info(`mongo mirror: ${run.tables.length} tables, ${run.rows} rows verified into ${run.database}`);
        return run;
      },
      (e: unknown) => {
        const error = redact(e instanceof Error ? e.message : String(e));
        last = {
          ok: false,
          database: MIRROR_DATABASE,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          error,
        };
        log.error(`mongo mirror failed: ${error}`);
        throw new Error(error);
      },
    )
    .finally(() => {
      running = undefined;
    });
  // The outcome is kept in `last`; a scheduled copy nobody awaits must not surface as an unhandled rejection.
  promise.catch(() => undefined);
  running = { startedAt, promise };
  return running;
}

/** Copy on a schedule while this deployment can. Returns how to stop it, or undefined when there is no schedule. */
export function startMirrorSchedule(): (() => void) | undefined {
  if (notConfigured() || !(INTERVAL_MIN > 0)) return undefined;
  const tick = () => {
    startMirror();
  };
  // The first copy a minute after boot, once a deploy's own traffic has settled.
  const first = setTimeout(tick, 60_000);
  const every = setInterval(tick, INTERVAL_MIN * 60_000);
  first.unref();
  every.unref();
  log.info(`mongo mirror: copying into ${MIRROR_DATABASE} every ${INTERVAL_MIN} min`);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

export const mirrorRoutes = new Hono();

mirrorRoutes.get('/ops/mirror', requireScope('admin'), (c) => {
  const reason = notConfigured();
  return c.json({
    configured: !reason,
    detail: reason ?? null,
    database: MIRROR_DATABASE || null,
    intervalMinutes: !reason && INTERVAL_MIN > 0 ? INTERVAL_MIN : null,
    running: running ? { startedAt: running.startedAt.toISOString() } : null,
    last: last ?? null,
  });
});

mirrorRoutes.post('/ops/mirror', requireScope('admin'), (c) => {
  const reason = notConfigured();
  if (reason) return c.json({ status: 'blocked', reason: 'not_configured', detail: reason }, 409);
  const run = startMirror();
  return c.json({ status: 'started', database: MIRROR_DATABASE, startedAt: run.startedAt.toISOString() }, 202);
});
