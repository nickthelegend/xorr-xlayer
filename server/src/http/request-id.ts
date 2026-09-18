/**
 * A request id on every request, echoed back and carried into every log line it produces.
 *
 * The logs were a flat stream of `[error] ...` with no way to tell which request a line belonged
 * to, or to connect a user's "it failed at about 3pm" to anything. Under any concurrency at all —
 * a scheduler tick overlapping two API calls — the interleaved lines are unreadable.
 *
 * Honoured from the caller when they send one, so an id can span a client retry and a proxy hop
 * rather than being reinvented at every boundary.
 *
 * The same per-request scope carries whether the request has broadcast a transaction (`markBroadcast`): the only code
 * that knows is the code that sends, several calls below any route, and the idempotency layer above every route is
 * what has to be told.
 */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, Next } from 'hono';

/** What one request carries down every async path it starts. */
export type RequestScope = {
  id: string;
  /**
   * Whether this request has sent a transaction, or begun to: set by `markBroadcast`, immediately before the send.
   *
   * The idempotency layer released a key on every 5xx so that a retry would genuinely retry. That is right for a
   * request that failed before acting, and a second trade for one that broadcast and then answered 502 because its
   * receipt did not arrive in time. This is what tells the two apart (`http/idempotency.ts`).
   */
  broadcast: boolean;
  /**
   * What has to be written down before the first broadcast may go ahead. The idempotency layer sets it to record the
   * broadcast on the key's row, so a process that dies straight after sending still leaves the broadcast known.
   */
  beforeFirstBroadcast?: () => Promise<void>;
  /** That recording, once started — shared by every later broadcast in the same request. */
  recorded?: Promise<void>;
};

const store = new AsyncLocalStorage<RequestScope>();

/** The id of the request being handled on this async path, if any. */
export function currentRequestId(): string | undefined {
  return store.getStore()?.id;
}

/**
 * Say that this request is about to put a transaction on a chain. Await it immediately before the send, and let it throw.
 *
 * Every path that sends from a request calls it: the delegate's `spend` and `closePosition`, the faucet's two
 * transfers, the gas drip, the audit anchor, and the Privy policy probes. Outside a request — a scheduler tick — there
 * is no key to protect and it only returns. Inside one that holds an `Idempotency-Key`, the broadcast is recorded on the
 * key's row first; when that cannot be done — the database refused, or a retry has taken the key over — it throws and
 * nothing is sent, because a broadcast the row does not show is exactly the one a retry would repeat.
 */
export async function markBroadcast(): Promise<void> {
  const scope = store.getStore();
  if (!scope) return;
  scope.recorded ??= scope.beforeFirstBroadcast ? scope.beforeFirstBroadcast() : Promise.resolve();
  await scope.recorded;
  scope.broadcast = true;
}

/**
 * Run `fn` in this request's scope, opening one when nothing upstream did.
 *
 * `requestId` opens it for every request the server handles. A router mounted without it — a test, a script — still
 * gets one here, so a broadcast marked inside it is never marked into nothing.
 */
export function withRequestScope<T>(fn: (scope: RequestScope) => Promise<T>): Promise<T> {
  const scope = store.getStore();
  if (scope) return fn(scope);
  const opened: RequestScope = { id: randomUUID(), broadcast: false };
  return store.run(opened, () => fn(opened));
}

/**
 * Log with the current request's id attached.
 *
 * Deliberately a wrapper around `console` rather than a logging framework: the whole value here is
 * the correlation, and a dependency that has to be configured before it prints anything is a
 * dependency that gets configured wrong in the one deployment that matters.
 */
export const log = {
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
};

function emit(level: 'info' | 'warn' | 'error', args: unknown[]) {
  const id = currentRequestId();
  const prefix = id ? `[${id.slice(0, 8)}]` : '[-]';
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(prefix, ...args);
}

export async function requestId(c: Context, next: Next) {
  const incoming = c.req.header('x-request-id');
  // A client-supplied id is used, but bounded: it ends up in log lines, and an unbounded header is
  // an easy way to make those unreadable or to smuggle newlines into them.
  const id =
    incoming && /^[A-Za-z0-9_-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  c.header('x-request-id', id);
  c.set('requestId', id);
  return store.run({ id, broadcast: false }, () => next());
}
