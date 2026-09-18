/**
 * Every rule name fits Privy's limit, on the deployment that stores the most rules (PLAN.md 4.14).
 *
 * Privy refuses a rule name of 50 characters or more, and refuses the whole write with it. The sign twins first shipped
 * with ", signed for the executor to send" on each name, and on 2026-09-15 both executors' policy writes came back
 * `400 rules.13.name: Rule name must be fewer than 50 characters`. A fork of Base approves every equity as well, so its
 * list is the one measured here, with the real equity registry.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../evm/delegation.js', () => ({
  DELEGATION_ADDRESS: '0xc32dD8AeED3035D46C7c82A351fC5522c9D463f4',
  delegatePublicKey: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5',
}));
vi.mock('../evm/chains.js', () => ({
  ADDRESSES: {
    usdcBase: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    wethBase: '0x4200000000000000000000000000000000000006',
    cbbtcBase: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  },
  CHAIN_KEY: 'base-fork',
  IS_BASE_MAINNET_STATE: true,
}));
vi.mock('../db/index.js', () => ({ one: vi.fn(), query: vi.fn() }));

const { desiredRules, policyRules } = await import('./privyPolicy.js');
const { STOCKS } = await import('../venues/stocks.js');

describe("Privy's rule-name limit", () => {
  it('holds for every rule a fork of Base stores, each equity approval and its signing twin included', () => {
    const rules = policyRules();
    expect(Object.keys(STOCKS).length).toBeGreaterThan(0);
    expect(rules).toHaveLength(2 * desiredRules().length);
    for (const r of rules) expect(r.name.length, r.name).toBeLessThan(50);
  });

  it('keeps every name distinct, so a refusal names one rule', () => {
    const names = policyRules().map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
