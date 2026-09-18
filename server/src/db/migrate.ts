/**
 * Schema migrations, applied in order and recorded.
 *
 * `schema.sql` is the base — idempotent CREATE TABLE IF NOT EXISTS, safe to re-run — and every
 * change after it is a numbered file in `migrations/`. Both are needed: the base means a fresh
 * database is one command away, and the numbered files mean an EXISTING database can be brought
 * forward without anyone having to remember which ALTERs they have already run.
 *
 * Recorded in `schema_migrations`, so re-running this is free. That is what makes it safe to put
 * in a start script rather than a wiki page.
 *
 * ## Naming a new migration
 *
 *     npx tsx src/db/new-migration.ts watchlist-order
 *     -> server/src/db/migrations/20260917T084512-watchlist-order.sql
 *
 * New migrations are named for the UTC second they were created, not for the next free number.
 * A number has to be read from the directory, and with several branches open it is stale the
 * moment it is read: two people both see 033, both write 034, both pass their own tests, and the
 * collision exists only once the branches meet. That happened three times. A timestamp needs no
 * knowledge of any other branch and cannot collide unless two migrations are created in the same
 * second.
 *
 * The existing numbered files keep their names. Bookkeeping below is by FILENAME, so renaming an
 * applied migration would make a migrated database run it again — and plain filename sort already
 * orders the two schemes correctly, because `034-` sorts before `2026…`. `migration-names.ts` has
 * the details and `migration-order.test.ts` enforces them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pool } from './index.js';
import { withoutPassword } from './redact.js';

const here = import.meta.dirname;
// Without the password: this line printed `DATABASE_URL` whole, into the host's deploy log on every deploy.
const target = process.env.DATABASE_URL ? withoutPassword(process.env.DATABASE_URL) : 'default local xorr';
console.log(`migrating ${target}`);

await pool.query(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
await pool.query(
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     name text PRIMARY KEY,
     applied_at timestamptz NOT NULL DEFAULT now()
   )`,
);

const dir = path.join(here, 'migrations');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];

/*
 * Migrations this repo has renumbered, newest name to the name it shipped under.
 *
 * Bookkeeping is by FILENAME, so renaming a migration makes an already-migrated database see a
 * file it has no record of and run it again. These particular ones are idempotent and would
 * survive that, but relying on every future rename being idempotent is not a plan — and a second
 * bookkeeping row for the same change makes the table lie about what was applied when.
 *
 * So a rename is declared here and carried forward once: a database that ran the old name is
 * recorded as having run the new one, without executing anything.
 */
const RENAMED: Readonly<Record<string, string>> = Object.freeze({
  // Collided with 030-agent-risk-profile.sql. Moved after it, which is the order it already ran in.
  '033-multiplier-observations.sql': '030-multiplier-observations.sql',
  // Collided with 034-position-sleeves.sql: both branches read 033 and both wrote 034. Moved to
  // the timestamped scheme, which is the collision this repo stopped being able to have.
  '20260917T091529-corporate-action-notices.sql': '034-corporate-action-notices.sql',
});

for (const [current, previous] of Object.entries(RENAMED)) {
  const { rowCount } = await pool.query(
    `INSERT INTO schema_migrations (name)
     SELECT $1 WHERE EXISTS (SELECT 1 FROM schema_migrations WHERE name = $2)
       AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1)`,
    [current, previous],
  );
  if (rowCount) console.log(`  carried ${previous} forward to ${current}`);
}

for (const name of files) {
  const done = await pool.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [name]);
  if (done.rowCount) {
    console.log(`  skip ${name} (already applied)`);
    continue;
  }
  /*
   * Each migration runs in its own transaction, with its bookkeeping row written inside it.
   *
   * A migration that half-applied and then recorded itself as done is the worst outcome here —
   * every later run would skip it and the schema would be permanently wrong in a way nothing
   * detects. Same transaction, or neither.
   */
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(fs.readFileSync(path.join(dir, name), 'utf8'));
    await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [name]);
    await client.query('COMMIT');
    console.log(`  applied ${name}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`  FAILED ${name}: ${e instanceof Error ? e.message : e}`);
    throw e;
  } finally {
    client.release();
  }
}

const { rows } = await pool.query(
  `select table_name from information_schema.tables where table_schema='public' order by table_name`,
);
console.log('tables:', rows.map((r) => r.table_name).join(', '));
await pool.end();
