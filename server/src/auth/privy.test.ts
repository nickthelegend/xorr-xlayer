/**
 * The account record behind every signed-in request (PLAN.md 2.1).
 *
 * `verifyToken` asked Privy for the user on every request. These drive the real `verifyToken` with
 * Privy's client replaced by a recorder: the record is reused, expires, is never kept when the read
 * failed, is kept per account, and can be refreshed by a route about to refuse an address.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.PRIVY_APP_ID ??= 'test-app';
  process.env.PRIVY_APP_SECRET ??= 'test-secret';
  return { getUser: vi.fn(), verifyAuthToken: vi.fn() };
});

vi.mock('@privy-io/server-auth', () => ({
  PrivyClient: class {
    verifyAuthToken = h.verifyAuthToken;
    getUser = h.getUser;
  },
}));

const { verifyToken, freshWallets, clearUserCache } = await import('./privy.js');

const embedded = {
  type: 'wallet',
  chainType: 'ethereum',
  walletClientType: 'privy',
  address: '0x95A0b368588713011a15f4b1041423f31B08e615',
};
const linkedLater = {
  type: 'wallet',
  chainType: 'ethereum',
  walletClientType: 'metamask',
  address: '0x0EAc22965EB9DbCFBfDAE5c89899EF4C089e3c16',
};
const account = (...linkedAccounts: object[]) => ({ id: 'did:privy:owner', linkedAccounts });

beforeEach(() => {
  vi.useRealTimers();
  clearUserCache();
  h.getUser.mockReset();
  h.verifyAuthToken.mockReset();
  h.verifyAuthToken.mockImplementation(async (token: string) => ({
    userId: token === 'other' ? 'did:privy:other' : 'did:privy:owner',
  }));
});

describe('the account record', () => {
  it('is asked of Privy once, however many requests the session makes', async () => {
    h.getUser.mockResolvedValue(account(embedded));
    for (let i = 0; i < 3; i++) {
      expect((await verifyToken('Bearer owner')).walletAddress).toBe(embedded.address);
    }
    expect(h.getUser).toHaveBeenCalledTimes(1);
    // The token itself is still verified every time.
    expect(h.verifyAuthToken).toHaveBeenCalledTimes(3);
  });

  it('is asked for again once it is five minutes old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-13T09:00:00Z'));
    h.getUser.mockResolvedValue(account(embedded));
    await verifyToken('Bearer owner');
    vi.setSystemTime(new Date('2026-09-13T09:04:59Z'));
    await verifyToken('Bearer owner');
    expect(h.getUser).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-09-13T09:05:01Z'));
    await verifyToken('Bearer owner');
    expect(h.getUser).toHaveBeenCalledTimes(2);
  });

  it('is never kept when Privy could not be asked', async () => {
    h.getUser.mockRejectedValueOnce(new Error('Privy 503')).mockResolvedValue(account(embedded));
    expect((await verifyToken('Bearer owner')).wallets).toBeUndefined();
    expect((await verifyToken('Bearer owner')).wallets).toEqual([{ address: embedded.address, embedded: true }]);
    expect(h.getUser).toHaveBeenCalledTimes(2);
  });

  it("is kept per account — one user never gets another's wallets", async () => {
    h.getUser.mockImplementation(async (id: string) =>
      id === 'did:privy:other' ? account(linkedLater) : account(embedded),
    );
    expect((await verifyToken('Bearer owner')).walletAddress).toBe(embedded.address);
    expect((await verifyToken('Bearer other')).walletAddress).toBe(linkedLater.address);
    expect((await verifyToken('Bearer owner')).walletAddress).toBe(embedded.address);
    expect(h.getUser).toHaveBeenCalledTimes(2);
  });

  it('is refreshed by a route about to refuse, and the next request sees the new wallet', async () => {
    h.getUser.mockResolvedValueOnce(account(embedded)).mockResolvedValue(account(embedded, linkedLater));
    expect((await verifyToken('Bearer owner')).wallets).toHaveLength(1);
    expect(await freshWallets('did:privy:owner')).toEqual([
      { address: embedded.address, embedded: true },
      { address: linkedLater.address, embedded: false },
    ]);
    expect((await verifyToken('Bearer owner')).wallets).toHaveLength(2);
    expect(h.getUser).toHaveBeenCalledTimes(2);
  });

  it('is not read at all for a token that fails verification', async () => {
    h.verifyAuthToken.mockRejectedValue(new Error('jwt expired'));
    await expect(verifyToken('Bearer stale')).rejects.toMatchObject({ status: 401 });
    expect(h.getUser).not.toHaveBeenCalled();
  });
});
