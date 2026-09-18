/**
 * The venues a grant names (PLAN.md 3.1).
 *
 * `SETTLEMENT_VENUES` is what the app asks the user to sign and what the safety screen shows: every contract the
 * delegation may call on this chain, and nothing without code behind it. On X Layer that is Uniswap v3's router and, where
 * mainnet state is, OKX DEX's router and the approval contract it pulls through (`spendVia`).
 *
 * And the chain it starts on: one it knows, and real money only by a deliberate decision.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Uniswap v3's SwapRouter02 on X Layer (developers.uniswap.org/deployments), where the wrapped xStocks pool. */
const UNISWAP_ROUTER = '0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca';
/** OKX DEX's router on X Layer, and its approval contract. */
const OKX_ROUTER = '0x7c5bee2a8091c3ef39072f64f18fac913060aeaf';
const OKX_SPENDER = '0x8b773d83bc66be128c60e07e17c8901f7a64f000';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const venues = async () => (await import('./chains.js')).SETTLEMENT_VENUES.map((v) => v.toLowerCase());

describe('the venues a grant names', () => {
  it("on mainnet's state, are the Uniswap router first, then OKX DEX's router and approval contract", async () => {
    vi.stubEnv('XORR_CHAIN', 'xlayer-fork');
    vi.stubEnv('OKX_DEX_ROUTER', '');
    vi.stubEnv('OKX_APPROVE_SPENDER', '');
    expect(await venues()).toEqual([UNISWAP_ROUTER, OKX_ROUTER, OKX_SPENDER]);
  });

  it('on the testnet, which has no DEX, are none — never an address with no code there', async () => {
    vi.stubEnv('XORR_CHAIN', 'xlayer-testnet');
    expect(await venues()).toEqual([]);
  });

  it('ignore an OKX override that is not an address, keeping the checked default', async () => {
    vi.stubEnv('XORR_CHAIN', 'xlayer-fork');
    vi.stubEnv('OKX_DEX_ROUTER', 'not-an-address');
    vi.stubEnv('OKX_APPROVE_SPENDER', '0x1234');
    const list = await venues();
    expect(list).toEqual([UNISWAP_ROUTER, OKX_ROUTER, OKX_SPENDER]);
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
