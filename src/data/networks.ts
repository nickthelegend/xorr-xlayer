/**
 * Reading another network's executor.
 *
 * `api.ts` talks to the executor this build was made for. The Networks screen reads every executor xorr is deployed on,
 * so it asks each one directly, at paths every executor serves without a session (`/health`, `/market/tradable`,
 * `/yield/supply`). No token goes with them: a session belongs to one deployment, and none of these reads needs one.
 *
 * Bounded more tightly than a screen's own reads, because a list of networks should show the ones that answered and say
 * which did not rather than wait out the slowest.
 */
import { ApiError, TimedOut } from './apiError';
import type { Health, TradableToken } from './system';
import type { NetworkRead } from '@/networks/status';

export const NETWORK_READ_MS = 15_000;

async function readJson<T>(base: string, path: string, ms: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    // A health check answers 503 with its whole report when a critical dependency is down, and the report is the answer.
    const healthReport = path === '/health' && res.status === 503 && typeof body === 'object' && body !== null;
    if (!res.ok && !healthReport) {
      throw new ApiError(res.status, `${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`, body);
    }
    return body as T;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new TimedOut(path, ms);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const settle = <T>(read: Promise<T>): Promise<T | Error> =>
  read.catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));

/** What one executor answers at its public paths, each read on its own so one failure does not hide the rest. */
export async function readNetwork(api: string, ms: number = NETWORK_READ_MS): Promise<NetworkRead> {
  const [health, tradable, yieldSupply] = await Promise.all([
    settle(readJson<Health>(api, '/health', ms)),
    settle(readJson<TradableToken[]>(api, '/market/tradable', ms)),
    settle(readJson<{ availableHere?: boolean } | null>(api, '/yield/supply', ms)),
  ]);
  return { health, tradable, yieldSupply };
}
