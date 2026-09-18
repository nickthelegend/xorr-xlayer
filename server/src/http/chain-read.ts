/**
 * A chain read that failed, kept distinct from a chain that answered "nothing" (PLAN.md 1.7).
 *
 * Routes caught their chain reads and substituted a value — `usd: 0`, `null`, `revoked: true`, `[]` —
 * so a timeout reached the screen as a confident statement about the user's money: "$0.00", "no
 * permission", "permission is off", "no venues allowed". Every one of those is a real state a user
 * can be in, which is exactly why a failed read must never look like one.
 */
import { StillFetching, beforeDeadline } from './deadline.js';

export class ChainReadFailed extends Error {
  readonly status = 502;
  constructor(
    /** What was being read, in the words the message uses: "your permission", "your balance". */
    readonly what: string,
    /** The error the read threw, kept for the log. */
    readonly underlying: unknown,
  ) {
    super(`Could not read ${what} from the chain just now.`);
    this.name = 'ChainReadFailed';
  }
}

/**
 * Run a chain read. A throw becomes `ChainReadFailed`; an answer — including an answer of null — passes through.
 *
 * `deadlineMs` is for a read behind a screen (`http/patience.ts`). viem's own bound is ten seconds an attempt over four
 * attempts, so a node that takes calls and answers them slowly could hold a screen past the app's 45 seconds with a read
 * that was never going to fail. Past the deadline the read is `ChainReadFailed` like any other that did not answer, and
 * the call itself is left to finish.
 *
 * A `StillFetching` from inside passes through as itself. A balance read waits on a price feed as well as the chain, and
 * "could not read your balance from the chain" about a price that is seconds away would send someone to the wrong place.
 */
export async function readChain<T>(what: string, read: () => Promise<T>, deadlineMs?: number): Promise<T> {
  try {
    return await beforeDeadline(read(), deadlineMs, () => new Error(`no answer in ${deadlineMs}ms`));
  } catch (e) {
    if (e instanceof StillFetching) throw e;
    throw new ChainReadFailed(what, e);
  }
}
