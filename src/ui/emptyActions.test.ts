/**
 * An empty list has to have an exit, and the exit has to go somewhere.
 *
 * The second half is the one a reviewer cannot do by eye: expo-router resolves a route string at tap time, so
 * `/strategy/dca` renaming to `/strategy/recurring` leaves every CTA pointing at it silently broken until
 * someone taps one on a device. These read `app/` and check.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_LISTS, emptyList, type EmptyListKey } from './emptyActions';

const APP = path.resolve(import.meta.dirname, '../../app');

/**
 * Does expo-router have a screen for this path?
 *
 * File routing, so `/strategy/dca` is `app/strategy/dca.tsx` or `app/strategy/dca/index.tsx`. A group segment —
 * `app/(tabs)/holdings.tsx` — serves `/holdings` without appearing in the URL, so the groups are searched too.
 */
function routeExists(href: string): boolean {
  const rel = href.replace(/^\//, '');
  const groups = readdirSync(APP, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('('))
    .map((e) => e.name);
  const bases = [APP, ...groups.map((g) => path.join(APP, g))];
  return bases.some((base) =>
    ['.tsx', '.ts'].some(
      (ext) => existsSync(path.join(base, `${rel}${ext}`)) || existsSync(path.join(base, rel, `index${ext}`)),
    ),
  );
}

const keys = Object.keys(EMPTY_LISTS) as EmptyListKey[];

describe('every empty list has a next action', () => {
  it.each(keys)('%s sends somewhere that exists', (key) => {
    const copy = emptyList(key);
    expect(copy.text.trim().length, `${key} has no sentence`).toBeGreaterThan(0);
    expect(copy.actionLabel.trim().length, `${key} has no action`).toBeGreaterThan(0);
    expect(routeExists(copy.href), `${key} points at ${copy.href}, which no screen serves`).toBe(true);
  });

  it('never offers a retry as the next action', () => {
    // A failed read is not an empty list, and "Try again" belongs to `ErrorState`. A list that is genuinely
    // empty does not become less empty by being read again, so offering that is a dead end dressed as an exit.
    for (const key of keys) {
      expect(emptyList(key).actionLabel.toLowerCase(), key).not.toMatch(/try again|look again|reload|refresh/);
    }
  });

  it('writes a sentence, not a fragment', () => {
    for (const key of keys) expect(emptyList(key).text, key).toMatch(/[.!?]$/);
  });

  it('keeps the action a verb rather than a restatement of the emptiness', () => {
    for (const key of keys) expect(emptyList(key).actionLabel, key).not.toMatch(/^(No|Nothing)\b/);
  });
});
