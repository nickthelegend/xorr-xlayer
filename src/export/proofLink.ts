/**
 * A link to one wallet's live checks (FEATURES.md #22).
 *
 * `/judge` and `/verify` run every claim this app makes against the wallet they are asked about, and neither needs an
 * account. A link that opens straight to one wallet's checks is how that becomes something a person can hand on — not
 * "trust me" but "run this". It carries the address and nothing else, which anyone could already look up on an
 * explorer; the screen it opens reads everything else live.
 *
 * Pure, so what a link may name and where it may point are tested without a browser. Handing it over is `shareLink.ts`.
 */
import { isAddress } from 'viem';

/** The two screens that run the checks. */
export type ProofRoute = '/judge' | '/verify';

/**
 * The owner a link asks about, or nothing.
 *
 * Checked the way the executor checks it — viem's `isAddress`, checksum and all, in server/src/routes/verify.ts — so a
 * link the executor would refuse with a 400 opens the screen as if it named no one, rather than to an error about the
 * link. `?owner=a&owner=b` names no one wallet, and goes the same way.
 */
export function linkedOwner(raw: string | string[] | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const owner = raw.trim();
  return isAddress(owner) ? owner : undefined;
}

/**
 * The origin a shared link points at, or nothing when this build cannot name one.
 *
 * In a browser it is the page's own origin, which is by definition an address this screen was just served from. A phone
 * has no such thing. The build knows its executor (`EXPO_PUBLIC_API_URL`) and its chain's RPC, and neither is where the
 * web app lives; no variable names that, and a host written into the source would go on pointing there after the app
 * moved. So a phone makes no link, and the screens draw no control to share one. Nor does a page whose origin is not
 * http(s) — a `file:` page, or a sandbox that reports "null".
 */
export function linkOrigin(platform: string, pageOrigin: string | undefined): string | undefined {
  if (platform !== 'web' || !pageOrigin) return undefined;
  return /^https?:\/\/[^/\s]+$/.test(pageOrigin) ? pageOrigin : undefined;
}

/** The link, or `undefined` wherever there is no origin to point it at or no wallet for it to name. */
export function proofLink(origin: string | undefined, route: ProofRoute, owner: string | undefined): string | undefined {
  const who = linkedOwner(owner);
  return origin && who ? `${origin}${route}?owner=${encodeURIComponent(who)}` : undefined;
}

/**
 * Whether a share sheet was closed, rather than refused.
 *
 * The Web Share API rejects both ways: `AbortError` when the person dismissed the sheet, `NotAllowedError` — desktop
 * Chrome's answer, among others — when the browser would not show one. Only a refusal is a reason to copy the link
 * instead. Writing to someone's clipboard after they chose not to share is doing the thing they just declined.
 */
export function shareDismissed(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}
