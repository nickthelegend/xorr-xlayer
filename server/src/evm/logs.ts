/**
 * `eth_getLogs` in windows the provider will actually serve.
 *
 * Every public Base RPC caps the block range of a log query, and the cap MOVES. `venues/aqua.ts`
 * documented it as 10,000 and set its window to 9,000; the endpoint anvil forks from now answers
 * `-32614 eth_getLogs is limited to a 2,000 range`, so the query throws, the caller's `.catch`
 * turns it into `undefined`, and every trade quietly goes to the aggregator with no Aqua fill and
 * no error. That is the silent fallback this codebase refuses everywhere else, arriving for the
 * second time through the same door.
 *
 * Lowering the constant again would fix it until the next tightening. Paging fixes the class: the
 * caller asks for the range it wants, and this splits the request into windows the provider
 * accepts — and when the provider names a smaller limit than we guessed, it says so in the error,
 * so that number is read and used rather than guessed at again.
 *
 * Windows are fetched sequentially on purpose. These providers rate-limit as well as range-limit,
 * and firing thirty parallel windows at a free endpoint trades one refusal for another.
 */
import type { AbiEvent, Address, GetLogsParameters, GetLogsReturnType } from 'viem';
import { publicClient } from './client.js';

/** Conservative first guess: under every Base limit seen so far (2,000), with room to spare. */
const DEFAULT_SPAN = BigInt(process.env.LOG_WINDOW_BLOCKS ?? 1_800);

/** Providers say the number in the refusal. Reading it beats guessing again. */
function limitFrom(e: unknown): bigint | undefined {
  const m = /limited to a ([\d,]+) range/i.exec(e instanceof Error ? e.message : String(e));
  if (!m) return undefined;
  const n = BigInt(m[1]!.replace(/,/g, ''));
  return n > 0n ? n : undefined;
}

/** True when the failure is the provider refusing the RANGE, rather than the query being wrong. */
export function isRangeRefusal(e: unknown): boolean {
  return /limited to a [\d,]+ range|block range|query returned more than|-32614/i.test(
    e instanceof Error ? e.message : String(e),
  );
}

export async function getLogsPaged<const TEvent extends AbiEvent>(params: {
  address: Address;
  event: TEvent;
  /**
   * An indexed-topic filter — `{ owner }` on an event that indexes `owner` — handed to viem's `getLogs` unchanged.
   *
   * Added for the transaction history (PLAN.md 3.14). A contract's events are every owner's, so without a topic
   * filter one wallet's history would download everybody's, window by window, to keep its own handful — when the
   * node can match an indexed topic itself. Left out of the request entirely when absent, so the book scans in
   * `venues/aqua.ts` and `venues/swapvm.ts`, whose events index nothing, ask exactly what they always asked.
   */
  args?: GetLogsParameters<TEvent>['args'];
  fromBlock: bigint;
  toBlock: bigint;
}): Promise<GetLogsReturnType<TEvent>> {
  // Decoded logs, so callers keep `args` — the whole reason they pass an `event`.
  const out = [] as unknown as GetLogsReturnType<TEvent>;
  let span = DEFAULT_SPAN;
  let cursor = params.fromBlock;

  while (cursor <= params.toBlock) {
    const end = cursor + span - 1n > params.toBlock ? params.toBlock : cursor + span - 1n;
    try {
      const logs = await publicClient.getLogs({
        address: params.address,
        event: params.event,
        // On every window, retries included: a shrunken window asked without it would widen to every owner.
        ...(params.args === undefined ? {} : { args: params.args }),
        fromBlock: cursor,
        toBlock: end,
      });
      out.push(...(logs as typeof out));
      cursor = end + 1n;
    } catch (e) {
      const named = limitFrom(e);
      /*
       * Shrink and retry the SAME window rather than skipping it. Advancing past a window the
       * provider refused would lose whatever books were shipped inside it, and lose them silently
       * — which is the failure this file exists to end, not to relocate.
       *
       * Shrink from the window we ACTUALLY asked for, not from `span`. The last window of a range
       * is clamped by `toBlock`, so a span of 1,800 can attempt 250 blocks — and halving 1,800 to
       * 900 leaves that attempt identical, refused again, halved again, forever. Deriving the new
       * span from the attempt guarantees each retry is strictly smaller.
       */
      const attempted = end - cursor + 1n;
      if (named && named < attempted) {
        span = named;
        continue;
      }
      if (isRangeRefusal(e) && attempted > 1n) {
        span = attempted / 2n > 0n ? attempted / 2n : 1n;
        continue;
      }
      throw e;
    }
  }
  return out;
}
