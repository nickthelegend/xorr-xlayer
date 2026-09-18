/**
 * The way in from OKX (PLAN.md P4.7, owner decisions D8 and D16): a link out, never a card form inside the app.
 *
 * The purchase happens on OKX, in OKX's own pages: buy USDC or USDT0 there, then withdraw it to this wallet's address on
 * the X Layer network. The link is OKX's public "Buy crypto" page (checked to answer 200, 2026-09-19). No query
 * parameters are added — none that pre-fill a token, a network or an address could be verified, and a guessed one would
 * be worse than none.
 */
import * as WebBrowser from 'expo-web-browser';

export const OKX_BUY_URL = 'https://www.okx.com/buy-crypto';

/** Opens OKX in the in-app browser (a new tab on web). */
export async function openOkx(): Promise<void> {
  await WebBrowser.openBrowserAsync(OKX_BUY_URL);
}
