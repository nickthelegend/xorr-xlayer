/**
 * Which build this is, and whether the executor it talks to is the same one (FEATURES.md #53).
 *
 * The hosted app and its executors deploy separately — the web app to Vercel, each executor to Railway — so a screen
 * can be one commit ahead of the server it reads, and "fixed on main" can be true of one and not the other. The web
 * build carries its own commit (`scripts/build-web.mjs` writes `EXPO_PUBLIC_APP_COMMIT`); every executor reports its
 * commit as `/health` → `version`. Showing both, and whether they agree, is the difference between guessing and
 * knowing which code answered.
 */

const COMMIT_SHAPE = /^[0-9a-f]{7,40}$/i;
const commitOrUndefined = (c: string | undefined) => (c && COMMIT_SHAPE.test(c) ? c.toLowerCase() : undefined);

/** The commit this bundle was built from. Undefined in a development build, which is whatever is on disk. */
export const appCommit: string | undefined = commitOrUndefined(process.env.EXPO_PUBLIC_APP_COMMIT);

/**
 * An executor commit that runs this build's own server code, when the build found one (`scripts/build-web.mjs`).
 *
 * A web-only deploy leaves the executors on the commit they were deployed from. When nothing under `server/` changed
 * since then, "App x · server y" in the warning colour is a false alarm about identical code. Git can tell and the app
 * cannot, so the build asks and writes the answer here. An executor redeployed from any other commit differs again.
 */
export const serverMatch: string | undefined = commitOrUndefined(process.env.EXPO_PUBLIC_SERVER_MATCH);

/** Seven characters, as git prints a commit. */
export const shortCommit = (commit: string) => commit.slice(0, 7);

export type VersionAgreement =
  | { kind: 'same'; commit: string }
  | { kind: 'different'; app: string; executor: string }
  | { kind: 'unknown'; app?: string; executor?: string };

/** A short commit agrees with a full one it begins. */
const agree = (x: string, y: string) => x.startsWith(y) || y.startsWith(x);

/**
 * Whether this bundle and the executor run the same code. Unknown when either did not say.
 *
 * `match` is `serverMatch`: an executor on that commit runs this build's server code, so the two agree under the app's
 * commit. A match for some other commit hides nothing.
 */
export function compareVersions(
  app: string | undefined,
  executor: string | undefined,
  match?: string,
): VersionAgreement {
  const a = app?.toLowerCase();
  const e = executor?.toLowerCase();
  if (!a || !e || !COMMIT_SHAPE.test(a) || !COMMIT_SHAPE.test(e)) return { kind: 'unknown', app: a, executor: e };
  if (agree(a, e)) return { kind: 'same', commit: a.length >= e.length ? a : e };
  const m = commitOrUndefined(match);
  return m && agree(m, e) ? { kind: 'same', commit: a } : { kind: 'different', app: a, executor: e };
}
