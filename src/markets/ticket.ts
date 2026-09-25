/**
 * What the order ticket may send, checked against what the wallet actually has.
 *
 * A sale had no check at all. Its ceiling was the position's value, and with no position the ceiling was
 * `undefined`, which the ticket read as "no limit" — so "Sell $250 of XBTC" stayed live for a token the
 * wallet did not hold, and only the executor said no. A buy is checked against cash where cash is known;
 * the executor enforces the daily cap either way.
 *
 * The amount ITSELF is `amount.ts`: the executor's floor and ceiling, and the cent dollars stop at. That was
 * the other half missing here — the ceiling was a balance and nothing else, so `$0.001` and `$9,999,999` both
 * passed this and were refused on the wire, by a sentence written for a schema rather than for a person.
 */
import { money } from '@/format';
import { checkAmount, type AmountRefusal } from './amount';

/** Below a cent, a holding is what a sale left behind, not something to sell — the line Portfolio and the asset screen draw. */
export const DUST_USD = 0.01;

export type TicketLimit =
  | { state: 'ok' }
  /** The holding has not been read yet, so a sale cannot be checked. */
  | { state: 'checking' }
  /** `code` where the amount itself is what was refused, so a screen can tell a typo from an empty wallet. */
  | { state: 'refused'; reason: string; code?: AmountRefusal };

export function ticketLimit(input: {
  side: 'buy' | 'sell';
  symbol: string;
  amountUsd: number;
  /** Spendable cash, once read. */
  cashUsd: number | undefined;
  /**
   * What the permission allows today (`/limits` remainingUsd), once read. A buy over it is refused by the contract
   * (`DailyCapExceeded`); saying so on the ticket beats a green button the chain will turn down. Undefined is unread,
   * and the executor still enforces the cap either way.
   */
  remainingTodayUsd?: number;
  /**
   * Whether this wallet has granted a permission at all (`/limits` granted), once read. Without one nothing can trade —
   * the contract has no delegate to act for — so the ticket says that, rather than the day's allowance (which reads $0
   * and would be the wrong reason) or nothing at all, which left "Buy" live for an order the executor could only refuse.
   */
  granted?: boolean;
  /** What the position is worth — 0 when there is none — or where the read of it stands. */
  held: number | 'loading' | 'unread';
  /** The field exactly as typed, where the caller has it: `0.001` and `0.00` are not the same state. */
  text?: string;
}): TicketLimit {
  const { side, symbol, amountUsd, cashUsd, held } = input;
  /*
   * What the field says, not what it parsed to. `0.001` and `0.00` are different states and
   * `parseFloat` makes them the same one, so the ticket passes the text through where it has it.
   */
  const text = input.text ?? String(amountUsd);

  if (input.granted === false) {
    return { state: 'refused', reason: 'There is no permission on this wallet yet, so nothing can trade. Set one up first.' };
  }

  if (side === 'buy') {
    const amount = checkAmount({
      text,
      available:
        cashUsd === undefined ? undefined : { usd: cashUsd, reason: (usd) => `You have ${money(usd)}.` },
    });
    if (amount.state === 'refused') return { state: 'refused', reason: amount.reason, code: amount.code };
    const left = input.remainingTodayUsd;
    if (left !== undefined && amountUsd > left + 1e-9) {
      return {
        state: 'refused',
        reason:
          left < 0.01
            ? 'Your permission has nothing left to spend today. It resets at midnight UTC.'
            : `Your permission allows ${money(left)} more today.`,
      };
    }
    return { state: 'ok' };
  }

  // A sale's ceiling is the position, so the holding has to be read before the amount can be judged at all.
  if (held === 'loading') return { state: 'checking' };
  if (held === 'unread') return { state: 'refused', reason: 'Your holding did not load.' };
  if (held < DUST_USD) return { state: 'refused', reason: `You hold no ${symbol}.` };

  const amount = checkAmount({
    text,
    available: { usd: held, reason: (usd) => `You hold ${money(usd)} of ${symbol}.` },
  });
  return amount.state === 'refused'
    ? { state: 'refused', reason: amount.reason, code: amount.code }
    : { state: 'ok' };
}

/** "Max" on a sale: the whole holding, to the cent below, so it never asks for more than is there. */
export function sellMax(heldUsd: number): string {
  return String(Math.floor(heldUsd * 100) / 100);
}
