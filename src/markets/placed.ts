/**
 * What the ticket says once an attempt comes back — and specifically, what it says when the attempt did
 * nothing because the same one already had.
 *
 * ## The invisible half of idempotency
 *
 * `intentKey.ts` makes the retry safe: the same ask tapped again after a timeout carries the same
 * `Idempotency-Key`, the executor answers it with what the first attempt did, and no second order is placed.
 * All of that works, and until now none of it was visible. The replayed answer is byte for byte the first
 * one, so the ticket rendered "Bought 0.0412 XBTC" a second time, for a fill that happened minutes ago.
 *
 * That is the wrong sentence in the one place it matters most. Someone who tapped again because they were
 * not sure whether the first went through reads a second confirmation and concludes they bought twice. The
 * mechanism that exists to stop a double spend looks, to the person it protected, exactly like one.
 *
 * `server/src/http/idempotency.ts` already says so on the wire: a stored answer comes back with
 * `idempotent-replay: true`. `api.ts` carries it through, and this turns it into the two words that make
 * the difference.
 *
 * ## Why this is not just a string
 *
 * A replay can be a replay of anything the first attempt did. A fill, a refusal, a run that failed. "Already
 * filled" over a stored 409 would be a lie of exactly the kind this is meant to prevent, so the outcome
 * decides the verb and the replay decides only whether it happened just now or already had.
 */
import { quantity } from '@/format';

export type Placement = {
  /** The button's label. */
  label: string;
  /**
   * The line under it, where there is something to say that the label cannot.
   *
   * Only ever present on a replay: on a first attempt the label is the whole story.
   */
  note?: string;
  /** Whether this answer was the executor repeating what an earlier attempt with the same key did. */
  replayed: boolean;
};

/**
 * The ticket's answer to one attempt.
 *
 * `units` is what the outcome reported. Zero is a real answer for a watch-mode or skipped run, and the label
 * never quotes a quantity it was not given.
 */
export function placementOf(input: {
  side: 'buy' | 'sell';
  symbol: string;
  units: number | undefined;
  replayed: boolean;
}): Placement {
  const { side, symbol, units, replayed } = input;
  const verb = side === 'buy' ? 'Bought' : 'Sold';
  const what = units !== undefined && units > 0 ? `${quantity(units)} ${symbol}` : symbol;

  if (!replayed) return { label: `${verb} ${what}`, replayed: false };

  return {
    // "Already" is the whole feature: it says this tap placed nothing, without saying anything failed.
    label: `Already ${verb.toLowerCase()} ${what}`,
    note: 'This is the same order you already placed, so it filled once. Nothing was placed again.',
    replayed: true,
  };
}

/**
 * The same idea for an outcome that was not a fill.
 *
 * A replayed refusal is still a refusal, and the sentence has to say which attempt it belongs to: someone
 * who taps again and reads "the daily cap is spent" should know that is the answer their FIRST attempt got,
 * not a second refusal of a second try. Without that, a stored answer looks like two separate rejections.
 */
export function replayNote(replayed: boolean): string | undefined {
  return replayed
    ? 'This is what your earlier attempt came back with. Nothing was sent again.'
    : undefined;
}
