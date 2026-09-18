/**
 * What a route delivers, read from a dry run (PLAN.md X77): the call that will carry the leg, as it will be sent, with a
 * floor of one — and the router's first word read back as the amount delivered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters } from 'viem';

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const ROUTER = '0x111111125421cA6dc452d289314280a0f8842A65';
const DELEGATION = '0xc32dd8aeed3035d46c7c82a351fc5522c9d463f4';

const h = vi.hoisted(() => ({ chain: 'xlayer-fork', simulateContract: vi.fn() }));
vi.mock('./chains.js', () => ({
  get CHAIN_KEY() {
    return h.chain;
  },
}));
vi.mock('./client.js', () => ({
  delegateAccount: { address: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5' },
  publicClient: { simulateContract: (...a: unknown[]) => h.simulateContract(...a) },
}));
vi.mock('./delegation.js', () => ({ DELEGATION_ABI: [], DELEGATION_ADDRESS: DELEGATION }));

async function load(chain: string) {
  vi.resetModules();
  h.chain = chain;
  return import('./measure-route.js');
}

/** The $15 buy that the Railway fork's router refused: what it would really have delivered, and what it spent. */
const DELIVERED = 5_927_798_290_791_051n;
const BUY = { owner: OWNER, via: 'spend', token: USDC, venue: ROUTER, amount: 15_000_000n, tokenOut: WETH, data: '0x07ed2379' } as const;

beforeEach(() => {
  h.simulateContract.mockReset();
});

describe('what a route delivers on this chain', () => {
  it('dry-runs spend() for a buy, with the leg as it will be sent and a floor of one, and reads the first word', async () => {
    const { deliveredOnChain } = await load('xlayer-fork');
    // The router's `swap` answers (returnAmount, spentAmount).
    h.simulateContract.mockResolvedValue({
      result: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [DELIVERED, 15_000_000n]),
    });

    await expect(deliveredOnChain(BUY)).resolves.toBe(DELIVERED);
    expect(h.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'spend',
        address: DELEGATION,
        args: [OWNER, USDC, ROUTER, 15_000_000n, WETH, 1n, '0x07ed2379'],
      }),
    );
  });

  it('dry-runs closePosition() for a sale, in the sold token’s own units', async () => {
    const { deliveredOnChain } = await load('xlayer-fork');
    h.simulateContract.mockResolvedValue({ result: encodeAbiParameters([{ type: 'uint256' }], [50_297_581n]) });
    const sale = { ...BUY, via: 'closePosition', token: WETH, amount: 20_000_000_000_000_000n, tokenOut: USDC } as const;

    await expect(deliveredOnChain(sale)).resolves.toBe(50_297_581n);
    expect(h.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'closePosition', args: [OWNER, WETH, ROUTER, sale.amount, USDC, 1n, '0x07ed2379'] }),
    );
  });

  it('refuses an answer too short to hold an amount, rather than reading nothing as zero', async () => {
    const { deliveredOnChain } = await load('xlayer-fork');
    h.simulateContract.mockResolvedValue({ result: '0x' });
    await expect(deliveredOnChain(BUY)).rejects.toThrow('The route answered without saying what it delivered.');
  });

  it("lets the chain's own refusal through", async () => {
    const { deliveredOnChain } = await load('xlayer-fork');
    h.simulateContract.mockRejectedValue(new Error('execution reverted: DailyCapExceeded'));
    await expect(deliveredOnChain(BUY)).rejects.toThrow('DailyCapExceeded');
  });
});

describe('where prices drift', () => {
  it('is a fork of Base — not Base, and not Base Sepolia', async () => {
    for (const [chain, drift] of [
      ['xlayer-fork', true],
      ['localnet', true],
      ['xlayer', false],
      ['xlayer-testnet', false],
    ] as const) {
      expect((await load(chain)).PRICES_DRIFT, chain).toBe(drift);
    }
  });
});
