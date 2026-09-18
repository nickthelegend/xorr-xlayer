/**
 * What the wallet holds, in the chain's own words — `GET /wallet/tokens` (PLAN.md 3.10).
 *
 * The Assets tab already lists Holdings, and those are the LEDGER: what the executor recorded buying and selling.
 * A wallet is more than that book — the OKB that pays for gas, a deposit, a token sent in, anything bought somewhere
 * else — and this is the read that says what is actually there. On every X Layer network the executor reads the
 * chain itself: native OKB, USDC and every registry token. `source` says so, and the screen repeats it.
 *
 * These types mirror the executor's response field for field. Every nullable is nullable because the executor
 * could not know it, and a zero would be a different claim.
 */
import { api } from './api';

export type WalletToken = {
  /** The registry's spelling for a token the app trades (`XBTC`, `NVDAx`), or `OKB` for the gas token. */
  symbol: string;
  /** The token's name, where the executor gave one. Absent from a chain read. */
  name?: string;
  /** Checksummed. A token IS its address; two tokens can share a symbol. */
  address: string;
  decimals: number;
  units: number;
  /** Null where no price feed can be trusted to mean this token, or none answered in time. Never 0 for "unknown". */
  usd: number | null;
  /** Null where no registry had a logo for it; the mark keeps its gradient. */
  logo: string | null;
  /** Native OKB, the gas token, which has no contract. */
  native?: boolean;
};

export type WalletTokens = {
  owner: string;
  chain: string;
  /** Where the balances came from: the chain, read directly — the only source on X Layer. */
  source: 'chain';
  /** Largest dollar value first; the unpriced after, by symbol. */
  tokens: WalletToken[];
  /**
   * Held, with a balance, but with no symbol or decimals to show them with. Listed rather than dropped, so a list
   * missing them says so. A chain read only asks after tokens it knows, so this is empty on X Layer.
   */
  undescribed: string[];
};

export function walletTokens(): Promise<WalletTokens> {
  return api.get<WalletTokens>('/wallet/tokens');
}
