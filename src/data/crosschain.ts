/**
 * Cross-chain quotes, read-only — PLAN.md 3.16.
 *
 * The executor asks 1inch's Fusion+ quoter what would arrive on another chain for USDC or WETH sent from Base, and
 * answers with the auction presets a person would choose between. Nothing here can submit one: a Fusion+ order locks
 * real funds on mainnet, so every quote comes back `submittable: false`, with the reason.
 *
 * These types mirror `server/src/venues/fusion-plus.ts` field for field.
 */
import { api } from './api';

export type CrosschainToken = 'USDC' | 'WETH';

/** Where a quote can go from Base, and the contract that arrives on that chain. */
export type CrosschainDestination = {
  chainId: number;
  name: string;
  tokens: Record<CrosschainToken, { address: string; decimals: number }>;
};

export type CrosschainDestinations = {
  from: { chainId: number; name: string };
  tokens: CrosschainToken[];
  destinations: CrosschainDestination[];
};

/** One auction preset. Amounts are what arrives on the destination chain, in token units. */
export type CrosschainPreset = {
  name: 'fast' | 'medium' | 'slow';
  /** The preset 1inch recommends for this quote. */
  recommended: boolean;
  /** Seconds until the auction opens, and how long it then runs. Not an arrival time: a resolver fills inside it. */
  startsInSeconds: number;
  auctionSeconds: number;
  /** At the auction's opening price, and the least the price may fall to. */
  receiveMost: number;
  receiveLeast: number;
  /** 1inch's estimate of what filling costs. `costUsd` is null when 1inch sent no price — unpriced, not free. */
  costInToken: number;
  costUsd: number | null;
};

export type CrosschainQuote = {
  token: CrosschainToken;
  from: { chainId: number; name: string; address: string; amount: number };
  to: { chainId: number; name: string; address: string; amount: number };
  presets: CrosschainPreset[];
  submittable: false;
  reason: string;
};

/** The destinations the executor quotes, so a screen offers exactly the chains the route accepts. */
export function crosschainDestinations(): Promise<CrosschainDestinations> {
  return api.get<CrosschainDestinations>('/crosschain/destinations');
}

/**
 * What would arrive. `amount` is the decimal as typed; the executor parses it into base units, never through a float.
 *
 * A refusal throws an `ApiError` carrying the executor's sentence: 400 for a question it cannot ask, and 502 with
 * `error: 'quoter_refused'` when 1inch said no, or `'quoter_unavailable'` when 1inch did not answer.
 */
export function crosschainQuote(ask: { to: number; token: CrosschainToken; amount: string }): Promise<CrosschainQuote> {
  return api.get<CrosschainQuote>(
    `/crosschain/quote?to=${ask.to}&token=${ask.token}&amount=${encodeURIComponent(ask.amount)}`,
  );
}
