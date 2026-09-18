/**
 * useSeriesLayers — what a chart keeps on screen while one series gives way to the next (FEATURES.md #83).
 *
 * Switching a range redrew the chart from nothing: the old line was gone the moment the pill was pressed and the new
 * one drew itself in from the left, so every tap read as the chart reloading. A crossfade needs the series that is
 * leaving for as long as it fades, after the screen has already handed over the next one, so the chart keeps it here.
 *
 * Two slots that trade places, rather than a leaving layer and an arriving one. Each slot keeps its own opacity for
 * the life of the chart, so a series arriving mid-fade starts from where its slot really is — not from a value a
 * remount would make up, which is a frame of the new line at full strength before it starts to fade in.
 *
 * A key names the question a series answers: a symbol and a range. The same key with new values is the same series
 * updated, and it changes in place. A refresh is not a switch, and fading on every refresh would animate a price.
 */
import { useState } from 'react';

/** How far a series steps back while the next one loads: enough to read as not the answer, not so far it vanishes. */
export const PENDING_OPACITY = 0.35;

export interface Layers<T> {
  key: string;
  /** The slot holding what the screen is showing now. The other holds what it showed before, fading out. */
  front: 0 | 1;
  slots: readonly [T | null, T | null];
  /** One more for every change of key, so an effect can run once per switch. */
  generation: number;
}

export function initialLayers<T>(key: string, value: T): Layers<T> {
  return { key, front: 0, slots: [value, null], generation: 0 };
}

/** The layers after a render with `key` and `value` — the same object when nothing a viewer could see has changed. */
export function nextLayers<T>(
  layers: Layers<T>,
  key: string,
  value: T,
  same: (a: T, b: T) => boolean,
): Layers<T> {
  const shown = layers.slots[layers.front];
  if (key === layers.key) {
    if (shown !== null && same(shown, value)) return layers;
    return { ...layers, slots: layers.front === 0 ? [value, layers.slots[1]] : [layers.slots[0], value] };
  }
  const front = layers.front === 0 ? 1 : 0;
  return {
    key,
    front,
    slots: front === 0 ? [value, shown] : [shown, value],
    generation: layers.generation + 1,
  };
}

export function useSeriesLayers<T>(key: string, value: T, same: (a: T, b: T) => boolean): Layers<T> {
  const [layers, setLayers] = useState(() => initialLayers(key, value));
  const next = nextLayers(layers, key, value, same);
  /*
   * State adjusted to a new prop during render, which is React's own pattern for it: React renders again at once,
   * before anything is committed, and this render already draws `next`. Only when something changed, so it settles.
   */
  if (next !== layers) setLayers(next);
  return next;
}

/** Two lists with the same items in the same order — by `same`, or by value. */
export function sameItems<T>(
  a: readonly T[],
  b: readonly T[],
  same: (x: T, y: T) => boolean = Object.is,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!same(a[i]!, b[i]!)) return false;
  }
  return true;
}
