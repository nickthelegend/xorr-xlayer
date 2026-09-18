/**
 * The one condition the app refuses to keep running under.
 */
import { describe, expect, it } from 'vitest';
import { compareChains } from './chainMatch';

describe('agreement', () => {
  it('is a match when both sides name the same chain', () => {
    expect(compareChains({ app: 'xlayer-fork', server: 'xlayer-fork' })).toEqual({ state: 'match', chain: 'xlayer-fork' });
  });

  it('is unknown, never a mismatch, when the executor did not say', () => {
    // An executor older than the `chain` field on `/health`, or one that could not be read at all. Blocking
    // the app on the absence of an answer would take the kill switch away from everyone on that deployment.
    for (const server of [undefined, null, '', '   ']) {
      expect(compareChains({ app: 'xlayer-fork', server }), String(server)).toEqual({ state: 'unknown' });
    }
  });
});

describe('disagreement', () => {
  it('names both sides and says nothing was sent', () => {
    const m = compareChains({
      app: 'xlayer-testnet',
      server: 'xlayer-fork',
      appName: 'X Layer testnet',
      serverName: 'a fork of X Layer mainnet',
      appMoney: 'test',
      serverMoney: 'copy',
    });
    expect(m.state).toBe('mismatch');
    if (m.state !== 'mismatch') return;
    expect(m).toMatchObject({ app: 'xlayer-testnet', server: 'xlayer-fork', realMoney: false });
    expect(m.detail).toContain('X Layer testnet');
    expect(m.detail).toContain('a fork of X Layer mainnet');
    expect(m.detail).toContain('Nothing has been sent.');
  });

  it('calls it real money when either side is a mainnet', () => {
    const forkAppMainnetServer = compareChains({
      app: 'xlayer-fork',
      server: 'xlayer',
      appMoney: 'copy',
      serverMoney: 'real',
    });
    expect(forkAppMainnetServer).toMatchObject({ state: 'mismatch', realMoney: true });
    if (forkAppMainnetServer.state === 'mismatch') {
      expect(forkAppMainnetServer.detail).toContain('real money');
    }
    expect(compareChains({ app: 'xlayer', server: 'xlayer-fork', appMoney: 'real', serverMoney: 'copy' })).toMatchObject({
      realMoney: true,
    });
  });

  it('treats a side whose money it cannot name as real, never as a test', () => {
    // `moneyOn` on the executor does the same. Telling someone their mainnet funds are a copy is the one
    // direction this must never get wrong.
    expect(compareChains({ app: 'xlayer-fork', server: 'something-new', appMoney: 'copy' })).toMatchObject({
      realMoney: true,
    });
  });

  it('never calls a fork and a mainnet a match, though both answer the same chain id', () => {
    // A fork of X Layer IS chain 196. Comparing ids would pass exactly the case that matters most.
    expect(compareChains({ app: 'xlayer-fork', server: 'xlayer' }).state).toBe('mismatch');
    expect(compareChains({ app: 'localnet', server: 'xlayer-fork' }).state).toBe('mismatch');
  });

  it('falls back to the raw key where no name was given, rather than inventing one', () => {
    const m = compareChains({ app: 'xlayer-fork', server: 'xlayer-testnet' });
    if (m.state !== 'mismatch') throw new Error('expected a mismatch');
    expect(m.detail).toContain('xlayer-fork');
    expect(m.detail).toContain('xlayer-testnet');
  });
});
