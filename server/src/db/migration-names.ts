/**
 * How a migration file is named, and why it changed.
 *
 * ## The problem with sequential numbers
 *
 * `034-` is chosen by reading the directory and adding one. With several people working at once
 * that number is stale the moment it is picked: two branches both read 033, both write 034, both
 * pass their own tests, and the collision only exists once they are on the same branch. It has
 * happened three times here. No amount of care fixes it, because the information needed to choose
 * correctly does not exist yet at the moment of choosing.
 *
 * ## The scheme
 *
 * New migrations are named for the UTC minute and second they were created:
 *
 *     20260917T084512-watchlist-order.sql
 *
 * Two authors cannot collide unless they create a migration in the same second, and the name needs
 * no knowledge of any other branch. Nothing has to be renamed when branches merge.
 *
 * ## Why the old files stay exactly as they are
 *
 * Bookkeeping is by filename (`schema_migrations.name`), so renaming an applied migration makes a
 * migrated database run it again. The numbered files are therefore left alone, and lexicographic
 * sort — which is what the runner uses — already orders them correctly against the new ones:
 * `034-…` sorts before `2026…` because `'0' < '2'`. That holds for every number below 203, and
 * the highest in use is far below it. `MAX_LEGACY_NUMBER` guards the gap, so a new numbered file
 * cannot be added high enough to sort itself after a timestamp and apply out of order.
 *
 * The result needs no rename, no carry-forward and no change to the runner's logic: it is purely a
 * rule about names that new files follow and old files are exempt from.
 */

/** `034-position-sleeves.sql` — the old scheme, still valid, no longer added to. */
export const LEGACY_RE = /^(\d{3})-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/;

/** `20260917T084512-watchlist-order.sql` — the scheme new migrations use. */
export const TIMESTAMP_RE = /^(\d{8}T\d{6})-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/;

/**
 * A numbered migration at or above this would sort after a timestamped one and apply out of order.
 * Kept well below the real boundary of 203 so the rule has room to be wrong in.
 */
export const MAX_LEGACY_NUMBER = 199;

/**
 * Every numbered migration that exists. The list is closed.
 *
 * This is the part that cannot race, and it is worth being precise about why.
 *
 * "No two migrations share a number" is a statement about the whole tree, so a branch can only
 * check it against the tree it can see — its own base. Two branches each adding 035 both pass,
 * because at the moment each is tested the other does not exist. The collision is created by the
 * second merge, after every check has already run. That is exactly how 034 happened twice, with
 * both PRs green.
 *
 * "This file is in the frozen list" is a statement about ONE file against a constant. Its truth
 * does not depend on any other branch, so a branch adding `035-anything.sql` fails on its own base,
 * every time, no matter what else is in flight. There is nothing left to race for: the next free
 * number is not a resource because no new file may take a number at all.
 *
 * The list may name a file that has not landed yet. It is an allowlist, not an inventory: a
 * numbered migration already in flight on another branch when the scheme changed is named here so
 * the two can merge in either order. An entry permits exactly one filename, so a different branch
 * taking the same number is still refused.
 *
 * Nothing else is added here. A new migration is timestamped.
 */
export const LEGACY_MIGRATIONS: ReadonlySet<string> = new Set([
  '001-alert-firing.sql',
  '002-realised-pnl.sql',
  '003-unbased-units.sql',
  '004-idempotency.sql',
  '005-last-seen.sql',
  '006-disposals.sql',
  '007-notification-prefs.sql',
  '008-audit-chain-unique.sql',
  '009-app-config.sql',
  '010-price-observations.sql',
  '011-wallet-active-at.sql',
  '012-fill-quality.sql',
  '013-supply-is-not-a-fill.sql',
  '014-strategy-retry-attempts.sql',
  '015-chain-scope.sql',
  '016-fill-sides.sql',
  '017-portfolio-snapshots.sql',
  '018-venue-backfill.sql',
  '019-agents-stopped.sql',
  '020-limit-orders.sql',
  '021-faucet-claims.sql',
  '022-withdrawal-addresses.sql',
  '023-delegation-grant-time.sql',
  '024-ended-strategies-have-no-next-run.sql',
  '025-idempotency-body-broadcast-claim.sql',
  '026-business-treasuries.sql',
  '027-custom-agents.sql',
  '028-solana-withdrawals.sql',
  '029-reserve-attestations.sql',
  '030-agent-risk-profile.sql',
  '031-strategy-paused-from.sql',
  '032-xstock-basket.sql',
  '033-multiplier-observations.sql',
  '034-position-sleeves.sql',
]);

export type MigrationName =
  | { style: 'legacy'; key: string; number: number }
  | { style: 'timestamp'; key: string; at: string }
  | { style: 'invalid'; key: string; reason: string };

export function classify(filename: string): MigrationName {
  const legacy = LEGACY_RE.exec(filename);
  if (legacy) {
    if (!LEGACY_MIGRATIONS.has(filename)) {
      return {
        style: 'invalid',
        key: filename,
        reason:
          'is a new numbered migration. Numbers are closed because two branches cannot tell that ' +
          'they picked the same one until they meet',
      };
    }
    const number = Number(legacy[1]);
    if (number > MAX_LEGACY_NUMBER) {
      return {
        style: 'invalid',
        key: filename,
        reason: `numbered ${legacy[1]}, which is above ${MAX_LEGACY_NUMBER} and would sort after a timestamped migration`,
      };
    }
    return { style: 'legacy', key: filename, number };
  }

  const stamped = TIMESTAMP_RE.exec(filename);
  if (stamped) return { style: 'timestamp', key: filename, at: stamped[1]! };

  return {
    style: 'invalid',
    key: filename,
    reason: 'is neither NNN-name.sql nor YYYYMMDDTHHMMSS-name.sql',
  };
}

/**
 * The name a migration created now should have.
 *
 * Exported so the test's failure message and the generator agree, and so nobody has to work the
 * format out by hand at the moment they are least inclined to be careful about it.
 */
export function migrationFilename(slug: string, now: Date = new Date()): string {
  const clean = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!clean) throw new Error('A migration needs a name: migrationFilename("watchlist-order").');

  const iso = now.toISOString(); // 2026-09-17T08:45:12.345Z
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}T${iso.slice(11, 19).replace(/:/g, '')}`;
  return `${stamp}-${clean}.sql`;
}
