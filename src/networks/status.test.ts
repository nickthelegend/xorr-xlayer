/**
 * A network's status is what its executor answered, read by the same rule the System screen uses.
 */
import { describe, expect, it } from 'vitest';
import type { Health } from '@/data/system';
import { DEPLOYMENTS } from './deployments';
import { blockOf, networkStatus } from './status';

const fork = DEPLOYMENTS.find((d) => d.key === 'base-fork')!;

const health = (over: Partial<Health> = {}): Health => ({
  ok: true,
  status: 'degraded',
  chain: 'base-fork',
  version: 'f4dda8a151809f4d9a4a2e88ec21e7b60829a85f',
  delegation: '0xc32dd8aeed3035d46c7c82a351fc5522c9d463f4',
  uptimeSec: 60,
  dependencies: [
    { name: 'postgres', status: 'up', critical: true, detail: 'responded' },
    { name: 'rpc', status: 'up', critical: true, detail: 'base-fork at block 51242381' },
    { name: 'subgraph', status: 'degraded', critical: false, detail: 'indexing another deployment' },
  ],
  ...over,
});

const tokens = [{ symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 }];

describe('networkStatus', () => {
  it('is up when every critical dependency is, whatever a non-critical one says, and reads the block', () => {
    const s = networkStatus(fork, { health: health(), tradable: tokens, yieldSupply: { availableHere: true } });
    expect(s).toMatchObject({ state: 'up', block: 51242381, chain: 'base-fork', mismatch: false, trades: 'fill', earn: true });
  });

  it('is degraded when a critical dependency is not up, and down when the executor says so', () => {
    const rpcDown = health({
      dependencies: [
        { name: 'postgres', status: 'up', critical: true },
        { name: 'rpc', status: 'down', critical: true, detail: 'no answer in 5000ms' },
      ],
    });
    expect(networkStatus(fork, { health: rpcDown, tradable: tokens, yieldSupply: null }).state).toBe('degraded');
    expect(networkStatus(fork, { health: health({ status: 'down' }), tradable: tokens, yieldSupply: null }).state).toBe('down');
  });

  it('says where nothing fills, and leaves what could not be read unknown rather than no', () => {
    const watch = networkStatus(fork, { health: health(), tradable: [], yieldSupply: { availableHere: false } });
    expect(watch).toMatchObject({ trades: 'watch', earn: false });

    const unread = networkStatus(fork, { health: health(), tradable: new Error('timed out'), yieldSupply: new Error('502') });
    expect(unread.trades).toBeUndefined();
    expect(unread.earn).toBeUndefined();
  });

  it('is unreachable, with the reason, when its health could not be read, and keeps what the other reads said', () => {
    const s = networkStatus(fork, { health: new Error('The executor did not answer within 15s.'), tradable: tokens, yieldSupply: null });
    expect(s).toMatchObject({ state: 'unreachable', reason: 'The executor did not answer within 15s.', trades: 'fill' });
    expect(s.block).toBeUndefined();
  });

  it('flags an executor serving another chain than its deployment names', () => {
    expect(networkStatus(fork, { health: health({ chain: 'base-sepolia' }), tradable: [], yieldSupply: null }).mismatch).toBe(true);
  });
});

describe('blockOf', () => {
  it('reads nothing when the RPC detail carries no block', () => {
    expect(blockOf(health({ dependencies: [{ name: 'rpc', status: 'down', critical: true, detail: 'no answer' }] }))).toBeUndefined();
  });
});
