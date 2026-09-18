/**
 * What a deposit can arrive as, and what the wallet holds of it (PLAN.md P4.7, P4.12; owner decisions D8, D16).
 *
 * A deposit is USDC or USDT0 sent to the wallet's address on X Layer. The executor settles in USDC; USDT0 is accepted
 * because it is what OKX withdraws on X Layer, and the person can convert it to USDC themselves (`convert.ts`). Gas is
 * OKB, the chain's own token — a conversion the person signs spends a little of it.
 *
 * The balances come from `GET /wallet/tokens`, which reads the chain. That route lists only what is held, so a token it
 * does not list is a zero, and the rows here say so rather than hiding the token.
 */
import type { WalletTokens } from '@/data/walletTokens';
import type { FundsRead } from '@/state/moneyIn';

/** Both deposit tokens are six-decimal dollars. */
export const STABLE_DECIMALS = 6;
const GAS_DECIMALS = 18;

/** Circle's native USDC on X Layer mainnet (not USDC.e). */
export const USDC_MAINNET = '0xB6CEceAB302E2E4948951eE7843FC24E92933061';
/** Circle's USDC on X Layer testnet (1952). */
export const USDC_TESTNET = '0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3';
/** Tether's USD₮0 on X Layer mainnet. There is none on the testnet. */
export const USDT0_MAINNET = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';

/** The chains this app builds for, as `src/chain.ts` names them. */
export type DepositChainKey = 'xlayer' | 'xlayer-testnet' | 'xlayer-fork' | 'localnet';

/** Mainnet and its fork carry the real tokens and pools; the testnet and its local copy carry only USDC. */
export function hasMainnetState(chain: DepositChainKey): boolean {
  return chain === 'xlayer' || chain === 'xlayer-fork';
}

/** The USDC and USDT0 contracts on a chain. USDT0 is null where it does not exist. */
export function stablecoinsOn(chain: DepositChainKey): { usdc: string; usdt0: string | null } {
  return hasMainnetState(chain) ? { usdc: USDC_MAINNET, usdt0: USDT0_MAINNET } : { usdc: USDC_TESTNET, usdt0: null };
}

/** What may be sent to the address on this chain, in words. */
export function acceptedTokens(chain: DepositChainKey): string {
  return stablecoinsOn(chain).usdt0 ? 'USDC or USDT0' : 'USDC';
}

/** One balance: its base units exactly as a decimal string, and the amount they make. */
export type Held = { raw: string; amount: number };

export type DepositBalances = {
  owner: string;
  chain: string;
  usdc: Held;
  /** Null on a chain with no USDT0. */
  usdt0: Held | null;
  /** OKB, for the gas a transaction the person signs spends. */
  gas: Held;
};

const ZERO: Held = { raw: '0', amount: 0 };

/**
 * Base units from an amount, through its decimal string rather than a multiplication — `0.1 * 1e18` is not an integer.
 * The route sends amounts as numbers, so this is as exact as the number is; it is used to see balances rise, never to
 * build a transaction (the conversion reads its amount from the chain).
 */
export function toRaw(amount: number, decimals: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '0';
  const [whole, fraction = ''] = amount.toFixed(Math.min(decimals, 20)).split('.');
  const digits = `${whole}${fraction.padEnd(decimals, '0').slice(0, decimals)}`.replace(/^0+(?=\d)/, '');
  return /^\d+$/.test(digits) ? digits : '0';
}

/**
 * USDC, USDT0 and OKB out of a `/wallet/tokens` read. A token is matched by its contract, never its symbol — two tokens
 * can share a symbol, and OKX's bridged USDC.e is not USDC — and a token the list leaves out is held at zero.
 */
export function depositBalances(read: WalletTokens, chain: DepositChainKey): DepositBalances {
  const { usdc, usdt0 } = stablecoinsOn(chain);
  const find = (address: string) =>
    read.tokens.find((t) => !t.native && t.address.toLowerCase() === address.toLowerCase());
  const held = (units: number | undefined, decimals: number): Held =>
    units === undefined || !(units > 0) ? ZERO : { raw: toRaw(units, decimals), amount: units };

  const gas = read.tokens.find((t) => t.native);
  return {
    owner: read.owner,
    chain: read.chain,
    usdc: held(find(usdc)?.units, STABLE_DECIMALS),
    usdt0: usdt0 ? held(find(usdt0)?.units, STABLE_DECIMALS) : null,
    gas: held(gas?.units, GAS_DECIMALS),
  };
}

/** Nothing to trade with yet: no USDC and no USDT0. Gas alone is not a deposit. */
export function isUnfunded(balances: DepositBalances): boolean {
  return balances.usdc.amount <= 0 && (balances.usdt0?.amount ?? 0) <= 0;
}

/** The read as `moneyIn.ts` judges arrivals from it. */
export function asFundsRead(balances: DepositBalances, chain: DepositChainKey): FundsRead {
  const { usdc, usdt0 } = stablecoinsOn(chain);
  return {
    owner: balances.owner,
    chain: balances.chain,
    usdc: { ...balances.usdc, address: usdc },
    eth: balances.gas,
    ...(balances.usdt0 && usdt0 ? { usdt0: { ...balances.usdt0, address: usdt0 } } : {}),
  };
}
