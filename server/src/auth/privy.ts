/**
 * Authentication — Privy.
 *
 * This closes the largest hole in the previous build: the executor had NO auth, so any caller
 * could reach every route and act on any wallet. Every request now carries a Privy access token,
 * the token is verified against Privy's public keys, and the resulting user id scopes every query.
 *
 * Privy is also the embedded-wallet provider, which means the user identity and the wallet that
 * signs are the same object — there is no separate account system to keep in sync.
 */
import { PrivyClient, type User } from '@privy-io/server-auth';
import 'dotenv/config';

const APP_ID = process.env.PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  throw new Error(
    'PRIVY_APP_ID and PRIVY_APP_SECRET are required. The executor refuses to start without auth — ' +
      'an unauthenticated trading server is the one configuration that must never be possible.',
  );
}

export const privy = new PrivyClient(APP_ID, APP_SECRET);

export type LinkedWallet = {
  /** As Privy returns it — checksummed. */
  address: string;
  /** Privy's own embedded wallet, as opposed to one the user brought and linked. */
  embedded: boolean;
};

export type AuthedUser = {
  /** Privy DID, e.g. did:privy:xxx. The primary key for everything this user owns. */
  userId: string;
  /** The embedded wallet address Privy manages for them, when they have one. */
  walletAddress?: string;
  /**
   * Every Ethereum wallet on this Privy account, embedded or linked — the only addresses this user may
   * register as theirs (`/wallet/connect`). Undefined when Privy could not be asked, which is not the
   * same as an account with no wallets and must not be treated as one.
   */
  wallets?: LinkedWallet[];
  email?: string;
};

export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(detail: string) {
    super(detail);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Privy's record of an account, reused for five minutes (PLAN.md 2.1).
 *
 * Every authenticated request asked Privy for the user by id — a round trip to an endpoint Privy's
 * own SDK marks as strictly rate limited — to read a wallet list two routes use. The token is still
 * verified on every request, locally, against Privy's key; only the account record is reused. That
 * record can be up to five minutes old, so a route about to refuse an address it did not find asks
 * again with `freshWallets` first: a wallet linked a moment ago is never turned away by an old copy.
 *
 * A failed read is not kept. It means "could not ask", and the next request asks.
 */
const USER_TTL_MS = 5 * 60_000;
const USER_CACHE_MAX = 10_000;
const users = new Map<string, { at: number; user: Promise<User | null> }>();

function readUser(userId: string, fresh = false): Promise<User | null> {
  const hit = users.get(userId);
  if (!fresh && hit && Date.now() - hit.at < USER_TTL_MS) return hit.user;
  const entry = { at: Date.now(), user: privy.getUser(userId).catch(() => null) };
  users.delete(userId);
  if (users.size >= USER_CACHE_MAX) users.delete(users.keys().next().value as string);
  users.set(userId, entry);
  void entry.user.then((u) => {
    if (u === null && users.get(userId) === entry) users.delete(userId);
  });
  return entry.user;
}

function walletsOf(user: User | null): LinkedWallet[] | undefined {
  if (!user) return undefined;
  return (user.linkedAccounts ?? []).flatMap((a) => {
    const w = a as { type?: string; address?: unknown; chainType?: string; walletClientType?: string };
    return w.type === 'wallet' && w.chainType === 'ethereum' && typeof w.address === 'string'
      ? [{ address: w.address, embedded: w.walletClientType === 'privy' }]
      : [];
  });
}

/**
 * The account's wallets as Privy lists them now rather than as cached — for a route about to refuse
 * an address it did not find. Replaces the cached record as a side effect.
 */
export async function freshWallets(userId: string): Promise<LinkedWallet[] | undefined> {
  return walletsOf(await readUser(userId, true));
}

/** Testing only. */
export function clearUserCache(): void {
  users.clear();
}

/**
 * Verify a Privy access token and return the user it belongs to.
 * Throws rather than returning null: a route that forgets to check a null cannot leak data.
 */
export async function verifyToken(authorization: string | undefined): Promise<AuthedUser> {
  const token = authorization?.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new UnauthorizedError('Missing bearer token.');

  let claims;
  try {
    claims = await privy.verifyAuthToken(token);
  } catch (e) {
    throw new UnauthorizedError(
      `Invalid or expired token${e instanceof Error ? `: ${e.message}` : ''}`,
    );
  }

  const user = await readUser(claims.userId);
  const wallets = walletsOf(user);
  const email = user?.linkedAccounts?.find(
    (a): a is typeof a & { address: string } =>
      a.type === 'email' && typeof (a as { address?: unknown }).address === 'string',
  );

  return {
    userId: claims.userId,
    // The embedded wallet when there is one. "The first wallet of any kind" was whichever the account
    // happened to link first — a browser extension, on web.
    walletAddress: (wallets?.find((w) => w.embedded) ?? wallets?.[0])?.address,
    wallets,
    email: email?.address,
  };
}
