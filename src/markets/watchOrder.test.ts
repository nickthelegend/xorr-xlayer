/**
 * Keeping someone's watchlist order across a list that moves underneath it.
 *
 * `/market/watchable` is what a strategy can follow on this network, so it gains and loses rows as
 * the executor's coverage changes. The two ways to get this wrong are opposite, and both are here:
 * losing an arrangement because an upstream had a bad hour, and hiding a market the executor has
 * just started supporting.
 */
import { describe, expect, it } from 'vitest';
import { applyOrder, canMove, move, orderChanged, orderToSave } from './watchOrder';

describe('applying a saved order', () => {
  it('puts the saved symbols in their saved order', () => {
    expect(applyOrder(['A', 'B', 'C'], ['C', 'A', 'B'])).toEqual(['C', 'A', 'B']);
  });

  it('appends anything watchable the user has never ordered', () => {
    // A market the executor just started supporting must be visible, not hidden until someone
    // thinks to re-save.
    expect(applyOrder(['A', 'B', 'NEW'], ['B', 'A'])).toEqual(['B', 'A', 'NEW']);
  });

  it('keeps the executor’s own order for the unordered remainder', () => {
    // Not alphabetical: a second sort would make a newly-supported market harder to spot.
    expect(applyOrder(['Z', 'Y', 'X'], [])).toEqual(['Z', 'Y', 'X']);
  });

  it('skips a saved symbol that is not watchable right now', () => {
    expect(applyOrder(['A', 'C'], ['C', 'GONE', 'A'])).toEqual(['C', 'A']);
  });

  it('never repeats a symbol saved twice', () => {
    expect(applyOrder(['A', 'B'], ['A', 'A', 'B'])).toEqual(['A', 'B']);
  });

  it('shows the whole list when nothing is saved', () => {
    expect(applyOrder(['A', 'B'], [])).toEqual(['A', 'B']);
  });

  it('shows nothing when the executor can follow nothing', () => {
    // A saved order is a preference applied to the live list, never a copy of it.
    expect(applyOrder([], ['A', 'B'])).toEqual([]);
  });
});

describe('moving one row', () => {
  const order = ['A', 'B', 'C'];

  it('moves it up one place', () => {
    expect(move(order, 'B', 'up')).toEqual(['B', 'A', 'C']);
  });

  it('moves it down one place', () => {
    expect(move(order, 'B', 'down')).toEqual(['A', 'C', 'B']);
  });

  it('does not wrap at the top', () => {
    // Wrapping from the top to the bottom is never what someone tapping "up" means.
    expect(move(order, 'A', 'up')).toEqual(order);
  });

  it('does not wrap at the bottom', () => {
    expect(move(order, 'C', 'down')).toEqual(order);
  });

  it('leaves a symbol that is not in the list alone', () => {
    expect(move(order, 'NOPE', 'up')).toEqual(order);
  });

  it('does not mutate what it was given', () => {
    const before = [...order];
    move(order, 'B', 'up');
    expect(order).toEqual(before);
  });
});

describe('whether a control should be offered', () => {
  const order = ['A', 'B', 'C'];

  it('refuses up at the top and down at the bottom', () => {
    // Disabled rather than a no-op: a control that does nothing when tapped reads as broken.
    expect(canMove(order, 'A', 'up')).toBe(false);
    expect(canMove(order, 'C', 'down')).toBe(false);
  });

  it('allows the moves that would do something', () => {
    expect(canMove(order, 'A', 'down')).toBe(true);
    expect(canMove(order, 'B', 'up')).toBe(true);
    expect(canMove(order, 'C', 'up')).toBe(true);
  });

  it('refuses both for a symbol that is not there', () => {
    expect(canMove(order, 'NOPE', 'up')).toBe(false);
    expect(canMove(order, 'NOPE', 'down')).toBe(false);
  });

  it('refuses both when there is only one row', () => {
    expect(canMove(['A'], 'A', 'up')).toBe(false);
    expect(canMove(['A'], 'A', 'down')).toBe(false);
  });
});

describe('whether to write at all', () => {
  it('says no when the order is what is already stored', () => {
    // Every tap would otherwise be a write.
    expect(orderChanged(['A', 'B'], ['A', 'B'])).toBe(false);
  });

  it('says yes when the order differs', () => {
    expect(orderChanged(['A', 'B'], ['B', 'A'])).toBe(true);
  });

  it('says yes when the length differs', () => {
    expect(orderChanged(['A'], ['A', 'B'])).toBe(true);
    expect(orderChanged(['A', 'B'], ['A'])).toBe(true);
  });
});

describe('what gets persisted after a move', () => {
  it('is the arrangement the user can see', () => {
    expect(orderToSave(['B', 'A'], ['A', 'B'], ['A', 'B'])).toEqual(['B', 'A']);
  });

  it('keeps a symbol they ordered that is not watchable right now', () => {
    /*
     * Dropping it would quietly discard part of someone's arrangement because an upstream had a bad
     * hour — and they would only find out by noticing the order was wrong afterwards.
     */
    expect(orderToSave(['C', 'A'], ['A', 'GONE', 'C'], ['A', 'C'])).toContain('GONE');
  });

  it('keeps an absent symbol near where it was, not at the end', () => {
    // It was second; it comes back second when the executor offers it again.
    expect(orderToSave(['A', 'C'], ['A', 'GONE', 'C'], ['A', 'C'])).toEqual(['A', 'GONE', 'C']);
  });

  it('puts one saved before everything at the front', () => {
    expect(orderToSave(['A', 'C'], ['GONE', 'A', 'C'], ['A', 'C'])).toEqual(['GONE', 'A', 'C']);
  });

  it('restores the arrangement once the symbol is watchable again', () => {
    // The round trip: save with a gap, then the executor offers it again.
    const saved = orderToSave(['A', 'C'], ['A', 'GONE', 'C'], ['A', 'C']);
    expect(applyOrder(['A', 'GONE', 'C'], saved)).toEqual(['A', 'GONE', 'C']);
  });
});
