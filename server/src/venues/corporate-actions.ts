/**
 * Telling a holder about a split or a dividend before it happens (PLAN.md §8.4).
 *
 * There is no corporate-action calendar here, and that is the point. Token-2022's Scaled UI Amount
 * extension carries the issuer's NEXT multiplier alongside the current one, with the timestamp it
 * takes effect — so the mint itself announces the action, on-chain, ahead of time. Nothing about
 * the schedule is inferred, scraped or assumed: `newMultiplierEffectiveTimestamp` IS the date.
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
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { query } from '../db/index.js';
import { append } from '../audit/log.js';
import { send } from '../notifications/push.js';
import { connection as defaultConnection } from '../solana/connection.js';
import { readScaledUiConfig, tokenProgramForMint } from '../solana/balances.js';
import { XSTOCKS } from './xstocks.js';

/**
 * A step this size or larger reads as a split rather than as income.
 *
 * Reinvested dividends move the multiplier by fractions of a percent; the smallest real split is
 * a 3:2, which is +50%. Ten percent sits far from both.
 */
const SPLIT_STEP = 0.10;

/** Warn this far ahead. Sooner is noise; later is a holder finding out from their balance. */
export const NOTICE_WINDOW_MS = 72 * 60 * 60 * 1000;

export type PendingAction = {
  symbol: string;
  mint: string;
  currentMultiplier: number;
  newMultiplier: number;
  factor: number;
  effectiveAt: string;
  /** What the size of the step says this is. The chain does not label it. */
  reading: 'split' | 'reverse-split' | 'reinvested-dividend';
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
  if (action.reading === 'reinvested-dividend') {
    return {
      title: `${action.symbol} dividend`,
      body: `${action.symbol} is scheduled to reinvest a dividend on ${when}. Your holding grows by ${(
        (action.factor - 1) *
        100
      ).toFixed(3)}%; the tokens you own do not change.`,
    };
  }
  const kind = action.reading === 'split' ? 'split' : 'reverse split';
  return {
    title: `${action.symbol} ${kind}`,
    body: `${action.symbol} is scheduled for a ${action.factor.toFixed(
      4,
    )}x ${kind} on ${when}. Your position is worth the same either side of it — you will hold a different number of tokens at a proportionally different price.`,
  };
}

/**
 * The action a mint has announced, where one is pending inside the notice window.
 *
 * Returns null when nothing is scheduled, and null when the mint cannot be read — an unreadable
 * mint is not evidence that nothing is coming, and this deliberately says nothing rather than
 * implying all-clear.
 */
export async function pendingAction(
  symbol: string,
  conn: Connection = defaultConnection,
  now: number = Date.now(),
): Promise<PendingAction | null> {
  const token = XSTOCKS[symbol];
  if (!token) return null;

  const mintPk = new PublicKey(token.address);
  const prog = tokenProgramForMint(mintPk);
  if (!prog.equals(TOKEN_2022_PROGRAM_ID)) return null;

  let scale;
  try {
    const mintInfo = await getMint(conn, mintPk, 'confirmed', prog);
    scale = readScaledUiConfig(mintInfo, now / 1000);
  } catch {
    return null;
  }
  if (!scale?.pending) return null;

  const effectiveMs = Date.parse(scale.pending.effectiveAt);
  // Already in force, or too far out to be news yet.
  if (!Number.isFinite(effectiveMs) || effectiveMs <= now || effectiveMs - now > NOTICE_WINDOW_MS) {
    return null;
  }
  if (!(scale.multiplier > 0) || !(scale.pending.multiplier > 0)) return null;

  const factor = scale.pending.multiplier / scale.multiplier;
  return {
    symbol: token.symbol,
    mint: token.address,
    currentMultiplier: scale.multiplier,
    newMultiplier: scale.pending.multiplier,
    factor,
    effectiveAt: scale.pending.effectiveAt,
    reading: readingFor(factor),
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
 * Tell every holder about anything their tokens have scheduled.
 *
 * Idempotent by construction: the notice row is written before the push and carries a unique key
 * on the action itself, so a sweep every thirty seconds sends one notification per action per
 * holder. An issuer amending an announced action changes the key, and is announced again — an
 * amendment is news.
 */
export async function sweepCorporateActions(
  conn: Connection = defaultConnection,
  now: number = Date.now(),
): Promise<NoticeOutcome[]> {
  const outcomes: NoticeOutcome[] = [];

  for (const symbol of Object.keys(XSTOCKS)) {
    const action = await pendingAction(symbol, conn, now);
    if (!action) continue;

    const walletsNotified: string[] = [];
    let alreadyTold = 0;

    for (const walletId of await holdersOf(action.symbol)) {
      /*
       * Claim the notice first. If the insert finds a row already there this holder has been told,
       * and nothing is sent — the claim is what makes the sweep safe to run as often as it likes.
       */
      const claimed = await query(
        `INSERT INTO corporate_action_notices (wallet_id, mint, symbol, new_multiplier, effective_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (wallet_id, mint, new_multiplier, effective_at) DO NOTHING
         RETURNING id`,
        [walletId, action.mint, action.symbol, action.newMultiplier, action.effectiveAt],
      ).catch(() => []);

      if (claimed.length === 0) {
        alreadyTold += 1;
        continue;
      }

      const { title, body } = describeAction(action);

      /*
       * The audit entry is written whether or not the push lands: a notification that did not
       * arrive must still be findable.
       *
       * `kind` is constrained to the four the audit log allows, so a reinvested dividend files as
       * `yield` — which is what it is — and a split as `risk`, because it changes how many tokens
       * a holder owns. Neither is invented: `reading` in the payload carries the real distinction.
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

  return outcomes;
}
