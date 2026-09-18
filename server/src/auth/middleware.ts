/**
 * Auth middleware — every route except /health is behind it.
 *
 * The previous build enforced limits server-side but had no notion of WHO was calling. That made
 * the limits meaningless in a multi-user world: anyone could spend anyone's cap. This binds every
 * request to a verified Privy user, and `requireUser` is the only way a route reads that identity.
 */
import type { Context, Next } from 'hono';
import { log } from '../http/request-id.js';
import { UnauthorizedError, verifyToken, type AuthedUser } from './privy.js';
import { agentFor, can, isAgentKey, operatorFor, type Principal, type Scope } from './agentKeys.js';

/**
 * Routes reachable without a token. Deliberately tiny.
 *
 * Market data is public on purpose: a spot price is not user data, and gating it behind a session
 * means an unauthenticated visitor sees a market list of dashes. Nothing under these paths reads
 * `requireUser`, so none of them can leak a wallet, a policy or a fill.
 */
const PUBLIC_PATHS = new Set([
  '/health',
  '/market/quotes',
  '/market/sparklines',
  '/market/ohlc',
  '/market/symbols',
  '/market/logos',
  '/market/tradable',
  '/market/watchable',
  '/market/stocks',
  /** The tokenized-equity catalog: what is listed and what it costs. Not user data. */
  '/market/xstocks',
  // Same reasoning as the rest of `/market/*`: an observed price series is not user data, and
  // gating it means an unauthenticated visitor sees an equity with a number and no shape.
  '/market/stocks/history',
  '/yield/supply',
  /*
   * The verification console.
   *
   * Public for the same reason the contract is: the whole argument is that you do not have to
   * trust us, and a proof you need our permission to run is not a proof. Every probe behind it is
   * a read of something already public — the chain, a price feed — and the
   * wallet-specific ones take an address anyone could paste into an explorer.
   */
  '/verify',
  /** Operational, and read-only. A health check behind a session cannot be used by a load balancer. */
  '/metrics',
  /** A second opinion on a public price is still a public price. */
  '/market/crosscheck',
  /**
   * A split or dividend, read off a public Token-2022 mint.
   *
   * The same argument as the rest of `/market/*`: the multiplier and the timestamp it starts
   * applying are on the chain, where anyone can read them without asking us. Gating it would
   * mean a signed-out visitor sees an asset screen with a price, a chart and no mention of the
   * corporate action that is about to restate every unit of it.
   */
  '/market/corporate-action',
  /** A futures venue's public market data — the Futures screens' list. */
  '/market/futures',
]);

/** Path prefixes that are public. `/perp/:symbol` is a mark price, not user data. */
const PUBLIC_PREFIXES = ['/perp/'];

/**
 * The public surface, published.
 *
 * The client needs to know which paths it may call without a session — otherwise it fires
 * authenticated requests before it has a token and the browser logs a 401 for each one on every
 * signed-out load. Exposing the list means the client mirrors a value rather than guessing one,
 * and `/health` reports it so the two can be checked against each other instead of drifting.
 */
export const publicSurface = {
  paths: [...PUBLIC_PATHS],
  prefixes: [...PUBLIC_PREFIXES],
};

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthedUser;
    /** A deployed agent or the operator, when the caller is not a person. */
    principal: Principal;
  }
}

/** `/agent/*` is the machine surface. A Privy session is not a valid credential for it. */
const AGENT_PREFIX = '/agent/';

export async function authMiddleware(c: Context, next: Next) {
  const isPublic =
    PUBLIC_PATHS.has(c.req.path) || PUBLIC_PREFIXES.some((p) => c.req.path.startsWith(p));
  if (isPublic || c.req.method === 'OPTIONS') return next();

  /*
   * Two kinds of caller, and they do not overlap.
   *
   * A person presents a Privy token. A deployed worker presents an agent key. `/agent/*` is
   * the machine surface: it is reached with a key or not at all, so a stolen phone session
   * cannot drive the trading loop, and an agent key cannot read someone's wallet through the
   * user routes. Checking the key FIRST also means a `/agent/*` request never spends a
   * round-trip on Privy verification that could not have applied to it.
   */
  const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) {
    // Only a token shaped like an agent key is looked up as one; a Privy session never is.
    const principal = operatorFor(bearer) ?? (isAgentKey(bearer) ? await agentFor(bearer) : undefined);
    if (principal) {
      c.set('principal', principal);
      return next();
    }
  }

  if (c.req.path.startsWith(AGENT_PREFIX)) {
    log.warn(`401 ${c.req.method} ${c.req.path}: not a known agent key`);
    return c.json({ error: 'unauthorized', detail: 'This surface needs an agent key.' }, 401);
  }

  try {
    const user = await verifyToken(c.req.header('authorization'));
    c.set('user', user);
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'Unauthorized';
    /*
     * Say why, in the log.
     *
     * A 401 is the one status that is equally consistent with "the caller is not signed in" and
     * "our verification is broken", and the response body cannot say much without helping an
     * attacker. Without this line the two are indistinguishable from the outside, which is exactly
     * the position a whole test sweep going 401 leaves you in.
     */
    log.warn(`401 ${c.req.method} ${c.req.path}: ${detail}`);
    return c.json({ error: 'unauthorized', detail }, 401);
  }
  return next();
}

/** The ONLY way a route learns who is calling. */
export function requireUser(c: Context): AuthedUser {
  const user = c.get('user');
  if (user) return user;
  /*
   * A machine reached a route that is about a person.
   *
   * `/positions` and friends are scoped to a wallet, and an agent key is not attached to
   * one — so this is not "who are you", it is "you are the wrong kind of caller". Saying
   * that costs nothing and it is the difference between a fixable misconfiguration and a
   * 500 that reads as the server being broken.
   */
  if (c.get('principal')) {
    throw new WrongPrincipalError(
      'This route belongs to a signed-in user. An agent key cannot stand in for one.',
    );
  }
  throw new UnauthorizedError('No authenticated user on this request.');
}

/** A valid credential, of the wrong kind for this route. 403, never 401 — retrying will not help. */
export class WrongPrincipalError extends Error {
  readonly status = 403;
  constructor(detail: string) {
    super(detail);
    this.name = 'WrongPrincipalError';
  }
}

/** The principal behind a machine request, if there is one. */
export function principalOf(c: Context): Principal | undefined {
  return c.get('principal');
}

/**
 * Gate a route on a scope.
 *
 * The refusal says which scope was missing. That is deliberate: the caller is a deployed
 * worker we provisioned, not an attacker probing — telling it "you need trade:close" is the
 * difference between a fixable misconfiguration and an afternoon of guessing.
 */
export function requireScope(scope: Scope) {
  return async (c: Context, next: Next) => {
    const principal = principalOf(c);
    if (!can(principal, scope)) {
      return c.json(
        {
          error: 'forbidden',
          detail: principal
            ? `${principal.name} does not hold ${scope}.`
            : 'This route needs an agent key.',
        },
        403,
      );
    }
    return next();
  };
}
