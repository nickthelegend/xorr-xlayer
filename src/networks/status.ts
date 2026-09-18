/**
 * What a network is doing right now, from what its executor answered.
 *
 * Pure, so the rules are tested as they run: whether it is up is the System screen's rule (a critical dependency that is
 * not up makes it degraded, and a non-critical one does not), whether trades settle is `/market/tradable` being non-empty,
 * and whether idle cash can earn is `/yield/supply` saying so. A read that failed leaves its answer unknown — never a
 * no — and an executor serving a different chain than its deployment names is said, not reconciled.
 */
import type { Health, TradableToken } from '@/data/system';
import type { Deployment } from './deployments';

export type NetworkRead = {
  /** `/health`, or why it could not be read. */
  health: Health | Error;
  /** `/market/tradable`: what a trade can settle in here, empty where nothing fills. */
  tradable: TradableToken[] | Error;
  /** `/yield/supply`, as far as whether idle cash can be supplied here. */
  yieldSupply: { availableHere?: boolean } | null | Error;
};

export type NetworkState = 'up' | 'degraded' | 'down' | 'unreachable';

export type NetworkStatus = {
  state: NetworkState;
  /** Why it could not be reached, as the read failed. */
  reason?: string;
  block?: number;
  /** The chain the executor says it serves. */
  chain?: string;
  /** The executor serves another chain than its deployment names. */
  mismatch: boolean;
  /** `fill` where a trade settles, `watch` where none does, undefined where that could not be read. */
  trades?: 'fill' | 'watch';
  /** Whether idle cash can be supplied here, undefined where that could not be read. */
  earn?: boolean;
  version?: string;
};

/** The block the executor's RPC dependency last reported, where `/health` already says it. */
export function blockOf(health: Health): number | undefined {
  const rpc = health.dependencies.find((d) => d.name === 'rpc');
  const match = /block (\d+)/.exec(rpc?.detail ?? '');
  return match ? Number(match[1]) : undefined;
}

export function networkStatus(deployment: Deployment, read: NetworkRead): NetworkStatus {
  const { health, tradable, yieldSupply } = read;
  const trades = tradable instanceof Error ? undefined : tradable.length > 0 ? 'fill' : 'watch';
  const earn = yieldSupply instanceof Error || yieldSupply === null ? undefined : yieldSupply.availableHere;

  if (health instanceof Error) {
    return { state: 'unreachable', reason: health.message, mismatch: false, trades, earn };
  }

  const criticalDown = health.dependencies.some((d) => d.critical && d.status !== 'up');
  const state: NetworkState = health.status === 'down' ? 'down' : criticalDown ? 'degraded' : 'up';
  return {
    state,
    block: blockOf(health),
    chain: health.chain,
    mismatch: health.chain !== deployment.key,
    trades,
    earn,
    version: health.version,
  };
}
