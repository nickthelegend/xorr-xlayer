/**
 * What the wallet holds, in the chain's own words — `GET /wallet/tokens` (PLAN.md 3.10).
 *
 * The Assets tab already lists Holdings, and those are the LEDGER: what the executor recorded buying and selling.
 * A wallet is more than that book — gas ETH, a deposit, a token sent in, anything bought somewhere else — and this
 * is the read that says what is actually there. On Base the executor asks 1inch's Balance API; on a fork or a
 * testnet it reads the chain itself. `source` says which, and the screen repeats it.
 *
 * These types mirror the executor's response field for field. Every nullable is nullable because the executor
 * could not know it, and a zero would be a different claim.
 */
import { api } from './api';

export type WalletToken = {
  /** The registry's spelling for a token the app trades (`CBBTC`, `NVDAc`); 1inch's for anything else. */
  symbol: string;
  /** 1inch's name for the token, where it gave one. Absent on a fork or testnet. */
  name?: string;
  /** Checksummed. A token IS its address; two tokens can share a symbol. */
  address: string;
  decimals: number;
  units: number;
  /** Null where no price feed can be trusted to mean this token, or none answered in time. Never 0 for "unknown". */
  usd: number | null;
  /** Null where no registry had a logo for it; the mark keeps its gradient. */
  logo: string | null;
  /** Native ETH, which has no contract — its address is 1inch's sentinel. */
  native?: true;
};

export type WalletTokens = {
  owner: string;
  chain: string;
  /** Where the balances came from: 1inch's Balance API on Base, or the chain read directly. */
  source: '1inch' | 'chain';
  /** Largest dollar value first; the unpriced after, by symbol. */
  tokens: WalletToken[];
  /**
   * Held, with a balance, but 1inch would not say what they are — so there is no symbol or decimals to show them
   * with. Listed rather than dropped, so a list missing them says so.
   */
  undescribed: string[];
};

export function walletTokens(): Promise<WalletTokens> {
  return api.get<WalletTokens>('/wallet/tokens');
}
