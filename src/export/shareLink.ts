/**
 * Handing someone the link to a wallet's checks, on whichever platform is asking (FEATURES.md #22).
 *
 * `deliverFile` beside this learned the first half: `Share.share` is the wrong call in a browser, because
 * react-native-web maps it to `navigator.share` and desktop Chrome refuses. A link is not a file, though. A browser that
 * will open a share sheet for one should, and one that cannot — or will not — copies it instead, and says so in a word.
 */
import { useCallback, useState } from 'react';
import { Platform, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { linkOrigin, proofLink, shareDismissed, type ProofRoute } from './proofLink';

export type Shared = 'shared' | 'copied' | 'dismissed';

/** The link to `owner`'s checks from where this is running, or `undefined` where there is nothing to point it at. */
export function linkTo(route: ProofRoute, owner: string | undefined): string | undefined {
  const page = Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : undefined;
  return proofLink(linkOrigin(Platform.OS, page), route, owner);
}

/**
 * Share `url`, or copy it.
 *
 * In a browser `navigator.share` is the first thing awaited. A browser opens the sheet only inside the press that asked
 * for it, and an `await` in front of the call spends that press.
 */
export async function shareLink(url: string): Promise<Shared> {
  if (Platform.OS !== 'web') {
    // iOS shares a `url`; Android reads only `message`.
    const sheet = await Share.share(Platform.OS === 'ios' ? { url } : { message: url });
    return sheet.action === Share.dismissedAction ? 'dismissed' : 'shared';
  }
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  if (nav && typeof nav.share === 'function' && (typeof nav.canShare !== 'function' || nav.canShare({ url }))) {
    try {
      await nav.share({ url });
      return 'shared';
    } catch (e) {
      if (shareDismissed(e)) return 'dismissed';
      // Refused rather than closed, which leaves the clipboard.
    }
  }
  // `setStringAsync` answers false, rather than throwing, when even the browser's older copy fails.
  if (!(await Clipboard.setStringAsync(url))) throw new Error('The link was not copied.');
  return 'copied';
}

/**
 * A share control: its label, and what pressing it does.
 *
 * "Copied" is the whole confirmation, and it stays until the link changes, as Deposit's does. A share that failed says
 * so, rather than passing for a press that did nothing.
 */
export function useShareLink(url: string | undefined): { label: string; share: () => void } {
  const [outcome, setOutcome] = useState<{ url: string; copied: boolean }>();
  const share = useCallback(() => {
    if (!url) return;
    shareLink(url).then(
      (how) => setOutcome(how === 'copied' ? { url, copied: true } : undefined),
      () => setOutcome({ url, copied: false }),
    );
  }, [url]);
  const label = !outcome || outcome.url !== url ? 'Share' : outcome.copied ? 'Copied' : 'Couldn’t share';
  return { label, share };
}
