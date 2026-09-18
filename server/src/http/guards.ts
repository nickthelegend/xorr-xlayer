/**
 * Who is calling, whether they are calling too fast, and whether this exact request has been answered already — in that
 * order, and the order is the point.
 *
 * Idempotency ran in front of the rate limiter. A request the limiter refused had run nothing, yet it had already
 * claimed its key, and the 429 was stored against it: every retry with that key — the retry the key exists to make
 * safe — was answered 429 again for as long as the row lived, a day. The app worked around it by treating a 429 as an
 * answer and minting a new key (`src/data/intentKey.ts`). Now the limiter answers first, and a request it refuses never
 * reaches the key.
 *
 * Auth stays in front of both: the limit is per identity and a key is scoped to a user. One function rather than three
 * lines in `index.ts`, so the order the server runs is the order `idempotency.test.ts` proves.
 */
import type { Hono, MiddlewareHandler } from 'hono';
import { idempotency } from './idempotency.js';
import { rateLimit } from './rate-limit.js';

export function guardRequests(app: Hono, auth: MiddlewareHandler): void {
  // Auth before ANY route. An unauthenticated trading server must not be a possible state.
  app.use('*', auth);

  /*
   * After auth, because the limit is per identity and auth is what resolves one.
   *
   * The executor holds one 1inch key, one CoinGecko tier and one delegate key, and nothing bounded
   * how fast a single caller could spend them. The scheduler competes for the same quota, so the
   * first thing an unbounded loop would break is the trading — silently, while the app looked fine.
   */
  app.use('*', rateLimit);

  /*
   * Idempotency, after the limiter so a refusal claims no key, and before every route so any state-changing request can
   * opt in with a header rather than each handler reimplementing it.
   */
  app.use('*', idempotency);
}
