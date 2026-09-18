/**
 * What the user is told when a trade does not go through.
 *
 * On-chain failures the handoff never designed for — PLAN.md 10.13 [G46]. Each one gets
 * plain language, because "custom program error: 0x1" is not something to show a person.
 *
 * ## Why this is its own module
 *
 * It is a pure string table with no dependencies, and it lived in `executor/run.ts` — which
 * imports the 1inch venue, the chain client and (until recently) an HTTP route module. So a
 * unit test for this function failed at import time with "ONEINCH_API_KEY is required",
 * which says nothing about the thing under test. A pure function should be testable without
 * standing up the world it happens to be used in.
 */
export function humanFailure(error: string): string {
  const e = error.toLowerCase();

  /**
   * XorrDelegation's custom errors, by 4-byte selector.
   *
   * Match the selector EXACTLY. Substring matching is a trap here — one selector is a prefix of
   * another often enough that a naive `includes` reports the wrong cause, which on a trading
   * surface is worse than saying nothing. (These replaced a table of Solana Anchor codes that
   * could never fire on an EVM chain, so every real revert fell through to the generic line.)
   */
  const BY_SELECTOR: Record<string, string> = {
    '0x1db3b859': 'That agent is not the one you gave permission to.', // NotDelegate()
    '0x430f7460': 'You revoked the trading permission, so nothing was placed.', // PolicyRevoked()
    '0x9c5bebca': 'The trading permission has expired. Renew it to let the bot trade again.', // PolicyExpired()
    '0x2114fba2': 'That venue is not on your allowlist, so the trade was refused.', // VenueNotAllowed
    '0x3e814127': "Today's cap is used up. Nothing was placed.", // DailyCapExceeded
    '0x1f2a2005': 'The order size came out as zero, so nothing was placed.', // ZeroAmount()
    '0xc2e441e5': 'The venue rejected the order, so nothing was placed.', // VenueCallFailed()
    /*
     * 1inch's own errors, now that the delegation bubbles them instead of masking them.
     *
     * `ReturnAmountIsNotEnough` is the common one and used to arrive as VenueCallFailed, so a
     * trade blocked by a price move looked identical to malformed calldata. It is the difference
     * between "try again" and "something is broken", and the user is the one who has to decide.
     */
    '0x9a446475': 'The price moved more than your slippage limit while this was in flight. Nothing was placed.', // ReturnAmountIsNotEnough(uint256)
    '0xf32bec2f': 'The price moved more than your slippage limit while this was in flight. Nothing was placed.', // ReturnAmountIsNotEnough()
    /*
     * The two-argument form, which is the one the deployed router actually reverts with.
     *
     * Both zero-arg and one-arg variants were in this table and neither ever matched. A live DCA
     * run failed with `0x064a4ec6` and the user was shown the generic "the transaction did not go
     * through", while the log carried "Unable to decode signature 0x064a4ec6 as it was not found
     * on the provided ABI" — a price move reported as an unknown fault.
     *
     * All three stay: which arity a router uses is a property of its version, not something to
     * rediscover the next time one is deployed.
     */
    '0x064a4ec6': 'The price moved more than your slippage limit while this was in flight. Nothing was placed.', // ReturnAmountIsNotEnough(uint256,uint256)
    '0xf4059071': 'The venue could not collect the token — the approval was short or withdrawn.', // SafeTransferFromFailed()
    '0x28ebf247': 'The route came back with nothing, so there was no trade to make.', // ZeroReturnAmount()
    /*
     * The output binding (PLAN.md 1.4): a trade whose proceeds would not have reached the owner is
     * refused on chain. Which rule refused it is worth saying — the first is a price or routing
     * problem, the second is a fill aimed at somebody else.
     */
    '0xbab03309': 'The trade would have delivered less to your wallet than its floor, so it was refused. Nothing was placed.', // OutputNotReceived(uint256,uint256)
    '0xcd8f6b48': 'The fill named a recipient other than your wallet, so it was refused. Nothing was placed.', // RecipientNotActiveOwner(address,address)
    '0x1b6d1fa0': 'The order did not say what your wallet should receive, so nothing was placed.', // InvalidTokenOut()
    '0x2870c094': 'The order had no minimum for your wallet to receive, so nothing was placed.', // ZeroMinOut()
    '0xa156bd0a': 'Cash cannot leave through the close path — the daily cap governs it. Nothing was placed.', // SettlementTokenNotClosable()
  };
  const selector = /(?:custom error|reverted with|signature)[^0-9a-fx]*(0x[0-9a-f]{8})\b/.exec(e)?.[1];
  if (selector && BY_SELECTOR[selector]) return BY_SELECTOR[selector];

  /*
   * `TF` — a bare revert STRING, not a selector, from inside a pool.
   *
   * Uniswap and several adapters revert with two-character reasons. `TF` is a failed token
   * transfer, and on a fork it means the route touched a pool that cannot serve it: the quote was
   * built against one set of protocols and the fill against another, so 1inch produced a path
   * through liquidity that is not there. Every tokenized-equity fill produced this for a week and
   * the user was told only "the transaction did not go through".
   *
   * Matched exactly and word-bounded: `TF` appears inside plenty of longer words, and a substring
   * match here would blame a routing failure for something else entirely.
   */
  if (/reverted with the following reason:\s*TF\b/.test(error) || /\breason:\s*"?TF"?\b/.test(error)) {
    return 'The route could not be filled — the venue it went through could not move the token. Nothing was placed.';
  }

  // Named errors, when the RPC decodes them for us.
  if (e.includes('dailycapexceeded')) return BY_SELECTOR['0x3e814127']!;
  if (e.includes('policyrevoked')) return BY_SELECTOR['0x430f7460']!;
  if (e.includes('policyexpired')) return BY_SELECTOR['0x9c5bebca']!;
  if (e.includes('venuenotallowed')) return BY_SELECTOR['0x2114fba2']!;
  if (e.includes('notdelegate')) return BY_SELECTOR['0x1db3b859']!;
  if (e.includes('returnamountisnotenough')) return BY_SELECTOR['0x9a446475']!;

  if (e.includes('cannot fill on'))
    return 'This network cannot settle trades. Prices are real; filling needs Base or a Base fork.';
  if (e.includes('transfer amount exceeds allowance') || e.includes('pull failed'))
    return 'The spending approval is too small or was withdrawn, so nothing could be pulled.';
  // The bot paying for gas and the user paying for the trade are different pockets, and saying
  // "you are short" when the bot is short sends someone looking in the wrong place.
  if (e.includes('exceeds the balance of the account') || e.includes('gas required exceeds'))
    return 'The agent ran out of gas money on this network, so nothing was placed. Your funds are untouched.';
  if (e.includes('insufficient funds') || e.includes('exceeds balance'))
    return 'Not enough settled balance to cover this buy.';
  /*
   * Matched on the CAUSE, not on any occurrence of the word.
   *
   * `e.includes('slippage')` also matches the request URL, which carries `&slippage=` on every
   * swap — so a `400 Bad Request` from the venue was reported to the user as "the price moved",
   * which is a market explanation for a malformed request. The rest of this function reads
   * reverts; this one has to read an HTTP failure, and the distinguishing thing is that the venue
   * REFUSED the price rather than refusing the call.
   */
  if (/\b(4\d\d|5\d\d) (bad request|unprocessable|internal|service unavailable)/i.test(error)) {
    return 'The venue rejected the request, so nothing was placed.';
  }
  if (e.includes('returnamount') || e.includes('min return') || /slippage (limit|exceeded|too)/.test(e))
    return 'The price moved more than your slippage limit while this was in flight.';
  if (e.includes('nonce') || e.includes('replacement transaction'))
    return 'The network moved on before this confirmed. Nothing was placed; I will retry.';
  if (e.includes('timed out') || e.includes('timeout'))
    return 'The network did not confirm in time. I will check and retry rather than send twice.';
  if (e.includes('gas') || e.includes('fee too low') || e.includes('underpriced'))
    return 'The network was congested and the fee was too low to land.';
  return 'The transaction did not go through, so nothing was placed.';
}

/**
 * Will this error happen again for the same reason, or was it weather?
 *
 * `strategy_runs.period_key` is UNIQUE, which is what makes a retry, a restart and two schedulers
 * racing all safe — and it also means a FAILED row consumes that period permanently. A user whose
 * daily buy hit a five-second RPC timeout silently lost the day, with a `failed` row nobody ever
 * revisited as the only trace.
 *
 * So a run that never reached the chain and failed for a passing reason releases its claim. The
 * classification has to be conservative in one direction only: calling something transient that is
 * really permanent costs a wasted retry; calling something permanent that was really transient
 * costs a user a trade they asked for.
 *
 * Everything the CONTRACT refuses is permanent by definition — a revoked permission, a spent cap,
 * a venue not on the allowlist and an expired policy will all refuse identically on the next tick.
 * A price that moved past the slippage limit is deliberately permanent too: it is a real market
 * answer, and hammering it inside one tick is how a bot chases a moving price.
 */
export function isTransient(error: string): boolean {
  const e = error.toLowerCase();

  // The contract's own refusals, and the venue's. Real answers, not failures to get one.
  if (/notdelegate|policyrevoked|policyexpired|venuenotallowed|dailycapexceeded|zeroamount/.test(e)) return false;
  if (/returnamountisnotenough|slippage|insufficient|exceeds the balance|transfer amount exceeds/.test(e)) return false;
  if (/venuecallfailed|no route|not tradable|cannot fill on|reverted/.test(e)) return false;

  // Nothing was obtained, rather than something being refused.
  return /timeout|timed out|did not answer|econnreset|econnrefused|etimedout|enotfound|socket hang up|network|fetch failed|502|503|504|429|rate limit|nonce|replacement transaction|upstream/.test(
    e,
  );
}

/**
 * The HTTP status a run outcome deserves — which is really the question "should the app offer a
 * Try again?"
 *
 * Every route that runs a strategy answered `failed ? 502 : 200`, and the client reads 5xx as
 * retryable by design. So a run that failed because *this chain cannot settle at all* came back
 * 502, and the screen put a **Try again** button under "This network cannot settle trades" — a
 * button that will answer the same way for as long as the deployment exists. `isRetryable`'s own
 * docblock names that as the failure it was written to prevent, and `isTransient` right above
 * already classifies `cannot fill on` as permanent. The two were simply never connected.
 *
 * 409 rather than 400: the request was well-formed and the refusal is about the state of the
 * world, which is the same reason `blocked` and `not_tradable` already use it.
 */
export function httpStatusFor(outcome: { status: string; raw?: string }): 200 | 409 | 502 {
  if (outcome.status === 'blocked') return 409;
  if (outcome.status !== 'failed') return 200;
  return isTransient(outcome.raw ?? '') ? 502 : 409;
}
