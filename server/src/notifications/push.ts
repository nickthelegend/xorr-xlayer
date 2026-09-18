/**
 * Server-side push delivery — PLAN.md 12.19.
 *
 * Sends through Expo's push service. Delivery to a real handset needs a token from a physical
 * device, so this exercises Expo's API shape and the local device registry; the last hop is a
 * device requirement, recorded honestly rather than faked.
 */
import { query } from '../db/index.js';

const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';

export type PushMessage = {
  title: string;
  body: string;
  /** Deep link the app opens on tap — PLAN.md 10.10. */
  route: string;
  /**
   * Which kind of interruption this is.
   *
   * Carried so the client can honour the user's per-alert mutes on arrival, and so a delivery can
   * be traced back to the event that caused it. `strategy-blocked` is the one a user most needs:
   * it is the moment the safety layer did its job, and silence there looks identical to the bot
   * simply not trying.
   */
  kind?: string;
  data?: Record<string, unknown>;
};

export async function devicesFor(walletId: string): Promise<string[]> {
  const rows = await query<{ token: string }>(`SELECT token FROM devices WHERE wallet_id=$1`, [
    walletId,
  ]);
  return rows.map((r) => r.token);
}

export type PushResult = { sent: number; skipped: number; errors: string[] };

/**
 * The interruptions this app can produce, and what each one is for.
 *
 * Listed here rather than inferred from whatever `send()` happens to have been called with, so the
 * settings screen can offer them all — including the ones that have not fired yet for this user.
 */
export const PUSH_KINDS = [
  { kind: 'dca-executed', label: 'A trade went through', detail: 'Every fill the bot places.' },
  {
    kind: 'strategy-blocked',
    label: 'A trade was stopped',
    detail: 'Your cap, expiry or allowlist refused something. This is the one worth keeping on.',
  },
  { kind: 'alert-fired', label: 'An alert you set', detail: 'Price levels and risk thresholds.' },
  { kind: 'panic-flatten', label: 'Everything sold', detail: 'When you ask to be flattened.' },
  {
    kind: 'proposal-awaiting',
    label: 'The bot wants to trade',
    detail: 'A momentum or event-driven strategy found a setup and is waiting for your yes.',
  },
] as const;

/**
 * Has this user muted this kind?
 *
 * Absent means allowed. A missing row must never mean silence — someone who has never opened
 * settings expects to hear from the bot, and defaulting to muted would make the whole feature look
 * broken for every user who has not configured it.
 */
export async function allowsKind(walletId: string, kind: string | undefined): Promise<boolean> {
  if (!kind) return true;
  const rows = await query<{ enabled: boolean }>(
    `SELECT enabled FROM notification_prefs WHERE wallet_id = $1 AND kind = $2`,
    [walletId, kind],
  );
  return rows[0]?.enabled ?? true;
}

export async function send(walletId: string, msg: PushMessage): Promise<PushResult> {
  /*
   * Check the mute before looking for devices.
   *
   * Cheaper, and it keeps the log honest: "muted" and "no devices registered" are different
   * reasons for silence and the second one is a bug while the first is a preference.
   */
  if (!(await allowsKind(walletId, msg.kind))) {
    console.log(`[push] ${msg.kind}: muted by the user`);
    return { sent: 0, skipped: 0, errors: ['muted'] };
  }

  const tokens = await devicesFor(walletId);
  if (tokens.length === 0) {
    // Worth saying out loud. A trade that settled and told nobody looks identical, from the logs,
    // to a notification path that works — which is how this stayed unwired for so long.
    console.log(`[push] ${msg.kind ?? 'event'}: no registered devices for wallet ${walletId}`);
    return { sent: 0, skipped: 0, errors: ['no registered devices'] };
  }

  const messages = tokens.map((to) => ({
    to,
    title: msg.title,
    body: msg.body,
    // copy.md's restraint applies to sound: a trading app that pings all day gets muted.
    sound: null,
    data: { route: msg.route, kind: msg.kind, ...msg.data },
  }));

  try {
    const res = await fetch(EXPO_PUSH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!res.ok) {
      console.log(`[push] ${msg.kind ?? 'event'}: Expo returned ${res.status}`);
      return { sent: 0, skipped: tokens.length, errors: [`${res.status}`] };
    }
    const json = (await res.json()) as { data?: { status: string; message?: string }[] };
    const rows = json.data ?? [];
    const result = {
      sent: rows.filter((r) => r.status === 'ok').length,
      skipped: rows.filter((r) => r.status !== 'ok').length,
      errors: rows.filter((r) => r.status !== 'ok').map((r) => r.message ?? 'unknown'),
    };
    console.log(
      `[push] ${msg.kind ?? 'event'}: sent ${result.sent}, skipped ${result.skipped}` +
        (result.errors.length ? ` — ${result.errors[0]}` : ''),
    );
    return result;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.log(`[push] ${msg.kind ?? 'event'}: failed — ${detail}`);
    return { sent: 0, skipped: tokens.length, errors: [detail] };
  }
}
