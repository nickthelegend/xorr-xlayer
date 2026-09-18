/**
 * The app and the executor have to mean the same thing by a chain key.
 *
 * `src/chain.ts` says so in as many words — "the app and the executor have to agree about which chain they
 * are on, and the only way to be sure is for both to read it from the same name in the same `.env`" — and
 * until now nothing checked it. Two lists in two files agreeing by convention is not agreement.
 *
 * The app's runtime check (`src/net/chainMatch.ts`) catches a build pointed at the wrong executor. This
 * catches the thing that check cannot: a chain added to one side's vocabulary and not the other's, where the
 * app would compare a key it does not know against one it does and be unable to say anything useful about
 * either.
 *
 * The executor keeps that vocabulary in one registry, `evm/money.ts`: every chain it settles on is X Layer or a copy of
 * it (2026-09-18). The Solana clusters it once kept beside it went with the Solana code.
 */
import { describe, expect, it } from 'vitest';
import { KNOWN_CHAINS, isKnownChain, moneyOn, networkName } from './money.js';

const app = await import('@/chain');

/** Every chain key the executor can be started on. */
const EXECUTOR_CHAINS: string[] = [...KNOWN_CHAINS];

const executorMoneyOn = (key: string) => moneyOn(key);
const executorNameOf = (key: string) => networkName(key);

describe('the two sides know the same chains', () => {
  it('the app knows every chain the executor does', () => {
    // A key the executor can be started on that the app refuses to build for is a deployment nobody can
    // reach from the product.
    for (const key of EXECUTOR_CHAINS) {
      expect(app.CHAIN_KEYS, key).toContain(key);
    }
  });

  it('and the executor knows every chain the app does', () => {
    for (const key of app.CHAIN_KEYS) {
      expect(isKnownChain(key), key).toBe(true);
    }
  });
});

describe('and the same facts about them', () => {
  it('agrees on what money on each chain is', () => {
    // The word that decides whether anything is handed out, on either side. `src/chain.ts` mirrors
    // `evm/money.ts` for exactly this reason; a disagreement here is a build
    // calling a mainnet a test net.
    for (const key of EXECUTOR_CHAINS) {
      expect(app.moneyOnChain(key), key).toBe(executorMoneyOn(key));
    }
  });

  it('names each chain the same way inside a sentence', () => {
    // A mismatch screen names both sides. Two vocabularies would have it say "X Layer fork" of one and "a fork
    // of X Layer mainnet" of the other, for the same chain.
    for (const key of EXECUTOR_CHAINS) {
      expect(app.chainSentenceNameOf(key), key).toBe(executorNameOf(key));
    }
  });
});
