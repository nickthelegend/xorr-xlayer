import { describe, expect, it } from 'vitest';
import { profitClose, UNMEASURED_REASON, type CloseOutcome } from './profitClose';

const close = (over: Partial<CloseOutcome> = {}): CloseOutcome => ({
  proceedsUsd: 120,
  units: 2,
  entryPrice: 50,
  ...over,
});

describe('profitClose — the arithmetic is two recorded numbers', () => {
  it('reports a gain against the real cost basis', () => {
    // 2 units bought at 50 = 100 cost; sold for 120.
    expect(profitClose(close())).toEqual({ kind: 'profit', realisedUsd: 20, pct: 20 });
  });

  it('reports a loss the same way, without softening it', () => {
    expect(profitClose(close({ proceedsUsd: 80 }))).toEqual({ kind: 'loss', realisedUsd: -20, pct: -20 });
  });

  /* The same rule `pnlTone` keeps: a cent of profit dressed as a moment is a moment nobody believes twice. */
  it('calls a close that rounds to nothing flat, not a win', () => {
    const state = profitClose(close({ proceedsUsd: 100.004 }));
    expect(state.kind).toBe('flat');
    expect(profitClose(close({ proceedsUsd: 100 })).kind).toBe('flat');
  });

  it('is a gain once it clears the printed precision', () => {
    expect(profitClose(close({ proceedsUsd: 100.01 })).kind).toBe('profit');
    expect(profitClose(close({ proceedsUsd: 99.99 })).kind).toBe('loss');
  });
});

describe('the four refusals', () => {
  /*
   * The executor recognised the idempotency key and handed back an earlier attempt. Nothing was sold by this tap, and a
   * gain announced for it is the sentence that makes someone believe they sold twice.
   */
  it('says nothing for a replayed close, even with a perfect basis', () => {
    expect(profitClose(close({ replayed: true }))).toEqual({ kind: 'unmeasured', why: 'replayed' });
  });

  /* Zero is not a cost of nothing. Treating it as free turns every proceed into pure profit — the flattering lie. */
  it('refuses a missing or zero entry price rather than calling the whole proceed profit', () => {
    expect(profitClose(close({ entryPrice: undefined })).kind).toBe('unmeasured');
    expect(profitClose(close({ entryPrice: 0 }))).toEqual({ kind: 'unmeasured', why: 'no-basis' });
    expect(profitClose(close({ entryPrice: -5 }))).toEqual({ kind: 'unmeasured', why: 'no-basis' });
  });

  it('respects the executor’s own warning that the basis has gaps', () => {
    expect(profitClose(close({ basisIncomplete: true }))).toEqual({
      kind: 'unmeasured',
      why: 'incomplete-basis',
    });
  });

  it('refuses a close that sold nothing', () => {
    expect(profitClose(close({ units: 0 }))).toEqual({ kind: 'unmeasured', why: 'nothing-sold' });
    expect(profitClose(close({ units: -1 })).kind).toBe('unmeasured');
  });

  it('refuses figures that are not figures', () => {
    for (const over of [
      { proceedsUsd: Number.NaN },
      { proceedsUsd: Number.POSITIVE_INFINITY },
      { units: Number.NaN },
      { entryPrice: Number.NaN },
    ]) {
      expect(profitClose(close(over)).kind, JSON.stringify(over)).toBe('unmeasured');
    }
  });

  /* A replayed close outranks every other reason: it was not measured at all, whatever basis exists for it. */
  it('reports replayed first when several reasons apply', () => {
    const state = profitClose(close({ replayed: true, basisIncomplete: true, entryPrice: 0 }));
    expect(state).toEqual({ kind: 'unmeasured', why: 'replayed' });
  });
});

describe('every refusal says what is missing', () => {
  it('has a sentence for each reason, and no two the same', () => {
    const reasons = Object.values(UNMEASURED_REASON);
    for (const r of reasons) expect(r.length).toBeGreaterThan(0);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  /* Each names the missing thing rather than implying the sale failed — the sale happened; only the maths cannot. */
  it('never says the close failed', () => {
    for (const [why, sentence] of Object.entries(UNMEASURED_REASON)) {
      if (why === 'nothing-sold') continue;
      expect(sentence, why).not.toMatch(/failed|error|went wrong/i);
    }
  });
});
