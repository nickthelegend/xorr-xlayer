/**
 * tradingNow.ts — whether an agent is trading *right now*, from the runs the executor recorded.
 *
 * `strategy_runs.status = 'pending'` is a run that started and has not finished. It is the only honest signal in the
 * system for "something is happening at this moment", and until now nothing showed it: the app could say what the bot
 * had done and what it was allowed to do, and never that it was doing something.
 *
 * ## The claim this makes, and the two ways it could lie
 *
 * Saying "trading now" is a claim about the present tense, which is the hardest kind to keep true from recorded data.
 *
 * **A run that never finished.** A row left `pending` by a crashed process, a lost connection or a container restart
 * stays `pending` for ever. Believed literally it would have the app announcing that an agent is trading, continuously,
 * for days — the most confident possible statement about the least certain thing. So a pending run older than
 * `STALE_AFTER_MS` is no longer reported as trading; it is reported as **stuck**, which is what it is, and which is
 * something the reader can act on.
 *
 * **A read that failed.** Not knowing is not the same as nothing happening. A failed read says so rather than
 * resolving to a quiet "idle", because "no agent is trading" is itself a claim, and one somebody might act on.
 */

/** What this needs from a run. A subset of `StrategyRunRow`, so the shape stays testable without the whole type. */
export type RunLike = {
  id: string;
  status: string;
  symbol: string;
  /** The strategy's own label — never an agent name, which a run does not carry and must not be invented. */
  label: string;
  /** When the run started, as `/runs` sends it. */
  at: string;
};

/**
 * How long a run may be in flight before the app stops calling it trading.
 *
 * A real fill is seconds of work: a quote, a signature, a confirmation. Ten minutes is far past any of that and well
 * inside the executor's own ten-minute autonomous cooldown, so a run still open at that point is not busy, it is stuck.
 */
export const STALE_AFTER_MS = 10 * 60_000;

export type TradingNow =
  /** At least one run is genuinely in flight. */
  | { kind: 'trading'; runs: RunLike[] }
  /** Runs are open but too old to be believed. They are named, because a stuck run is worth knowing about. */
  | { kind: 'stuck'; runs: RunLike[] }
  /** Nothing is in flight. A real answer, and a different one from not knowing. */
  | { kind: 'idle' }
  /** The runs have not been read yet. */
  | { kind: 'checking' }
  /** The read came back unable to answer. Never resolved to `idle`. */
  | { kind: 'unknown' };

/**
 * What the agents are doing, from the recorded runs.
 *
 * `runs === undefined` with no error is a read still out; an error is a read that failed. The two are kept apart for
 * the reason they are kept apart everywhere else in this app: one resolves itself and the other will not.
 */
export function tradingNow(
  runs: readonly RunLike[] | undefined,
  options: { failed?: boolean; now?: number } = {},
): TradingNow {
  const { failed = false, now = Date.now() } = options;
  if (failed) return { kind: 'unknown' };
  if (runs === undefined) return { kind: 'checking' };

  const open = runs.filter((r) => r.status === 'pending');
  if (open.length === 0) return { kind: 'idle' };

  /*
   * A run whose start cannot be read is treated as stuck rather than as trading. An unparseable timestamp is not
   * evidence of anything happening now, and this is the direction to be wrong in.
   */
  const age = (run: RunLike) => {
    const started = Date.parse(run.at);
    return Number.isFinite(started) ? now - started : Number.POSITIVE_INFINITY;
  };
  const live = open.filter((r) => age(r) <= STALE_AFTER_MS);
  if (live.length > 0) return { kind: 'trading', runs: live };
  return { kind: 'stuck', runs: open };
}

/**
 * The one line a ticker shows, or `undefined` where there is nothing to say.
 *
 * Names the strategy and the symbol because those are on the run. It does not name an agent: a run does not carry one,
 * and putting a persona in this sentence would be inventing the actor in a claim about what is happening right now.
 */
export function tradingLine(state: TradingNow): string | undefined {
  switch (state.kind) {
    case 'trading': {
      const first = state.runs[0]!;
      if (state.runs.length === 1) return `${first.label} is trading ${first.symbol}`;
      return `${state.runs.length} runs in flight, including ${first.label} on ${first.symbol}`;
    }
    case 'stuck': {
      const first = state.runs[0]!;
      const n = state.runs.length;
      return n === 1
        ? `${first.label} has been open on ${first.symbol} for a while with no result`
        : `${n} runs have been open for a while with no result`;
    }
    case 'idle':
      return 'No agent is trading right now';
    case 'checking':
      return 'Checking what the agents are doing';
    case 'unknown':
      return 'Couldn’t read what the agents are doing';
  }
}
