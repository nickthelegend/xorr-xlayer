import { describe, expect, it } from 'vitest';
import { can, hashToken, mintToken, type Principal } from './agentKeys.js';

/**
 * The scope rules, on their own. Everything else in `agentKeys.ts` needs a database; this is
 * the part that decides whether a request is allowed to move money, so it is tested without
 * one.
 */
const agent = (scopes: Principal['scopes']): Principal => ({
  kind: 'agent',
  id: 'a',
  name: 'test',
  scopes,
});

describe('agent scopes', () => {
  it('a scope grants itself and nothing adjacent', () => {
    expect(can(agent(['trade:open']), 'trade:open')).toBe(true);
    expect(can(agent(['trade:open']), 'trade:close')).toBe(false);
    expect(can(agent(['trade:close']), 'trade:open')).toBe(false);
  });

  it('admin implies read, and NEVER a trade scope', () => {
    // The whole reason the operator credential is separate: it provisions agents and cannot
    // move money with itself, so a leaked operator key is not a leaked trading key.
    const op = agent(['admin']);
    expect(can(op, 'read')).toBe(true);
    expect(can(op, 'admin')).toBe(true);
    expect(can(op, 'trade:open')).toBe(false);
    expect(can(op, 'trade:close')).toBe(false);
  });

  it('no principal is no permission', () => {
    for (const s of ['read', 'trade:open', 'trade:close', 'admin'] as const) {
      expect(can(undefined, s)).toBe(false);
    }
  });

  it('a revoked key is simply never resolved, so it holds nothing', () => {
    // `agentFor` filters on `revoked = false`, so a revoked key produces no principal at all
    // — which is the same as being unauthenticated, and is checked here as the empty case.
    expect(can(agent([]), 'read')).toBe(false);
  });

  it('tokens are recognisable, unguessable, and stored only as a digest', () => {
    const t = mintToken();
    expect(t.startsWith('xagt_')).toBe(true);
    expect(t.length).toBeGreaterThan(60);
    expect(mintToken()).not.toBe(t);
    const h = hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
    // Same input, same digest — the lookup depends on it.
    expect(hashToken(t)).toBe(h);
  });
});
