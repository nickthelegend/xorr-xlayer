import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PushMessage } from './push.js';

const sendMock = vi.fn<(walletId: string, msg: PushMessage) => Promise<unknown>>();
const queryMock = vi.fn<(sql: string, params: unknown[]) => Promise<unknown>>();

vi.mock('./push.js', () => ({
  send: (walletId: string, msg: PushMessage) => sendMock(walletId, msg),
}));

vi.mock('../db/index.js', () => ({
  query: (sql: string, params: unknown[]) => queryMock(sql, params),
}));

const { notifyEntry, notifyExit, notifyKill } = await import('./alerts.js');

/**
 * The one call, or a failure that says so.
 *
 * `mock.calls[0]` is possibly-undefined under `noUncheckedIndexedAccess`, and destructuring it
 * straight into `[walletId, pushMsg]` does not typecheck. Asserting the count separately and then
 * indexing anyway would put the two facts in different places; this keeps them together and fails
 * with a sentence rather than a `TypeError` on the next line.
 */
function onlyCall<A extends unknown[]>(mock: { mock: { calls: A[] } }, what: string): A {
  const { calls } = mock.mock;
  if (calls.length !== 1) throw new Error(`expected exactly one ${what}, saw ${calls.length}`);
  const [call] = calls;
  if (!call) throw new Error(`expected exactly one ${what}, saw none`);
  return call;
}

describe('notifications alerts', () => {
  beforeEach(() => {
    sendMock.mockReset();
    queryMock.mockReset();
    sendMock.mockResolvedValue({ sent: 1, skipped: 0, errors: [] });
    queryMock.mockResolvedValue([]);
  });

  it('notifyEntry sends push notification and saves chat drawer message', async () => {
    await notifyEntry({
      walletId: 'wallet-123',
      symbol: 'NVDAx',
      strategyKind: 'momentum',
      notionalUsd: 50,
      units: 0.2309,
      price: 216.5,
      signature: '5K3yTestSignatureSolanaEntry',
      rationale: 'Breakout above 20-day high with strong volume.',
      agentName: 'Momentum Scout',
    });

    const [walletId, pushMsg] = onlyCall(sendMock, 'push');
    expect(walletId).toBe('wallet-123');
    expect(pushMsg.title).toContain('Momentum Scout Traded');
    expect(pushMsg.body).toContain('NVDAx');
    expect(pushMsg.body).toContain('$50.00');
    expect(pushMsg.body).toContain('$216.50');
    expect(pushMsg.data).toMatchObject({
      action: 'entry',
      symbol: 'NVDAx',
      strategyKind: 'momentum',
      notionalUsd: 50,
      signature: '5K3yTestSignatureSolanaEntry',
    });

    const [sql, params] = onlyCall(queryMock, 'insert');
    expect(sql).toContain('INSERT INTO messages');
    expect(params[1]).toBe('wallet-123');
    expect(params[2]).toBe('Momentum Scout');
    const parsedBody = JSON.parse(String(params[3]));
    expect(parsedBody.symbol).toBe('NVDAx');
    expect(parsedBody.notionalUsd).toBe(50);
  });

  it('notifyExit sends exit notification with pnl and proceeds', async () => {
    await notifyExit({
      walletId: 'wallet-123',
      symbol: 'TSLAx',
      reason: 'Take-profit target triggered at $420.00',
      units: 0.5,
      price: 420.0,
      proceedsUsd: 210.0,
      pnlUsd: 15.0,
      signature: '5K3yTestSignatureSolanaExit',
    });

    const [walletId, pushMsg] = onlyCall(sendMock, 'push');
    expect(walletId).toBe('wallet-123');
    expect(pushMsg.title).toBe('xorr: Position Closed');
    expect(pushMsg.body).toContain('TSLAx');
    expect(pushMsg.body).toContain('$210.00');
    expect(pushMsg.body).toContain('+$15.00');
    expect(pushMsg.data).toMatchObject({
      action: 'exit',
      symbol: 'TSLAx',
      proceedsUsd: 210.0,
      pnlUsd: 15.0,
      signature: '5K3yTestSignatureSolanaExit',
    });

    const [sql, params] = onlyCall(queryMock, 'insert');
    expect(sql).toContain('INSERT INTO messages');
    expect(params[1]).toBe('wallet-123');
  });

  it('notifyKill sends kill switch alert and persists to chat drawer', async () => {
    await notifyKill({
      walletId: 'wallet-123',
      reason: 'Delegation permission revoked on-chain.',
      signature: '5K3yTestSignatureSolanaKill',
    });

    const [walletId, pushMsg] = onlyCall(sendMock, 'push');
    expect(walletId).toBe('wallet-123');
    expect(pushMsg.title).toBe('xorr: Trading Stopped');
    expect(pushMsg.body).toContain('Delegation permission revoked');
    expect(pushMsg.data).toMatchObject({
      action: 'kill',
      signature: '5K3yTestSignatureSolanaKill',
    });

    const [sql, params] = onlyCall(queryMock, 'insert');
    expect(sql).toContain('INSERT INTO messages');
    expect(params[1]).toBe('wallet-123');
  });

  /*
   * The kill notice is the one place this app could most easily claim something it did not do.
   * Pausing the strategies is not revoking the delegation, and the sentence must not say it is.
   */
  it('notifyKill does not claim the on-chain delegation was revoked', async () => {
    await notifyKill({ walletId: 'wallet-123', reason: 'User activated agent kill switch.' });

    const [, pushMsg] = onlyCall(sendMock, 'push');
    expect(pushMsg.body).not.toContain('delegation revoked');
    expect(pushMsg.body).toContain('paused');
  });
});
