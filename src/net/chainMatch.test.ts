/**
 * The one condition the app refuses to keep running under.
 */
import { describe, expect, it } from 'vitest';
import { compareChains } from './chainMatch';

describe('agreement', () => {
  it('is a match when both sides name the same chain', () => {
    expect(compareChains({ app: 'base-fork', server: 'base-fork' })).toEqual({ state: 'match', chain: 'base-fork' });
  });

  it('is unknown, never a mismatch, when the executor did not say', () => {
    // An executor older than the `chain` field on `/health`, or one that could not be read at all. Blocking
    // the app on the absence of an answer would take the kill switch away from everyone on that deployment.
    for (const server of [undefined, null, '', '   ']) {
      expect(compareChains({ app: 'base-fork', server }), String(server)).toEqual({ state: 'unknown' });
    }
  });
});

describe('disagreement', () => {
  it('names both sides and says nothing was sent', () => {
    const m = compareChains({
      app: 'base-sepolia',
      server: 'base-fork',
      appName: 'Base Sepolia',
      serverName: 'a fork of Base mainnet',
      appMoney: 'test',
      serverMoney: 'copy',
    });
    expect(m.state).toBe('mismatch');
    if (m.state !== 'mismatch') return;
    expect(m).toMatchObject({ app: 'base-sepolia', server: 'base-fork', realMoney: false });
    expect(m.detail).toContain('Base Sepolia');
    expect(m.detail).toContain('a fork of Base mainnet');
    expect(m.detail).toContain('Nothing has been sent.');
  });

  it('calls it real money when either side is a mainnet', () => {
    const forkAppMainnetServer = compareChains({
      app: 'base-fork',
      server: 'base',
      appMoney: 'copy',
      serverMoney: 'real',
    });
    expect(forkAppMainnetServer).toMatchObject({ state: 'mismatch', realMoney: true });
    if (forkAppMainnetServer.state === 'mismatch') {
      expect(forkAppMainnetServer.detail).toContain('real money');
    }
    expect(compareChains({ app: 'base', server: 'base-fork', appMoney: 'real', serverMoney: 'copy' })).toMatchObject({
      realMoney: true,
    });
  });

  it('treats a side whose money it cannot name as real, never as a test', () => {
    // `moneyOn` on the executor does the same. Telling someone their mainnet funds are a copy is the one
    // direction this must never get wrong.
    expect(compareChains({ app: 'base-fork', server: 'something-new', appMoney: 'copy' })).toMatchObject({
      realMoney: true,
    });
  });

  it('never calls a fork and a mainnet a match, though both answer the same chain id', () => {
    // A fork of Base IS chain 8453. Comparing ids would pass exactly the case that matters most.
    expect(compareChains({ app: 'base-fork', server: 'base' }).state).toBe('mismatch');
    expect(compareChains({ app: 'localnet', server: 'base-fork' }).state).toBe('mismatch');
  });

  it('falls back to the raw key where no name was given, rather than inventing one', () => {
    const m = compareChains({ app: 'base-fork', server: 'base-sepolia' });
    if (m.state !== 'mismatch') throw new Error('expected a mismatch');
    expect(m.detail).toContain('base-fork');
    expect(m.detail).toContain('base-sepolia');
  });
});
