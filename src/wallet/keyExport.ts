/**
 * A copy of the wallet's private key, where Privy can give one (PLAN.md 4.10).
 *
 * xorr never holds the key, so it cannot hand one over; Privy can. On the web its export window shows the key inside
 * Privy's own frame, and xorr only asks for that window to open. Privy's mobile SDK has no export at all, so a phone
 * says where the export is instead of drawing a button that could not work.
 */
export type KeyExport =
  | { supported: true; exportKey: () => Promise<void> }
  | { supported: false; reason: string };

/** Signing in at the web app with the same email reaches the same Privy wallet, so its export is this wallet's. */
export const EXPORT_ON_WEB = 'Export your key at app.xorr.finance, signed in with this email.';

export const EXPORT_NEEDS_WALLET = 'Sign in to export your key.';
