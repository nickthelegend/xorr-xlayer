/**
 * Migrations are applied in filename order, so the filenames have to encode a total, unambiguous
 * order — across both naming schemes at once.
 *
 * Two files sharing a number does not fail loudly: `readdirSync().sort()` still produces a
 * deterministic order, just one decided by whatever follows the number alphabetically rather than
 * by anyone's intent. It stayed harmless the first time only because the two files touched
 * different objects. Had one depended on the other, a fresh database would have built a schema
 * nobody tested while incrementally-migrated databases kept the other order.
 *
 * The number scheme caused that three times, because the number is stale the moment it is read.
 * New migrations are timestamped instead (`migration-names.ts`), and the old numbered files stay
 * exactly as they are — renaming an applied migration would make a migrated database run it again.
 * These assertions are what keep the two schemes ordering correctly against each other.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classify, migrationFilename, MAX_LEGACY_NUMBER, LEGACY_MIGRATIONS } from './migration-names.js';

const DIR = path.join(import.meta.dirname, 'migrations');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const classified = files.map(classify);

describe('migration filenames', () => {
  it('has migrations to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('names every migration in one of the two known shapes', () => {
    const invalid = classified.filter((c) => c.style === 'invalid');
    expect(
      invalid.map((c) => `${c.key} ${'reason' in c ? c.reason : ''}`),
      `new migrations are named like ${migrationFilename('example-change')}`,
    ).toEqual([]);
  });

  it('never gives two migrations the same key', () => {
    const seen = new Map<string, string[]>();
    for (const c of classified) {
      // Legacy files collide on their number; timestamped ones on their timestamp.
      const key = c.style === 'legacy' ? String(c.number) : c.style === 'timestamp' ? c.at : c.key;
      seen.set(key, [...(seen.get(key) ?? []), c.key]);
    }
    const clashes = [...seen.entries()].filter(([, group]) => group.length > 1);
    expect(
      clashes.map(([k, group]) => `${k}: ${group.join(' + ')}`),
      `two migrations sharing a key apply in filename order, not the order anyone intended. ` +
        `Name a new migration ${migrationFilename('your-change')} — it cannot collide.`,
    ).toEqual([]);
  });

  it('keeps every numbered migration below the point it would outsort a timestamp', () => {
    // '203-…' sorts after '2026…'; anything at or below MAX_LEGACY_NUMBER cannot.
    const tooHigh = classified.filter((c) => c.style === 'legacy' && c.number > MAX_LEGACY_NUMBER);
    expect(tooHigh.map((c) => c.key)).toEqual([]);
  });

  it('applies every numbered migration before every timestamped one', () => {
    const lastLegacy = files.findLastIndex((f) => classify(f).style === 'legacy');
    const firstStamped = files.findIndex((f) => classify(f).style === 'timestamp');
    if (lastLegacy === -1 || firstStamped === -1) return; // only one scheme present
    expect(
      lastLegacy,
      'a numbered migration sorted after a timestamped one, so it would apply out of order',
    ).toBeLessThan(firstStamped);
  });

  it('sorts in the same order a reader would put them in', () => {
    // What the runner does — plain filename sort — must equal ordering by scheme then by key.
    const intended = [...files].sort((a, b) => {
      const ca = classify(a);
      const cb = classify(b);
      const rank = (c: ReturnType<typeof classify>) => (c.style === 'legacy' ? 0 : 1);
      if (rank(ca) !== rank(cb)) return rank(ca) - rank(cb);
      if (ca.style === 'legacy' && cb.style === 'legacy') return ca.number - cb.number;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    expect(files).toEqual(intended);
  });

  it('orders timestamped migrations by the moment they were created', () => {
    const stamps = classified.flatMap((c) => (c.style === 'timestamp' ? [c.at] : []));
    expect(stamps).toEqual([...stamps].sort());
  });
});

describe('the name a new migration should have', () => {
  it('is generated, not guessed', () => {
    const at = new Date('2026-09-17T08:45:12.345Z');
    expect(migrationFilename('watchlist order', at)).toBe('20260917T084512-watchlist-order.sql');
  });

  it('is accepted by the same rules the directory is checked against', () => {
    const c = classify(migrationFilename('some new change'));
    expect(c.style).toBe('timestamp');
  });

  it('cannot collide between two authors a second apart', () => {
    const a = migrationFilename('one', new Date('2026-09-17T08:45:12Z'));
    const b = migrationFilename('two', new Date('2026-09-17T08:45:13Z'));
    expect(a).not.toBe(b);
    expect(a < b).toBe(true);
  });

  it('refuses a name that would leave nothing to read', () => {
    expect(() => migrationFilename('   ')).toThrow(/needs a name/);
  });
});

/**
 * Why the check itself cannot race.
 *
 * The collision that reached main twice was not missed by a weak assertion; it was invisible to a
 * correct one. "No two migrations share a number" is a claim about the whole tree, and a branch can
 * only evaluate it against the tree it can see. Two branches each adding 034 both passed, because
 * when each ran the other did not exist. The collision was created by the second merge, after every
 * check had already finished.
 *
 * The fix is not a better assertion but a different KIND of assertion: one whose truth does not
 * depend on any other branch. A timestamp is unique by construction, and the numbered list is
 * closed, so "is this file allowed" is answered against a constant.
 */
describe('the check cannot be raced by another branch', () => {
  it('rejects a new numbered migration on its own base, whatever else is in flight', () => {
    // Both branches in the 034 incident would have failed here, independently, before merging.
    for (const name of ['035-branch-a.sql', '035-branch-b.sql', '036-anything.sql']) {
      const c = classify(name);
      expect(c.style, `${name} should not be accepted`).toBe('invalid');
      if (c.style !== 'invalid') continue;
      expect(c.reason).toMatch(/Numbers are closed/);
    }
  });

  it('still accepts every numbered migration that already exists', () => {
    for (const name of LEGACY_MIGRATIONS) {
      expect(classify(name).style, `${name} must stay valid`).toBe('legacy');
    }
  });

  it('allows every numbered file on disk', () => {
    /*
     * A subset check, not equality. The list is an allowlist rather than an inventory: it may name
     * a numbered migration still in flight on another branch, so the two can merge in either
     * order. What must never happen is a file on disk that the list does not name.
     */
    const onDisk = files.filter((f) => /^\d{3}-/.test(f));
    const unlisted = onDisk.filter((f) => !LEGACY_MIGRATIONS.has(f));
    expect(unlisted, `numbered migrations not in the frozen list: ${unlisted.join(', ')}`).toEqual([]);
  });

  it('accepts two timestamped migrations written by different branches', () => {
    // The property that removes the race: no shared resource to contend for.
    const a = migrationFilename('branch-a', new Date('2026-09-17T10:00:00Z'));
    const b = migrationFilename('branch-b', new Date('2026-09-17T10:00:01Z'));
    expect(classify(a).style).toBe('timestamp');
    expect(classify(b).style).toBe('timestamp');
    expect(a).not.toBe(b);
  });
});

/**
 * Renaming a migration is bookkeeping, not just a file move.
 *
 * `schema_migrations` records the FILENAME, so a renamed migration is a file an already-migrated
 * database has no record of and will run again. `migrate.ts` handles that with a `RENAMED` map
 * that carries the bookkeeping row forward without executing anything.
 *
 * The timestamp scheme removed the collisions that forced those renames; it did not remove
 * renaming. The map already carries two entries, and nothing held it to the files it names — so it
 * can go stale in three ways, silently, and the symptom is a deployed database re-running SQL.
 *
 * Read out of the source rather than imported: `migrate.ts` connects to a database and migrates it
 * at import time, so importing it here would run a migration.
 */
describe('the renamed-migration map', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, 'migrate.ts'), 'utf8');

  /** The `'current': 'previous'` pairs inside `const RENAMED = Object.freeze({ ... })`. */
  function renamedPairs(): { current: string; previous: string }[] {
    const block = /const RENAMED[^{]*\{([\s\S]*?)\}\)/.exec(source);
    if (!block?.[1]) throw new Error('could not find the RENAMED map in migrate.ts');
    return [...block[1].matchAll(/'([^']+\.sql)'\s*:\s*'([^']+\.sql)'/g)].map((m) => ({
      current: m[1]!,
      previous: m[2]!,
    }));
  }

  it('finds the map, so these assertions are checking something', () => {
    expect(renamedPairs().length).toBeGreaterThan(0);
  });

  /*
   * A key naming a file that is not there carries nothing forward, silently. It is what happens the
   * second time one migration is renamed — the map still points at the first new name.
   */
  it('names a migration that actually exists for every rename', () => {
    const missing = renamedPairs()
      .filter((p) => !files.includes(p.current))
      .map((p) => p.current);
    expect(missing, `RENAMED points at files that are not here: ${missing.join(', ')}`).toEqual([]);
  });

  /* Both present means the same migration runs twice, under two names. */
  it('does not leave the old filename in place beside the new one', () => {
    const stillThere = renamedPairs()
      .filter((p) => files.includes(p.previous))
      .map((p) => p.previous);
    expect(stillThere, `renamed away but still present: ${stillThere.join(', ')}`).toEqual([]);
  });

  /*
   * A rename declared twice would write two carry-forward rows for one change, and the second
   * would claim a migration ran under a name it never had.
   */
  it('declares each rename once, in each direction', () => {
    const pairs = renamedPairs();
    expect(new Set(pairs.map((p) => p.current)).size).toBe(pairs.length);
    expect(new Set(pairs.map((p) => p.previous)).size).toBe(pairs.length);
  });

  /*
   * A chain — A renamed to B, then B renamed to C — needs `A -> C` as well, or a database still on
   * A is carried to B and then left there, and B is not a file any more.
   */
  it('leaves no rename chained through a name that no longer exists', () => {
    const pairs = renamedPairs();
    const currents = new Set(pairs.map((p) => p.current));
    const dangling = pairs
      .filter((p) => currents.has(p.previous))
      .map((p) => `${p.previous} -> ${p.current}`);
    expect(dangling, `chained rename needs a direct entry too: ${dangling.join(', ')}`).toEqual([]);
  });
});
