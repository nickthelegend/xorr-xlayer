/**
 * Deterministic randomness from a string.
 *
 * An agent's face is part of its identity, so it has to be the same drawing on every screen, every
 * device and every reload. Nothing here touches `Math.random`: one seed always walks one sequence.
 */

/**
 * The form a name is compared in.
 *
 * "Momentum Scout", " momentum scout" and "Momentum  Scout" are one agent. Hashing them raw would
 * give the same agent three faces depending on where the string came from.
 */
export function normaliseSeed(seed: string): string {
  return seed.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** FNV-1a, 32-bit, over the normalised seed. Cheap, stable, and spreads near-identical names apart. */
export function hashSeed(seed: string): number {
  const s = normaliseSeed(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 seeded from the name. Good enough to choose features; not for anything secret. */
export function seededRandom(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One item from a non-empty list. */
export function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length) % items.length]!;
}
