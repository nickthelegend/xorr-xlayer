import { describe, expect, it, vi, beforeEach } from 'vitest';

const readMintScaleMock = vi.fn();

vi.mock('../solana/balances.js', () => ({
  readMintScale: (mint: string) => readMintScaleMock(mint),
}));

const { corporateAction } = await import('./corporate-action.js');
const { XSTOCKS } = await import('../venues/xstocks.js');

const NVDAX = XSTOCKS.NVDAx!.address;
const HOUR = 3_600_000;

describe('corporate action, read off the mint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readMintScaleMock.mockResolvedValue({ decimals: 8, multiplier: 1, pending: null });
  });

  it('reports nothing queued as a real answer, with the multiplier in force', async () => {
    const notice = await corporateAction('NVDAx');
    expect(notice.status).toBe('none');
    expect(notice.multiplier).toBe(1);
    expect(notice.pending).toBeNull();
  });

  it('reports a queued change with the ratio a holding gets restated by', async () => {
    const at = Date.now() + 30 * HOUR;
    readMintScaleMock.mockResolvedValue({
      decimals: 8,
      multiplier: 1,
      pending: { nextMultiplier: 2, effectiveAtMs: at },
    });

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
    readMintScaleMock.mockResolvedValue({
      decimals: 8,
      multiplier: 2,
      pending: { nextMultiplier: 4, effectiveAtMs: Date.now() + 10 * HOUR },
    });

    const notice = await corporateAction('NVDAx');
    expect(notice.pending?.ratio).toBe(2);
    expect(notice.multiplier).toBe(2);
  });

  it('calls a shrinking multiplier a decrease', async () => {
    readMintScaleMock.mockResolvedValue({
      decimals: 8,
      multiplier: 1,
      pending: { nextMultiplier: 0.5, effectiveAtMs: Date.now() + 10 * HOUR },
    });

    const notice = await corporateAction('NVDAx');
    expect(notice.pending?.direction).toBe('decrease');
    expect(notice.pending?.ratio).toBe(0.5);
  });

  it('accepts the Base spelling and answers about the same company', async () => {
    const notice = await corporateAction('NVDAc');
    expect(notice.symbol).toBe('NVDAx');
    expect(readMintScaleMock).toHaveBeenCalledWith(NVDAX);
  });

  /*
   * "Nothing is coming" and "we could not find out" are different claims. A screen that shows the
   * first when it means the second is telling the user something nobody checked.
   */
  it('says unavailable, not none, when the mint cannot be read', async () => {
    readMintScaleMock.mockRejectedValue(new Error('cluster did not answer'));

    const notice = await corporateAction('NVDAx');
    expect(notice.status).toBe('unavailable');
    expect(notice.multiplier).toBeNull();
    if (notice.status === 'unavailable') expect(notice.reason).toBe('unreadable');
  });

  it('says unavailable for something that is not a tokenized equity at all', async () => {
    const notice = await corporateAction('WETH');
    expect(notice.status).toBe('unavailable');
    if (notice.status === 'unavailable') expect(notice.reason).toBe('not_tokenized');
    expect(readMintScaleMock).not.toHaveBeenCalled();
  });
});
