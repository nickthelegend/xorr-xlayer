/**
 * The off-hours guard's second opinion: xStocks' share price for the same xStock on Solana, times the X Layer
 * wrapper's multiplier. Anything missing is null — the guard then holds rather than trading on an unchecked price.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getJson = vi.fn();
const reading = vi.fn();
vi.mock('../http/get.js', () => ({ getJson: (...a: unknown[]) => getJson(...a) }));
vi.mock('../venues/multiplier.js', () => ({ readMultiplierOrNull: (s: string) => reading(s) }));

const { referencePriceUsd } = await import('./nasdaq.js');

const SPYX_MINT = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';

beforeEach(() => {
  getJson.mockReset();
  reading.mockReset();
});

describe('referencePriceUsd', () => {
  it('is the share price times the wrapper multiplier', async () => {
    getJson.mockResolvedValue({ [SPYX_MINT]: { usdPrice: 757, stockData: { price: 761.34 } } });
    reading.mockResolvedValue({ multiplier: 1.005714560286254 });
    const px = await referencePriceUsd('SPYx');
    expect(px).toBeCloseTo(765.69, 2);
    expect(getJson.mock.calls[0]?.[0]).toContain(SPYX_MINT);
    // One attempt: a reference is a guard input, never worth a price's retry ladder.
    expect(getJson.mock.calls[0]?.[4]).toEqual({ attempts: 1 });
  });

  it('is null when Jupiter answers without a share price — never its pool price in its place', async () => {
    getJson.mockResolvedValue({ [SPYX_MINT]: { usdPrice: 757 } });
    reading.mockResolvedValue({ multiplier: 1 });
    expect(await referencePriceUsd('SPYx')).toBeNull();
  });

  it('is null when the wrapper multiplier cannot be read', async () => {
    getJson.mockResolvedValue({ [SPYX_MINT]: { stockData: { price: 761.34 } } });
    reading.mockResolvedValue(null);
    expect(await referencePriceUsd('SPYx')).toBeNull();
  });

  it('is null when Jupiter does not answer', async () => {
    getJson.mockRejectedValue(new Error('timeout'));
    reading.mockResolvedValue({ multiplier: 1 });
    expect(await referencePriceUsd('SPYx')).toBeNull();
  });

  it('is null for a symbol that is not an xStock, without asking anyone', async () => {
    expect(await referencePriceUsd('BTC')).toBeNull();
    expect(getJson).not.toHaveBeenCalled();
  });
});
