/**
 * What money on each chain is: the one fact every guard that must never hand out real value reads.
 *
 * Those guards compared chain keys. The mainnet guard and the faucet named one chain key, and the gas drip one chain's own state, so a
 * mainnet added under any other key would have started without ALLOW_MAINNET and, with a faucet key set, been sent real
 * ETH from it. A chain says what its money is here, where it is added, and a key this list does not have is real: nothing
 * is handed out on a guess.
 *
 *   real — a mainnet. Nothing is handed out, and the executor starts on one only with ALLOW_MAINNET=yes.
 *   test — a public test network. Its funds are test funds.
 *   copy — a local copy of another chain (anvil). Balances there are set, not sent.
 *
 * The app keeps the same three words for the chain it signs on (`src/chain.ts`).
 */
export type Money = 'real' | 'test' | 'copy';

const FACTS = {
  xlayer: { money: 'real', name: 'X Layer mainnet' },
  'xlayer-testnet': { money: 'test', name: 'X Layer testnet' },
  'xlayer-fork': { money: 'copy', name: 'a fork of X Layer mainnet' },
  localnet: { money: 'copy', name: 'a local copy of X Layer testnet' },
} as const satisfies Record<string, { money: Money; name: string }>;

/** Every chain this executor knows. */
export type KnownChain = keyof typeof FACTS;

export const KNOWN_CHAINS = Object.keys(FACTS) as KnownChain[];

export function isKnownChain(key: string): key is KnownChain {
  return Object.prototype.hasOwnProperty.call(FACTS, key);
}

/** What money on `key` is. A key this list does not know is real. */
export function moneyOn(key: string): Money {
  return isKnownChain(key) ? FACTS[key].money : 'real';
}

/** The network as a sentence names it: "Base mainnet", "a fork of Base mainnet". A key this list does not know is itself. */
export function networkName(key: string): string {
  return isKnownChain(key) ? FACTS[key].name : key;
}
