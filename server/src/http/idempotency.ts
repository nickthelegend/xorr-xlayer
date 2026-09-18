/**
 * Idempotency for state-changing requests.
 *
 * A client that sends a request and never sees the response has no safe way to retry: the request
 * may have succeeded, and doing it again could place a second trade or sign a second grant. The
 * fix is the one this codebase already uses for strategy runs — make the CHECK be the WRITE, so
 * there is no window between deciding to act and acting.
 *
 *   POST /strategies
 *   Idempotency-Key: 6f9c…
 *
 * The first request runs and its response is stored. Any later request with the same key gets that
 * same response back, byte for byte, without running anything. A duplicate arriving while the
 * first is still in flight is refused with 409 rather than run alongside it.
 *
 * Opt-in by header, deliberately. Making it mandatory would break every existing caller, and a
 * key the server invents for a client cannot deduplicate anything — the whole point is that the
 * SAME key comes back on a retry.
 *
 * ## Four ways a key still acted twice, or refused for a day (migration 025)
 *
 * Found wiring the app's keys (FEATURES.md #29):
 *
 *   - **It stored the rate limiter's 429.** This ran in front of the limiter, so a request the limiter refused — nothing
 *     ran — claimed its key and kept the refusal, and the retry the key exists for was answered 429 for as long as the
 *     row lived. The limiter answers first now (`http/guards.ts`); a request it refuses never reaches this.
 *   - **A key matched on method and path.** The same key with a different body replayed the first answer, so a key kept
 *     past its answer returned this morning's fill for this afternoon's order. The body's SHA-256 is kept with the
 *     claim, and a different body under the same key is refused.
 *   - **Every 5xx released the key.** Right for a request that failed before acting, and a second trade for one that
 *     broadcast and then answered 502 because its receipt was late — which `/orders`, `/swap`, `/positions/close`,
 *     `/faucet`, `/panic/flatten` and a limit-order fill can all do. A 5xx is released now only when nothing was
 *     broadcast (`markBroadcast`, `http/request-id.ts`); after a broadcast it is stored, and a retry replays it.
 *   - **A request that died mid-flight answered `request_in_flight` until the daily sweep.** A claim still unanswered
 *     after `ABANDONED_AFTER_SECONDS` is abandoned. One that never broadcast is taken over and run; one that did is
 *     answered 409 with what may have happened, and never run again.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Context, Next } from 'hono';
import { one, query } from '../db/index.js';
import { log, withRequestScope } from './request-id.js';

/**
 * How long a claim with no answer stands before it counts as abandoned: five minutes.
 *
 * Past the app's write deadline (180 s, `src/data/api.ts`), so a request still inside the time a person was told to wait
 * is never taken for a dead one, and far inside the day a row is kept (`executor/scheduler.ts`).
 */
export const ABANDONED_AFTER_SECONDS = 300;

/** What the row says about a key, and two things only the database clock and column can say. */
type Claim = {
  method: string;
  path: string;
  status: number | null;
  body: string | null;
  /** Null on rows written before migration 025. */
  request_hash: string | null;
  broadcast: boolean;
  abandoned: boolean;
};

/**
 * The attempt that held a key lost it while it ran: it went past `ABANDONED_AFTER_SECONDS` with nothing broadcast, and a
 * retry took the key over. It must send nothing — the retry is now the attempt that acts.
 */
export class ClaimTakenOver extends Error {
  constructor() {
    super(
      'This request ran for more than five minutes without sending anything, and a retry with the same ' +
        'Idempotency-Key has taken its place, so nothing was sent from this one.',
    );
    this.name = 'ClaimTakenOver';
  }
}

export async function idempotency(c: Context, next: Next) {
  const key = c.req.header('idempotency-key');
  if (!key || c.req.method === 'GET' || c.req.method === 'OPTIONS') return next();

  const user = c.get('user') as { userId?: string } | undefined;
  // Without an identity there is nothing to scope the key to, and a global namespace would let one
  // caller read another's response by guessing a key.
  if (!user?.userId) return next();
  const userId = user.userId;

  if (key.length > 200) {
    return c.json({ error: 'idempotency_key_too_long', message: 'Keys are at most 200 characters.' }, 400);
  }

  // The body exactly as it arrived, before anything parses it. Hono keeps the bytes, so the route still reads them.
  const requestHash = createHash('sha256').update(new Uint8Array(await c.req.arrayBuffer())).digest('hex');
  const method = c.req.method;
  const path = c.req.path;
  /** This attempt's name on the row: every later write it makes has to still find it there. */
  const claimId = randomUUID();

  const existing = await one<Claim>(
    `SELECT method, path, status, body, request_hash,
            broadcast_at IS NOT NULL AS broadcast,
            created_at < now() - make_interval(secs => $3::double precision) AS abandoned
       FROM idempotency WHERE user_id = $1 AND key = $2`,
    [userId, key, ABANDONED_AFTER_SECONDS],
  );

  if (existing) {
    /*
     * The same key on a DIFFERENT request is a client bug, and a dangerous one.
     *
     * Replaying the stored response would answer a question the caller did not ask; running it
     * would defeat the key entirely. Refusing is the only option that cannot silently do the wrong
     * thing.
     */
    if (existing.path !== path || existing.method !== method) {
      return reused(c, `That key was already used for ${existing.method} ${existing.path}.`);
    }
    // A row from before the body was kept is held to method and path, as every row was.
    if (existing.request_hash !== null && existing.request_hash !== requestHash) {
      return reused(
        c,
        `That key was already used for ${method} ${path} with a different body. A different request needs a new key.`,
      );
    }
    if (existing.status !== null) return replay(existing.status, existing.body);
    if (!existing.abandoned) return inFlight(c);
    if (existing.broadcast) return outcomeUnknown(c);

    /*
     * Abandoned, and nothing was sent under it: take the claim over, and run.
     *
     * The check is the write again. The UPDATE re-reads every condition the SELECT answered, so two retries of one dead
     * request cannot both take it, and a request that was only slow cannot be taken once it has broadcast. One that
     * broadcasts after losing its claim finds its claim gone when it records the broadcast, and sends nothing
     * (`ClaimTakenOver`).
     */
    const taken = await query(
      `UPDATE idempotency SET claim_id = $3, request_hash = $4, created_at = now()
        WHERE user_id = $1 AND key = $2 AND method = $5 AND path = $6
          AND status IS NULL AND broadcast_at IS NULL
          AND (request_hash IS NULL OR request_hash = $4)
          AND created_at < now() - make_interval(secs => $7::double precision)
        RETURNING key`,
      [userId, key, claimId, requestHash, method, path, ABANDONED_AFTER_SECONDS],
    );
    if (taken.length === 0) return inFlight(c);
    log.warn(`[idempotency] ${method} ${path}: an attempt abandoned before it sent anything is being run again`);
  } else {
    // Claim the key. A concurrent duplicate loses this insert and is told the request is in flight.
    const claimed = await query(
      `INSERT INTO idempotency (user_id, key, method, path, request_hash, claim_id) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, key) DO NOTHING RETURNING key`,
      [userId, key, method, path, requestHash, claimId],
    );
    if (claimed.length === 0) return inFlight(c);
  }

  const scope = await withRequestScope(async (scope) => {
    // Recorded on the row before the first send, by the attempt that still holds the claim — or not sent at all.
    scope.beforeFirstBroadcast = async () => {
      const marked = await query(
        `UPDATE idempotency SET broadcast_at = now() WHERE user_id = $1 AND key = $2 AND claim_id = $3 RETURNING key`,
        [userId, key, claimId],
      );
      if (marked.length === 0) throw new ClaimTakenOver();
    };
    try {
      await next();
    } catch (e) {
      // No response to keep. What sent nothing is given back; what did stays claimed, for the abandoned rule to answer.
      if (!scope.broadcast) await release(userId, key, claimId).catch(unrecorded(method, path));
      throw e;
    }
    return scope;
  });

  const status = c.res.status;
  try {
    if (status >= 500 && !scope.broadcast) {
      /*
       * Release the claim on a server error that sent nothing.
       *
       * Leaving it would mean a retry of a request that failed for a transient reason gets 409
       * forever — the key would have permanently locked out the very operation it exists to make
       * safe to retry. A 5xx after a broadcast is kept below instead: that retry must replay.
       */
      await release(userId, key, claimId);
      return;
    }
    // Read the body without consuming it: the response still has to reach the caller.
    const body = await c.res.clone().text();
    await query(`UPDATE idempotency SET status = $4, body = $5 WHERE user_id = $1 AND key = $2 AND claim_id = $3`, [
      userId,
      key,
      claimId,
      status,
      body,
    ]);
  } catch (e) {
    /*
     * The answer stands even when it cannot be kept.
     *
     * A failure here threw past the route, and the error handler replaced an order that had filled with a 500. The claim
     * stays unanswered instead: a retry is refused while it is fresh, then judged by the abandoned rule — which never
     * runs again a request that broadcast.
     */
    unrecorded(method, path)(e);
  }
}

/** Give the key back — only while this attempt still holds it, and only if nothing was sent under it. */
async function release(userId: string, key: string, claimId: string): Promise<void> {
  await query(`DELETE FROM idempotency WHERE user_id = $1 AND key = $2 AND claim_id = $3 AND broadcast_at IS NULL`, [
    userId,
    key,
    claimId,
  ]);
}

function unrecorded(method: string, path: string) {
  return (e: unknown) =>
    log.error(
      `[idempotency] ${method} ${path}: the outcome could not be recorded against its key: ${e instanceof Error ? e.message : String(e)}`,
    );
}

function reused(c: Context, message: string) {
  return c.json({ error: 'idempotency_key_reused', message }, 422);
}

function inFlight(c: Context) {
  return c.json({ error: 'request_in_flight', message: 'An identical request is still being processed.' }, 409);
}

/** Never "failed" and never run again: the earlier attempt sent a transaction, and only the chain knows what became of it. */
function outcomeUnknown(c: Context) {
  return c.json(
    {
      error: 'request_outcome_unknown',
      message:
        'An earlier attempt with this key stopped without answering after it had sent a transaction, so it may have gone through. Check Activity before trying again.',
    },
    409,
  );
}

function replay(status: number, body: string | null): Response {
  return new Response(body ?? '', {
    status,
    headers: { 'content-type': 'application/json', 'idempotent-replay': 'true' },
  });
}
