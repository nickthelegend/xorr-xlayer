/**
 * The split or dividend an equity has queued, and the sentence that says so.
 *
 * Backed's xStocks on X Layer are rebasing ERC-20s behind an ERC-4626 wrapper, and a corporate
 * action lives on the raw token as a NEW MULTIPLIER (`newMultiplier`) with the time it takes effect
 * (`newMultiplierActivationTime`). The server reads it off the token; this turns the reading into
 * words.
 *
 * ## Why the wording is careful
 *
 * The token records THAT the multiplier changes, not WHY. A forward split and a dividend paid
 * as extra units both raise it, and nothing in the contract state separates them. So the sentence
 * says what is about to happen to the holding — units multiplied, price per unit divided — and
 * never names the event. Calling a dividend a split on an asset screen would be exactly the sort of
 * invention the on-chain read was chosen to avoid.
 *
 * ## Why the countdown is composed here
 *
 * "In 2 days" has to keep being true. The server sends the effective timestamp and the screen holds
 * it against a clock that ticks (`useNow`), rather than being handed a sentence that was accurate
 * when the request was answered and silently ages on the screen.
 */

export type PendingAction = {
  nextMultiplier: number;
  effectiveAtMs: number;
  /** What a holding gets restated by: units x ratio, price per unit / ratio. */
  ratio: number;
  direction: 'increase' | 'decrease';
};

export type CorporateActionNotice =
  | { status: 'scheduled'; symbol: string; multiplier: number; pending: PendingAction }
  | { status: 'none'; symbol: string; multiplier: number; pending: null }
  | {
      status: 'unavailable';
      symbol: string;
      multiplier: null;
      pending: null;
      reason: 'not_tokenized' | 'unreadable';
    };

/**
 * How long until it lands, in the coarsest unit that still says something.
 *
 * Past the timestamp this reads "any moment now" rather than a negative duration: the multiplier
 * flips when the chain says it does, and a screen counting up from the deadline is describing the
 * gap between two clocks rather than anything about the asset.
 */
export function untilText(effectiveAtMs: number, now: number): string {
  const ms = effectiveAtMs - now;
  if (ms <= 0) return 'any moment now';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return mins <= 1 ? 'in under a minute' : `in ${mins} minutes`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return hours === 1 ? 'in an hour' : `in ${hours} hours`;
  return `in ${Math.round(hours / 24)} days`;
}

/**
 * The ratio as people say it: 2 is "2-for-1", 0.5 is "1-for-2".
 *
 * Fractions that are not a clean one-for-n — a dividend rarely is — are left as a multiplier rather
 * than forced into ratio language a holder would have to decode.
 */
export function ratioText(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '';
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  if (ratio > 1 && near(ratio, Math.round(ratio))) return `${Math.round(ratio)}-for-1`;
  const inverse = 1 / ratio;
  if (ratio < 1 && near(inverse, Math.round(inverse))) return `1-for-${Math.round(inverse)}`;
  return `×${Number(ratio.toFixed(4))}`;
}

/**
 * The strip's sentence, or null when there is nothing to say.
 *
 * Null for `none` deliberately: an asset with no corporate action queued should show no strip at
 * all, not a strip announcing the absence of one. `unavailable` DOES produce a sentence, because
 * "we could not check" is worth saying on a screen whose other numbers are all things we did check.
 */
export function actionSentence(
  notice: CorporateActionNotice | undefined,
  now: number,
): { text: string; kind: 'risk' | 'blocked' } | null {
  if (!notice) return null;

  if (notice.status === 'unavailable') {
    // Nothing to say about an asset that was never an xStock — it has no multiplier to move.
    if (notice.reason === 'not_tokenized') return null;
    return {
      text: 'The token did not answer, so whether a split or dividend is scheduled is unknown right now.',
      kind: 'blocked',
    };
  }

  if (notice.status === 'none') return null;

  const { pending } = notice;
  const when = untilText(pending.effectiveAtMs, now);
  const ratio = ratioText(pending.ratio);
  const movement =
    pending.direction === 'increase'
      ? `your units multiply by ${trim(pending.ratio)} and the price per unit divides by the same`
      : `your units are divided by ${trim(1 / pending.ratio)} and the price per unit rises by the same`;

  return {
    text: `A ${ratio} change to this share takes effect ${when}: ${movement}. What your holding is worth does not change. Agents do not open new positions here until it has passed.`,
    kind: 'risk',
  };
}

/** A multiplier as a number a person reads: `2`, not `2.0000`. */
function trim(n: number): string {
  return String(Number(n.toFixed(4)));
}
