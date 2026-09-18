/**
 * The scenario this module exists to prevent.
 *
 * A position entered at $200 with a 10% stop, through a 4:1 split, sees a mark near $50 against a
 * stored entry of $200: a 75% fall that never happened. Unadjusted, every stop on every holder of
 * that token fires on the same block. The arithmetic below is what stops that, and the refusals
 * are what stop a half-known level firing anyway.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const QUERY = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock('../db/index.js', () => ({ query: QUERY }));

const { adjustLevel, adjustLevels, resolveBasis, adjustmentNote } = await import('./multiplier-adjust.js');

const MINT = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const SET_AT = new Date('2026-09-01T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  QUERY.mockResolvedValue([]);
});

describe('scaling a level across a split', () => {
  it('quarters a $200 entry through a 4:1 split, so the stop does not fire', () => {
    // Multiplier 1 -> 4 means each displayed token is worth a quarter as much.
    expect(adjustLevel(200, 1, 4)).toBeCloseTo(50, 10);

    // The mark after the split is about $50. Against the adjusted entry that is a 0% move,
    // which is the truth; against the stored $200 it would read as -75%.
    const adjustedEntry = adjustLevel(200, 1, 4);
    expect(((50 - adjustedEntry) / adjustedEntry) * 100).toBeCloseTo(0, 6);
    expect(((50 - 200) / 200) * 100).toBeCloseTo(-75, 6);
  });

  it('raises a level through a reverse split', () => {
    expect(adjustLevel(50, 4, 1)).toBeCloseTo(200, 10);
  });

  it('leaves a level alone when nothing has moved', () => {
    expect(adjustLevel(200, 1.0017, 1.0017)).toBeCloseTo(200, 12);
  });

  it('refuses a non-positive multiplier rather than producing Infinity', () => {
    expect(() => adjustLevel(200, 0, 4)).toThrow(/positive/);
    expect(() => adjustLevel(200, 1, 0)).toThrow(/positive/);
  });
});

describe('adjustLevels', () => {
  it('restates every positive level and reports that it did', async () => {
    const res = await adjustLevels({
      levels: { entryPrice: 200, peakPrice: 260 },
      storedBasis: { multiplier: 1, recordedAt: SET_AT.toISOString() },
      mint: MINT,
      levelSetAt: SET_AT,
      currentMultiplier: 4,
    });

    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.adjusted).toBe(true);
    expect(res.factor).toBeCloseTo(0.25, 12);
    expect(res.levels.entryPrice).toBeCloseTo(50, 10);
    expect(res.levels.peakPrice).toBeCloseTo(65, 10);
    expect(res.currentMultiplier).toBe(4);
  });

  it('leaves an unset level at zero rather than scaling it into existence', async () => {
    const res = await adjustLevels({
      levels: { entryPrice: 200, peakPrice: 0 },
      storedBasis: { multiplier: 1, recordedAt: SET_AT.toISOString() },
      mint: MINT,
      levelSetAt: SET_AT,
      currentMultiplier: 4,
    });
    if (res.status !== 'ok') throw new Error('expected ok');
    // Zero means "no trailing peak yet". Scaling it would invent a level at 0.
    expect(res.levels.peakPrice).toBe(0);
  });

  it('will not fire when the multiplier cannot be read', async () => {
    const res = await adjustLevels({
      levels: { entryPrice: 200 },
      storedBasis: { multiplier: 1, recordedAt: SET_AT.toISOString() },
      mint: MINT,
      levelSetAt: SET_AT,
      currentMultiplier: null,
    });
    expect(res.status).toBe('unsafe');
    if (res.status !== 'unsafe') return;
    expect(res.reason).toMatch(/could not be read/i);
  });

  it('reports no adjustment when the multiplier is unchanged', async () => {
    const res = await adjustLevels({
      levels: { entryPrice: 200 },
      storedBasis: { multiplier: 1.0017, recordedAt: SET_AT.toISOString() },
      mint: MINT,
      levelSetAt: SET_AT,
      currentMultiplier: 1.0017,
    });
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(res.adjusted).toBe(false);
    expect(res.levels.entryPrice).toBeCloseTo(200, 10);
  });
});

describe('establishing a basis without one stored', () => {
  it('refuses when we have never recorded a multiplier for the token', async () => {
    QUERY.mockResolvedValue([]);
    const res = await resolveBasis({ mint: MINT, levelSetAt: SET_AT, currentMultiplier: 4 });

    expect(res.status).toBe('unsafe');
    if (res.status !== 'unsafe') return;
    expect(res.reason).toMatch(/cannot be ruled out/);
  });

  it('refuses when our history begins after the level was set', async () => {
    QUERY.mockResolvedValue([{ multiplier: '1', observed_at: new Date('2026-09-10T00:00:00Z') }]);
    const res = await resolveBasis({ mint: MINT, levelSetAt: SET_AT, currentMultiplier: 1 });

    // A split could have happened in the gap and we would never know.
    expect(res.status).toBe('unsafe');
  });

  it('adopts today’s multiplier when we watched the whole period and it never moved', async () => {
    QUERY.mockResolvedValue([{ multiplier: '1.0017', observed_at: new Date('2026-08-01T00:00:00Z') }]);
    const res = await resolveBasis({ mint: MINT, levelSetAt: SET_AT, currentMultiplier: 1.0017 });

    expect(res.status).toBe('adopted');
    if (res.status !== 'adopted') return;
    expect(res.basis.multiplier).toBe(1.0017);
  });

  it('uses the earliest observed multiplier when it has moved during our watch', async () => {
    QUERY.mockResolvedValue([{ multiplier: '1', observed_at: new Date('2026-08-01T00:00:00Z') }]);
    const res = await resolveBasis({ mint: MINT, levelSetAt: SET_AT, currentMultiplier: 4 });

    expect(res.status).toBe('adopted');
    if (res.status !== 'adopted') return;
    expect(res.basis.multiplier).toBe(1);
  });

  it('prefers a stored basis over anything inferred', async () => {
    QUERY.mockResolvedValue([{ multiplier: '9', observed_at: new Date('2026-08-01T00:00:00Z') }]);
    const res = await resolveBasis({
      storedBasis: { multiplier: 2, recordedAt: SET_AT.toISOString() },
      mint: MINT,
      levelSetAt: SET_AT,
      currentMultiplier: 4,
    });
    expect(res.status).toBe('known');
    if (res.status !== 'known') return;
    expect(res.basis.multiplier).toBe(2);
  });
});

describe('what the user is told', () => {
  it('names a split and a reverse split correctly', () => {
    expect(adjustmentNote('NVDAx', 0.25)).toMatch(/went through a split/);
    expect(adjustmentNote('NVDAx', 4)).toMatch(/reverse split/);
  });
});
