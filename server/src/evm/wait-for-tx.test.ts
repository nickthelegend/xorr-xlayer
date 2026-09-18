/**
 * A transaction the app just broadcast is looked for, not written off (2026-09-13).
 *
 * The app's wallet broadcasts through Privy's RPC; the executor reads another node, where the
 * transaction can take a moment to appear. `waitForTx` asked once, so `/delegation/record` answered a
 * real grant — signed through the hosted app and mined seconds later — with "That transaction is not
 * on this chain". A hash nobody has heard of still has to come back absent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTransaction = vi.fn();
const waitForTransactionReceipt = vi.fn();

vi.mock('./client.js', () => ({
  publicClient: {
    getTransaction: (...a: unknown[]) => getTransaction(...a),
    waitForTransactionReceipt: (...a: unknown[]) => waitForTransactionReceipt(...a),
  },
  walletClient: {},
  delegateAccount: { address: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5' },
}));

const { waitForTx } = await import('./delegation.js');

const HASH = '0xce90642d65cd970bd17984a06b51791ceaf51997b1ace72cb4c25a6bec6b6a1f' as const;
const notFound = () => Promise.reject(new Error('Transaction with hash not found.'));

beforeEach(() => {
  getTransaction.mockReset();
  waitForTransactionReceipt.mockReset();
});

describe('waitForTx', () => {
  it('finds a transaction that reaches this node a moment after the app sent it', async () => {
    getTransaction.mockImplementationOnce(notFound).mockImplementationOnce(notFound).mockResolvedValue({ hash: HASH });
    waitForTransactionReceipt.mockResolvedValue({ status: 'success' });

    expect(await waitForTx(HASH, 5_000, 5_000)).toBe(true);
    expect(getTransaction).toHaveBeenCalledTimes(3);
  });

  it('still says absent for a hash that never appears', async () => {
    getTransaction.mockImplementation(notFound);

    expect(await waitForTx(HASH, 5_000, 1_500)).toBeUndefined();
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('reports a mined revert as false', async () => {
    getTransaction.mockResolvedValue({ hash: HASH });
    waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });

    expect(await waitForTx(HASH)).toBe(false);
  });
});
