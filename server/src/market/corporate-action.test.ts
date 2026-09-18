import { describe, expect, it, vi, beforeEach } from 'vitest';

// The database is never reached here; mocked so importing the registry does not need a configured chain.
vi.mock('../db/index.js', () => ({ query: vi.fn(async () => []) }));

const readMultiplierMock = vi.fn();

vi.mock('../venues/multiplier.js', () => ({
  readMultiplier: (token: { address: string }) => readMultiplierMock(token.address),
}));

/** A reading as `venues/multiplier.ts` returns it: the multiplier in force and any schedule. */
function reading(multiplier: number, pending: { nextMultiplier: number; effectiveAtMs: number } | null = null) {
  return {
    symbol: 'NVDAx',
    multiplier,
    exact: String(multiplier),
    decimals: 18,
    pending: pending && {
      multiplier: pending.nextMultiplier,
      exact: String(pending.nextMultiplier),
      effectiveAtMs: pending.effectiveAtMs,
      effectiveAt: new Date(pending.effectiveAtMs).toISOString(),
    },
  };
}

const { corporateAction } = await import('./corporate-action.js');
const { XSTOCKS } = await import('../venues/xstocks.js');

const NVDAX = XSTOCKS.NVDAx!.address;
const HOUR = 3_600_000;

describe('corporate action, read off the token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readMultiplierMock.mockResolvedValue(reading(1));
  });

  it('reports nothing queued as a real answer, with the multiplier in force', async () => {
    const notice = await corporateAction('NVDAx');
    expect(notice.status).toBe('none');
    expect(notice.multiplier).toBe(1);
    expect(notice.pending).toBeNull();
  });

  it('reports a queued change with the ratio a holding gets restated by', async () => {
    const at = Date.now() + 30 * HOUR;
    readMultiplierMock.mockResolvedValue(reading(1, { nextMultiplier: 2, effectiveAtMs: at }));

    const notice = await corporateAction('NVDAx');
    expect(notice.status).toBe('scheduled');
    expect(notice.pending).toEqual({
      nextMultiplier: 2,
      effectiveAtMs: at,
      ratio: 2,
      direction: 'increase',
    });
  });

  /*
   * A mint that has already split sits above 1, and the next action is measured from there. Reading
   * `nextMultiplier` as the ratio would announce a second two-for-one as a four-for-one.
   */
  it('measures the ratio from the multiplier in force, not from 1', async () => {
    readMultiplierMock.mockResolvedValue(reading(2, { nextMultiplier: 4, effectiveAtMs: Date.now() + 10 * HOUR }));

    const notice = await corporateAction('NVDAx');
    expect(notice.pending?.ratio).toBe(2);
    expect(notice.multiplier).toBe(2);
  });

  it('calls a shrinking multiplier a decrease', async () => {
    readMultiplierMock.mockResolvedValue(reading(1, { nextMultiplier: 0.5, effectiveAtMs: Date.now() + 10 * HOUR }));

    const notice = await corporateAction('NVDAx');
    expect(notice.pending?.direction).toBe('decrease');
    expect(notice.pending?.ratio).toBe(0.5);
  });

  it('accepts the Base spelling and answers about the same company', async () => {
    const notice = await corporateAction('NVDAc');
    expect(notice.symbol).toBe('NVDAx');
    expect(readMultiplierMock).toHaveBeenCalledWith(NVDAX);
  });

  /*
   * "Nothing is coming" and "we could not find out" are different claims. A screen that shows the
   * first when it means the second is telling the user something nobody checked.
   */
  it('says unavailable, not none, when the token cannot be read', async () => {
    readMultiplierMock.mockRejectedValue(new Error('chain did not answer'));

    const notice = await corporateAction('NVDAx');
    expect(notice.status).toBe('unavailable');
    expect(notice.multiplier).toBeNull();
    if (notice.status === 'unavailable') expect(notice.reason).toBe('unreadable');
  });

  it('says unavailable for something that is not a tokenized equity at all', async () => {
    const notice = await corporateAction('WETH');
    expect(notice.status).toBe('unavailable');
    if (notice.status === 'unavailable') expect(notice.reason).toBe('not_tokenized');
    expect(readMultiplierMock).not.toHaveBeenCalled();
  });
});
