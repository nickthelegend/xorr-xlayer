/**
 * Money in on Deposit (FEATURES.md #21): which balance reads count as money arriving.
 *
 * A roll and a success tap are a claim that money landed. Claimed for the read the screen opened on, for dust nobody can
 * see, or for another wallet's balance, they would be the kind of confident motion the price rule exists to stop.
 */
import { describe, expect, it } from 'vitest';
import { NO_ARRIVALS, noteFunds, type Arrivals, type FundsRead } from './moneyIn';

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** Base units for an amount, through its decimal string rather than a float multiplication. */
function units(amount: number, decimals: number): string {
  const [whole, fraction = ''] = amount.toFixed(decimals).split('.');
  return BigInt(`${whole}${fraction}`).toString();
}

/** A read of `/wallet/funds`: USDC in six decimals, ETH in eighteen. */
function funds(usdc: number, eth: number, over: Partial<FundsRead> = {}): FundsRead {
  return {
    owner: OWNER,
    chain: 'base-fork',
    usdc: { address: USDC, raw: units(usdc, 6), amount: usdc },
    eth: { raw: units(eth, 18), amount: eth },
    ...over,
  };
}

const reads = (...list: FundsRead[]): Arrivals => list.reduce(noteFunds, NO_ARRIVALS);

describe('noteFunds', () => {
  it('does not count the first read, which is what the wallet held when the screen opened', () => {
    const opened = reads(funds(250, 0.05));
    expect(opened).toMatchObject({ count: 0, usdc: 0, eth: 0 });
    expect(opened.last?.usdc.amount).toBe(250);
  });

  it('counts a balance that rose, once for the read that showed it', () => {
    expect(reads(funds(0, 0.05), funds(100, 0.05))).toMatchObject({ count: 1, usdc: 1, eth: 0 });
    expect(reads(funds(100, 0.001), funds(100, 0.05))).toMatchObject({ count: 1, usdc: 0, eth: 1 });
  });

  it('taps once for a read that brought both balances, and rolls both', () => {
    // The faucet sends USDC and raises the ETH for gas in the same claim.
    expect(reads(funds(0, 0.001), funds(100, 0.05))).toMatchObject({ count: 1, usdc: 1, eth: 1 });
  });

  it('counts each arrival, and none of the reads between them', () => {
    expect(reads(funds(0, 0.05), funds(100, 0.05), funds(100, 0.05), funds(250, 0.05))).toMatchObject({
      count: 2,
      usdc: 2,
      eth: 0,
    });
  });

  it('does not count money leaving, or a read that changed nothing', () => {
    expect(reads(funds(250, 0.05), funds(100, 0.05))).toMatchObject({ count: 0, usdc: 0 });
    expect(reads(funds(250, 0.05), funds(250, 0.05))).toMatchObject({ count: 0, usdc: 0, eth: 0 });
  });

  it('counts money that arrives after money left', () => {
    expect(reads(funds(250, 0.05), funds(100, 0.05), funds(150, 0.05))).toMatchObject({ count: 1, usdc: 1 });
  });

  it('does not tap for dust too small for the figure to show', () => {
    // A thousandth of a cent: the base units rose, and "250.00" did not.
    const before = funds(250, 0.05);
    const dust = { ...before, usdc: { ...before.usdc, raw: (BigInt(before.usdc.raw) + BigInt(10)).toString(), amount: 250.00001 } };
    expect(reads(before, dust)).toMatchObject({ count: 0, usdc: 0 });
  });

  it('decides from base units, not from the floats made of them', () => {
    const before = funds(100, 0.05);
    expect(reads(before, { ...before, usdc: { ...before.usdc, amount: 100.5 } })).toMatchObject({ count: 0 });
  });

  it('is not fooled by another wallet, another network or another token', () => {
    const before = funds(0, 0.05);
    const after = funds(100, 0.05);
    expect(reads(before, { ...after, owner: '0x000000000000000000000000000000000000dEaD' })).toMatchObject({ count: 0 });
    expect(reads(before, { ...after, chain: 'base-sepolia' })).toMatchObject({ count: 0 });
    expect(
      reads(before, { ...after, usdc: { ...after.usdc, address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' } }),
    ).toMatchObject({ count: 0 });
    // The same address in another case is the same wallet.
    expect(reads(before, { ...after, owner: OWNER.toLowerCase() })).toMatchObject({ count: 1, usdc: 1 });
  });

  it('counts nothing from base units it cannot read', () => {
    const before = funds(0, 0.05);
    const after = funds(100, 0.05);
    expect(reads(before, { ...after, usdc: { ...after.usdc, raw: '' } })).toMatchObject({ count: 0 });
    expect(reads({ ...before, usdc: { ...before.usdc, raw: '1e6' } }, after)).toMatchObject({ count: 0 });
  });

  it('counts USDT0 arriving, on its own contract only', () => {
    const USDT0 = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
    const withUsdt0 = (amount: number, address = USDT0) => funds(0, 0.05, { usdt0: { address, raw: units(amount, 6), amount } });
    expect(reads(withUsdt0(0), withUsdt0(40))).toMatchObject({ count: 1, usdt0: 1, usdc: 0 });
    expect(reads(withUsdt0(0), withUsdt0(40, '0x000000000000000000000000000000000000dEaD'))).toMatchObject({ count: 0 });
    // A read without USDT0 beside one with it is not an arrival either way.
    expect(reads(funds(0, 0.05), withUsdt0(40))).toMatchObject({ count: 0, usdt0: 0 });
  });
});
