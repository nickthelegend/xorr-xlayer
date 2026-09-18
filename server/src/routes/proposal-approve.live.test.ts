/**
 * LIVE — approving a proposal places the order it describes, or says why it placed nothing (PLAN.md 1.3).
 *
 * Approving wrote "Filled 0.0041 WETH at $2,431. Stop set at $2,406." into the thread and the trail
 * and traded nothing. This creates a proposal through the real API, approves it, and holds the answer
 * to what the executor actually did: on a chain 1inch settles on, a fill with a transaction hash and
 * a real exit strategy; on one it does not, a refusal that claims nothing. A second approve places no
 * second order, and another account cannot decide it at all.
 *
 * On the fork this spends $5 of fork USDC. The exit it arms sits at $1 and $1,000,000 so it can never
 * fire, and is ended afterwards.
 *
 * Run with the executor up: npm run test:live
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788';
const TOKEN_SCRIPT = fileURLToPath(new URL('../e2e-token.ts', import.meta.url));
const OWNER_EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';
const OTHER_EMAIL = process.env.E2E_PRIVY_EMAIL_2 ?? 'test-0356@privy.io';

type Reply = { status: number; body: unknown };
type Decision = { status: string; message: string; signature?: string; orderId?: string; exitStrategyId?: string | null };
const tokens = { owner: '', other: '' };

function caller(who: keyof typeof tokens) {
  return async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const owner = caller('owner');
const other = caller('other');

let chain = '';
let proposalId = '';
let exitStrategyId: string | null = null;

beforeAll(async () => {
  tokens.owner = execFileSync('npx', ['tsx', TOKEN_SCRIPT, OWNER_EMAIL], { encoding: 'utf8' }).trim();
  tokens.other = execFileSync('npx', ['tsx', TOKEN_SCRIPT, OTHER_EMAIL], { encoding: 'utf8' }).trim();
  chain = String(((await (await fetch(`${BASE}/health`)).json()) as { chain?: string }).chain);

  const created = await owner('POST', '/proposals', {
    agent: 'Momentum Scout',
    ttlSeconds: 600,
    payload: {
      symbol: 'WETH',
      usd: '5',
      stopPrice: '1',
      targetPrice: '1000000',
      status: 'Live test',
      action: 'Buy $5 of WETH',
      notional: '$5',
      entry: 'Market',
      stop: '$1',
      target: '$1,000,000',
      rationale: 'A $5 probe that approving places a real order.',
      onApprove: 'Places a $5 market buy of WETH.',
      onSkip: 'Skipped.',
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  proposalId = String((created.body as { id: string }).id);
}, 120_000);

afterAll(async () => {
  if (exitStrategyId) await owner('DELETE', `/strategies/${exitStrategyId}`);
});

describe('approving a proposal', () => {
  it('cannot be done by another account', async () => {
    const res = await other('POST', `/proposals/${proposalId}/decide`, { decision: 'approve' });
    // A named 404 when the other account has a wallet, read exactly like an unknown id (E160); `no_wallet` when it has
    // none. Never a decision.
    if (res.status === 404) expect(res.body).toMatchObject({ error: 'not_found', status: 'gone' });
    else expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  it('places the order it describes, and says exactly what happened', async () => {
    const res = await owner('POST', `/proposals/${proposalId}/decide`, { decision: 'approve' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as Decision;

    if (chain === 'base-sepolia') {
      // 1inch does not settle on Base Sepolia, so the honest answer is a refusal — never a fill.
      expect(body.status, body.message).not.toBe('filled');
      expect(body.message).not.toMatch(/^(Filled|Bought)/);
      return;
    }

    expect(body.status, body.message).toBe('filled');
    expect(body.signature).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(body.message).toMatch(/^Bought \d+\.\d{4} WETH at \$/);
    exitStrategyId = body.exitStrategyId ?? null;
    if (exitStrategyId) {
      const list = (await owner('GET', '/strategies')).body as { id: string; kind: string; state: string }[];
      expect(list.find((s) => s.id === exitStrategyId)).toMatchObject({ kind: 'exit-rules', state: 'live' });
    } else {
      expect(body.message).toMatch(/existing exit/);
    }
  }, 180_000);

  it('places no second order when approved again', async () => {
    const res = await owner('POST', `/proposals/${proposalId}/decide`, { decision: 'approve' });
    expect(res.status).toBe(200);
    expect((res.body as Decision).status).toBe('approve');
  });
});
