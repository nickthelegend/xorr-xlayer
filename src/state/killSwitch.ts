/**
 * killSwitch.ts — whether the agents can trade, decided from the chain.
 *
 * This is the most dangerous label in the app to get wrong, and it is wrong in only one direction. A chip that says
 * STOPPED over a live permission is alarming and harmless — the user goes and looks. A chip that says ARMED over a
 * revoked one, or over a chain nobody could read, tells someone their money is under management when it may not be, or
 * that a stop they just pulled did not take. So:
 *
 *   **Armed is claimed only when the chain itself said `live`.** Every other answer — revoked, expired, never granted,
 *   unreadable, still reading — is something other than armed, and each says which.
 *
 * ## Why not the stored flag
 *
 * `store.killed` is a boolean this browser wrote when someone pressed the button here. It drifts the moment anything
 * happens anywhere else: a revoke from another device, a permission that expired on its own, a reload after site data
 * was cleared, or simply the write not landing. This app has already shipped a green LIVE badge over a permission the
 * contract reported revoked — that is this exact bug, and the stored flag is how it happened.
 *
 * The chain is the only party that knows, so the chain is asked. The executor's `/limits` is not a second opinion
 * either: it is a record of what the executor believes, which is a different question from what the contract says.
 */

/** What the chain reported, as `standingOnChain` reports it (`src/wallet/delegationChain.ts`). */
export type ChainStandingKind = 'live' | 'revoked' | 'expired' | 'none' | 'unreadable';

/**
 * What the chip says.
 *
 * `unreadable` and `checking` are deliberately separate, and neither is `disarmed`: not knowing is not the same as
 * knowing it is off, and a chip that quietly rounds "could not ask" down to "stopped" is as wrong as one that rounds it
 * up to "armed" — it just fails in the reassuring direction, which is worse.
 */
export type KillSwitchState = 'armed' | 'stopped' | 'expired' | 'ungranted' | 'unreadable' | 'checking';

export type KillSwitchChip = {
  state: KillSwitchState;
  /** The word on the chip. */
  label: string;
  /** One line under it, for a surface with room. */
  detail: string;
  /** Whether the agents can place an order right now. **True only on a live chain read.** */
  armed: boolean;
  /** The chain could not be asked, or has not answered. Neither confirms nor denies. */
  unknown: boolean;
};

const CHIPS: Readonly<Record<KillSwitchState, Omit<KillSwitchChip, 'state'>>> = {
  armed: {
    label: 'Armed',
    detail: 'The permission is live on-chain. Agents can place orders inside your limits.',
    armed: true,
    unknown: false,
  },
  stopped: {
    label: 'Stopped',
    detail: 'The permission is revoked on-chain. Nothing can trade until you grant again.',
    armed: false,
    unknown: false,
  },
  expired: {
    label: 'Expired',
    detail: 'The permission reached its end date. Nothing can trade until you grant again.',
    armed: false,
    unknown: false,
  },
  ungranted: {
    label: 'Not granted',
    detail: 'No permission has been granted, so nothing can trade.',
    armed: false,
    unknown: false,
  },
  /*
   * Said plainly, because the alternative is to pick one of the two real answers and be wrong half the time on the
   * question of whether something is currently allowed to spend money.
   */
  unreadable: {
    label: 'Can’t check',
    detail: 'The chain could not be reached, so whether agents can trade is not known right now.',
    armed: false,
    unknown: true,
  },
  checking: {
    label: 'Checking',
    detail: 'Asking the chain whether the permission is live.',
    armed: false,
    unknown: true,
  },
};

/**
 * The chip, from the chain's answer.
 *
 * `undefined` is a read still out. A failed read is `unreadable` — the caller passes `'unreadable'` for both the
 * chain's own "I could not read this" and a request that never got there, because to a reader they are the same fact.
 */
export function killSwitchChip(standing: ChainStandingKind | undefined, failed = false): KillSwitchChip {
  const state: KillSwitchState = failed
    ? 'unreadable'
    : standing === undefined
      ? 'checking'
      : standing === 'live'
        ? 'armed'
        : standing === 'revoked'
          ? 'stopped'
          : standing === 'expired'
            ? 'expired'
            : standing === 'none'
              ? 'ungranted'
              : 'unreadable';
  return { state, ...CHIPS[state] };
}
