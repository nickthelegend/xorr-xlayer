/**
 * The line must be absent, not zero, when nothing was measured.
 *
 * `yieldLine` returning null is what makes that structural: a caller cannot accidentally render
 * "0.00%" for a window nobody watched, because there is no string to render.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { fetchYield, yieldLine } from './dividendYield';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const MEASURED = {
  status: 'measured' as const,
  symbol: 'NVDAx',
  yieldFraction: 0.004004,
  annualisedFraction: 0.0366,
  observations: 12,
  from: '2026-08-01T00:00:00Z',
  to: '2026-09-17T00:00:00Z',
  days: 47,
  excluded: [],
};

describe('the yield line', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('draws nothing at all when nothing was measured', () => {
    expect(yieldLine({ status: 'unmeasured', symbol: 'NVDAx', reason: 'no readings' })).toBeNull();
  });

  it('states the window alongside the number', () => {
    const line = yieldLine(MEASURED)!;
    expect(line).toMatch(/0\.40% reinvested over 47 days/);
    expect(line).toMatch(/3\.66% annualised/);
  });

  it('omits the annualised figure when the window is too short for one', () => {
    const line = yieldLine({ ...MEASURED, annualisedFraction: null, days: 4 })!;
    expect(line).toMatch(/over 4 days/);
    expect(line).not.toMatch(/annualised/);
  });

  it('keeps unmeasured distinct from zero when the executor is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const w = await fetchYield('NVDAx');

    expect(w.status).toBe('unmeasured');
    // Nothing a screen could render as a measured figure.
    expect(yieldLine(w)).toBeNull();
    expect(JSON.stringify(w)).not.toMatch(/yieldFraction/);
  });

  it('reports the executor’s status when it refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const w = await fetchYield('NVDAx');
    if (w.status !== 'unmeasured') throw new Error('expected unmeasured');
    expect(w.reason).toMatch(/503/);
  });

  it('carries a real unmeasured reason through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({
      status: 'unmeasured', symbol: 'NVDAx',
      reason: 'Only one multiplier reading is on record.',
    })));
    const w = await fetchYield('NVDAx');
    if (w.status !== 'unmeasured') throw new Error('expected unmeasured');
    expect(w.reason).toMatch(/Only one multiplier reading/);
  });

  it('refuses a measured body whose yield is not a number', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ ...MEASURED, yieldFraction: 'lots' })));
    expect((await fetchYield('NVDAx')).status).toBe('unmeasured');
  });

  it('passes a measured window through with its excluded corporate actions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({
      ...MEASURED,
      excluded: [{ from: 1, to: 4, factor: 4, at: '2026-09-01T00:00:00Z', reason: 'split, not income' }],
    })));
    const w = await fetchYield('NVDAx');
    if (w.status !== 'measured') throw new Error('expected measured');
    // The split is visible rather than silently dropped from the figure.
    expect(w.excluded).toHaveLength(1);
    expect(w.excluded[0]!.factor).toBe(4);
  });
});
