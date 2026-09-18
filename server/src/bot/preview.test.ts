import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const oneMock = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>();
const heartbeatMock = vi.fn<() => { tickMs: number; lastTickAt: number | null }>();

vi.mock('../db/index.js', () => ({ one: (sql: string, p?: unknown[]) => oneMock(sql, p) }));
vi.mock('../executor/scheduler.js', () => ({ schedulerHeartbeat: () => heartbeatMock() }));

const { agentPreview } = await import('./preview.js');
const { AGENT_DECISION } = await import('./autonomous.js');
const { RISK_SETTINGS, DEFAULT_RISK_PROFILE } = await import('./risk-profile.js');
const COOLDOWN_MINUTES = RISK_SETTINGS[DEFAULT_RISK_PROFILE].cooldownMinutes;
const { XSTOCKS } = await import('../venues/xstocks.js');

const NOW = Date.parse('2026-09-17T12:00:00Z');
const MINUTE = 60_000;

describe('what the agent is about to do', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    heartbeatMock.mockReturnValue({ tickMs: 30_000, lastTickAt: NOW - 10_000 });
    oneMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dates the next sweep from the loop rather than from the wall clock', async () => {
    const preview = await agentPreview('wallet-1');
    expect(preview.tickMs).toBe(30_000);
    expect(preview.lastTickAt).toBe(NOW - 10_000);
    expect(preview.nextTickAt).toBe(NOW + 20_000);
  });

  /*
   * A restarted executor has a period but no anchor. Deriving a next tick from the wall clock
   * would be a guess presented as a time, on the screen built to say when something happens.
   */
  it('says it does not know the next tick when the executor has not ticked yet', async () => {
    heartbeatMock.mockReturnValue({ tickMs: 30_000, lastTickAt: null });

    const preview = await agentPreview('wallet-1');
    expect(preview.lastTickAt).toBeNull();
    expect(preview.nextTickAt).toBeNull();
  });

  it('lists the universe the sweep will consider', async () => {
    const preview = await agentPreview('wallet-1');
    expect(preview.universe).toHaveLength(Object.keys(XSTOCKS).length);
    expect(preview.universe.map((u) => u.symbol)).toContain('NVDAx');
    expect(preview.universe[0]).toHaveProperty('name');
  });

  it('is eligible when nothing is holding the wallet back', async () => {
    const preview = await agentPreview('wallet-1');
    expect(preview.wallet).toEqual({
      agentsStopped: false,
      cooldownUntil: null,
      eligible: true,
    });
  });

  it('reports the kill switch as the reason it will be skipped', async () => {
    oneMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM wallets') ? { agents_stopped: true } : null,
    );

    const preview = await agentPreview('wallet-1');
    expect(preview.wallet.agentsStopped).toBe(true);
    expect(preview.wallet.eligible).toBe(false);
  });

  /*
   * "Held" without "until when" is the version of this that sends someone back to check every
   * thirty seconds. The cooldown is asked for without the sweep's time window so the moment it
   * lifts can be stated.
   */
  it('says when the cooldown lifts, not merely that it is on', async () => {
    const decidedAt = new Date(NOW - 4 * MINUTE);
    oneMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM proposals') ? { decided_at: decidedAt } : null,
    );

    const preview = await agentPreview('wallet-1');
    expect(preview.wallet.cooldownUntil).toBe(NOW - 4 * MINUTE + COOLDOWN_MINUTES * MINUTE);
    expect(preview.wallet.eligible).toBe(false);
  });

  it('treats a lapsed cooldown as no cooldown at all', async () => {
    const decidedAt = new Date(NOW - (COOLDOWN_MINUTES + 1) * MINUTE);
    oneMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM proposals') ? { decided_at: decidedAt } : null,
    );

    const preview = await agentPreview('wallet-1');
    expect(preview.wallet.cooldownUntil).toBeNull();
    expect(preview.wallet.eligible).toBe(true);
  });

  /* The preview and the sweep must agree on which rows count, or the screen describes another gate. */
  it('keys the cooldown on the same decision word the sweep writes', async () => {
    await agentPreview('wallet-1');
    const call = oneMock.mock.calls.find(([sql]) => sql.includes('FROM proposals'));
    expect(call?.[1]).toContain(AGENT_DECISION);
  });
});
