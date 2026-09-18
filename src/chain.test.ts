/**
 * The chain a build signs on, and what it tells a person about their money (src/chain.ts). Each flag follows what money on
 * the chain is, and a chain the app does not know is refused where the app is built.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function buildFor(key: string) {
  vi.stubEnv('EXPO_PUBLIC_XORR_CHAIN', key);
  vi.stubEnv('EXPO_PUBLIC_CHAIN_RPC', '');
  return import('./chain');
}

const facts = (c: typeof import('./chain')) => ({
  id: c.activeChain.id,
  label: c.chainLabel,
  test: c.testNetwork,
  chip: c.networkChip,
  code: c.depositQrWorks,
  signsOnly: c.walletSignsOnly,
});

describe('the chain a build signs on', () => {
  it('on X Layer mainnet, is real money: no Test label, a deposit code, and the wallet sends', async () => {
    expect(facts(await buildFor('xlayer'))).toEqual({
      id: 196,
      label: 'X Layer',
      test: false,
      chip: 'X Layer',
      code: true,
      signsOnly: false,
    });
  });

  it('on X Layer testnet, is test funds, with a deposit code, and the wallet sends', async () => {
    expect(facts(await buildFor('xlayer-testnet'))).toEqual({
      id: 1952,
      label: 'X Layer testnet',
      test: true,
      chip: 'Test network',
      code: true,
      signsOnly: false,
    });
  });

  it('on a fork of X Layer mainnet, is a copy: no deposit code, and the wallet only signs', async () => {
    expect(facts(await buildFor('xlayer-fork'))).toEqual({
      id: 196,
      label: 'X Layer fork',
      test: true,
      chip: 'Test network',
      code: false,
      signsOnly: true,
    });
  });

  it('on localnet, a local copy of the testnet, is a copy too', async () => {
    expect(facts(await buildFor('localnet'))).toEqual({
      id: 1952,
      label: 'X Layer local',
      test: true,
      chip: 'Test network',
      code: false,
      signsOnly: true,
    });
  });

  it('refuses a chain the app does not know, naming the ones it does', async () => {
    await expect(buildFor('base')).rejects.toThrow(
      'EXPO_PUBLIC_XORR_CHAIN=base is not a chain this app knows (xlayer, xlayer-testnet, xlayer-fork, localnet).',
    );
  });

  it('does not take a name every object has for a chain', async () => {
    await expect(buildFor('constructor')).rejects.toThrow('is not a chain this app knows');
  });
});
