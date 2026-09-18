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
  it('on Base, is real money: no Test label, a deposit code, and the wallet sends', async () => {
    expect(facts(await buildFor('base'))).toEqual({
      id: 8453,
      label: 'Base',
      test: false,
      chip: 'Base',
      code: true,
      signsOnly: false,
    });
  });

  it('on Base Sepolia, is test funds, with a deposit code, and the wallet sends', async () => {
    expect(facts(await buildFor('base-sepolia'))).toEqual({
      id: 84532,
      label: 'Base Sepolia',
      test: true,
      chip: 'Test network',
      code: true,
      signsOnly: false,
    });
  });

  it.each(['base-fork', 'localnet'])(
    'on %s, a copy of Base, is a test network with no deposit code, and the wallet only signs',
    async (key) => {
      expect(facts(await buildFor(key))).toEqual({
        id: 8453,
        label: 'Base fork',
        test: true,
        chip: 'Test network',
        code: false,
        signsOnly: true,
      });
    },
  );

  it('on solana-fork, is a test network with no EVM deposit code, and the wallet only signs', async () => {
    expect(facts(await buildFor('solana-fork'))).toEqual({
      id: 8453,
      label: 'Solana fork',
      test: true,
      chip: 'Test network',
      code: false,
      signsOnly: true,
    });
  });

  it('refuses a chain the app does not know, naming the ones it does', async () => {
    await expect(buildFor('arbitrum')).rejects.toThrow(
      'EXPO_PUBLIC_XORR_CHAIN=arbitrum is not a chain this app knows (base, base-sepolia, base-fork, localnet, solana-fork, solana-devnet, solana-localnet, solana-mainnet).',
    );
  });

  it('does not take a name every object has for a chain', async () => {
    await expect(buildFor('constructor')).rejects.toThrow('is not a chain this app knows');
  });
});
