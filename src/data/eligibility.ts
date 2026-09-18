/**
 * May this wallet hold this xStock?
 *
 * xStocks are jurisdiction-restricted, and the issuer can pause the token, freeze an account, or
 * create new accounts frozen. The screen asks before it offers a buy, so a refusal is a sentence
 * rather than a transaction that fails after the money has moved.
 *
 * `eligible: false` with `indeterminate: true` means a gate could not be read. That is NOT a pass
 * and must never be drawn as one — which is why there is no boolean here that collapses the two.
 */
import { API_BASE } from './apiBase';

export type EligibilityCheck = {
  id: 'mint-paused' | 'transfer-hook' | 'account-frozen' | 'default-account-state';
  title: string;
  status: 'pass' | 'blocked' | 'not-configured' | 'unknown';
  detail: string;
};

export type Eligibility = {
  symbol: string;
  wallet: string;
  mint: string;
  eligible: boolean;
  indeterminate: boolean;
  checks: readonly EligibilityCheck[];
  summary: string;
  permanentDelegate: string | null;
};

export async function fetchEligibility(
  symbol: string,
  wallet: string,
  signal?: AbortSignal,
): Promise<Eligibility> {
  const unreadable = (summary: string): Eligibility => ({
    symbol,
    wallet,
    mint: '',
    eligible: false,
    indeterminate: true,
    checks: [],
    summary,
    permanentDelegate: null,
  });

  try {
    const res = await fetch(
      `${API_BASE}/xstocks/${encodeURIComponent(symbol)}/eligibility?wallet=${encodeURIComponent(wallet)}`,
      { signal },
    );
    if (!res.ok) return unreadable(`The executor answered ${res.status}, so eligibility is unknown.`);

    const body = (await res.json()) as Eligibility;
    if (typeof body?.eligible !== 'boolean') {
      return unreadable('The executor sent an answer this build cannot read.');
    }
    return body;
  } catch {
    return unreadable('The executor could not be reached, so eligibility is unknown.');
  }
}

/** Whether a buy may be offered at all. Unknown is not permission. */
export function mayBuy(e?: Eligibility): boolean {
  return e?.eligible === true;
}
