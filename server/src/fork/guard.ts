/**
 * The chain a fork script will touch, checked before anything else is loaded.
 *
 * On a real chain a transaction that cannot be found is an RPC problem, never a reason to rewrite a book, so
 * `reconcile-orphans.ts` refuses every chain but an anvil fork of Base before it reads one.
 *
 * This module imports nothing, on purpose. The database module reads a `.env` as it loads, and a variable a `.env`
 * supplied is not one the person running the script named. So the script checks what its command line named first, and
 * loads the database module only afterwards — when a `.env` can no longer change those three, because it never
 * overrides a variable already set.
 */

const XLAYER_CHAIN_ID = 196;

/** The three variables that say which executor a fork script rewrites. */
export type NamedTargets = {
  XORR_CHAIN?: string | undefined;
  FORK_RPC?: string | undefined;
  DATABASE_URL?: string | undefined;
};

/**
 * Refuse anything but an anvil fork of Base, before a book is read.
 *
 * `rpc` is one JSON-RPC call to the node that will be asked about transactions. The executor's own defaults — a local
 * node, a local database — are not accepted either: an orphan is a transaction THIS node lacks, so the node and the
 * database must both be named on purpose.
 */
export async function assertXLayerFork(env: NamedTargets, rpc: (method: string) => Promise<unknown>): Promise<void> {
  if (env.XORR_CHAIN !== 'xlayer-fork') {
    throw new Error(
      `XORR_CHAIN=${env.XORR_CHAIN ?? '(unset)'}: this reconciles an xlayer-fork executor only, and refuses every other chain.`,
    );
  }
  if (!env.FORK_RPC) throw new Error('FORK_RPC is required: the fork node the executor serves, named on purpose.');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required: that executor’s database, named on purpose.');
  const node = String(await rpc('web3_clientVersion'));
  if (!node.toLowerCase().startsWith('anvil')) {
    throw new Error(`The node answers as "${node}", not anvil. A missing transaction on a real chain is not an orphan.`);
  }
  const chainId = Number(await rpc('eth_chainId'));
  if (chainId !== XLAYER_CHAIN_ID) throw new Error(`The node is chain ${chainId}, not a fork of X Layer (${XLAYER_CHAIN_ID}).`);
}
