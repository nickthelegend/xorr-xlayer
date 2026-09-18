/**
 * The venues a grant names (PLAN.md 3.1).
 *
 * `SETTLEMENT_VENUES` is what the app asks the user to sign and what the safety screen shows. The SwapVM book
 * was missing from it, so no grant made through the app could ever reach the venue settlement tries second.
 *
 * And the chain it starts on: one it knows, and real money only by a deliberate decision.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const BOOK = '0x74e1283711106a5844eb20760c7cb6405933c54f';
const PROGRAMS = '0x2fbae90b836545d6a0cb947ff701c27d7b627bd1';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const venues = async () => (await import('./chains.js')).SETTLEMENT_VENUES.map((v) => v.toLowerCase());

describe('the venues a grant names', () => {
  it('include both books when this deployment has them, after the DEX router', async () => {
    vi.stubEnv('XORR_CHAIN', 'xlayer-fork');
    vi.stubEnv('AQUA_BOOK_ADDRESS', BOOK);
    vi.stubEnv('SWAPVM_BOOK_ADDRESS', PROGRAMS);
    const list = await venues();
    expect(list).toContain(BOOK);
    expect(list).toContain(PROGRAMS);
    // Uniswap v3's SwapRouter02 on X Layer (developers.uniswap.org/deployments), where the wrapped xStocks pool.
    expect(list[0]).toBe('0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca');
  });

  it('leave out a book that is not configured, or not an address', async () => {
    vi.stubEnv('XORR_CHAIN', 'xlayer-fork');
    vi.stubEnv('AQUA_BOOK_ADDRESS', '');
    vi.stubEnv('SWAPVM_BOOK_ADDRESS', 'not-an-address');
    const list = await venues();
    expect(list).not.toContain(BOOK);
    expect(list.some((v) => v === 'not-an-address')).toBe(false);
  });
});

describe('the chain this executor starts on', () => {
  it('is refused when the executor does not know it, naming the chains it does', async () => {
    vi.stubEnv('XORR_CHAIN', 'arbitrum');
    await expect(import('./chains.js')).rejects.toThrow(
      'XORR_CHAIN=arbitrum is not a chain this executor knows (xlayer, xlayer-testnet, xlayer-fork, localnet).',
    );
  });

  it('is refused where its money is real, unless ALLOW_MAINNET=yes says that was decided', async () => {
    vi.stubEnv('XORR_CHAIN', 'xlayer');
    vi.stubEnv('ALLOW_MAINNET', '');
    await expect(import('./chains.js')).rejects.toThrow(
      'Refusing to start against X Layer mainnet. Set ALLOW_MAINNET=yes only with a deliberate decision.',
    );
    vi.resetModules();
    vi.stubEnv('ALLOW_MAINNET', 'yes');
    expect((await import('./chains.js')).CHAIN_KEY).toBe('xlayer');
  });

  it.each([
    // Circle's native USDC on X Layer and on its testnet (developers.circle.com), never the bridged USDC.e.
    ['xlayer', '0xB6CEceAB302E2E4948951eE7843FC24E92933061', 'https://www.oklink.com/xlayer/tx/0xabc'],
    ['xlayer-fork', '0xB6CEceAB302E2E4948951eE7843FC24E92933061', 'fork:0xabc'],
    ['xlayer-testnet', '0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3', 'https://www.oklink.com/xlayer-test/tx/0xabc'],
    ['localnet', '0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3', 'local:0xabc'],
  ])('on %s, settles in its own USDC and shows a transaction where that chain shows it', async (key, usdc, link) => {
    vi.stubEnv('XORR_CHAIN', key);
    vi.stubEnv('ALLOW_MAINNET', key === 'xlayer' ? 'yes' : '');
    const chains = await import('./chains.js');
    expect(chains.ADDRESSES.usdc).toBe(usdc);
    expect(chains.explorerTx('0xabc')).toBe(link);
  });
});
