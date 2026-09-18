/**
 * The delegate's two sends are recorded before they are signed (migration 025).
 *
 * A request holding an Idempotency-Key must never send a transaction its key's row does not show: that is the one a
 * retry would repeat. These run the real `spendAsDelegate` and `closeAsDelegate` inside a request scope whose record is
 * a recorder, with the node stood in for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

const h = vi.hoisted(() => {
  process.env.DELEGATION_ADDRESS = '0x6c5528Fd8E74a047A85bAb413856A9239E73540e';
  return { events: [] as string[], simulate: vi.fn(), estimate: vi.fn(), send: vi.fn() };
});

vi.mock('./client.js', () => ({
  publicClient: { simulateContract: h.simulate, estimateContractGas: h.estimate },
  walletClient: { writeContract: h.send },
  delegateAccount: { address: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5' },
}));

const { closeAsDelegate, spendAsDelegate } = await import('./delegation.js');
const { withRequestScope } = await import('../http/request-id.js');

const OWNER: Address = '0x95A0b368588713011a15f4b1041423f31B08e615';
const WETH: Address = '0x4200000000000000000000000000000000000006';
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ROUTER: Address = '0x111111125421cA6dc452d289314280a0f8842A65';

const spend = () =>
  spendAsDelegate({ owner: OWNER, venue: ROUTER, usd: 25, data: '0x12' as Hex, tokenOut: WETH, minOut: 1n });
const close = () =>
  closeAsDelegate({ owner: OWNER, token: WETH, venue: ROUTER, amount: 10n ** 16n, data: '0x34' as Hex, tokenOut: USDC, minOut: 1n });

/** `send`, as a request whose key's row records the broadcast with `record`. */
function inRequest(record: () => Promise<void>, send: () => Promise<Hex>) {
  return withRequestScope(async (scope) => {
    scope.beforeFirstBroadcast = record;
    const outcome = await send().then(
      (hash) => ({ hash }),
      (error: unknown) => ({ error }),
    );
    return { ...outcome, broadcast: scope.broadcast };
  });
}

beforeEach(() => {
  h.events.length = 0;
  h.simulate.mockReset();
  h.simulate.mockImplementation(async (call: unknown) => {
    h.events.push('simulate');
    return { request: call };
  });
  h.estimate.mockReset();
  h.estimate.mockImplementation(async () => {
    h.events.push('estimate');
    return 100_000n;
  });
  h.send.mockReset();
  h.send.mockImplementation(async () => {
    h.events.push('send');
    return '0xsent';
  });
});

describe.each([
  ['spend', spend],
  ['closePosition', close],
])('%s as the delegate', (_name, sendAsDelegate) => {
  it('is recorded after the simulation and before the transaction is signed', async () => {
    const out = await inRequest(async () => {
      h.events.push('recorded');
    }, sendAsDelegate);
    expect(out).toEqual({ hash: '0xsent', broadcast: true });
    expect(h.events).toEqual(['simulate', 'estimate', 'recorded', 'send']);
  });

  it('is never sent when the record cannot be written', async () => {
    const out = await inRequest(async () => {
      throw new Error('Connection terminated unexpectedly');
    }, sendAsDelegate);
    expect(out).toMatchObject({ error: expect.objectContaining({ message: 'Connection terminated unexpectedly' }), broadcast: false });
    expect(h.events).toEqual(['simulate', 'estimate']);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('marks nothing when the simulation refuses it, so the key can be given back', async () => {
    h.simulate.mockRejectedValueOnce(new Error('execution reverted: CapExceeded'));
    const record = vi.fn(async () => undefined);
    const out = await inRequest(record, sendAsDelegate);
    expect(out).toMatchObject({ broadcast: false });
    expect(record).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('outside any request', () => {
  it('a scheduled run sends as it always did', async () => {
    expect(await close()).toBe('0xsent');
    expect(h.events).toEqual(['simulate', 'estimate', 'send']);
  });
});
