/**
 * Is the executor answering at all, and which chain does it say it serves?
 *
 * Lives in the data layer because that is where network access lives — the repository-boundary
 * test enforces it, and the rule is a good one: a component that reaches the network directly is
 * a component nobody can test without a server. `Reachability` composes this into a heartbeat;
 * the request itself belongs here.
 *
 * `/health` and not a real route, so this reports on the NETWORK rather than the session. A
 * signed-out user is not offline, and telling them they are would be its own wrong answer.
 *
 * The chain comes back from the same request. It was being asked for twice a minute already and the answer
 * carries `chain` (`server/src/routes/ops.ts`), so checking that the executor serves the chain this build
 * signs on costs nothing beyond reading a field that was on the wire the whole time.
 */
import { API_BASE } from './apiBase';

export type HealthBeat = {
  /** The executor answered its health check. */
  reachable: boolean;
  /**
   * The upstream hosts its circuit breakers have shut out right now (`server/src/http/get.ts`).
   *
   * While one is open, prices and quotes are being answered from fewer sources — which the app says rather
   * than letting the gaps look like nothing being priced. Empty where the executor did not report any, and
   * also where it is too old to have the field: an absent list is not a claim that none is open, but it is
   * the only honest thing to draw.
   */
  breakers: readonly { host: string; failures: number; openUntil: number; open?: boolean }[];
  /**
   * The chain key it says it serves, where it said one.
   *
   * Undefined covers two different things, and both have to be treated the same way: an executor older than
   * the field, and an executor that did not answer at all. Neither is evidence of a mismatch.
   */
  chain?: string;
};

export async function executorHealth(): Promise<HealthBeat> {
  try {
    const res = await fetch(`${API_BASE}/health`, { method: 'GET' });
    /*
     * A 503 still carries the report. `/health` answers 503 when a critical dependency is down, and its body
     * is the whole thing — chain included. Reading the chain only from a 200 would drop the check exactly
     * when a deployment is in the state most likely to have been pointed somewhere new.
     */
    const body = (await res.json().catch(() => undefined)) as
      | { chain?: unknown; breakers?: unknown }
      | undefined;
    return {
      reachable: res.ok,
      chain: typeof body?.chain === 'string' && body.chain.trim() ? body.chain.trim() : undefined,
      breakers: breakersOf(body?.breakers),
    };
  } catch {
    return { reachable: false, breakers: [] };
  }
}

/** The breakers as the executor reported them, keeping only rows that are the shape this expects. */
function breakersOf(value: unknown): HealthBeat['breakers'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (row === null || typeof row !== 'object') return [];
    const b = row as { host?: unknown; failures?: unknown; openUntil?: unknown; open?: unknown };
    if (typeof b.host !== 'string' || !b.host) return [];
    return [
      {
        host: b.host,
        failures: typeof b.failures === 'number' ? b.failures : 0,
        openUntil: typeof b.openUntil === 'number' ? b.openUntil : 0,
        open: typeof b.open === 'boolean' ? b.open : undefined,
      },
    ];
  });
}

/** Just the reachability, for the callers that only ever wanted that. */
export async function executorReachable(): Promise<boolean> {
  return (await executorHealth()).reachable;
}
