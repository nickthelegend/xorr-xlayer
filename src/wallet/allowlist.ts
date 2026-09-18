/**
 * The withdrawal allowlist — PLAN.md §3.4 / 12.21, held by the executor since 4.9.
 *
 * "Withdrawals go only to a user-allowlisted destination with a cooling-off period."
 * The cooling-off is the whole point: a stolen phone cannot add an address and drain the wallet in
 * the same session.
 *
 * It used to live here, in AsyncStorage, with this phone's clock deciding when an address had waited
 * long enough — so the device the cooling-off guards against was the one deciding when it ended, and
 * a phone with its date moved forward a day had no cooling-off at all. The list is the executor's now
 * (`/withdrawal-addresses`), and so is the clock: every entry arrives with `usable` already decided by
 * the executor's database and `usableAt` saying when a pending one will be. Nothing in this file
 * compares a time with `Date.now()`, and nothing should.
 *
 * Nor is this list the last word. `useWithdraw` asks the executor again immediately before it
 * requests a signature, so an address removed from another device while a screen was open cannot be
 * sent to.
 */
import { useCallback, useEffect } from 'react';
import { useAsync } from '@/data/useAsync';
import { withdrawals, type WithdrawalAddress, type WithdrawalAddressBook } from '@/data/withdrawals';

export type AllowlistEntry = WithdrawalAddress;

/**
 * A destination has to be an address on this chain.
 *
 * The add flow accepted any string. An allowlist whose entries cannot receive anything is not a
 * safety feature, it is a list — and the one moment it matters is the moment someone is trying to
 * get their money out.
 */
export function isValidAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(normaliseAddress(address));
}

/**
 * What the user pasted, as an address.
 *
 * Trim, and accept a `0X` prefix. Both are the same address, and the screen rejected the second
 * with **"That is not a valid address. It should start 0x and be 42 characters."** — about a string
 * that starts with 0x and is 42 characters. A confidently wrong error on the one screen someone
 * reaches while trying to get their money out, and the second time this screen has refused valid
 * destinations (it once required base58, so no EVM address could pass at all).
 *
 * The hex body keeps its casing: EIP-55 encodes a checksum in it, and comparisons downstream
 * lowercase both sides anyway.
 */
export function normaliseAddress(address: string): string {
  const t = address.trim();
  return t.startsWith('0X') ? `0x${t.slice(2)}` : t;
}

/** One address, however it is spelled: EIP-55 casing is a checksum, not a different destination. */
export function sameAddress(a: string, b: string): boolean {
  return normaliseAddress(a).toLowerCase() === normaliseAddress(b).toLowerCase();
}

/** The executor's answer, exactly as it gave it. Never worked out again from this device's clock. */
export function isUsable(entry: AllowlistEntry): boolean {
  return entry.usable;
}

/**
 * How far off a pending address is, from the executor's own two numbers.
 *
 * Rounded up, so it never tells someone an address is usable sooner than it is.
 */
export function usableIn(entry: AllowlistEntry, serverTime: number): string {
  const ms = entry.usableAt - serverTime;
  if (ms < 60_000) return 'in under a minute';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  return `in ${Math.ceil(minutes / 60)} h`;
}

/**
 * The moment a pending address becomes usable, in this device's own words for a time. The moment is
 * the executor's; only the way it is written out is local.
 */
export function usableFromText(entry: AllowlistEntry): string {
  return new Date(entry.usableAt).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * How long until the soonest pending address becomes usable, by the executor's clock — so a screen
 * can ask again then, rather than keep saying "Pending" about an address already let through.
 * Undefined when nothing is pending.
 */
export function nextChangeIn(book: Pick<WithdrawalAddressBook, 'serverTime' | 'addresses'>): number | undefined {
  const waits = book.addresses.filter((a) => !a.usable).map((a) => a.usableAt - book.serverTime);
  return waits.length === 0 ? undefined : Math.max(0, Math.min(...waits));
}

/** The longest delay a timer takes on every platform: 2³¹ − 1 ms, a little under 25 days. */
const MAX_TIMER_MS = 2_147_483_647;

export function useAllowlist() {
  const book = useAsync(() => withdrawals.addresses(), []);
  const { reload, settledAt } = book;
  const addresses = book.data?.addresses ?? [];

  /*
   * Ask again when the executor said the next address would become usable, plus a second so the
   * answer has changed by the time the question arrives. The delay is the executor's two numbers
   * subtracted; this device's clock only runs the timer.
   */
  const wait = book.data ? nextChangeIn(book.data) : undefined;
  useEffect(() => {
    if (wait === undefined) return;
    const timer = setTimeout(reload, Math.min(wait + 1_000, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [wait, reload, settledAt]);

  const add = useCallback(
    async (label: string, address: string) => {
      if (!isValidAddress(address)) {
        throw new Error('Not a valid address: it starts with 0x and has 42 characters.');
      }
      /*
       * The duplicate check is the executor's, where the list is authoritative.
       *
       * The screen checks too and cannot be trusted to: it reads the rendered list, so two taps in
       * the same tick both see it without the entry either is adding — which once produced two
       * identical rows. The executor refuses the second and leaves the first one's clock alone, so a
       * double tap can neither duplicate an address nor restart its cooling-off.
       */
      const out = await withdrawals.add(label.trim(), normaliseAddress(address));
      reload();
      if (out.status !== 'added') throw new Error(out.detail);
      return out.entry;
    },
    [reload],
  );

  const remove = useCallback(
    async (address: string) => {
      const out = await withdrawals.remove(address);
      reload();
      if (out.status !== 'removed') throw new Error(out.detail);
    },
    [reload],
  );

  const pendingFor = useCallback((entry: AllowlistEntry) => !isUsable(entry), []);

  return {
    addresses,
    usable: addresses.filter(isUsable),
    pending: addresses.filter((a) => !isUsable(a)),
    /** Both undefined until the executor has answered: a number here is only ever the executor's. */
    coolingOffHours: book.data?.coolingOffHours,
    serverTime: book.data?.serverTime,
    loading: book.loading && !book.data,
    error: book.error,
    reload,
    add,
    remove,
    pendingFor,
  };
}
