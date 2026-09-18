/**
 * Who is calling, decided before any route runs (PLAN.md 2.1).
 *
 * Every bearer token used to be looked up as an agent key first — a database write, because the
 * lookup stamps `last_seen_at` — including every Privy session, which is nearly all traffic. These run
 * the real middleware in front of a two-route app with the key lookup and Privy replaced by recorders.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agentKeys.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentKeys.js')>()),
  agentFor: vi.fn(),
}));
vi.mock('./privy.js', () => ({
  UnauthorizedError: class extends Error {
    readonly status = 401;
  },
  verifyToken: vi.fn(),
}));

const { agentFor } = await import('./agentKeys.js');
const { verifyToken } = await import('./privy.js');
const { authMiddleware } = await import('./middleware.js');

const app = new Hono();
app.use('*', authMiddleware);
app.get('/wallet', (c) => c.json({ user: c.get('user')?.userId ?? null, principal: c.get('principal')?.name ?? null }));
app.get('/agent/whoami', (c) => c.json({ principal: c.get('principal')?.name ?? null }));

const call = (path: string, token: string) => app.request(path, { headers: { authorization: `Bearer ${token}` } });

const SESSION = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.session.signature';
const KEY = `xagt_${'a'.repeat(64)}`;

beforeEach(() => {
  vi.mocked(agentFor).mockReset();
  vi.mocked(verifyToken).mockReset();
});

describe('a Privy session', () => {
  it('is verified with Privy and never looked up as an agent key', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ userId: 'did:privy:owner' });
    const res = await call('/wallet', SESSION);
    expect(await res.json()).toEqual({ user: 'did:privy:owner', principal: null });
    expect(agentFor).not.toHaveBeenCalled();
  });

  it('cannot reach the agent surface, and costs nothing to refuse', async () => {
    const res = await call('/agent/whoami', SESSION);
    expect(res.status).toBe(401);
    expect(agentFor).not.toHaveBeenCalled();
    expect(verifyToken).not.toHaveBeenCalled();
  });
});

describe('an agent key', () => {
  it('is looked up, and a known one never touches Privy', async () => {
    vi.mocked(agentFor).mockResolvedValue({ kind: 'agent', id: 'k1', name: 'scout worker', scopes: ['read'] });
    const res = await call('/agent/whoami', KEY);
    expect(await res.json()).toEqual({ principal: 'scout worker' });
    expect(agentFor).toHaveBeenCalledWith(KEY);
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('an unknown or revoked one is refused on the agent surface', async () => {
    vi.mocked(agentFor).mockResolvedValue(undefined);
    const res = await call('/agent/whoami', KEY);
    expect(res.status).toBe(401);
    expect(verifyToken).not.toHaveBeenCalled();
  });
});
