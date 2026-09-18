/**
 * The agent's reasons for one trade, turned into lines a person can read.
 *
 * Every line here comes from a field the agent wrote down at the moment it decided — the band it
 * was looking at, the session the exchange was in, the multiplier in force, the drift it could or
 * could not measure. Nothing is recomputed and nothing is inferred from the outcome.
 *
 * ## Why that restraint matters on this screen more than most
 *
 * This is the screen where an explanation is most tempting to improve. It would be easy to look at
 * the price now, notice the trade worked, and word the reason more confidently than the agent
 * actually held it — or to soften one that did not. Both turn a record into a story. The agent's
 * sentence is shown as the agent wrote it, and the facts under it are the ones it had.
 *
 * A row with no record gets no narration at all. See `explainLines` returning an empty list.
 */
import { MINUS } from '@/format';

export type DecisionRecord = {
  symbol: string;
  strategyKind: string;
  persona: string;
  personaName: string;
  score: number;
  usd: number;
  units: number;
  price: number;
  stopPrice: number;
  targetPrice: number;
  signature: string;
  slot: number;
  opening: string;
  reason: string;
  marketCondition: string;
  multiplier: number;
  pendingMultiplier: number | null;
  pendingEffectiveAtMs: number | null;
  nasdaqSession: string;
  spreadBps: number | null;
  slippageBps: number;
  /**
   * The risk profile that was active when this was decided.
   *
   * Optional because trades placed before the setting existed do not have one, and captioning
   * those with today's profile would attribute a decision to a setting that was not yet a thing.
   */
  riskProfile?: string;
  exitStrategyId: string | null;
  decidedAtMs: number;
};

export type TradeExplanation =
  | {
      status: 'explained';
      seq: string;
      at: string;
      agent: string;
      kind: string;
      signature: string | null;
      /** A URL on a public chain, or a `fork:`/`local:` label where there is nowhere to link to. */
      explorer: string | null;
      record: DecisionRecord;
    }
  | {
      status: 'no_record';
      seq: string;
      at: string;
      agent: string;
      kind: string;
      signature: string | null;
      explorer: string | null;
    };

/** One "because" — a heading and the fact under it. */
export type ExplainLine = { label: string; value: string };

/** The library's own word for a strategy, not the enum's. */
export const STRATEGY_LABEL: Readonly<Record<string, string>> = Object.freeze({
  momentum: 'Momentum',
  'event-driven': 'Around an earnings date',
  dca: 'Accumulating',
});

/** How each profile reads on the explanation, rather than as a bare enum. */
const PROFILE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  conservative: 'Conservative',
  balanced: 'Balanced',
  aggressive: 'Aggressive',
});

/** What the exchange was doing, in words rather than the enum. */
const SESSION_LABEL: Readonly<Record<string, string>> = Object.freeze({
  regular: 'Nasdaq was open',
  extended: 'Nasdaq was in extended hours',
  closed: 'Nasdaq was closed',
});

export function strategyLabel(kind: string): string {
  return STRATEGY_LABEL[kind] ?? kind;
}

/**
 * The reasons, in the order they were decided in.
 *
 * Empty when there is no record. The screen shows its own sentence in that case rather than a list
 * with blanks in it, which is what a template driven by missing fields produces.
 */
export function explainLines(record: DecisionRecord): ExplainLine[] {
  const lines: ExplainLine[] = [
    { label: 'The setup', value: `${strategyLabel(record.strategyKind)}, scored ${record.score}` },
    { label: 'What it saw', value: record.marketCondition },
  ];

  /*
   * The profile as it was, not as it is.
   *
   * Omitted entirely for a trade that predates the setting rather than captioned with today's
   * value — the thresholds this was decided under are a fact about the decision, and borrowing
   * the current ones would describe a decision nobody made. An unrecognised value is shown raw
   * rather than dropped: it is still what the record says.
   */
  if (record.riskProfile) {
    lines.push({
      label: 'Risk profile',
      value: `${PROFILE_LABEL[record.riskProfile] ?? record.riskProfile} at the time`,
    });
  }

  /*
   * The drift, or the fact that there was none to be had.
   *
   * `spreadBps: null` is the agent saying it had no second source to measure the pool against, and
   * it is a different statement from a drift of zero. Rendering null as "0 bps" would turn "I could
   * not check" into "I checked and it was perfect", which is the exact inversion this app exists
   * not to make.
   */
  const session = SESSION_LABEL[record.nasdaqSession] ?? record.nasdaqSession;
  lines.push({
    label: 'Where it was priced',
    value:
      record.spreadBps === null
        ? `${session}, and no second venue answered, so the drift was unmeasured`
        : `${session}, and the pool was within ${record.spreadBps} bps of the Base listing`,
  });

  lines.push({
    label: 'Slippage allowed',
    value: `${record.slippageBps} bps`,
  });

  // Only worth a line when the issuer has actually moved it. A multiplier of 1 is the absence of news.
  if (record.multiplier !== 1) {
    lines.push({
      label: 'Share multiplier',
      value: `${trim(record.multiplier)} in force at the time`,
    });
  }

  lines.push({
    label: 'Levels it set',
    value: `out at ${dollars(record.stopPrice)} or ${dollars(record.targetPrice)}, from a fill at ${dollars(record.price)}`,
  });

  lines.push({
    label: 'Exit',
    value: record.exitStrategyId
      ? 'Armed on the fill price, checked daily'
      : 'Not armed — set one in Auto Close',
  });

  return lines;
}

/** `$216.50`, with a real minus sign if it ever needs one. */
function dollars(n: number): string {
  const body = `$${Math.abs(n).toFixed(2)}`;
  return n < 0 ? `${MINUS}${body}` : body;
}

/** A multiplier as a person reads it: `1.0017`, not `1.001701196801074`. */
function trim(n: number): string {
  return String(Number(n.toFixed(4)));
}
