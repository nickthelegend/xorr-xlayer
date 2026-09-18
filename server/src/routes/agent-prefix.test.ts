/**
 * A user route must never live under `/agent/`.
 *
 * `/agent/decision` was registered on the user surface while the auth middleware treats the
 * `/agent/` prefix as the MACHINE surface. A Privy token got "this surface needs an agent key";
 * an agent key got "this route belongs to a signed-in user". Both refusals were correct, and the
 * route was dead between them — for months, silently, because nothing in the app calls it.
 *
 * It is the surface that shows the subgraph driving a real decision, so its being unreachable was
 * the most expensive kind of dead code.
 *
 * The guard is textual rather than behavioural on purpose: it catches the mistake at the moment
 * someone writes the path, which is the only moment it is obvious.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROUTES = path.resolve(import.meta.dirname);

/** Files whose routes are reached with a Privy session rather than an agent key. */
const USER_SURFACES = [
  'extra.ts',
  'index.ts',
  'strategies.ts',
  'market.ts',
  'alerts.ts',
  'privy.ts',
  'catchup.ts',
];

describe('the machine surface and the user surface do not overlap', () => {
  it('no user-surface route is registered under the /agent/ prefix', () => {
    const offenders: string[] = [];
    for (const f of USER_SURFACES) {
      const file = path.join(ROUTES, f);
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\.(get|post|patch|delete|put)\(\s*'(\/agent\/[^']*)'/g)) {
        offenders.push(`${f}: ${m[2]}`);
      }
    }
    expect(
      offenders,
      `these are on the user surface but the middleware will demand an agent key:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('`/agents/` plural is a different prefix and stays where it is', () => {
    // `/agents/leaderboard` and `/agents/:id/backtest` are user routes and must NOT be caught by
    // the rule above — the machine prefix is `/agent/`, singular, with the slash.
    const src = fs.readFileSync(path.join(ROUTES, 'extra.ts'), 'utf8');
    expect(src).toContain("'/agents/leaderboard'");
    expect(/\.get\('\/agent\/decision'/.test(src)).toBe(false);
    expect(src).toContain("'/graph/decision'");
  });
});
