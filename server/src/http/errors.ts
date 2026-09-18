/**
 * How a thrown error becomes a response — one place, so every route answers a failure the same way.
 *
 * Moved out of `index.ts`, where the handler could not be tested without starting the server.
 */
import type { Context } from 'hono';
import { ZodError } from 'zod';
import { currentRequestId, log } from './request-id.js';
import { WrongPrincipalError } from '../auth/middleware.js';
import { NoWalletError } from '../routes/wallet-context.js';
import { ChainReadFailed } from './chain-read.js';
import { StillFetching } from './deadline.js';

export function errorResponse(err: Error, c: Context): Response {
  // A malformed request is the CLIENT's fault, and saying 500 tells the caller to retry something
  // that will never work. Zod failures and unparseable bodies both used to land here as 500s with
  // a raw validator dump, which was wrong on both the status and the message.
  if (err instanceof ZodError) {
    const detail = err.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    return c.json({ error: 'invalid_request', detail }, 400);
  }
  if (err instanceof SyntaxError) {
    return c.json({ error: 'invalid_json', detail: err.message }, 400);
  }
  /*
   * A valid credential, of the wrong kind for this route.
   *
   * 403 rather than 500: an agent key on a user-scoped route is a misconfiguration the caller
   * can fix, and retrying cannot help. A 500 here reads as the server being broken.
   */
  if (err instanceof WrongPrincipalError) {
    return c.json({ error: 'wrong_principal', detail: err.message }, 403);
  }
  // Signed in, not yet onboarded. The account has to change, not the server — see `NoWalletError`.
  if (err instanceof NoWalletError) {
    return c.json({ error: 'no_wallet', detail: err.message }, 409);
  }
  /*
   * The chain did not answer (PLAN.md 1.7).
   *
   * 502: an upstream failed, not this server, and the client reads a 5xx as worth retrying — which
   * is right for a read that timed out. The sentence names what could not be read; the cause goes
   * to the log, because an RPC error message is written for an engineer.
   */
  if (err instanceof ChainReadFailed) {
    const cause = err.underlying instanceof Error ? err.underlying.message : String(err.underlying);
    log.warn(`[chain] ${err.message} ${cause}`);
    return c.json({ error: 'chain_read_failed', message: err.message, requestId: currentRequestId() }, 502);
  }
  /*
   * Still being fetched (`http/deadline.ts`).
   *
   * 503 with a `retry-after`, the answer `/market/quotes` and the backtests give a cold upstream: nothing about the
   * request is wrong, the data is seconds away, and the fetch keeps going so the next attempt finds it. A 500 would say
   * the server broke, and a $0 would say something false about the wallet.
   */
  if (err instanceof StillFetching) {
    c.header('retry-after', String(err.retryAfterSec));
    return c.json({ error: 'warming', detail: err.message, requestId: currentRequestId() }, 503);
  }

  // Everything else is ours. Surface the real message: a trading server that hides its errors is
  // worse than one that fails.
  log.error(err.message, err.stack?.split('\n')[1]?.trim() ?? '');
  // The id goes in the body too, so a user can quote it from a screen without opening devtools.
  return c.json({ error: err.message, requestId: currentRequestId() }, 500);
}
