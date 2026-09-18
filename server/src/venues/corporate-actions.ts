/**
 * Telling a holder about a split or a dividend (PLAN.md §8.4, P2.6).
 *
 * There is no corporate-action calendar here, and that is the point. Two things on X Layer say a
 * multiplier is moving, and both are read rather than assumed:
 *
 * - **Scheduled** — Backed's raw xStock carries the issuer's NEXT multiplier and the time it takes
 *   effect (`newMultiplier`, `newMultiplierActivationTime`; see `multiplier.ts`). So the token
 *   itself announces the action, on chain, ahead of time. That timestamp IS the date.
 * - **Observed** — an issuer can also apply a new multiplier at once, with no schedule. Then the
 *   only evidence is our own record: the last two rows of `multiplier_observations` differ. The
 *   date given is when we first saw the new value, and the wording says "by", not "on".
 *
 * What the multiplier does not say is what KIND of action it is, and this does not pretend
 * otherwise. A large step is a split and a small one is a reinvested dividend, on the same
 * threshold the yield figures use, and the wording says which reading was taken rather than
 * asserting a fact the chain never stated.
 *
 * Following `alerts/evaluate.ts`, whose rules this sweep is built on: fire once per action, read
 * every condition from the real thing, and leave an audit entry as well as a push — a notification
 * that never arrived must still be findable.
 */
import { query } from '../db/index.js';
import { append } from '../audit/log.js';
import { send } from '../notifications/push.js';
import { XSTOCKS } from './xstocks.js';
import { readMultiplier, recentObservations } from './multiplier.js';

/**
 * A step this size or larger reads as a split rather than as income.
 *
 * Reinvested dividends move the multiplier by fractions of a percent; the smallest real split is
 * a 3:2, which is +50%. Ten percent sits far from both.
 */
const SPLIT_STEP = 0.10;

/**
 * Warn this far ahead of a scheduled action, and treat an observed one as news for this long after
 * we first saw it. Sooner is noise; later is a holder finding out from their balance.
 */
export const NOTICE_WINDOW_MS = 72 * 60 * 60 * 1000;

export type PendingAction = {
  symbol: string;
  /** The wrapper address — what `corporate_action_notices.mint` and the observations are keyed on. */
  mint: string;
  /** The multiplier before the action. */
  currentMultiplier: number;
  /** The multiplier the action moves it to. */
  newMultiplier: number;
  factor: number;
  /** Scheduled: when the issuer said it applies. Observed: when we first saw it applied. */
  effectiveAt: string;
  /** What the size of the step says this is. The chain does not label it. */
  reading: 'split' | 'reverse-split' | 'reinvested-dividend';
  /** Whether the chain announced it ahead of time, or we saw it after the fact. */
  source: 'scheduled' | 'observed';
};

export type NoticeOutcome = {
  action: PendingAction;
  walletsNotified: string[];
  /** Wallets that hold the token but had already been told about this exact action. */
  alreadyTold: number;
};

function readingFor(factor: number): PendingAction['reading'] {
  if (Math.abs(factor - 1) < SPLIT_STEP) return 'reinvested-dividend';
  return factor > 1 ? 'split' : 'reverse-split';
}

/** How to describe an action to a holder, without claiming more than the chain said. */
export function describeAction(action: PendingAction): { title: string; body: string } {
  const when = new Date(action.effectiveAt).toUTCString();
  const observed = action.source === 'observed';
  if (action.reading === 'reinvested-dividend') {
    const pct = ((action.factor - 1) * 100).toFixed(3);
    return {
      title: `${action.symbol} dividend`,
      body: observed
        ? `${action.symbol} reinvested a dividend, seen on chain by ${when}. Each token you hold is now worth ${pct}% more of the underlying share; the tokens you own do not change.`
        : `${action.symbol} is scheduled to reinvest a dividend on ${when}. Your holding grows by ${pct}%; the tokens you own do not change.`,
    };
  }
  const kind = action.reading === 'split' ? 'split' : 'reverse split';
  return {
    title: `${action.symbol} ${kind}`,
    body: observed
      ? `${action.symbol} went through a ${action.factor.toFixed(
          4,
        )}x ${kind}, seen on chain by ${when}. Your position is worth the same either side of it — the tokens you hold now each stand for a proportionally different number of shares.`
      : `${action.symbol} is scheduled for a ${action.factor.toFixed(
          4,
        )}x ${kind} on ${when}. Your position is worth the same either side of it — you will hold a different number of tokens at a proportionally different price.`,
  };
}

/**
 * The action the token has scheduled, where one is pending inside the notice window.
 *
 * Returns null when nothing is scheduled, and null when the token cannot be read — an unreadable
 * token is not evidence that nothing is coming, and this deliberately says nothing rather than
 * implying all-clear.
 */
export async function pendingAction(symbol: string, now: number = Date.now()): Promise<PendingAction | null> {
  const token = XSTOCKS[symbol];
  if (!token) return null;

  const reading = await readMultiplier(token, now).catch(() => null);
  if (!reading?.pending) return null;

  const effectiveMs = reading.pending.effectiveAtMs;
  // Already in force, or too far out to be news yet.
  if (!Number.isFinite(effectiveMs) || effectiveMs <= now || effectiveMs - now > NOTICE_WINDOW_MS) {
    return null;
  }
  if (!(reading.multiplier > 0) || !(reading.pending.multiplier > 0)) return null;

  const factor = reading.pending.multiplier / reading.multiplier;
  return {
    symbol: token.symbol,
    mint: token.address,
    currentMultiplier: reading.multiplier,
    newMultiplier: reading.pending.multiplier,
    factor,
    effectiveAt: reading.pending.effectiveAt,
    reading: readingFor(factor),
    source: 'scheduled',
  };
}

/**
 * A change our own observations show, first seen inside the notice window.
 *
 * Null with fewer than two observations (one value is not a change), when the newest one is older
 * than the window, and when the history cannot be read — again, never an all-clear.
 */
export async function observedAction(symbol: string, now: number = Date.now()): Promise<PendingAction | null> {
  const token = XSTOCKS[symbol];
  if (!token) return null;

  const rows = await recentObservations(token.address, 2).catch(() => null);
  if (!rows || rows.length < 2) return null;
  const [latest, previous] = rows as [(typeof rows)[0], (typeof rows)[0]];

  const seenMs = Date.parse(latest.observedAt);
  if (!Number.isFinite(seenMs) || seenMs > now || now - seenMs > NOTICE_WINDOW_MS) return null;
  if (!(latest.multiplier > 0) || !(previous.multiplier > 0) || latest.multiplier === previous.multiplier) {
    return null;
  }

  const factor = latest.multiplier / previous.multiplier;
  return {
    symbol: token.symbol,
    mint: token.address,
    currentMultiplier: previous.multiplier,
    newMultiplier: latest.multiplier,
    factor,
    effectiveAt: latest.effectiveAt,
    reading: readingFor(factor),
    source: 'observed',
  };
}

/** Wallets holding this xStock, who are the only ones an action concerns. */
async function holdersOf(symbol: string): Promise<string[]> {
  const rows = await query<{ wallet_id: string }>(
    `SELECT DISTINCT wallet_id FROM positions WHERE symbol = $1 AND units > 0`,
    [symbol],
  ).catch(() => []);
  return rows.map((r) => r.wallet_id);
}

/**
 * Claim the notice for one holder. True when this holder had not been told.
 *
 * A scheduled action is keyed exactly: an issuer amending it (a new ratio or a new date) is a
 * different row and is announced again — an amendment is news. An observed change is additionally
 * checked against any notice for the same multiplier within the window, because a scheduled action
 * we already announced shows up again in our observations once it applies, a few minutes after its
 * date, and telling the holder twice is how notifications get turned off.
 */
async function claim(walletId: string, action: PendingAction): Promise<boolean> {
  const params = [walletId, action.mint, action.symbol, action.newMultiplier, action.effectiveAt];
  const rows =
    action.source === 'scheduled'
      ? await query(
          `INSERT INTO corporate_action_notices (wallet_id, mint, symbol, new_multiplier, effective_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (wallet_id, mint, new_multiplier, effective_at) DO NOTHING
           RETURNING id`,
          params,
        ).catch(() => [])
      : await query(
          `INSERT INTO corporate_action_notices (wallet_id, mint, symbol, new_multiplier, effective_at)
           SELECT $1, $2, $3, $4, $5::timestamptz
            WHERE NOT EXISTS (
              SELECT 1 FROM corporate_action_notices
               WHERE wallet_id = $1 AND mint = $2 AND new_multiplier = $4
                 AND effective_at BETWEEN $5::timestamptz - ($6 || ' milliseconds')::interval
                                      AND $5::timestamptz + ($6 || ' milliseconds')::interval
            )
           ON CONFLICT (wallet_id, mint, new_multiplier, effective_at) DO NOTHING
           RETURNING id`,
          [...params, String(NOTICE_WINDOW_MS)],
        ).catch(() => []);
  return rows.length > 0;
}

/**
 * Tell every holder about anything their tokens have scheduled or just done.
 *
 * Idempotent by construction: the notice row is written before the push and carries a unique key
 * on the action itself, so a sweep every thirty seconds sends one notification per action per
 * holder.
 */
export async function sweepCorporateActions(now: number = Date.now()): Promise<NoticeOutcome[]> {
  const outcomes: NoticeOutcome[] = [];

  for (const symbol of Object.keys(XSTOCKS)) {
    const actions = [await pendingAction(symbol, now), await observedAction(symbol, now)].filter(
      (a): a is PendingAction => a !== null,
    );

    for (const action of actions) {
      const walletsNotified: string[] = [];
      let alreadyTold = 0;

      for (const walletId of await holdersOf(action.symbol)) {
        /*
         * Claim the notice first. If the claim finds a row already there this holder has been told,
         * and nothing is sent — the claim is what makes the sweep safe to run as often as it likes.
         */
        if (!(await claim(walletId, action))) {
          alreadyTold += 1;
          continue;
        }

        const { title, body } = describeAction(action);

        /*
         * The audit entry is written whether or not the push lands: a notification that did not
         * arrive must still be findable.
         *
         * `kind` is constrained to the four the audit log allows, so a reinvested dividend files as
         * `yield` — which is what it is — and a split as `risk`, because it changes what a token
         * stands for. Neither is invented: `reading` in the payload carries the real distinction.
         */
        await append({
          walletId,
          agent: 'corporate-actions',
          action: `${action.symbol} ${action.reading}`,
          detail: body,
          kind: action.reading === 'reinvested-dividend' ? 'yield' : 'risk',
          payload: {
            symbol: action.symbol,
            mint: action.mint,
            factor: action.factor,
            reading: action.reading,
            source: action.source,
            currentMultiplier: action.currentMultiplier,
            newMultiplier: action.newMultiplier,
            effectiveAt: action.effectiveAt,
          },
        }).catch(() => undefined);

        // `alert-fired` so the user's existing per-kind mute applies to this as to any other alert.
        await send(walletId, {
          title,
          body,
          route: `/agent/basket?symbol=${encodeURIComponent(action.symbol)}`,
          kind: 'alert-fired',
        }).catch(() => undefined);

        walletsNotified.push(walletId);
      }

      outcomes.push({ action, walletsNotified, alreadyTold });
    }
  }

  return outcomes;
}
