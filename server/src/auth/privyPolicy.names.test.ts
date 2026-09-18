/**
 * Every rule name fits Privy's limit, on the deployment that stores the most rules (PLAN.md 4.14).
 *
 * Privy refuses a rule name of 50 characters or more, and refuses the whole write with it. The sign twins first shipped
 * with ", signed for the executor to send" on each name, and on 2026-09-15 both executors' policy writes came back
 * `400 rules.13.name: Rule name must be fewer than 50 characters`. A fork of X Layer mainnet approves every wrapped
 * xStock as well, so its list is the one measured here, with the real equity registry and mainnet's approvable tokens.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../evm/delegation.js', () => ({
  DELEGATION_ADDRESS: '0xc32dD8AeED3035D46C7c82A351fC5522c9D463f4',
  delegatePublicKey: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5',
}));
// X Layer mainnet's approvable tokens, as `evm/chains.ts` lists them where mainnet state is.
vi.mock('../evm/chains.js', () => ({
  APPROVABLE_TOKENS: [
    { symbol: 'USDC', address: '0xB6CEceAB302E2E4948951eE7843FC24E92933061' },
    { symbol: 'USDT0', address: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736' },
    { symbol: 'USDG', address: '0x4ae46a509F6b1D9056937BA4500cb143933D2dc8' },
    { symbol: 'WETH', address: '0x5A77f1443D16ee5761d310e38b62f77f726bC71c' },
    { symbol: 'XBTC', address: '0xb7C00000bcDEeF966b20B3D884B98E64d2b06b4f' },
  ],
  CHAIN_KEY: 'xlayer-fork',
  IS_MAINNET_STATE: true,
}));
vi.mock('../db/index.js', () => ({ one: vi.fn(), query: vi.fn() }));

const { desiredRules, policyRules } = await import('./privyPolicy.js');
const { STOCKS } = await import('../venues/stocks.js');

describe("Privy's rule-name limit", () => {
  it('holds for every rule a fork of X Layer stores, each equity approval and its signing twin included', () => {
    const rules = policyRules();
    expect(Object.keys(STOCKS).length).toBeGreaterThan(0);
    expect(rules).toHaveLength(2 * desiredRules().length);
    // grant + revoke, the five tokens, and one approval per wrapped xStock — each twice.
    expect(desiredRules()).toHaveLength(2 + 5 + Object.keys(STOCKS).length);
    for (const r of rules) expect(r.name.length, r.name).toBeLessThan(50);
  });

  it('keeps every name distinct, so a refusal names one rule', () => {
    const names = policyRules().map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
