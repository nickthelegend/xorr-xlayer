/**
 * A duplicate submit has to read as "already", never as a second thing happening.
 */
import { describe, expect, it } from 'vitest';
import { placementOf, replayNote } from './placed';

describe('a first attempt', () => {
  it('says what was bought', () => {
    expect(placementOf({ side: 'buy', symbol: 'XBTC', units: 0.0412, replayed: false })).toEqual({
      label: 'Bought 0.0412 XBTC',
      replayed: false,
    });
  });

  it('says what was sold', () => {
    expect(placementOf({ side: 'sell', symbol: 'WOKB', units: 0.0031, replayed: false }).label).toBe(
      'Sold 0.0031 WOKB',
    );
  });

  it('has nothing extra to explain', () => {
    expect(placementOf({ side: 'buy', symbol: 'XBTC', units: 1, replayed: false }).note).toBeUndefined();
  });
});

describe('the same attempt again', () => {
  it('says already, and says nothing was placed a second time', () => {
    const p = placementOf({ side: 'buy', symbol: 'XBTC', units: 0.0412, replayed: true });
    expect(p.label).toBe('Already bought 0.0412 XBTC');
    expect(p.note).toContain('filled once');
    expect(p.note).toContain('Nothing was placed again.');
    expect(p.replayed).toBe(true);
  });

  it('never reads as a second fill', () => {
    // The failure this exists to prevent: someone who tapped again because they were not sure reads a
    // second confirmation and concludes they bought twice.
    const p = placementOf({ side: 'buy', symbol: 'XBTC', units: 0.0412, replayed: true });
    expect(p.label).not.toBe('Bought 0.0412 XBTC');
    expect(p.label.toLowerCase()).toContain('already');
  });
});

describe('a quantity that was not reported', () => {
  it('names the token rather than quoting a zero', () => {
    // A watch-mode or skipped run reports no units, and "Bought 0.0000 XBTC" would be a false number.
    expect(placementOf({ side: 'buy', symbol: 'XBTC', units: undefined, replayed: false }).label).toBe('Bought XBTC');
    expect(placementOf({ side: 'buy', symbol: 'XBTC', units: 0, replayed: true }).label).toBe('Already bought XBTC');
  });
});

describe('a replayed refusal', () => {
  it('says which attempt the refusal belongs to', () => {
    expect(replayNote(true)).toContain('earlier attempt');
    expect(replayNote(true)).toContain('Nothing was sent again.');
  });

  it('says nothing at all on a first attempt', () => {
    expect(replayNote(false)).toBeUndefined();
  });
});
