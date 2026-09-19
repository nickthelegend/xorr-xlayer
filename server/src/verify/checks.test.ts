/**
 * What `/verify` — the page a judge opens — says about a wallet that has no permission on this deployment.
 *
 * A wallet that never granted HERE has nothing to read, which is the same kind of answer as a request with no wallet
 * at all: `skip`, with the reason. It used to be `fail`, so pasting an address into `/judge` on the testnet
 * deployment produced two red rows under claims like "The permission is read from the chain" — which reads as the
 * product being broken rather than as this wallet's permission living somewhere else.
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.XORR_CHAIN = 'xlayer-testnet';
  process.env.PRIVY_APP_ID = 'test';
  process.env.PRIVY_APP_SECRET = 'test';
});

const readPolicy = vi.fn(async (_owner: string) => null);
vi.mock('../evm/delegation.js', () => ({
  readPolicy: (owner: string) => readPolicy(owner),
  DELEGATION_ADDRESS: '0x156DCE9E9d523775AB51f882616A431EdBfBcA22',
  DELEGATION_ABI: [],
  delegatePublicKey: '0x19033937953479E8F7b0237eB48ee87Be1D1c8ae',
}));
vi.mock('../evm/client.js', () => ({
  publicClient: {
    getCode: async () => '0x6080604052',
    getBlockNumber: async () => 1n,
    getChainId: async () => 1952,
    readContract: async () => false,
    getBalance: async () => 0n,
  },
}));
vi.mock('../db/index.js', () => ({ query: async () => [], one: async () => null }));
/*
 * Everything else `checks.ts` probes reaches the network. This test is about two rows and their status, so each of
 * those answers immediately — left real, they ran for whole seconds apiece and the suite timed out on data it never
 * needed.
 */
vi.mock('../market/prices.js', () => ({ priceOf: async () => 1 }));
vi.mock('../venues/uniswap.js', () => ({ quote: async () => ({ outAmount: 0.27, venues: ['Uniswap v3'] }), VENUE_NAME: 'Uniswap v3' }));
vi.mock('../market/yield.js', () => ({ usdt0Reserve: async () => null }));
vi.mock('../audit/anchor.js', () => ({ agreement: async () => null, anchoringConfigured: () => false }));
vi.mock('../audit/log.js', () => ({ verify: async () => ({ rows: 0, linkBreaks: 0 }) }));
vi.mock('../venues/stocks.js', () => ({ STOCKS: {}, equitiesFunctional: async () => ({ ok: false, detail: 'none here' }) }));
vi.mock('../market/edgar.js', () => ({ earningsCalendar: async () => null }));

const { runChecks } = await import('./checks.js');

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615' as const;

describe('/verify for a wallet with no permission on this chain', () => {
  it('skips the permission checks with a reason, instead of failing them', async () => {
    const report = await runChecks(OWNER);
    for (const id of ['policy', 'cap-agrees']) {
      const check = report.checks.find((c) => c.id === id);
      expect(check, id).toBeDefined();
      expect(check!.status, `${id}: ${check!.observed}`).toBe('skip');
      expect(check!.observed).toMatch(/no permission on this chain/i);
    }
  });

  it('counts those as skipped rather than failed, so the tally is not red', async () => {
    const report = await runChecks(OWNER);
    const ids = report.checks.filter((c) => c.status === 'fail').map((c) => c.id);
    expect(ids).not.toContain('policy');
    expect(ids).not.toContain('cap-agrees');
    expect(report.skipped).toBeGreaterThan(0);
  });
});
