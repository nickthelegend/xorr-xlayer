/**
 * Is this build talking to an executor for the same chain it signs on?
 *
 * `src/chain.ts` says, in as many words, that the app and the executor "have to agree about which chain they
 * are on, and the only way to be sure is for both to read it from the same name in the same `.env`". Nothing
 * checked that they did. Two names in two files agreeing by convention is not agreement, and the ways they
 * come apart are ordinary: a build made for Base Sepolia with `EXPO_PUBLIC_API_URL` still pointed at the
 * fork executor, a fork executor redeployed onto mainnet, a web bundle cached across a redeploy.
 *
 * What goes wrong when they do is not subtle, and it is not recoverable by anything the user does:
 *
 *   - The grant is signed on one chain and read on another, so the bot has permission where nobody is
 *     trading and none where it is. `/safety` then reports NOT GRANTED over a live grant.
 *   - Balances, positions and prices are the executor's chain; the wallet the screens show is this one's.
 *     Every number on screen is about a different chain than the one the buttons act on.
 *   - Worst: one of the two may be REAL money. A fork build pointed at a mainnet executor shows copy-chain
 *     balances beside buttons that spend actual funds.
 *
 * So this is the one condition in the app that earns a screen nobody can dismiss. Everything else degrades —
 * an unreachable executor shows a banner and leaves the app usable, because the kill switch is on chain and
 * has to keep working. A chain mismatch is different in kind: there is no correct thing for any screen to
 * show, and the kill switch would be signed on the wrong chain too.
 *
 * Pure, and keyed on the chain KEY rather than on a chain id, because the key is the contract. Two of the
 * four keys answer the same `eth_chainId` as Base — a fork of Base is 8453 — so an id comparison would call
 * a fork build talking to a mainnet executor a match, which is precisely the dangerous case.
 */

/** The three words both sides use for what money on a chain is (`server/src/evm/money.ts`, `src/chain.ts`). */
export type Money = 'real' | 'test' | 'copy';

export type ChainMatch =
  | { state: 'match'; chain: string }
  /**
   * The executor did not say which chain it serves.
   *
   * An executor older than the `chain` field on `/health`, or a health check that could not be read at all.
   * Never a hard error: blocking the whole app on the ABSENCE of an answer would take the kill switch away
   * from every user of an older deployment, which is the opposite of what this exists to protect.
   */
  | { state: 'unknown' }
  | {
      state: 'mismatch';
      /** The chain this build signs on. */
      app: string;
      /** The chain the executor answered with. */
      server: string;
      /** One line, for the top of the screen. */
      headline: string;
      /** What is actually wrong, and what it means for the money. */
      detail: string;
      /** True where either side is a mainnet, which makes this a money problem and not only a wiring one. */
      realMoney: boolean;
    };

/** How each side is named in a sentence. An unknown key is itself: a guess would be worse than the raw name. */
export function chainSentenceName(key: string, name?: string): string {
  return name ?? key;
}

export function compareChains(input: {
  /** This build's chain key, from `EXPO_PUBLIC_XORR_CHAIN`. */
  app: string;
  /** What `/health` answered in `chain`, or undefined where it did not answer or did not say. */
  server: string | undefined | null;
  /** How each side is named to a person, where the caller knows. */
  appName?: string;
  serverName?: string;
  /** What money on each side is, where the caller knows. Absent is not "test": see `realMoney` below. */
  appMoney?: Money;
  serverMoney?: Money;
}): ChainMatch {
  const { app, server } = input;
  if (!server || !server.trim()) return { state: 'unknown' };
  if (server === app) return { state: 'match', chain: app };

  const here = chainSentenceName(app, input.appName);
  const there = chainSentenceName(server, input.serverName);
  /*
   * A side whose money we cannot name is treated as REAL, exactly as `moneyOn` does on the executor: nothing
   * is reassured on a guess. The consequence of getting this wrong in the other direction is telling someone
   * their mainnet funds are a test copy.
   */
  const realMoney = (input.appMoney ?? 'real') === 'real' || (input.serverMoney ?? 'real') === 'real';

  return {
    state: 'mismatch',
    app,
    server,
    headline: 'This app and its server are on different chains.',
    detail: realMoney
      ? `The app signs on ${here} and the server is on ${there}. One of those is real money, so nothing here ` +
        'can be trusted to be about the other: balances, positions and permissions would all be read from one ' +
        'chain and acted on the other. Nothing has been sent.'
      : `The app signs on ${here} and the server is on ${there}. Balances, positions and permissions would be ` +
        'read from one chain and acted on the other, so none of them would mean what they say. Nothing has ' +
        'been sent.',
    realMoney,
  };
}
