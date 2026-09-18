/**
 * The business treasury, as the executor reports it (PLAN.md 4.14; `server/src/routes/business.ts`).
 *
 * Every answer that changed something carries the treasury read again after the action and a sentence saying what
 * happened, so a screen shows the state that resulted rather than the step it asked for.
 */
import { api } from './api';
import type { Keyed } from './intentKey';

export type TreasuryPermission =
  | { state: 'none' }
  | { state: 'live' | 'stopped' | 'expired'; dailyCapUsd: number; remainingUsd: number; expiresAt: number };

export type TreasuryActivity = { at: number; action: string; detail: string; tx: string | null };

export type TreasuryView = {
  id: string;
  name: string;
  address: string;
  createdAt: number;
  /** What Privy holds and enforces for the wallet, read from Privy. */
  privy: {
    walletId: string;
    ownerId: string | null;
    policyId: string | null;
    policyName: string | null;
    policyOwnerId: string | null;
    rules: number;
  };
  balances: { usdc: number; eth: number };
  permission: TreasuryPermission;
  /** Whether test funds can be sent here now; null when that could not be read. */
  fundable: boolean | null;
  /** Newest first. */
  activity: TreasuryActivity[];
};

export type TreasuryAnswer = { treasury: TreasuryView; note: string; tx?: string };

export const business = {
  treasury: () => api.get<{ treasury: TreasuryView | null }>('/business/treasury'),
  create: (name: string, write?: Keyed) => api.post<TreasuryAnswer>('/business/treasury', { name }, write),
  fund: (write?: Keyed) => api.post<TreasuryAnswer>('/business/treasury/fund', {}, write),
  grant: (dailyCapUsd: number, days: number, write?: Keyed) =>
    api.post<TreasuryAnswer>('/business/treasury/grant', { dailyCapUsd, days }, write),
  buy: (symbol: string, usd: number, write?: Keyed) =>
    api.post<TreasuryAnswer>('/business/treasury/buy', { symbol, usd }, write),
  revoke: (write?: Keyed) => api.post<TreasuryAnswer>('/business/treasury/revoke', {}, write),
  prove: () => api.post<TreasuryAnswer>('/business/treasury/prove', {}),
};
