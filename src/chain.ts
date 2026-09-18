/**
 * Which chain the APP signs on — X Layer (2026-09-18).
 *
 * Every transaction a PERSON signs — the delegation grant, the ERC-20 approvals, a withdrawal — goes to the chain named
 * here, and the executor settles on the chain named in `server/src/evm/chains.ts`. They must agree, so both read the same
 * name from the same `.env`: `EXPO_PUBLIC_XORR_CHAIN` here, `XORR_CHAIN` there. When they did not (a build pointed at one
 * network, its executor at another), the grant landed where nobody was trading and the approvals went with it.
 *
 * X Layer is OKX's EVM chain, gas paid in OKB:
 *   xlayer          — mainnet, chain 196. Real money.
 *   xlayer-testnet  — the public testnet, chain 1952. Test funds.
 *   xlayer-fork     — an anvil fork of mainnet: the real xStocks, USDC and DEX state, fills that are genuine EVM execution,
 *                     and nothing that is real money.
 *   localnet        — an anvil copy of the testnet on this machine.
 */
import { xLayer, xLayerTestnet } from 'viem/chains';
import { isAddress, type Address, type Chain } from 'viem';

export type ChainKey = 'xlayer' | 'xlayer-testnet' | 'xlayer-fork' | 'localnet';

/**
 * What money on each chain is, in the executor's three words (`server/src/evm/money.ts`): real on a mainnet, test funds on
 * a public test network, a copy on a fork. What this file tells a person about their money follows it, never a key.
 */
const MONEY: Record<ChainKey, 'real' | 'test' | 'copy'> = {
  xlayer: 'real',
  'xlayer-testnet': 'test',
  'xlayer-fork': 'copy',
  localnet: 'copy',
};

const ASKED = process.env.EXPO_PUBLIC_XORR_CHAIN ?? 'xlayer-testnet';

/* A chain this app does not know is refused where the app is built, rather than signed on a guess under the wrong name. */
if (!Object.prototype.hasOwnProperty.call(MONEY, ASKED)) {
  throw new Error(
    `EXPO_PUBLIC_XORR_CHAIN=${ASKED} is not a chain this app knows (${Object.keys(MONEY).join(', ')}). ` +
      'Add it here, as the executor adds it to server/src/evm/money.ts.',
  );
}

export const CHAIN_KEY = ASKED as ChainKey;

/**
 * Every chain this app knows, which must be every chain the executor knows.
 *
 * `server/src/evm/chain-agreement.test.ts` holds the two lists to each other: a chain the executor can be started on and
 * the app cannot be built for is a deployment nobody can reach from the product.
 */
export const CHAIN_KEYS = Object.keys(MONEY) as ChainKey[];

/** What money on any chain is, not only this build's. A key this app does not know is real: nothing is reassured on a guess. */
export function moneyOnChain(key: string): 'real' | 'test' | 'copy' {
  return Object.prototype.hasOwnProperty.call(MONEY, key) ? MONEY[key as ChainKey] : 'real';
}

const money = MONEY[CHAIN_KEY];

/**
 * What money on the chain this build signs on is, in the executor's own three words.
 *
 * Exported for `net/chainMatch.ts`, which has to say whether a disagreement between this build and its executor is a
 * wiring problem or a money one. `testNetwork` folds `test` and `copy` into one boolean, and that sentence needs which.
 */
export const chainMoney: 'real' | 'test' | 'copy' = money;

/** How this build's chain is named inside a sentence — the names `server/src/evm/money.ts` writes. */
const SENTENCE_NAMES: Record<ChainKey, string> = {
  xlayer: 'X Layer mainnet',
  'xlayer-testnet': 'X Layer testnet',
  'xlayer-fork': 'a fork of X Layer mainnet',
  localnet: 'a local copy of X Layer testnet',
};

export const chainSentenceName = SENTENCE_NAMES[CHAIN_KEY];

/** Any chain's sentence name, for the screens that talk about a chain other than this build's. */
export function chainSentenceNameOf(key: string): string {
  return Object.prototype.hasOwnProperty.call(SENTENCE_NAMES, key) ? SENTENCE_NAMES[key as ChainKey] : key;
}

/**
 * A fork of X Layer IS X Layer — same id, same deployed contracts, a different node. So the chain is X Layer with its RPC
 * replaced, as the executor does it; building it from anything else leaves viem without Multicall3, and it silently reads
 * zeros.
 */
function withRpc(chain: Chain, rpc: string | undefined): Chain {
  if (!rpc) return chain;
  return { ...chain, rpcUrls: { default: { http: [rpc] }, public: { http: [rpc] } } };
}

const RPC = process.env.EXPO_PUBLIC_CHAIN_RPC || undefined;
const LOCAL_ANVIL = 'http://127.0.0.1:8545';

/** Each chain as viem knows it. A record, so a chain added to `MONEY` cannot be missing here. */
const CHAINS: Record<ChainKey, () => Chain> = {
  xlayer: () => withRpc(xLayer, RPC),
  'xlayer-testnet': () => withRpc(xLayerTestnet, RPC),
  'xlayer-fork': () => withRpc({ ...xLayer, name: 'X Layer fork' }, RPC ?? LOCAL_ANVIL),
  localnet: () => withRpc({ ...xLayerTestnet, name: 'X Layer local' }, RPC ?? LOCAL_ANVIL),
};

export const activeChain: Chain = CHAINS[CHAIN_KEY]();

/**
 * Every chain the wallet may be asked to switch to. The active one first: Privy offers the list, and a person shown two
 * X Layers has to guess. The other X Layer stays available so a wallet funded there is still readable.
 */
export const supportedChains: Chain[] =
  activeChain.id === xLayer.id ? [activeChain, xLayerTestnet] : [activeChain, xLayer];

const LABELS: Record<ChainKey, string> = {
  xlayer: 'X Layer',
  'xlayer-testnet': 'X Layer testnet',
  'xlayer-fork': 'X Layer fork',
  localnet: 'X Layer local',
};

/** For the screens that name the network to the user. */
export const chainLabel = LABELS[CHAIN_KEY];

/** A network whose money is not real is for testing: nothing on it is real money. */
export const testNetwork = money !== 'real';

/**
 * The one place a money screen shows the network: a small chip on Deposit, Send and Fund. On a network whose money is not
 * real it says only "Test network"; where money is real it names the chain, because that is where a deposit must be sent.
 */
export const networkChip = testNetwork ? 'Test network' : chainLabel;

/**
 * Where a transaction the USER signs is broadcast (PLAN.md 4.1).
 *
 * Privy's embedded wallet previews and broadcasts through its own RPC for a chain it knows, and a fork of X Layer is chain
 * 196 — indistinguishable from real X Layer, where the wallet holds nothing, so every user-signed transaction would be
 * simulated against the wrong state. On a copy the wallet only SIGNS (nonce, gas and fees read from the fork) and the app
 * broadcasts to the fork itself (`src/wallet/userSigning.ts`). On mainnet and testnet the wallet sends.
 *
 * The bot's own trades never depend on this: the executor signs with its delegate key against the RPC it is given.
 */
export const walletSignsOnly = money === 'copy';

/**
 * Can a deposit code name the chain this build is on?
 *
 * A deposit code encodes `ethereum:<address>@<chainId>` (EIP-681), and a phone wallet that scans it opens on that chain
 * id. A copy of a chain carries the id of the chain it copies — a fork of X Layer is 196 — so its code would open a phone
 * wallet on real X Layer, where a transfer is real money sent to an address this build never reads. No copy has a code.
 */
export const depositQrWorks = money !== 'copy';

/** Said where the code would be. */
export const depositQrNote =
  money === 'copy' ? 'A copy of X Layer. Test funds only.' : 'Test network. Use test funds.';

/**
 * The delegation contract this build trusts, when the build pinned one (FEATURES.md #24).
 *
 * `scripts/build-web.mjs` writes it only after the executor it builds for, the deployment's own record and the chain all
 * agree on it. A grant refuses any other contract, and a stop can go there without asking the executor
 * (`src/wallet/delegationChain.ts`). A build that did not pin one pins nothing, and grants and stops still check the chain.
 */
const PINNED = process.env.EXPO_PUBLIC_PINNED_DELEGATION;
export const pinnedDelegation: Address | undefined = PINNED && isAddress(PINNED) ? PINNED : undefined;
