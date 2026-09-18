import { describe, expect, it } from 'vitest';
import {
  actionSentence,
  ratioText,
  untilText,
  type CorporateActionNotice,
} from './corporateAction';

const NOW = Date.parse('2026-09-17T12:00:00Z');
const HOUR = 3_600_000;

const scheduled = (p: Partial<CorporateActionNotice & { pending: unknown }> = {}) =>
  ({
    status: 'scheduled',
    symbol: 'NVDAx',
    multiplier: 1,
    pending: { nextMultiplier: 2, effectiveAtMs: NOW + 30 * HOUR, ratio: 2, direction: 'increase' },
    ...p,
  }) as CorporateActionNotice;

describe('untilText', () => {
  it('counts in the coarsest unit that still says something', () => {
    expect(untilText(NOW + 40 * 60_000, NOW)).toBe('in 40 minutes');
    expect(untilText(NOW + HOUR, NOW)).toBe('in an hour');
    expect(untilText(NOW + 30 * HOUR, NOW)).toBe('in 30 hours');
    expect(untilText(NOW + 5 * 24 * HOUR, NOW)).toBe('in 5 days');
  });

  /*
   * Past the timestamp the multiplier flips when the chain says it does. A screen counting up from
   * the deadline is describing the gap between two clocks, not anything about the asset.
   */
  it('does not count upward once the moment has passed', () => {
    expect(untilText(NOW - HOUR, NOW)).toBe('any moment now');
    expect(untilText(NOW, NOW)).toBe('any moment now');
  });
});

describe('ratioText', () => {
  it('says whole ratios the way people say them', () => {
    expect(ratioText(2)).toBe('2-for-1');
    expect(ratioText(3)).toBe('3-for-1');
    expect(ratioText(0.5)).toBe('1-for-2');
    expect(ratioText(0.25)).toBe('1-for-4');
  });

  /* A dividend is rarely a clean one-for-n, and forcing it into ratio language hides the number. */
  it('leaves an untidy ratio as a multiplier rather than inventing a ratio', () => {
    expect(ratioText(1.0234)).toBe('×1.0234');
  });
});

describe('actionSentence', () => {
  it('says nothing at all when nothing is queued', () => {
    const none: CorporateActionNotice = {
      status: 'none',
      symbol: 'NVDAx',
      multiplier: 1,
      pending: null,
    };
    expect(actionSentence(none, NOW)).toBeNull();
  });

  it('says nothing while the read is still in flight', () => {
    expect(actionSentence(undefined, NOW)).toBeNull();
  });

  it('describes what happens to the holding without naming the event', () => {
    const out = actionSentence(scheduled(), NOW);
    expect(out?.kind).toBe('risk');
    expect(out?.text).toContain('2-for-1');
    expect(out?.text).toContain('in 30 hours');
    expect(out?.text).toContain('units multiply by 2');
    expect(out?.text).toContain('does not change');
    // The extension records that the multiplier moves, not why. Neither word is knowable from it.
    expect(out?.text).not.toContain('split');
    expect(out?.text).not.toContain('dividend');
  });

  it('describes a shrinking multiplier the other way round', () => {
    const out = actionSentence(
      scheduled({
        pending: {
          nextMultiplier: 0.5,
          effectiveAtMs: NOW + 10 * HOUR,
          ratio: 0.5,
          direction: 'decrease',
        },
      }),
      NOW,
    );
    expect(out?.text).toContain('1-for-2');
    expect(out?.text).toContain('divided by 2');
  });

  /*
   * "We could not check" is worth saying on a screen whose other numbers are all things we did
   * check. It must not be shown as "nothing is coming".
   */
  it('says so when the token could not be read', () => {
    const out = actionSentence(
      { status: 'unavailable', symbol: 'NVDAx', multiplier: null, pending: null, reason: 'unreadable' },
      NOW,
    );
    expect(out?.kind).toBe('blocked');
    expect(out?.text).toContain('unknown');
  });

  it('stays silent about an asset that has no multiplier to move', () => {
    const out = actionSentence(
      { status: 'unavailable', symbol: 'XBTC', multiplier: null, pending: null, reason: 'not_tokenized' },
      NOW,
    );
    expect(out).toBeNull();
  });
});
