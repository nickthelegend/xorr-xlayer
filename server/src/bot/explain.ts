/**
 * Why the agent took the trade on that row — read back, never reconstructed.
 *
 * `runAutonomousCycle` writes a `DecisionRecord` onto the audit row at the moment it decides, so
 * everything here is a read of what the agent actually observed: the band it saw, the session the
 * exchange was in, the multiplier in force, the drift it could or could not measure, the score the
 * setup won on.
 *
 * ## Why it is not recomputed
 *
 * The tempting version of this feature re-runs the analysis when asked and narrates the result.
 * That produces a fluent explanation of what the agent WOULD decide now, presented as the reason it
 * decided then — and the two diverge the moment a price moves, which is immediately. A rationale
 * reconstructed after the fact is a guess about the past dressed up as a record of it, and this app
 * does not do that with prices, so it will not do it with reasons.
 *
 * The consequence is that a trade placed before the agent started recording has no explanation, and
 * this says so rather than inventing one. That is the correct answer and the honest one.
 */
import { one } from '../db/index.js';
import { explorerTx } from '../solana/connection.js';
import { sleevesFor, type SleeveBreakdown } from '../positions/sleeves.js';
import type { AuditKind } from '../audit/log.js';
import type { DecisionRecord } from './autonomous.js';

export type TradeExplanation =
  | {
      status: 'explained';
      seq: string;
      at: string;
      agent: string;
      kind: AuditKind;
      signature: string | null;
      /** Where to go and check it, or a `fork:`/`local:` label where there is nowhere to go. */
      explorer: string | null;
      record: DecisionRecord;
      /**
       * Who holds which part of this symbol now, this trade's source included.
       *
       * Several strategies can stack on one token, so "the agent bought NVDAc" is only half an
       * answer — the other half is what else is in there. Read at explain time rather than stored,
       * because unlike the decision this is a fact about NOW: the question is what the position
       * looks like today, not what it looked like when the trade was placed.
       *
       * Null when the breakdown could not be read. Not an empty breakdown, which would read as
       * "nothing else holds this" — a different and much stronger claim.
       */
      sleeves: SleeveBreakdown | null;
    }
  | {
      /**
       * The row exists and carries no decision record.
       *
       * One state, not two. Whether that is because it was a manual trade or because it predates
       * the agent recording its reasons is not something the row can tell us, and guessing between
       * them would put a confident sentence on top of an absence.
       */
      status: 'no_record';
      seq: string;
      at: string;
      agent: string;
      kind: AuditKind;
      signature: string | null;
      explorer: string | null;
    };

type Row = {
  seq: string;
  at: Date;
  agent: string;
  kind: AuditKind;
  signature: string | null;
  payload: Record<string, unknown>;
};

/**
 * Is this payload the agent's decision record, or some other row's payload?
 *
 * Checked field by field rather than cast. Every row in `audit_log` has a `payload` and most of
 * them are something else entirely — a run id, a strategy id, a raw error — so a cast would hand
 * the screen an object shaped like an explanation with `undefined` everywhere in it, which renders
 * as a confident page of blanks.
 */
function isDecisionRecord(p: Record<string, unknown>): p is DecisionRecord & Record<string, unknown> {
  return (
    typeof p.symbol === 'string' &&
    typeof p.strategyKind === 'string' &&
    typeof p.personaName === 'string' &&
    typeof p.reason === 'string' &&
    typeof p.marketCondition === 'string' &&
    typeof p.score === 'number' &&
    typeof p.price === 'number' &&
    typeof p.usd === 'number'
  );
}

/**
 * The explanation for one trail row, or null when that row is not this wallet's.
 *
 * Scoped to the wallet in the query rather than checked afterwards: an audit sequence is a global
 * counter, so `/activity/8/explain` on the wrong wallet must read as missing rather than as
 * somebody else's trade.
 */
export async function explainTrade(
  walletId: string,
  seq: string,
): Promise<TradeExplanation | null> {
  if (!/^\d+$/.test(seq)) return null;

  const row = await one<Row>(
    `SELECT seq, at, agent, kind, signature, payload
       FROM audit_log WHERE wallet_id = $1 AND seq = $2`,
    [walletId, seq],
  );
  if (!row) return null;

  const base = {
    seq: String(row.seq),
    at: new Date(row.at).toISOString(),
    agent: row.agent,
    kind: row.kind,
    signature: row.signature,
    /*
     * The same treatment `/activity` gives it. `explorerTx` answers with a `fork:` or `local:`
     * label rather than a URL on a network that has no explorer, and the screen renders the label
     * as plain text — a link to an explorer that has never seen the transaction reads as the
     * transaction not being real.
     */
    explorer: row.signature ? explorerTx(row.signature) : null,
  };

  const payload = row.payload ?? {};
  if (!isDecisionRecord(payload)) return { status: 'no_record', ...base };

  /*
   * Null rather than an empty breakdown when the read fails. An empty one would say "nothing else
   * holds this symbol", which is a claim, and a failed read is the absence of one.
   */
  const sleeves = await sleevesFor(walletId, payload.symbol).catch(() => null);

  return { status: 'explained', ...base, record: payload, sleeves };
}
