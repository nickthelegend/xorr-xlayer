/**
 * What counts as an amount, before anything is sent.
 *
 * The ticket checked one thing — is it more than the wallet has — and let everything else through to the
 * executor. So `$0.001` of XBTC went out as a real order and came back a refusal from the venue; `$12.3456`
 * went out as a number of dollars that does not exist and settled to a rounded one; and the keypad would
 * happily compose `$9999999`, past the executor's own ceiling, with the button live the whole time.
 *
 * None of those are failures worth a round trip. Each has a rule that is knowable on the device, and a
 * sentence better than anything the wire will answer with — the venue says `TF`, the schema says
 * `too_big`, and neither is addressed to a person.
 *
 * The bounds here are the EXECUTOR's, not this file's opinion:
 *
 *   - `ORDER_MAX_USD` is `OrderInput`'s `.max(1_000_000)` in `server/src/routes/strategies.ts`.
 *   - `ORDER_MIN_USD` is a cent, which is where money stops being divisible in every sentence this app
 *     writes and the line `DUST_USD` already draws for a holding. The route enforces it too, so this is a
 *     kinder version of a real refusal rather than a client-side invention.
 *
 * `server/src/routes/order-amount.test.ts` reads these constants and puts them through the real route, so
 * the two cannot drift into the app refusing what the executor accepts, or the reverse.
 */
import { money } from '@/format';

/** Dollars are to the cent. Anything finer is not a smaller order, it is a typo. */
export const AMOUNT_DECIMALS = 2;

/** The smallest order the executor will take. */
export const ORDER_MIN_USD = 0.01;

/** The largest, from `OrderInput` on the executor. */
export const ORDER_MAX_USD = 1_000_000;

/**
 * Why an amount was refused, as a code so the screen can decide how loudly to say it and a test can name it
 * without matching on prose.
 */
export type AmountRefusal =
  | 'not-a-number'
  | 'below-minimum'
  | 'above-maximum'
  | 'too-precise'
  | 'insufficient';

export type AmountCheck =
  /** Nothing typed yet. Not an error — a cleared field is someone starting over, not someone being wrong. */
  | { state: 'empty' }
  | { state: 'ok'; usd: number }
  | { state: 'refused'; code: AmountRefusal; reason: string };

/** How many digits sit after the point in what was typed. Counted on the STRING: 0.10 is two, and 0.1 is one. */
export function decimalsTyped(text: string): number {
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * One amount, checked.
 *
 * `text` is what is in the field, character for character, because two of these rules are about the typing
 * and not about the number: `12.3456` and `12.35` parse to different values, and `0.` is a person halfway
 * through typing rather than an invalid amount.
 *
 * `available` is what can pay for it — cash for a buy, the position for a sale — and is left undefined while
 * that is still being read. An unread balance never refuses: it disables, which is the ticket's job, not
 * this one's.
 */
export function checkAmount(input: {
  text: string;
  minUsd?: number;
  maxUsd?: number;
  available?: { usd: number; reason: (availableUsd: number) => string };
}): AmountCheck {
  const { text, minUsd = ORDER_MIN_USD, maxUsd = ORDER_MAX_USD, available } = input;
  const trimmed = text.trim();

  // A cleared field, a lone zero, and a point just tapped are all mid-typing. None of them is a refusal.
  if (trimmed === '' || trimmed === '.' || /^0*\.?0*$/.test(trimmed)) return { state: 'empty' };

  const usd = Number(trimmed);
  if (!Number.isFinite(usd) || usd < 0) {
    return { state: 'refused', code: 'not-a-number', reason: 'That is not an amount.' };
  }

  if (usd < minUsd) {
    return { state: 'refused', code: 'below-minimum', reason: `The smallest order is ${money(minUsd)}.` };
  }

  if (usd > maxUsd) {
    return {
      state: 'refused',
      code: 'above-maximum',
      reason: `The largest order is ${money(maxUsd, { fractionDigits: 0 })}.`,
    };
  }

  /*
   * Precision after the bounds, because a sub-cent amount is both and only one of the two sentences helps.
   * `$0.001` told "amounts are to the cent" leaves someone typing `$0.00`; told the floor, they type `$0.01`.
   * `$12.345` is a real typo at a real size, and there the rule is the whole answer.
   */
  if (decimalsTyped(trimmed) > AMOUNT_DECIMALS) {
    return {
      state: 'refused',
      code: 'too-precise',
      // Said as a rule rather than as a complaint, so the fix is in the sentence.
      reason: 'Amounts are to the cent.',
    };
  }

  /*
   * The balance last, deliberately.
   *
   * A malformed amount checked against a balance produces the wrong sentence — "$0.001 is more than you
   * have" for someone with $5,000 — and the balance is the only one of these that can change without the
   * user touching the field.
   */
  if (available && usd > available.usd) {
    return { state: 'refused', code: 'insufficient', reason: available.reason(available.usd) };
  }

  return { state: 'ok', usd };
}
