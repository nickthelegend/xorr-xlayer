/**
 * The markets someone looked at recently.
 *
 * Search opened on the first twelve of whatever the catalogue listed, which is a sample of a list
 * rather than a starting point. Almost every search in a trading app is a repeat of an earlier one.
 */
import { describe, expect, it } from 'vitest';
import { MAX_RECENTS, openingList, remember, visibleRecents } from './recents';

const KNOWN = new Set(['NVDAx', 'TSLAx', 'AAPLx', 'XBTC', 'BTC', 'SPYx', 'MSFTx', 'AMZNx']);

describe('recording a visit', () => {
  it('puts the newest first', () => {
    expect(remember(['XBTC'], 'NVDAx')).toEqual(['NVDAx', 'XBTC']);
  });

  it('moves a repeat to the front rather than adding it twice', () => {
    // The same symbol twice would push something genuinely different off the end.
    expect(remember(['XBTC', 'NVDAx', 'BTC'], 'NVDAx')).toEqual(['NVDAx', 'XBTC', 'BTC']);
  });

  it('keeps the list short enough to stay a shortcut', () => {
    let recents: string[] = [];
    for (const s of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) recents = remember(recents, s);
    expect(recents).toHaveLength(MAX_RECENTS);
    expect(recents[0]).toBe('H');
    // The oldest fell off, not the newest.
    expect(recents).not.toContain('A');
  });

  it('ignores an empty symbol', () => {
    expect(remember(['XBTC'], '   ')).toEqual(['XBTC']);
    expect(remember(['XBTC'], '')).toEqual(['XBTC']);
  });

  it('does not mutate what it was given', () => {
    const before = ['XBTC'];
    remember(before, 'NVDAx');
    expect(before).toEqual(['XBTC']);
  });
});

describe('which recents are worth showing', () => {
  it('drops one the catalogue no longer has', () => {
    // Tapping it would open a screen about an asset that is not there.
    expect(visibleRecents(['NVDAx', 'DELISTED'], KNOWN)).toEqual(['NVDAx']);
  });

  it('keeps the dropped one in storage, so it returns if the market does', () => {
    const stored = ['NVDAx', 'GONE'];
    visibleRecents(stored, KNOWN);
    expect(stored).toContain('GONE');
    expect(visibleRecents(stored, new Set([...KNOWN, 'GONE']))).toEqual(['NVDAx', 'GONE']);
  });

  it('shows nothing when none of them are known', () => {
    expect(visibleRecents(['GONE'], KNOWN)).toEqual([]);
  });
});

describe('what the screen opens on', () => {
  const catalogue = ['XBTC', 'BTC', 'NVDAx', 'TSLAx', 'AAPLx', 'SPYx'];

  it('puts recents first, marked as such', () => {
    const list = openingList({ recents: ['TSLAx', 'NVDAx'], catalogue, known: KNOWN, limit: 4 });
    expect(list.slice(0, 2)).toEqual([
      { symbol: 'TSLAx', recent: true },
      { symbol: 'NVDAx', recent: true },
    ]);
  });

  it('fills the rest from the catalogue, in the catalogue’s order', () => {
    const list = openingList({ recents: ['TSLAx'], catalogue, known: KNOWN, limit: 4 });
    expect(list.map((r) => r.symbol)).toEqual(['TSLAx', 'XBTC', 'BTC', 'NVDAx']);
  });

  it('never repeats a recent further down', () => {
    const list = openingList({ recents: ['NVDAx'], catalogue, known: KNOWN, limit: 6 });
    expect(list.filter((r) => r.symbol === 'NVDAx')).toHaveLength(1);
  });

  it('shows more than recents, always', () => {
    /*
     * A list of nothing but the last six markets would make the search screen useless for finding a
     * seventh, which is the one thing it exists for.
     */
    const list = openingList({ recents: ['NVDAx'], catalogue, known: KNOWN, limit: 5 });
    expect(list.some((r) => !r.recent)).toBe(true);
  });

  it('shows every recent even when they outnumber the limit', () => {
    // Truncating the recents to make room for the catalogue would drop the most useful rows first.
    const recents = ['XBTC', 'BTC', 'NVDAx', 'TSLAx'];
    const list = openingList({ recents, catalogue, known: KNOWN, limit: 2 });
    expect(list.filter((r) => r.recent).map((r) => r.symbol)).toEqual(recents);
  });

  it('is just the catalogue when there are no recents', () => {
    const list = openingList({ recents: [], catalogue, known: KNOWN, limit: 3 });
    expect(list).toEqual([
      { symbol: 'XBTC', recent: false },
      { symbol: 'BTC', recent: false },
      { symbol: 'NVDAx', recent: false },
    ]);
  });
});
