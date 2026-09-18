/**
 * Notifications for autonomous agent actions: Entry, Exit, Kill — PLAN.md 12.19.
 *
 * Uses existing devices table and push notification service (push.ts).
 * Also writes into the messages table so the mobile chat/drawer reflects every automated action.
 */
import { randomUUID } from 'node:crypto';
import { send } from './push.js';
import { query } from '../db/index.js';

export type EntryAlertParams = {
  walletId: string;
  symbol: string;
  strategyKind: string;
  notionalUsd: number;
  units: number;
  price: number;
  signature: string;
  rationale?: string;
  agentName?: string;
};

export type ExitAlertParams = {
  walletId: string;
  symbol: string;
  reason: string;
  units: number;
  price: number;
  proceedsUsd: number;
  pnlUsd?: number;
  signature?: string;
};

export type KillAlertParams = {
  walletId: string;
  reason?: string;
  signature?: string;
};

/**
 * Notifies the user when the autonomous agent enters an xStock position.
 */
export async function notifyEntry(params: EntryAlertParams): Promise<void> {
  const { walletId, symbol, strategyKind, notionalUsd, units, price, signature, rationale, agentName } = params;
  const agent = agentName ?? 'Autonomous Agent';
  const notionalStr = `$${notionalUsd.toFixed(2)}`;
  const priceStr = `$${price.toFixed(2)}`;
  const title = `xorr: ${agent} Traded`;
  const body = `Bought ${units.toFixed(4)} ${symbol} (${notionalStr} at ${priceStr}) via ${strategyKind}.${rationale ? ` ${rationale}` : ''}`;

  // 1. Send push notification to all registered devices
  try {
    await send(walletId, {
      title,
      body,
      route: '/activity',
      kind: 'dca-executed',
      data: {
        action: 'entry',
        symbol,
        strategyKind,
        notionalUsd,
        units,
        price,
        signature,
      },
    });
  } catch (e) {
    console.warn('[alerts] push send failed:', e instanceof Error ? e.message : e);
  }

  // 2. Persist message in messages table for chat/drawer
  await query(
    `INSERT INTO messages (id, wallet_id, at, author, type, agent, body)
     VALUES ($1, $2, now(), 'agent', 'trade', $3, $4)`,
    [
      randomUUID(),
      walletId,
      agent,
      JSON.stringify({
        title,
        text: body,
        symbol,
        notionalUsd,
        units,
        price,
        signature,
        strategyKind,
      }),
    ],
  ).catch((e) => console.error('[alerts] failed to write message:', e));
}

/**
 * Notifies the user when a position is closed (take-profit, stop-loss, trailing stop, flatten).
 */
export async function notifyExit(params: ExitAlertParams): Promise<void> {
  const { walletId, symbol, reason, units, price, proceedsUsd, pnlUsd, signature } = params;
  const priceStr = `$${price.toFixed(2)}`;
  const proceedsStr = `$${proceedsUsd.toFixed(2)}`;
  const pnlStr = pnlUsd !== undefined ? ` (P&L: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)})` : '';
  const title = `xorr: Position Closed`;
  const body = `Closed ${units.toFixed(4)} ${symbol} at ${priceStr} for ${proceedsStr}${pnlStr}. ${reason}`;

  // 1. Send push notification
  try {
    await send(walletId, {
      title,
      body,
      route: '/portfolio',
      kind: 'alert-fired',
      data: {
        action: 'exit',
        symbol,
        reason,
        units,
        price,
        proceedsUsd,
        pnlUsd,
        signature,
      },
    });
  } catch (e) {
    console.warn('[alerts] push send failed:', e instanceof Error ? e.message : e);
  }

  // 2. Persist message
  await query(
    `INSERT INTO messages (id, wallet_id, at, author, type, agent, body)
     VALUES ($1, $2, now(), 'agent', 'exit', 'Drawdown Guard', $3)`,
    [
      randomUUID(),
      walletId,
      JSON.stringify({
        title,
        text: body,
        symbol,
        units,
        price,
        proceedsUsd,
        pnlUsd,
        reason,
        signature,
      }),
    ],
  ).catch((e) => console.error('[alerts] failed to write message:', e));
}

/**
 * Notifies the user when the kill switch is engaged.
 *
 * The sentence says what the kill switch does and nothing more. It used to add "and on-chain
 * delegation revoked" to every one of these, which flipping the switch does not do on its own —
 * revoking is a separate transaction the user may not have sent. A notification that overstates
 * what happened is worse than none, because the next thing the user does is stop checking.
 */
export async function notifyKill(params: KillAlertParams): Promise<void> {
  const { walletId, reason, signature } = params;
  const title = `xorr: Trading Stopped`;
  const body = `Kill switch engaged. Every automated strategy is paused until you turn it back on. ${reason ?? ''}`.trim();

  // 1. Send push notification
  try {
    await send(walletId, {
      title,
      body,
      route: '/safety',
      kind: 'panic-flatten',
      data: {
        action: 'kill',
        reason,
        signature,
      },
    });
  } catch (e) {
    console.warn('[alerts] push send failed:', e instanceof Error ? e.message : e);
  }

  // 2. Persist message
  await query(
    `INSERT INTO messages (id, wallet_id, at, author, type, agent, body)
     VALUES ($1, $2, now(), 'agent', 'kill', 'Drawdown Guard', $3)`,
    [
      randomUUID(),
      walletId,
      JSON.stringify({
        title,
        text: body,
        reason,
        signature,
      }),
    ],
  ).catch((e) => console.error('[alerts] failed to write message:', e));
}
