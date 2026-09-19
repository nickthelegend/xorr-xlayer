/**
 * Every network xorr is deployed on, and the one place a new one is added.
 *
 * A build is made for one chain at a time — its executor, RPC and pinned contract are inlined when it is built
 * (`scripts/build-web.mjs`) — but the product is meant to run on whichever chain a hackathon asks for. What is deployed
 * where was known only to the deploy scripts. This names each deployment and the executor that serves it; everything a
 * screen says about one (whether it is up, its block, its contract, whether trades settle there) is read live from that
 * executor. No status or capability is ever written down here.
 *
 * A new chain is a new row: the chain key its executor serves (`XORR_CHAIN`), the id its chain answers `eth_chainId`
 * with, the executor's address, and a public explorer where one has seen that chain.
 */
import { API_BASE } from '@/data/apiBase';

export type Deployment = {
  /** The chain key the executor serves, as its `/health` names it. */
  key: string;
  /** How the network is named to a person. */
  name: string;
  /** What the chain answers `eth_chainId` with. A fork of X Layer answers X Layer's own id, 196. */
  chainId: number;
  /** The executor that serves it. */
  api: string;
  /** A public block explorer for it, or null where no public explorer has seen the chain, as on a fork. */
  explorer: string | null;
  /** Nothing on it is real money. */
  test: boolean;
};

/**
 * The X Layer executors, as deployed 2026-09-19 (Railway project `xorr-xlayer`). The fork is where fills are real — a
 * copy of X Layer mainnet's state, so it answers chain id 196 and no public explorer has seen its own transactions; the
 * testnet serves the source-verified contracts in `contracts/deployments/xlayer-testnet.json`, and nothing fills there.
 */
export const DEPLOYMENTS: readonly Deployment[] = [
  {
    key: 'xlayer-fork',
    name: 'X Layer (fork of mainnet)',
    chainId: 196,
    api: 'https://executor-fork-production-2db8.up.railway.app',
    explorer: null,
    test: true,
  },
  {
    key: 'xlayer-testnet',
    name: 'X Layer testnet',
    chainId: 1952,
    api: 'https://executor-testnet-production.up.railway.app',
    explorer: 'https://www.oklink.com/xlayer-test',
    test: true,
  },
];

const bare = (url: string) => url.replace(/\/+$/, '');

/**
 * The deployment a chain key names, if xorr is deployed on it.
 *
 * `list` is for tests, which pin the matching rule against rows of their own.
 */
export function deploymentFor(
  key: string | undefined,
  list: readonly Deployment[] = DEPLOYMENTS,
): Deployment | undefined {
  return key ? list.find((d) => d.key === key) : undefined;
}

/**
 * The deployment this build talks to, matched by its executor's address.
 *
 * Not by chain key: two builds for the same chain can point at different executors, and naming the wrong one as "this
 * app" would put another executor's facts under it. A build no deployment serves — a developer's Metro against a local
 * executor — has none.
 */
export function thisDeployment(
  apiBase: string = API_BASE,
  list: readonly Deployment[] = DEPLOYMENTS,
): Deployment | undefined {
  return list.find((d) => bare(d.api) === bare(apiBase));
}
