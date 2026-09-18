/**
 * Errors the venues raise that callers need to tell apart from a failure.
 *
 * `UnpricedError` lived in the Jupiter client on the Solana build. It is venue-independent — "nobody would price this"
 * is the same fact whichever pool was asked — so it lives on its own and the Uniswap/OKX paths share it.
 */

/**
 * Raised when no venue will price a pair: no route, no liquidity at this size, or the venue could not be reached.
 *
 * Its own class so a caller can tell "we could not find out" from "the swap failed" — the first is a screen that says
 * so and a button still worth pressing later, the second is money that moved.
 */
export class UnpricedError extends Error {
  override readonly name = 'UnpricedError';
}
