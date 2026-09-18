/**
 * Money semantics and facts per cluster for xorr-solana (PLAN.md §8.1).
 */
import { CLUSTER_KEY, DEFAULT_MINTS, type SolanaClusterKey } from './clusters.js';

export type MoneyClass = 'copy' | 'test' | 'real';

export type MoneyFacts = {
  money: MoneyClass;
  settlementMint: string;
  settlementDecimals: number;
  solDecimals: number;
  stockDecimals: number;
  faucetAllowed: boolean;
  canDripSol: boolean;
  canMintTokens: boolean;
  isMainnet: boolean;
};

export const FACTS: Record<SolanaClusterKey, MoneyFacts> = {
  'solana-localnet': {
    money: 'copy',
    settlementMint: process.env.SOLANA_USDC_MINT ?? DEFAULT_MINTS.USDC,
    settlementDecimals: 6,
    solDecimals: 9,
    stockDecimals: 8,
    faucetAllowed: true,
    canDripSol: true,
    canMintTokens: true,
    isMainnet: false,
  },
  'solana-devnet': {
    money: 'test',
    settlementMint: process.env.SOLANA_USDC_MINT ?? DEFAULT_MINTS.USDC,
    settlementDecimals: 6,
    solDecimals: 9,
    stockDecimals: 8,
    faucetAllowed: true,
    canDripSol: true,
    canMintTokens: true,
    isMainnet: false,
  },
  'solana-fork': {
    money: 'copy',
    settlementMint: process.env.SOLANA_USDC_MINT ?? DEFAULT_MINTS.USDC,
    settlementDecimals: 6,
    solDecimals: 9,
    stockDecimals: 8,
    faucetAllowed: true,
    canDripSol: true,
    canMintTokens: true,
    isMainnet: false,
  },
  'solana-mainnet': {
    money: 'real',
    settlementMint: DEFAULT_MINTS.USDC,
    settlementDecimals: 6,
    solDecimals: 9,
    stockDecimals: 8,
    faucetAllowed: false,
    canDripSol: false,
    canMintTokens: false,
    isMainnet: true,
  },
};

export function factsFor(cluster: SolanaClusterKey = CLUSTER_KEY): MoneyFacts {
  return FACTS[cluster];
}

export const CURRENT_FACTS = factsFor();
