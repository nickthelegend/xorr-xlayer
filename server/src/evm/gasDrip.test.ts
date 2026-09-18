/**
 * Test gas for a new wallet comes from the faucet, never from the bot's own key (PLAN.md 1.8).
 *
 * The drip paid from the delegate — the key every scheduled trade signs with — so each sign-up
 * spent the gas the bot needs to trade. These pin who pays, and that every refusal says why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const getBalance = vi.fn();
const sendTransaction = vi.fn(async () => '0xdrip');

vi.mock('./client.js', () => ({ publicClient: { getBalance: (...a: unknown[]) => getBalance(...a) } }));
const h = vi.hoisted(() => ({ chain: 'xlayer-testnet', baseState: false }));
vi.mock('./chains.js', () => ({
  get IS_MAINNET_STATE() {
    return h.baseState;
  },
  get CHAIN_KEY() {
    return h.chain;
  },
  chain: { id: 1952, name: 'X Layer Testnet' },
  rpcUrl: 'http://127.0.0.1:1',
}));
vi.mock('viem', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem')>()),
  createWalletClient: vi.fn(() => ({ sendTransaction })),
}));

const { dripGasIfNeeded } = await import('./gasDrip.js');
const { withRequestScope } = await import('../http/request-id.js');

/** A throwaway key for the test — anvil's second well-known account, never funded anywhere real. */
const FAUCET_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const FAUCET = privateKeyToAccount(FAUCET_KEY).address;
const NEW_WALLET = '0x00000000000000000000000000000000000a11ce' as const;

beforeEach(() => {
  getBalance.mockReset();
  sendTransaction.mockClear();
  delete process.env.FAUCET_PRIVATE_KEY;
  h.chain = 'xlayer-testnet';
  h.baseState = false;
});
afterEach(() => {
  delete process.env.FAUCET_PRIVATE_KEY;
});

const balances = (wallet: bigint, faucet: bigint) =>
  getBalance.mockImplementation(async ({ address }: { address: string }) =>
    address.toLowerCase() === FAUCET.toLowerCase() ? faucet : wallet,
  );

describe('dripGasIfNeeded', () => {
  it('sends nothing, and says so, when the deployment has no faucet key', async () => {
    const out = await dripGasIfNeeded(NEW_WALLET);
    expect(out).toMatchObject({ sent: false });
    expect(out.sent === false && out.reason).toMatch(/no faucet key/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('pays an empty wallet from the faucet, and names the faucet as the sender', async () => {
    process.env.FAUCET_PRIVATE_KEY = FAUCET_KEY;
    balances(0n, parseEther('0.05'));

    const out = await dripGasIfNeeded(NEW_WALLET);
    expect(out).toEqual({ sent: true, amountEth: '0.002', hash: '0xdrip', from: FAUCET });
    expect(sendTransaction).toHaveBeenCalledWith({ to: NEW_WALLET, value: parseEther('0.002') });
    // The only balances read are the new wallet's and the faucet's — the delegate is not involved.
    const read = getBalance.mock.calls.map((c) => (c[0] as { address: string }).address.toLowerCase()).sort();
    expect(read).toEqual([NEW_WALLET, FAUCET.toLowerCase()].sort());
  });

  it('does not top up a wallet that already has gas', async () => {
    process.env.FAUCET_PRIVATE_KEY = FAUCET_KEY;
    balances(1n, parseEther('0.05'));
    expect(await dripGasIfNeeded(NEW_WALLET)).toEqual({ sent: false, reason: 'wallet already has gas' });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('refuses when the faucet itself is nearly empty', async () => {
    process.env.FAUCET_PRIVATE_KEY = FAUCET_KEY;
    balances(0n, parseEther('0.001'));
    const out = await dripGasIfNeeded(NEW_WALLET);
    expect(out.sent === false && out.reason).toMatch(/the faucet holds 0.001 OKB/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('is recorded against the request’s Idempotency-Key before it is sent, and not sent when that cannot be done', async () => {
    // A retried `/wallet/connect` must not become a second drip (migration 025).
    process.env.FAUCET_PRIVATE_KEY = FAUCET_KEY;
    balances(0n, parseEther('0.05'));
    const order: string[] = [];
    sendTransaction.mockImplementation(async () => {
      order.push('send');
      return '0xdrip';
    });

    const sent = await withRequestScope(async (scope) => {
      scope.beforeFirstBroadcast = async () => {
        order.push('recorded');
      };
      return dripGasIfNeeded(NEW_WALLET);
    });
    expect(sent).toMatchObject({ sent: true, hash: '0xdrip' });
    expect(order).toEqual(['recorded', 'send']);

    const refused = withRequestScope(async (scope) => {
      scope.beforeFirstBroadcast = async () => {
        throw new Error('Connection terminated unexpectedly');
      };
      return dripGasIfNeeded(NEW_WALLET);
    });
    await expect(refused).rejects.toThrow('Connection terminated unexpectedly');
    expect(order).toEqual(['recorded', 'send']);
  });

  it("sends nothing on X Layer mainnet's state — a fork of it included — though the faucet could pay", async () => {
    process.env.FAUCET_PRIVATE_KEY = FAUCET_KEY;
    balances(0n, parseEther('0.05'));
    h.chain = 'xlayer-fork';
    h.baseState = true;
    expect(await dripGasIfNeeded(NEW_WALLET)).toEqual({ sent: false, reason: 'refusing to send real OKB on xlayer-fork' });
    expect(getBalance).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('sends nothing on a chain whose money is real, even were the mainnet-state flag to miss it', async () => {
    process.env.FAUCET_PRIVATE_KEY = FAUCET_KEY;
    balances(0n, parseEther('0.05'));
    h.chain = 'xlayer';
    h.baseState = false;
    expect(await dripGasIfNeeded(NEW_WALLET)).toEqual({ sent: false, reason: 'refusing to send real OKB on xlayer' });
    expect(getBalance).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
