/**
 * Which executor routes can be called without a session.
 *
 * Mirrors `publicSurface` in `server/src/auth/middleware.ts`, and `src/data/publicPaths.live.test.ts`
 * fails if the two drift — the same arrangement `tradable.ts` has with the token registry, for the
 * same reason: a second copy of a fact is fine as long as something notices when it stops matching.
 *
 * It exists because the client was firing authenticated requests before it had a token. Every
 * signed-out load of the home screen produced three 401s in the console — genuine errors, caused
 * by us asking a question we already knew we could not answer.
 */
export const PUBLIC_PATHS: readonly string[] = [
  '/health',
  '/metrics',
  '/verify',
  '/market/quotes',
  '/market/sparklines',
  '/market/ohlc',
  '/market/symbols',
  /*
   * Public on the server all along and missing here, so every logo request waited for the session
   * first — a second on a cold start, measured, before a single mark could draw.
   */
  '/market/logos',
  '/market/tradable',
  '/market/watchable',
  '/market/stocks',
  '/market/stocks/history',
  '/market/xstocks',
  '/market/crosscheck',
  '/market/corporate-action',
  '/market/futures',
  '/yield/supply',
];

export const PUBLIC_PREFIXES: readonly string[] = ['/perp/'];

/** Does this path need a session? Query strings are ignored; the server routes on the path. */
export function isPublicPath(path: string): boolean {
  const bare = path.split('?')[0] ?? path;
  return PUBLIC_PATHS.includes(bare) || PUBLIC_PREFIXES.some((p) => bare.startsWith(p));
}
