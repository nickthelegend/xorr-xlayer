/**
 * Deployed-agent identities.
 *
 * ## The problem this solves
 *
 * Every route on this server is behind a verified **Privy user** — which is right for
 * everything a person does, and wrong for the one thing a person is not doing. The trading
 * loop runs unattended. It has no session, no email and no wallet of its own, so it cannot
 * present a Privy token; and the moment you want that loop to run as a separate deployment
 * rather than inside the API process, it needs an identity the API can check.
 *
 * "Whoever can reach the port" is not an identity. This is.
 *
 * ## The shape
 *
 * A key is a row: a name, a **sha256 of the token** (never the token), a set of scopes, and a
 * revoked flag. Scopes are narrow on purpose:
 *
 *   `trade:open`   may open positions — the entry side of the book
 *   `trade:close`  may close them — stops, take-profits, exits
 *   `read`         may read the book and the policy
 *   `admin`        may mint and revoke identities, and nothing else
 *
 * Two deployed workers therefore hold one side each. A leaked entry key cannot close your
 * stops; a leaked exit key cannot open a position; and `admin` **deliberately does not imply
 * either trade scope**, so an operator credential that provisions agents still cannot move
 * money with itself.
 *
 * ## What this does NOT change
 *
 * The limits. An agent key is permission to ask the executor to act, not permission to act
 * outside policy: `runStrategy` still reads the on-chain cap, the venue allowlist and the
 * expiry, and the token program still refuses anything past the approval. This layer decides
 * WHO may ask. The chain decides what may happen.
 */
import crypto from 'node:crypto';
import { query } from '../db/index.js';

export type Scope = 'read' | 'trade:open' | 'trade:close' | 'admin';

export const ALL_SCOPES: readonly Scope[] = ['read', 'trade:open', 'trade:close', 'admin'];

export type Principal = {
  kind: 'agent' | 'operator';
  id: string;
  name: string;
  scopes: Scope[];
};

/** Tokens are stored as a digest only. A database dump must not be a set of live credentials. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** What every agent key starts with. */
export const AGENT_KEY_PREFIX = 'xagt_';

/** `xagt_` + 32 random bytes. Prefixed so a leaked one is recognisable in a log or a repo. */
export function mintToken(): string {
  return `${AGENT_KEY_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
}

/**
 * Whether a bearer token could be an agent key at all (PLAN.md 2.1).
 *
 * Every key minted here has carried the prefix since agent keys existed, so a token without it is
 * not one — and looking it up anyway cost every Privy session a write to `agent_keys` (`agentFor`
 * stamps `last_seen_at`) before its own verification began.
 */
export function isAgentKey(token: string): boolean {
  return token.startsWith(AGENT_KEY_PREFIX);
}

/**
 * What each scope implies.
 *
 * `admin` implies `read` and NOTHING else. An operator who can provision agents should not
 * also be able to trade with the same credential — the whole point of separating them is
 * that the blast radius of a leak is bounded by what the credential was for.
 */
const IMPLIED: Partial<Record<Scope, Scope[]>> = { admin: ['admin', 'read'] };

export function can(principal: Principal | undefined, scope: Scope): boolean {
  if (!principal) return false;
  for (const held of principal.scopes) {
    if (held === scope) return true;
    if (IMPLIED[held]?.includes(scope)) return true;
  }
  return false;
}

type KeyRow = {
  id: string;
  name: string;
  scopes: Scope[];
  revoked: boolean;
};

/**
 * Resolve a bearer token to an agent identity, or undefined.
 *
 * Looks the token up by DIGEST, so the plaintext is never compared against anything stored.
 * `last_seen_at` is stamped as a side effect: an identity nothing has used in weeks is the
 * first thing worth revoking, and you cannot notice that without recording it.
 */
export async function agentFor(token: string): Promise<Principal | undefined> {
  const rows = await query<KeyRow>(
    `UPDATE agent_keys SET last_seen_at = now()
      WHERE token_hash = $1 AND revoked = false
      RETURNING id, name, scopes, revoked`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return undefined;
  return { kind: 'agent', id: row.id, name: row.name, scopes: row.scopes };
}

/**
 * The operator credential, from the environment.
 *
 * It exists to break a chicken-and-egg: minting the first agent key needs `admin`, and
 * `admin` is only held by an agent key. Rather than a magic self-closing case in the code —
 * which is the kind of thing that quietly grants itself more later — it is one explicit
 * secret, injected like every other, and it cannot trade.
 */
export function operatorFor(token: string): Principal | undefined {
  const expected = process.env.OPERATOR_TOKEN;
  if (!expected || expected.length < 16) return undefined;
  // Constant-time: a length-leaking comparison on a bearer token is a free oracle.
  const a = Buffer.from(hashToken(token));
  const b = Buffer.from(hashToken(expected));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined;
  return { kind: 'operator', id: 'operator', name: 'operator', scopes: ['admin', 'read'] };
}

export async function listAgentKeys(): Promise<
  { id: string; name: string; scopes: Scope[]; revoked: boolean; lastSeenAt: Date | null }[]
> {
  const rows = await query<KeyRow & { last_seen_at: Date | null }>(
    `SELECT id, name, scopes, revoked, last_seen_at FROM agent_keys ORDER BY created_at ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scopes: r.scopes,
    revoked: r.revoked,
    lastSeenAt: r.last_seen_at,
  }));
}

/**
 * Mint one. The plaintext is returned ONCE and never stored — if it is lost, mint another
 * and revoke this one, because there is no way to recover it and that is the property that
 * makes the digest-only storage worth anything.
 */
export async function createAgentKey(
  name: string,
  scopes: Scope[],
): Promise<{ id: string; token: string }> {
  const token = mintToken();
  const rows = await query<{ id: string }>(
    `INSERT INTO agent_keys (id, name, token_hash, scopes)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [crypto.randomUUID(), name, hashToken(token), scopes],
  );
  return { id: rows[0]!.id, token };
}

export async function revokeAgentKey(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE agent_keys SET revoked = true WHERE id = $1 RETURNING id`,
    [id],
  );
  return rows.length > 0;
}
