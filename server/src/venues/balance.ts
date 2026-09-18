/**
 * What a wallet holds on Base, as 1inch reads it (PLAN.md 3.10).
 *
 * Two 1inch APIs, two jobs:
 *
 *   - `/balance/v1.2/8453/balances/:wallet` answers with the raw balance of every token on 1inch's Base list, zeros
 *     included, keyed by lowercase address, with native ETH under the 0xeeee sentinel. The list is 1inch's own: 187
 *     tokens on 2026-09-13, every registry token among them, the eight equities included. So it answers for far
 *     more than this app trades, and not for every airdrop a stranger sends.
 *   - `/token/v1.2/8453/custom?addresses=` says what each held address is — symbol, name, decimals, logo — keyed the
 *     same way. An address it does not know is left out of the answer rather than refused.
 *
 * Base mainnet is the only chain these read. On a fork or a testnet they would describe a chain the executor is not
 * on, so `routes/tokens.ts` reads the chain itself there.
 */
import { formatUnits, getAddress, type Address } from 'viem';
import { ONEINCH_CHAIN_ID } from '../evm/chains.js';
import { COINGECKO_IDS } from '../market/ids.js';
import { TOKENS, oneinchApi } from './oneinch.js';

/** 1inch's sentinel for native ETH, spelled the way the Balance API keys it. */
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/**
 * Short, because this is a balance: a list refreshed after a trade has to show the trade. Long enough that the reads
 * a tab starts together cost 1inch one request between them.
 */
const BALANCE_TTL_MS = 5_000;

/** What a token is does not change, and `described` keeps each answer once it has one. */
const TOKEN_TTL_MS = 6 * 60 * 60 * 1_000;

/**
 * Addresses per Token API request.
 *
 * All 187 of 1inch's Base tokens were described in one request (1.2 s, 2026-09-13), so any wallet costs at most two.
 * The bound is there so the URL cannot grow with 1inch's list.
 */
const TOKEN_BATCH = 100;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** One token as 1inch's Token API describes it. */
export type TokenInfo = {
  /** Lowercase, as the API keys it. */
  address: string;
  symbol: string;
  name?: string;
  decimals: number;
  logoURI: string | null;
};

/** One token a wallet holds, before it is priced. `routes/tokens.ts` builds the same shape from the chain. */
export type HeldToken = {
  symbol: string;
  name?: string;
  address: Address;
  decimals: number;
  units: number;
  logo: string | null;
  native?: true;
  /**
   * The symbol to ask a price feed for, or null where no feed can be trusted to mean this token.
   *
   * Feeds are keyed by ticker, and a ticker is a label anyone can reuse, so pricing a token claims what it is. A
   * token the registry names BY ADDRESS is priced as the registry's symbol. Anything else is priced only when its
   * symbol is exactly a crypto feed's (`LINK`, `AAVE`): the Balance API only answers for 1inch's curated list, so
   * that name is 1inch's word, not whatever a deployer typed. Never an equity by ticker, and never uppercased to
   * find one: an equity is its registry address, and a look-alike `NVDAC` priced off the real one's quote would be
   * an invented value.
   */
  feed: string | null;
};

export type BaseHoldings = {
  tokens: HeldToken[];
  /**
   * Held, with a balance, but 1inch would not describe them: there is no symbol or decimals to show them with.
   * Returned rather than dropped, because a list that silently leaves out a held token reads as the whole wallet.
   */
  undescribed: Address[];
};

/**
 * Every token on 1inch's Base list this wallet holds any of, keyed by lowercase address.
 *
 * The answer has a row for every listed token, zeros included, and only the non-zero ones are kept. A body that is not
 * a map of addresses to digit strings throws: read loosely, an answer whose shape 1inch changed would come back as an
 * empty wallet.
 */
export async function oneinchBalances(owner: Address): Promise<Map<string, bigint>> {
  const body = await oneinchApi<unknown>(`/balance/v1.2/${ONEINCH_CHAIN_ID}/balances/${owner}`, BALANCE_TTL_MS);
  if (!isRecord(body)) throw new Error('1inch Balance API did not answer with a map of balances');
  const held = new Map<string, bigint>();
  for (const [address, raw] of Object.entries(body)) {
    if (!ADDRESS.test(address) || typeof raw !== 'string' || !/^\d+$/.test(raw)) {
      throw new Error(`1inch Balance API answered ${JSON.stringify(raw)} for ${address}`);
    }
    const balance = BigInt(raw);
    if (balance > 0n) held.set(address.toLowerCase(), balance);
  }
  return held;
}

/**
 * Descriptions already given, by lowercase address.
 *
 * Only decided answers are kept. An address 1inch left out is asked about again next time rather than remembered as
 * unknown: the list is 1inch's and grows, while a token that has been described stays what it is.
 */
const described = new Map<string, TokenInfo>();

/** What 1inch's Token API says each address is. An address it does not describe is absent from the result. */
export async function tokenInfo(addresses: readonly string[]): Promise<Map<string, TokenInfo>> {
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))];
  // Sorted, so the same holdings ask the same URL and a repeat can be answered from `http/get.ts`'s cache.
  const unknown = wanted.filter((a) => !described.has(a)).sort();
  for (let i = 0; i < unknown.length; i += TOKEN_BATCH) {
    const batch = unknown.slice(i, i + TOKEN_BATCH);
    const body = await oneinchApi<unknown>(
      `/token/v1.2/${ONEINCH_CHAIN_ID}/custom?addresses=${batch.join(',')}`,
      TOKEN_TTL_MS,
    );
    if (!isRecord(body)) throw new Error('1inch Token API did not answer with a map of tokens');
    for (const [key, entry] of Object.entries(body)) {
      const info = parseInfo(key, entry);
      if (info) described.set(info.address, info);
    }
  }
  const out = new Map<string, TokenInfo>();
  for (const address of wanted) {
    const info = described.get(address);
    if (info) out.set(address, info);
  }
  return out;
}

/**
 * Every token this wallet holds on Base: 1inch's balances, described by 1inch's Token API.
 *
 * A token the registry names keeps the registry's spelling (`CBBTC`, not 1inch's `cbBTC`), so it reads the same here,
 * on a fork, and in the ledger's Holdings; 1inch still gives its name and logo. Decimals are 1inch's, since 1inch reads
 * them from the contract, and the registry's only where 1inch gave none.
 *
 * Either API failing throws. The caller answers that as a failure, because an empty list says the wallet is empty.
 */
export async function holdingsOnBase(owner: Address): Promise<BaseHoldings> {
  const balances = await oneinchBalances(owner);
  // Nothing held is an answer in itself, and leaves nothing to ask the Token API about.
  if (balances.size === 0) return { tokens: [], undescribed: [] };

  const info = await tokenInfo([...balances.keys()]);
  const registry = new Map(Object.entries(TOKENS).map(([symbol, t]) => [t.address.toLowerCase(), symbol]));

  const tokens: HeldToken[] = [];
  const undescribed: Address[] = [];
  for (const [address, raw] of balances) {
    const meta = info.get(address);
    const registered = registry.get(address);
    const decimals = meta?.decimals ?? (registered === undefined ? undefined : TOKENS[registered]?.decimals);
    const symbol = registered ?? meta?.symbol;
    if (decimals === undefined || symbol === undefined) {
      undescribed.push(getAddress(address));
      continue;
    }
    tokens.push({
      symbol,
      ...(meta?.name ? { name: meta.name } : {}),
      address: getAddress(address),
      decimals,
      units: Number(formatUnits(raw, decimals)),
      logo: meta?.logoURI ?? null,
      ...(address === NATIVE ? { native: true as const } : {}),
      // `hasOwn`, not `in` or a lookup: a symbol like `constructor` is on every object's prototype and is no feed.
      feed: registered ?? (Object.hasOwn(COINGECKO_IDS, symbol) ? symbol : null),
    });
  }
  return { tokens, undescribed };
}

/** Testing only — a description remembered from one case would answer the next without asking. */
export function resetTokenInfo(): void {
  described.clear();
}

/** One Token API entry, or undefined where it lacks what a balance needs to be shown: an address, a symbol, decimals. */
function parseInfo(key: string, entry: unknown): TokenInfo | undefined {
  if (!isRecord(entry)) return undefined;
  const address = typeof entry.address === 'string' ? entry.address : key;
  const { symbol, name, decimals, logoURI } = entry;
  if (!ADDRESS.test(address) || typeof symbol !== 'string' || !symbol.trim()) return undefined;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return undefined;
  return {
    address: address.toLowerCase(),
    symbol: symbol.trim(),
    ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
    decimals,
    logoURI: typeof logoURI === 'string' && logoURI ? logoURI : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
