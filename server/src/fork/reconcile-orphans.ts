/**
 * Take the fills a rebuilt fork no longer has back out of the executor's book (docs/qa/ENDPOINTS.md E096). What counts
 * as an orphan, what comes out and what is left for a person are all in `orphans.ts`.
 *
 * Dry run first. It asks the node about every filled run on this chain, prints each run it would take out, each it
 * would leave and why, and the exact change to `daily_spend` and each position — and then rolls all of it back. From
 * server/:
 *
 *   XORR_CHAIN=xlayer-fork FORK_RPC=<the fork's anvil RPC URL> DATABASE_URL=<that executor's Postgres URL> \
 *     npm run reconcile:orphans [-- --wallet <wallet id>]
 *
 * Then the same with `-- --apply`, which does exactly that in one transaction and commits it. A second run finds
 * nothing: the runs it took out are marked `failed` with the reason.
 *
 * All three variables must be on the command line. FORK_RPC must be the node the executor serves and DATABASE_URL that
 * executor's database, because an orphan is a transaction THIS node does not have — so they are read and checked before
 * anything that loads a `.env` is imported (`guard.ts`). It refuses any node that is not anvil, any chain that is not a
 * fork of X Layer, and any XORR_CHAIN but xlayer-fork.
 */
import { createPublicClient, http } from 'viem';
import { xLayer } from 'viem/chains';
import { assertXLayerFork } from './guard.js';

// What the command line named, read before the database module — which loads a `.env` — is.
const named = {
  XORR_CHAIN: process.env.XORR_CHAIN,
  FORK_RPC: process.env.FORK_RPC,
  DATABASE_URL: process.env.DATABASE_URL,
};

const apply = process.argv.includes('--apply');
const walletAt = process.argv.indexOf('--wallet');
const walletId = walletAt >= 0 ? process.argv[walletAt + 1] : undefined;
if (walletAt >= 0 && (!walletId || walletId.startsWith('--'))) throw new Error('--wallet needs a wallet id');

const node = named.FORK_RPC ?? '';
async function rpc(method: string): Promise<unknown> {
  const res = (await fetch(node, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
  }).then((r) => r.json())) as { result?: unknown; error?: { message: string } };
  if (res.error) throw new Error(`${method}: ${res.error.message}`);
  return res.result;
}

await assertXLayerFork(named, rpc);

// Loaded only now. A `.env` read here cannot change what was checked above: it never overrides a variable already set.
const { reconcile } = await import('./orphans.js');
const { pool } = await import('../db/index.js');
/*
 * X Layer, not Base. The guard above has just proved the node is chain 196; this client then declared 8453 to viem.
 * Reads survived it — an explicit transport does not consult `chain.id` — but everything viem derives from the chain
 * (its id, its multicall address, its formatters) was another network's, on a tool whose whole job is deciding whether
 * a transaction is really absent from THIS one. A leftover from before the X Layer migration.
 */
const chain = createPublicClient({ chain: xLayer, transport: http(node) });
const client = await pool.connect();
try {
  await reconcile({ client, chain, apply, walletId, out: (line) => console.log(line) });
} finally {
  client.release();
  await pool.end();
}
