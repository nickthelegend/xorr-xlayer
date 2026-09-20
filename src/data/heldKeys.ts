/**
 * A held idempotency key, kept somewhere a page reload cannot take it.
 *
 * `intentKey.ts` holds a key while an attempt's outcome is unknown, so the same ask tapped again after a timeout
 * carries the same key and the executor answers with what it already did. That held key lived in React state, and a
 * reload is exactly what somebody does when a request seems stuck: measured on the deployed build on 2026-09-20 —
 * tap Buy $10, reload a second later, ask for the same $10 again — the second ask carried a new key and the executor,
 * correctly, treated it as a second order. Two fills, $20 spent, for one thing the person asked for once.
 *
 * So the held key is written down. The rules are the ones `intentKey.ts` already states:
 *
 *   - One entry per intent, so another amount or another token is another key and can never replay this one.
 *   - Dropped the moment an outcome is known, by the same code that drops the in-memory one.
 *   - Short-lived. The executor keeps a stored answer for a day; a key worth replaying is one from minutes ago, not
 *     hours, and an entry past its window is ignored and removed.
 *
 * Storage is best-effort by design: a browser in private mode throws on access, and a wallet that cannot write this
 * down is no worse off than before — it falls back to holding the key in memory alone.
 */

/** How long a held key is worth replaying. Long enough to cover a slow fill and a reload; far short of a day. */
export const HELD_KEY_TTL_MS = 30 * 60_000;

const PREFIX = 'xorr:held-key:';

type Stored = { key: string; at: number };

/** The browser's own storage, or nothing on a platform (or a privacy mode) that does not offer it. */
function store(): Storage | undefined {
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** The key held for this intent, if one was written down recently enough to still mean something. */
export function loadHeldKey(intent: string, now: number = Date.now()): string | undefined {
  const s = store();
  if (!s) return undefined;
  try {
    const raw = s.getItem(PREFIX + intent);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (typeof parsed?.key !== 'string' || typeof parsed?.at !== 'number') return undefined;
    if (now - parsed.at > HELD_KEY_TTL_MS) {
      s.removeItem(PREFIX + intent);
      return undefined;
    }
    return parsed.key;
  } catch {
    return undefined;
  }
}

export function saveHeldKey(intent: string, key: string, now: number = Date.now()): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(PREFIX + intent, JSON.stringify({ key, at: now } satisfies Stored));
  } catch {
    // Out of quota, or a mode that refuses to write. The key still lives in memory for this page.
  }
}

export function dropHeldKey(intent: string): void {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(PREFIX + intent);
  } catch {
    // Nothing to do: an entry that cannot be removed will expire on its own.
  }
}
