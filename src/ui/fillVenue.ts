/**
 * fillVenue.ts — naming the place a fill actually happened.
 *
 * The executor records a venue on every fill (`strategy_runs.venue`), and until now no screen showed it. A receipt that
 * says "filled" without saying *where* is the one claim in this app nobody can check, because the venue is what decides
 * what the transaction beside it actually did.
 *
 * ## The rule this module exists to enforce
 *
 * On X Layer the executor settles through three venues (`SettlementVenue` in `server/src/executor/settle.ts`):
 *
 *   `uniswap-v3` — a swap through Uniswap v3's router, along the pools the quote named.
 *   `okx-dex`    — OKX DEX's aggregator picked the route, pulling the input through its own approval contract.
 *   `aave`       — cash supplied to Aave v3's pool. Nothing was swapped: it is a deposit, not a trade.
 *
 * The three get different words, and Aave's wording never says swap, route or trade — because nothing was traded.
 * Getting that wrong would not be a copy bug; it would be the app claiming a market trade that never took place, beside
 * a transaction that proves something else entirely.
 *
 * A venue this build does not recognise is shown **verbatim**. Inventing a friendly name for an identifier we cannot
 * interpret would be guessing at the one field the reader came to check, and a venue the app cannot name is still a
 * venue the executor recorded.
 */

/** What a receipt can say about where a fill happened. */
export type VenueNaming = {
  /** The short label on the receipt. */
  label: string;
  /** One line saying what that venue actually did. Absent for an identifier this build cannot interpret. */
  detail?: string;
  /** Whether a trade was really routed on-chain. `false` for an Aave supply; undefined when unknown. */
  routed?: boolean;
  /** This build does not recognise the identifier, so the label is the raw value. */
  unrecognised?: boolean;
};

/** The venues this build can speak for — the executor's `SettlementVenue`, exactly. */
const KNOWN: Readonly<Record<string, VenueNaming>> = {
  'uniswap-v3': {
    label: 'Uniswap v3',
    detail: 'Swapped through the Uniswap v3 pools on X Layer.',
    routed: true,
  },
  'okx-dex': {
    label: 'OKX DEX',
    detail: 'Routed by the OKX DEX aggregator on X Layer.',
    routed: true,
  },
  aave: {
    /*
     * Never "swap". Supplying to Aave moves cash into a lending pool at par; no market price was taken, and calling it
     * a trade would put a trade on the record that did not happen.
     */
    label: 'Aave',
    detail: 'Supplied to the Aave v3 pool. Nothing was traded.',
    routed: false,
  },
};

/**
 * How a receipt should name a recorded venue, or `undefined` when none was recorded.
 *
 * `undefined` is a real and distinct answer: a run that never reached a venue — blocked by the cap, refused by the
 * rules, skipped — has no venue, and that is not the same as a venue we failed to read. The caller says "unavailable"
 * for one and nothing at all for the other.
 */
export function venueNaming(venue: string | null | undefined): VenueNaming | undefined {
  if (venue === null || venue === undefined) return undefined;
  const key = venue.trim();
  if (key === '') return undefined;
  return KNOWN[key] ?? KNOWN[key.toLowerCase()] ?? { label: key, unrecognised: true };
}

/**
 * A transaction hash, short enough for one line and long enough to find.
 *
 * Both ends, never a prefix: two hashes can share leading characters, and a truncation nobody can match against an
 * explorer is decoration shaped like proof. Anything already short is returned exactly as it came, because a hash
 * this app did not produce is not one it should reformat.
 */
export function shortSignature(signature: string): string {
  const head = 8;
  const tail = 8;
  return signature.length <= head + tail + 1 ? signature : `${signature.slice(0, head)}…${signature.slice(-tail)}`;
}

/**
 * A block number as a receipt shows it, or `undefined` when there is nothing real to show.
 *
 * Zero is not a block anyone's fill landed in, and neither is a negative or a fraction, so none of them are drawn: a
 * receipt is the one surface where a placeholder number would be indistinguishable from a recorded fact.
 */
export function blockLabel(block: number | null | undefined): string | undefined {
  if (typeof block !== 'number' || !Number.isFinite(block) || !Number.isInteger(block) || block <= 0) return undefined;
  return block.toLocaleString('en-US');
}
