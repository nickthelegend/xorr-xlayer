import { describe, expect, it } from 'vitest';
import { otherRoom, roomForScheme, roomToShow } from './room';

describe('roomForScheme — the phone’s appearance, as a room', () => {
  it('a light phone asks for the light room', () => {
    expect(roomForScheme('light')).toBe('light');
  });

  /*
   * Silence is not a request for the bright one. `useColorScheme` answers null on a platform that does not report it
   * and on the web before the media query resolves, and the app's own ground is black.
   */
  it('a dark phone, and a phone that will not say, get the black room', () => {
    for (const scheme of ['dark', null, undefined, 'unspecified'] as const) {
      expect(roomForScheme(scheme), String(scheme)).toBe('black');
    }
  });
});

describe('roomToShow — a choice made here outranks the phone', () => {
  it('follows the phone while nothing has been chosen', () => {
    expect(roomToShow(null, 'light')).toBe('light');
    expect(roomToShow(null, 'dark')).toBe('black');
  });

  /* Someone who tapped the button answered about THIS room, which is the narrower question. */
  it('keeps an explicit choice even when the phone disagrees, and when it changes', () => {
    expect(roomToShow('black', 'light')).toBe('black');
    for (const scheme of ['light', 'dark', null] as const) {
      expect(roomToShow('light', scheme), String(scheme)).toBe('light');
    }
  });
});

describe('otherRoom — what the button picks', () => {
  it('is always the room that is not showing', () => {
    expect(otherRoom('black')).toBe('light');
    expect(otherRoom('light')).toBe('black');
  });

  /* Whatever decided the room showing — the phone or an earlier tap — the first tap does the visible thing. */
  it('round-trips', () => {
    expect(otherRoom(otherRoom('black'))).toBe('black');
    expect(otherRoom(otherRoom('light'))).toBe('light');
  });
});
