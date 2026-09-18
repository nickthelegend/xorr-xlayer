import { describe, expect, it } from 'vitest';
import { killSwitchChip, type ChainStandingKind, type KillSwitchState } from './killSwitch';

const EVERY_STANDING: ChainStandingKind[] = ['live', 'revoked', 'expired', 'none', 'unreadable'];

describe('killSwitchChip — armed is claimed only when the chain said live', () => {
  /*
   * The one rule this module exists for. A chip saying STOPPED over a live permission is alarming and harmless — the
   * user goes and looks. A chip saying ARMED over a revoked permission, or over a chain nobody could read, tells
   * someone their money is under management when it may not be, or that a stop they just pulled did not take.
   */
  it('is armed for `live`, and for nothing else at all', () => {
    expect(killSwitchChip('live').armed).toBe(true);
    for (const standing of EVERY_STANDING.filter((s) => s !== 'live')) {
      expect(killSwitchChip(standing).armed, standing).toBe(false);
    }
    expect(killSwitchChip(undefined).armed).toBe(false);
    for (const standing of [...EVERY_STANDING, undefined]) {
      expect(killSwitchChip(standing, true).armed, `${standing} + failed`).toBe(false);
    }
  });

  it('gives every standing its own state', () => {
    const states: Record<ChainStandingKind, KillSwitchState> = {
      live: 'armed',
      revoked: 'stopped',
      expired: 'expired',
      none: 'ungranted',
      unreadable: 'unreadable',
    };
    for (const [standing, state] of Object.entries(states)) {
      expect(killSwitchChip(standing as ChainStandingKind).state, standing).toBe(state);
    }
  });

  it('is checking while the read is out, and unreadable once it has failed', () => {
    expect(killSwitchChip(undefined).state).toBe('checking');
    expect(killSwitchChip(undefined, true).state).toBe('unreadable');
  });

  /* A failed read outranks whatever was there before it: a stale answer presented as current is the same bug again. */
  it('lets a failed read override any standing it was handed', () => {
    for (const standing of EVERY_STANDING) {
      expect(killSwitchChip(standing, true).state, standing).toBe('unreadable');
    }
  });
});

describe('not knowing is its own answer', () => {
  /*
   * Rounding "could not ask" down to "stopped" fails in the reassuring direction, which is worse than failing loudly:
   * it tells someone the agents are off when they may be trading.
   */
  it('never reports not-knowing as stopped or as armed', () => {
    for (const chip of [killSwitchChip(undefined), killSwitchChip('unreadable'), killSwitchChip(undefined, true)]) {
      expect(chip.unknown).toBe(true);
      expect(chip.armed).toBe(false);
      expect(chip.state).not.toBe('stopped');
      expect(chip.state).not.toBe('armed');
    }
  });

  it('marks every settled answer as known', () => {
    for (const standing of ['live', 'revoked', 'expired', 'none'] as const) {
      expect(killSwitchChip(standing).unknown, standing).toBe(false);
    }
  });
});

describe('every state says something, and no two say the same thing', () => {
  const all = [
    killSwitchChip('live'),
    killSwitchChip('revoked'),
    killSwitchChip('expired'),
    killSwitchChip('none'),
    killSwitchChip('unreadable'),
    killSwitchChip(undefined),
  ];

  it('has a label and a detail for each', () => {
    for (const chip of all) {
      expect(chip.label.length, chip.state).toBeGreaterThan(0);
      expect(chip.detail.length, chip.state).toBeGreaterThan(0);
    }
  });

  /* Two states that read alike are one state with extra steps, and the reader cannot act on the difference. */
  it('never repeats a label or a detail', () => {
    expect(new Set(all.map((c) => c.label)).size).toBe(all.length);
    expect(new Set(all.map((c) => c.detail)).size).toBe(all.length);
  });

  /* The two not-knowing states must not be dressed up as either real one. */
  it('does not describe an unknown state in the words of a known one', () => {
    for (const chip of [killSwitchChip('unreadable'), killSwitchChip(undefined)]) {
      expect(chip.detail).not.toMatch(/\bcan place orders\b/i);
      expect(chip.detail).not.toMatch(/\bis revoked\b/i);
    }
  });
});
