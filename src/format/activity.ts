/**
 * Activity as the main screens say it: what happened, without where it settled or how the server keeps time.
 *
 * The executor writes the venue into the trail's action line — "Bought 0.0020 XBTC on Uniswap v3" — and
 * every address in full, so the trail can be checked against where the money went; the Proof screens show each entry as
 * written. Home, Activity, Inbox, Catch-up and Business say what the bot did in the words a person uses, and the rest
 * stays in the trail, one tap away.
 */
import { shortAddress } from './index';

const VENUE_CLAUSES: readonly (readonly [RegExp, string])[] = [
  // The two X Layer swap venues, as `server/src/executor/run.ts` writes them.
  [/ on Uniswap v3\b/g, ''],
  [/ through OKX DEX\b/g, ''],
  [/ to Aave\b/g, ' to savings'],
];

export function plainAction(action: string): string {
  return VENUE_CLAUSES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), action);
}

/** A full address (40 hex digits) or transaction hash (64) inside a sentence. */
const FULL_HEX = /\b0x(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})\b/g;

/**
 * A detail line, shortened: "0xB9B7…7fB3" is the address a person recognises at a glance, and "by the executor's clock"
 * names a server nobody reading the row needs to know about.
 */
export function plainDetail(detail: string): string {
  return detail.replace(FULL_HEX, (hex) => shortAddress(hex)).replace(/,? by the executor['’]s clock/g, '');
}
