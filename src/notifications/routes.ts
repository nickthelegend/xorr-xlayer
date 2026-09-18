/**
 * The routing half of notifications, split out so it is testable on Node without the native
 * expo-notifications module. PLAN.md 12.19 / 10.10.
 */
export type AlertKind =
  | 'price'
  | 'earnings'
  | 'daily-cap'
  | 'drawdown'
  | 'staking-unlock'
  | 'proposal-awaiting'
  | 'dca-executed'
  | 'strategy-blocked'
  /*
   * The executor's own names for three pushes it sends that the design's list never had: an alert you
   * set went off, a flatten you asked for finished, a withdrawal address was added or removed
   * (`server/src/notifications/push.ts`, `server/src/withdrawals/allowlist.ts`).
   */
  | 'alert-fired'
  | 'panic-flatten'
  | 'allowlist-changed';

/**
 * Which alerts are INTERRUPTIONS the user may mute.
 *
 * All of them but one — because screens.md screen 18 draws the line elsewhere: "Circuit breakers stay
 * on even when notifications are muted. They stop trading, not just your phone." The breaker lives in
 * the server's rule engine and is deliberately not represented in this file.
 *
 * The one is an allowlist change, which the executor sends whatever the settings say and offers no
 * switch for: a new address waits out its cooling-off so that this arrives while it can still be removed.
 */
export const MUTABLE: Record<Exclude<AlertKind, 'allowlist-changed'>, boolean> = {
  price: true,
  earnings: true,
  'daily-cap': true,
  drawdown: true,
  'staking-unlock': true,
  'proposal-awaiting': true,
  'dca-executed': true,
  'strategy-blocked': true,
  'alert-fired': true,
  'panic-flatten': true,
};

export function routeFor(kind: AlertKind): string {
  switch (kind) {
    case 'proposal-awaiting':
      return '/bot';
    case 'dca-executed':
    case 'strategy-blocked':
    case 'panic-flatten':
      return '/activity';
    case 'daily-cap':
    case 'drawdown':
      return '/safety';
    case 'staking-unlock':
      return '/strategies';
    case 'price':
    case 'earnings':
    case 'alert-fired':
      return '/alerts';
    case 'allowlist-changed':
      return '/allowlist';
  }
}

/**
 * What a push carries besides its words.
 *
 * `route` and `kind` are set by `notifications/push.ts` on every message; the rest is whatever the
 * sending site knew. `seq` is the audit row's own id — the same string `/activity` puts on a row —
 * and `symbol` is the instrument. Both are optional because an older executor sends neither, and a
 * tap must still land somewhere sensible when they are missing.
 */
export type PushPayload = {
  route?: unknown;
  kind?: unknown;
  /** The audit row this push is about. */
  seq?: unknown;
  /** The instrument it is about. */
  symbol?: unknown;
  [key: string]: unknown;
};

/** Where a tap goes when the payload says nothing this app can use. */
const FALLBACK = '/activity';

/**
 * A symbol safe to put in a path segment.
 *
 * A push payload is not this app's own data — it arrives from outside — and it is handed straight
 * to the router. Anything that is not a plain ticker is refused rather than escaped, because there
 * is no legitimate symbol this rejects and no way to be sure what an escaped one would route to.
 */
function tickerIn(payload: PushPayload): string | null {
  const symbol = payload.symbol;
  if (typeof symbol !== 'string') return null;
  return /^[A-Za-z0-9]{1,12}$/.test(symbol) ? symbol : null;
}

/** The audit row's id, which `/activity` derives from a bigint sequence. Digits or nothing. */
function rowIn(payload: PushPayload): string | null {
  const seq = payload.seq;
  if (typeof seq === 'number') return Number.isSafeInteger(seq) && seq > 0 ? String(seq) : null;
  if (typeof seq !== 'string') return null;
  return /^[0-9]{1,19}$/.test(seq) ? seq : null;
}

/** The screen route the executor itself named, if it named one this app recognises. */
function sentRoute(payload: PushPayload): string | null {
  const route = payload.route;
  // A path and nothing else: no scheme, no host, no `..`. A push must not be able to send the app
  // anywhere the app did not already have a screen for.
  if (typeof route !== 'string') return null;
  return /^\/[A-Za-z0-9/_\-[\]?=&.]*$/.test(route) && !route.includes('..') ? route : null;
}

/**
 * Which kinds are ABOUT an instrument rather than about something that happened.
 *
 * An alert is a statement about a price — the useful place to land is the asset it names, where the
 * chart and the buy are. A fill is an event, and the useful place to land is the row that records
 * it. Getting this backwards would put someone on a chart when they wanted the receipt.
 */
const ABOUT_AN_ASSET = new Set<string>(['price', 'earnings', 'alert-fired']);

/**
 * Which kinds ARE an audit row, so a row id addresses the thing the push is about.
 *
 * `routeFor` already sends all three to `/activity`. The difference is that this can open the list
 * ON the row instead of at the top of a hundred of them, which is the whole distance between a
 * notification that told you something and one that took you to it.
 */
const IS_AN_AUDIT_ROW = new Set<string>(['dca-executed', 'strategy-blocked', 'panic-flatten']);

/**
 * Where a tapped notification should open.
 *
 * `routeFor` answers with a SCREEN — the list a kind belongs to — and that was as far as a tap could
 * ever get: "Bought 0.1234 NVDAx" opened the top of an activity log that might have a hundred rows
 * in it, and the one it was about was somewhere below. This answers with the thing itself where the
 * payload carries enough to name it.
 *
 * It degrades in order, and each step is a real answer rather than a guess:
 *
 *   1. the audit row, when the push is about an event and carries its id;
 *   2. the asset, when the push is about an instrument and names it;
 *   3. the screen the executor itself asked for;
 *   4. the screen this app maps the kind to;
 *   5. `/activity`, which is where an unrecognised event belongs.
 */
export function deepRouteFor(payload: PushPayload | undefined): string {
  if (!payload) return FALLBACK;
  const kind = typeof payload.kind === 'string' ? payload.kind : undefined;

  if (kind !== undefined && IS_AN_AUDIT_ROW.has(kind)) {
    const row = rowIn(payload);
    if (row) return `/activity?row=${row}`;
  }

  if (kind !== undefined && ABOUT_AN_ASSET.has(kind)) {
    const ticker = tickerIn(payload);
    if (ticker) return `/asset/${ticker}`;
  }

  /*
   * An unrecognised kind still gets the benefit of what it carried.
   *
   * A newer executor sending a kind this build has never heard of should not lose the row it took
   * the trouble to name — the alternative is a tap that lands on a list for no stated reason.
   */
  if (kind === undefined || !isAlertKind(kind)) {
    const row = rowIn(payload);
    if (row) return `/activity?row=${row}`;
  }

  return sentRoute(payload) ?? (kind !== undefined && isAlertKind(kind) ? routeFor(kind) : FALLBACK);
}

/** Is this one of the kinds this build knows? A push from a newer executor may not be. */
export function isAlertKind(kind: string): kind is AlertKind {
  return KINDS.has(kind);
}

/*
 * Derived, not listed again.
 *
 * `MUTABLE` is a `Record` over the whole union bar one, so a kind added to `AlertKind` fails the
 * typecheck until it is added there — and this set follows without anyone remembering. A
 * hand-written copy of the union is exactly the kind of second list that goes quietly stale.
 */
const KINDS = new Set<string>([...Object.keys(MUTABLE), 'allowlist-changed']);

/** One row of the audit trail as `/activity` returns it: the executor's words, not ours. */
export type TrailRow = { action: string; detail: string; kind: string; agent: string };

/**
 * The push an audit row went out with, or null when the row is a record rather than an interruption.
 *
 * The trail holds everything — a strategy created, a run with nothing to do, a watched run that "would
 * have" bought — and the inbox listed all of it as flagged for you, sending whatever it could not place to
 * Alerts. What interrupts is narrower, and the executor says exactly what: a push goes out beside six kinds
 * of row. `/activity` does not carry a row's payload, so the sender's own wording is the evidence, and each
 * rule names the file that writes it.
 */
export function interruptionFor(row: TrailRow): AlertKind | null {
  const { action, detail, kind, agent } = row;
  // executor/run.ts: a proposal waiting for a yes — "Asked before buying WETH".
  if (kind === 'risk' && action.startsWith('Asked before buying ')) return 'proposal-awaiting';
  // executor/run.ts: a run a limit refused — "Skipped WETH".
  if (kind === 'block' && action.startsWith('Skipped ')) return 'strategy-blocked';
  // routes/panic.ts: each leg of a flatten you asked for, or "Nothing to sell". An agent's own close also
  // writes "Sold all WETH", without this sentence, and sends nothing.
  if (detail.includes('You asked to be flattened')) return 'panic-flatten';
  // executor/run.ts: a fill — "Bought 0.1234 WETH", "Sold 0.1234 WETH", units always to four places — or cash moved
  // into savings. Your own close from the order ticket is "Sold 50% of WETH", and sends nothing.
  if ((kind === 'trade' && /^(Bought|Sold) \d+\.\d{4} /.test(action)) || (kind === 'yield' && action.startsWith('Supplied '))) {
    return 'dca-executed';
  }
  // withdrawals/allowlist.ts.
  if (action === 'Withdrawal address added' || action === 'Withdrawal address removed') return 'allowlist-changed';
  // alerts/evaluate.ts: the alert's own name, as Drawdown Guard, filed as risk. The other risk rows that
  // agent writes are a run with nothing to do, a watched run and an empty flatten, all named here.
  if (kind === 'risk' && agent === 'Drawdown Guard' && !/^(Nothing to do for |Would have |Nothing to sell)/.test(action)) {
    return 'alert-fired';
  }
  return null;
}
