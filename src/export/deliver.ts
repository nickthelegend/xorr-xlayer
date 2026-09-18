/**
 * Getting a generated file out of the app, on whichever platform is asking.
 *
 * `Share.share()` is the right call on a phone and the wrong one in a browser. React Native Web
 * maps it to `navigator.share`, which Chrome on desktop rejects outright — the export screen showed
 * "Permission denied" and produced no file, which on a screen whose entire purpose is producing a
 * file is a complete failure dressed as a handled error.
 *
 * A browser already has the right mechanism: a download. So the platform split lives here rather
 * than in the screen, which should not know or care.
 *
 * Deliberately not `expo-sharing` or `expo-file-system` — a download is three lines of platform API
 * and the app does not otherwise need a filesystem dependency to hand someone a CSV.
 */
import { Platform, Share } from 'react-native';

export type Delivered = { ok: true; how: 'download' | 'share' } | { ok: false; reason: string };

/**
 * @param filename what the file should be called once it lands
 * @param body     the file itself, already generated
 * @param mime     so a browser opens it with the right thing
 */
export async function deliverFile(
  filename: string,
  body: string,
  mime = 'text/csv',
): Promise<Delivered> {
  if (Platform.OS === 'web') {
    try {
      /*
       * Guarded rather than assumed. `Platform.OS === 'web'` is true in a browser and also in a
       * web-based test environment that may have no DOM, and a screen crashing on `document` would
       * be a worse outcome than a stated failure.
       */
      const doc = typeof document === 'undefined' ? undefined : document;
      if (!doc) return { ok: false, reason: 'No browser document to download into.' };

      const url = URL.createObjectURL(new Blob([body], { type: `${mime};charset=utf-8` }));
      const a = doc.createElement('a');
      a.href = url;
      a.download = filename;
      doc.body.appendChild(a);
      a.click();
      a.remove();
      // Freed on the next tick: revoking synchronously can cancel the download in some browsers
      // before it has read the blob.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      return { ok: true, how: 'download' };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  try {
    /*
     * On a phone the body goes in `message`, because there is no file to point at without writing
     * one to disk first — and a share sheet takes text perfectly well.
     */
    const res = await Share.share({ message: body, title: filename });
    // Dismissing the sheet is not a failure; the user changed their mind.
    return res.action === Share.dismissedAction
      ? { ok: false, reason: 'Cancelled.' }
      : { ok: true, how: 'share' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
