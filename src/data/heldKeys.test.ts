/**
 * The held key has to outlive the page that made it.
 *
 * Measured on the deployed build on 2026-09-20: tap "Buy $10 of TSLAx", reload a second later while the request is
 * still in flight, then ask for the same $10 again. The second ask carried a new key, so the executor — correctly —
 * treated it as a second order. Two fills, $20 spent, for one thing the person asked for once. These pin the
 * behaviour that makes the repeat safe, and the boundaries that keep it from replaying anything else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { intentKeys } from './intentKey';
import { HELD_KEY_TTL_MS, dropHeldKey, loadHeldKey, saveHeldKey } from './heldKeys';
import { ApiError } from './apiError';

/** A localStorage that behaves, for a test environment that may not have one. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
});

describe('a key written down', () => {
  it('comes back for the same intent, and not for any other', () => {
    saveHeldKey('{"symbol":"TSLAx","usd":10}', 'key-1');
    expect(loadHeldKey('{"symbol":"TSLAx","usd":10}')).toBe('key-1');
    expect(loadHeldKey('{"symbol":"TSLAx","usd":20}')).toBeUndefined();
    expect(loadHeldKey('{"symbol":"NVDAx","usd":10}')).toBeUndefined();
  });

  it('is forgotten once it is older than the window worth replaying', () => {
    const now = Date.now();
    saveHeldKey('i', 'key-1', now);
    expect(loadHeldKey('i', now + HELD_KEY_TTL_MS - 1)).toBe('key-1');
    expect(loadHeldKey('i', now + HELD_KEY_TTL_MS + 1)).toBeUndefined();
  });

  it('is dropped on request', () => {
    saveHeldKey('i', 'key-1');
    dropHeldKey('i');
    expect(loadHeldKey('i')).toBeUndefined();
  });

  it('degrades quietly where storage refuses to work', () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: () => {
        throw new Error('private mode');
      },
      setItem: () => {
        throw new Error('private mode');
      },
      removeItem: () => {
        throw new Error('private mode');
      },
    } as unknown as Storage;
    expect(() => saveHeldKey('i', 'k')).not.toThrow();
    expect(loadHeldKey('i')).toBeUndefined();
    expect(() => dropHeldKey('i')).not.toThrow();
  });
});

describe('the same ask after a reload', () => {
  const ask = { side: 'buy', symbol: 'TSLAx', usd: 10 };

  it('carries the key the vanished page was holding, so the executor can answer with what it already did', async () => {
    const mint = vi.fn(() => `key-${mint.mock.calls.length}`);
    // The page that vanished: the request never settles, exactly as when somebody reloads mid-flight.
    const gone = intentKeys(mint);
    void gone.send(ask, () => new Promise<never>(() => {}));
    await Promise.resolve();

    // A new page, with no memory of its own.
    const fresh = intentKeys(mint);
    let carried: string | undefined;
    await fresh.send(ask, async (key) => {
      carried = key;
      return 'filled';
    });
    expect(carried).toBe('key-1');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('starts a new key once the first attempt is answered — a second ask is a second order', async () => {
    const mint = vi.fn(() => `key-${mint.mock.calls.length}`);
    const first = intentKeys(mint);
    await first.send(ask, async () => 'filled');

    const later = intentKeys(mint);
    let carried: string | undefined;
    await later.send(ask, async (key) => {
      carried = key;
      return 'filled';
    });
    expect(carried).toBe('key-2');
  });

  it('starts a new key when the outcome is known to be a refusal', async () => {
    const mint = vi.fn(() => `key-${mint.mock.calls.length}`);
    const refused = intentKeys(mint);
    await refused
      .send(ask, async () => {
        throw new ApiError(400, 'The executor refused it.', { error: 'invalid_request' });
      })
      .catch(() => undefined);

    const again = intentKeys(mint);
    let carried: string | undefined;
    await again.send(ask, async (key) => {
      carried = key;
      return 'filled';
    });
    expect(carried).toBe('key-2');
  });
});
