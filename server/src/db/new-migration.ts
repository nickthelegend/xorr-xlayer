/**
 * Print the filename a new migration should use.
 *
 *   npx tsx src/db/new-migration.ts watchlist-order
 *
 * A one-line script rather than a documented format, because the format is the part people get
 * wrong at the moment they care least — and a wrong name is not caught until someone else's branch
 * collides with it.
 */
import { migrationFilename } from './migration-names.js';

const slug = process.argv.slice(2).join(' ');
if (!slug) {
  console.error('usage: npx tsx src/db/new-migration.ts <name>   e.g. watchlist-order');
  process.exit(1);
}
console.log(`server/src/db/migrations/${migrationFilename(slug)}`);
