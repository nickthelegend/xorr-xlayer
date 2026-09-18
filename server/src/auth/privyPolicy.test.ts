/**
 * The Privy policy allows what a grant needs and nothing else (PLAN.md 1.9).
 *
 * Its rules matched `to` alone, so every token on the list allowed any call to that token —
 * `USDC.transfer(attacker, …)` included. These evaluate the rules the way Privy documents it does —
 * `to` compared case-insensitively, calldata decoded with each condition's `abi`, a field named
 * `function.argument` or `function_name` — against the calls that matter.
 */
import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Abi, type Hex } from 'viem';

const DELEGATION = '0x6c5528Fd8E74a047A85bAb413856A9239E73540e';
const DELEGATE = '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5';
// Circle's USDC on X Layer testnet — the only token the testnet's grant approves (`evm/chains.ts`).
const USDC = '0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3';
// Mainnet WETH: it has no code on the testnet, so the testnet policy must not name it.
const MAINNET_WETH = '0x5A77f1443D16ee5761d310e38b62f77f726bC71c';
const UNISWAP_ROUTER = '0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA';
const AAVE = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const STRANGER = '0x000000000000000000000000000000000000dEaD';

vi.mock('../evm/delegation.js', () => ({ DELEGATION_ADDRESS: DELEGATION, delegatePublicKey: DELEGATE }));
vi.mock('../evm/chains.js', () => ({
  APPROVABLE_TOKENS: [{ symbol: 'USDC', address: USDC }],
  AAVE_V3_POOL: AAVE,
  CHAIN_KEY: 'xlayer-testnet',
  IS_MAINNET_STATE: false,
}));
vi.mock('../venues/stocks.js', () => ({ STOCKS: {} }));
vi.mock('../db/index.js', () => ({ one: vi.fn(), query: vi.fn() }));

const { desiredRules, allowedDestinations } = await import('./privyPolicy.js');
type Rule = ReturnType<typeof desiredRules>[number];

/** Privy's documented matching, for one rule: every condition must hold. */
function matches(rule: Rule, tx: { to: string; data?: Hex }): boolean {
  return rule.conditions.every((c) => {
    if (c.field_source === 'ethereum_transaction') return tx.to.toLowerCase() === c.value.toLowerCase();
    if (!tx.data) return false;
    try {
      const decoded = decodeFunctionData({ abi: c.abi as unknown as Abi, data: tx.data });
      if (c.field === 'function_name') return decoded.functionName === c.value;
      const [fn, arg] = c.field.split('.');
      if (decoded.functionName !== fn) return false;
      const inputs = (c.abi as { name: string; inputs: { name: string }[] }[]).find((f) => f.name === fn)!.inputs;
      const value = (decoded.args ?? [])[inputs.findIndex((i) => i.name === arg)];
      return String(value).toLowerCase() === c.value.toLowerCase();
    } catch {
      return false; // Calldata the condition's ABI cannot decode is not this call.
    }
  });
}
const allowed = (tx: { to: string; data?: Hex }) => desiredRules().some((r) => matches(r, tx));

const DELEGATION_ABI = [
  {
    type: 'function',
    name: 'grant',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'delegate', type: 'address' },
      { name: 'dailyCap', type: 'uint256' },
      { name: 'expiresAt', type: 'uint64' },
      { name: 'venues', type: 'address[]' },
    ],
    outputs: [],
  },
  { type: 'function', name: 'revoke', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'setVenue',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'venue', type: 'address' },
      { name: 'allowed', type: 'bool' },
    ],
    outputs: [],
  },
] as const;

describe('what the policy lets the wallet sign', () => {
  it('allows each step of a grant: the approvals, the grant to our delegate, and revoke', () => {
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [DELEGATION, 10n ** 12n] });
    expect(allowed({ to: USDC, data: approve })).toBe(true);
    // A token the chain does not have is not approvable, even with the right spender.
    expect(allowed({ to: MAINNET_WETH, data: approve })).toBe(false);
    const grant = encodeFunctionData({
      abi: DELEGATION_ABI,
      functionName: 'grant',
      args: [DELEGATE, 1_600_000_000n, 1_791_855_009n, [UNISWAP_ROUTER]],
    });
    expect(allowed({ to: DELEGATION.toLowerCase(), data: grant })).toBe(true);
    expect(allowed({ to: DELEGATION, data: encodeFunctionData({ abi: DELEGATION_ABI, functionName: 'revoke' }) })).toBe(true);
  });

  it('refuses a transfer out of a token the policy names — the call destination-only rules let through', () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [STRANGER, 10n ** 12n] });
    expect(allowed({ to: USDC, data })).toBe(false);
  });

  it('refuses an approval to anyone but the delegation', () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [STRANGER, 2n ** 255n] });
    expect(allowed({ to: USDC, data })).toBe(false);
  });

  it("refuses a grant to any key but this executor's delegate, and venue changes outright", () => {
    const toStranger = encodeFunctionData({
      abi: DELEGATION_ABI,
      functionName: 'grant',
      args: [STRANGER, 1_600_000_000n, 1_791_855_009n, []],
    });
    expect(allowed({ to: DELEGATION, data: toStranger })).toBe(false);
    const setVenue = encodeFunctionData({ abi: DELEGATION_ABI, functionName: 'setVenue', args: [STRANGER, true] });
    expect(allowed({ to: DELEGATION, data: setVenue })).toBe(false);
  });

  it('refuses a plain send, and anything to an address on no list', () => {
    expect(allowed({ to: USDC })).toBe(false);
    expect(allowed({ to: STRANGER })).toBe(false);
    expect(allowed({ to: AAVE, data: '0x617ba037' })).toBe(false);
  });

  it('has no rule that allows a contract by destination alone', () => {
    for (const r of desiredRules()) {
      expect(r.conditions.some((c) => c.field_source === 'ethereum_calldata'), r.name).toBe(true);
    }
    expect(allowedDestinations().map((d) => d.address)).not.toContain(AAVE.toLowerCase());
  });
});

describe('signing is never wider than sending (a fork build signs, and the executor broadcasts)', () => {
  it('names every call twice, to send and to sign, with the same conditions', async () => {
    const { policyRules } = await import('./privyPolicy.js');
    const all = policyRules();
    const send = all.filter((r) => r.method === 'eth_sendTransaction');
    const sign = all.filter((r) => r.method === 'eth_signTransaction');
    expect(send).toEqual(desiredRules());
    expect(sign).toHaveLength(send.length);
    for (const s of sign) {
      expect(send.some((r) => JSON.stringify(r.conditions) === JSON.stringify(s.conditions))).toBe(true);
    }
    expect(all).toHaveLength(send.length + sign.length);
  });

  it('refuses to sign what it refuses to send', async () => {
    const { policyRules } = await import('./privyPolicy.js');
    const signRules = policyRules().filter((r) => r.method === 'eth_signTransaction');
    const signs = (tx: { to: string; data?: Hex }) => signRules.some((r) => matches(r, tx));
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [STRANGER, 1n] });
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [DELEGATION, 1n] });
    expect(signs({ to: USDC, data: transfer })).toBe(false);
    expect(signs({ to: STRANGER })).toBe(false);
    expect(signs({ to: USDC, data: approve })).toBe(true);
  });
});
