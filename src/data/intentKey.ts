/**
 * One `Idempotency-Key` per thing a person asked for (FEATURES.md #29).
 *
 * A money action that times out has an unknown outcome: the executor may have filled it and not said so in time — a
 * `POST /orders` has taken 153s. Tapping the button again sent a second order. The executor runs a keyed write once and
 * answers any repeat of that key with the response it stored, or with 409 while the first is still running
 * (`server/src/http/idempotency.ts`). So a repeat is safe when it carries the SAME key, and only then, which makes when a
 * key is made the whole of the design:
 *
 *   - Made when the person commits — Place, Confirm, Close, the faucet's button — and not before.
 *   - Kept while the outcome is unknown, so the same tap after a timeout sends the same key.
 *   - Dropped once an answer arrives. The executor keeps stored responses for a day and matches a key on method and path,
 *     never on the body, so a key kept past its answer would replay this morning's fill for this afternoon's order.
 *   - Replaced whenever the ask changes. Another amount, token, side or tolerance is another intent, with another key.
 *
 * Pure, and apart from the screens and the transport, so the lifecycle is testable on Node.
 */
import { ApiError, NotSignedIn, TimedOut } from './apiError';

/** The executor refuses a longer key with a 400 (`idempotency_key_too_long`). */
export const IDEMPOTENCY_KEY_MAX = 200;

/** The header a key travels in. Lower case, like every other header this client sends; headers are case-insensitive. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** What a money write takes beside its body: the key of the intent it belongs to. */
export type Keyed = { idempotencyKey: string };

/**
 * A new key: random hex, then the time — how `newRequestId` in `api.ts` builds a request id. The executor scopes a key to
 * the signed-in user, so this is a label that must not repeat, not a secret. 43 characters, well inside the limit.
 */
export function newIdempotencyKey(random: () => number = Math.random, now: number = Date.now()): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('');
  return `${hex}${now.toString(16)}`;
}

/** The headers a write adds for its key, and none without one. */
export function keyHeaders(write?: Partial<Keyed>): Record<string, string> {
  return write?.idempotencyKey ? { [IDEMPOTENCY_HEADER]: write.idempotencyKey } : {};
}

/** An ask as one string. Keys are sorted, so two asks are the same intent exactly when their fields are. */
export function intentOf(ask: unknown): string {
  return JSON.stringify(ask, (_, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : value,
  );
}

/**
 * Whether a failed attempt's outcome is known.
 *
 * Known: the executor answered — a refusal, a request it would not accept, a key it would not take — or nothing was sent
 * at all. The next tap is a new attempt, with a new key.
 *
 * Unknown: the request may still be running, or may have run. A timeout. A dropped connection. A 5xx, which can be the
 * proxy in front of an executor that is still working — and the executor stores no 5xx, so the same key genuinely
 * retries. A 408. And the executor's own `request_in_flight`, which says in as many words that the first is still going.
 * These keep the key, so the next tap asks after that attempt instead of starting another.
 *
 * A 429 is known, although it means "later": the limiter answers before any route runs, so nothing happened — and the
 * idempotency layer sits in front of the limiter and stores that 429 against the key, so the same key would be answered
 * 429 for as long as the executor keeps it.
 */
export function outcomeKnown(error: unknown): boolean {
  if (error instanceof NotSignedIn) return true;
  if (error instanceof TimedOut || !(error instanceof ApiError)) return false;
  if (error.status >= 500 || error.status === 408) return false;
  return (error.body as { error?: unknown } | undefined)?.error !== 'request_in_flight';
}

/** The key one ask goes out with, and the ask it was made for. */
export type HeldKey = { intent: string; key: string };

/** The same ask again keeps the key it holds; any other ask gets a new one. */
export function keyForAsk(held: HeldKey | undefined, intent: string, mint: () => string): HeldKey {
  return held !== undefined && held.intent === intent ? held : { intent, key: mint() };
}

/**
 * What to hold once an attempt ends: nothing when its outcome is known, the same key while it is not.
 *
 * Only while that attempt still holds the slot. A double tap sends one key twice and the executor answers the second
 * `request_in_flight` at once; landing after the first one's fill, that answer must not bring back a key the fill spent.
 */
export function heldAfter(held: HeldKey | undefined, attempt: HeldKey, known: boolean): HeldKey | undefined {
  if (held !== attempt) return held;
  return known ? undefined : attempt;
}

/**
 * One screen's keys. `send` puts an ask through with the key it should carry, then keeps or drops that key by how the
 * attempt ended. Whatever the request answered or threw is passed on untouched.
 */
export function intentKeys(mint: () => string = newIdempotencyKey) {
  let held: HeldKey | undefined;
  return {
    async send<T>(ask: unknown, request: (idempotencyKey: string) => Promise<T>): Promise<T> {
      const attempt = keyForAsk(held, intentOf(ask), mint);
      held = attempt;
      try {
        const answer = await request(attempt.key);
        held = heldAfter(held, attempt, true);
        return answer;
      } catch (e) {
        held = heldAfter(held, attempt, outcomeKnown(e));
        throw e;
      }
    },
  };
}

export type IntentKeys = ReturnType<typeof intentKeys>;
