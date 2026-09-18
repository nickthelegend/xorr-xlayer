/**
 * Everything a position can say about what backs it (X Layer, 2026-09-19).
 *
 * Three sources, and they answer different questions:
 *
 *   the contracts   who the issuer's roles are, what those roles can do, whether transfers are
 *                   paused, how many tokens exist, and what the corporate-action multiplier is right
 *                   now — read on X Layer from the raw xStock (Backed's `BackedTokenImplementation`
 *                   behind an EIP-1967 proxy) and its ERC-4626 wrapper.
 *   the attestor    how many real shares sit with a custodian against tokens in circulation
 *                   (`proof-of-reserves.ts`, chain-agnostic).
 *   our own tables  how those two have moved, because neither source keeps history.
 *
 * What the contracts expose, probed read-only on X Layer mainnet on 2026-09-19 (NVDAx and TSLAx):
 *   raw      owner(), minter(), burner(), pauser(), multiplierUpdater(), sanctionsList(), isPaused(),
 *            multiplier(), newMultiplier(), newMultiplierActivationTime(), totalSupply(). No
 *            AccessControl (`hasRole` reverts), no `paused()`.
 *   wrapper  owner(), pauser(), isPaused(), totalSupply(), totalAssets(), asset() == raw.
 *   both     EIP-1967 proxies; the admin slot names a ProxyAdmin whose owner is the token owner.
 * And what the roles can do, established by `eth_call` simulation rather than assumed:
 *   minter   `mint(any, n)` succeeds from the minter and reverts "Only minter" from anyone else.
 *   pauser   `setPause(true)` succeeds from the pauser on both contracts ("Only pauser" otherwise).
 *   burner   `burn(holder, n)` on an account other than its own reverts "Cannot burn account" —
 *            there is no power to take tokens out of a holder's wallet (no Solana-style permanent
 *            delegate). `canSeize` is therefore not a field: nothing on chain answers it.
 *
 * Rules the drawer is built on:
 *
 *   A field is drawn from a recorded value or it is absent. `null` here means "we have no record
 *   of this", and the screen says so in words — never a dash, which reads as zero.
 *
 *   An attestation is reported with its age. `ageSeconds` is stated and `stale` is derived from
 *   it, so the screen never has to guess.
 */
import { createPublicClient, getAddress, http, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { xLayer } from 'viem/chains';
import { IS_MAINNET_STATE } from '../evm/chains.js';
import { query } from '../db/index.js';
import { backingFor, backingHistory, type CustodyHolding } from './proof-of-reserves.js';
import { XSTOCKS, xStockKey } from './xstocks.js';

/**
 * An attestation older than this is called stale.
 *
 * Backed's attestor refreshes roughly every ten minutes and Chainlink relays daily, so a day
 * without a fresh observation is the point at which "as of now" stops being a fair description.
 */
const STALE_AFTER_SECONDS = 24 * 60 * 60;

/** EIP-1967 admin slot: `bytes32(uint256(keccak256('eip1967.proxy.admin')) - 1)`. */
const ADMIN_SLOT: Hex = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

/** Every read below answered on X Layer mainnet on 2026-09-19. Nothing here is a guess at an interface. */
const RAW_ABI = parseAbi([
  'function owner() view returns (address)',
  'function minter() view returns (address)',
  'function burner() view returns (address)',
  'function pauser() view returns (address)',
  'function multiplierUpdater() view returns (address)',
  'function sanctionsList() view returns (address)',
  'function isPaused() view returns (bool)',
  'function multiplier() view returns (uint256)',
  'function newMultiplier() view returns (uint256)',
  'function newMultiplierActivationTime() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
]);
const WRAPPER_ABI = parseAbi([
  'function owner() view returns (address)',
  'function pauser() view returns (address)',
  'function isPaused() view returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
]);

/** All xStocks, raw and wrapped, are 18 decimals on X Layer; the multiplier is 1e18-scaled. */
const ONE = 10n ** 18n;

export type MultiplierPoint = {
  multiplier: number;
  effectiveAt: string;
  observedAt: string;
};

export type BackingDetail = {
  symbol: string;
  name: string | null;
  /** The ERC-4626 wrapper — what trades and what a wallet holds. (Was `mint` on Solana.) */
  address: string;
  /** The raw rebasing xStock behind the wrapper, where the issuer's roles live. */
  raw: string;

  /** The issuer's powers over the RAW token. Each address is null where it could not be read. */
  issuer: {
    /** Can reassign every role below, and owns the ProxyAdmin that can upgrade the contract. */
    owner: string | null;
    /** Can create new tokens. */
    minter: string | null;
    /** Can burn — only its own balance; burning a holder's balance reverts on chain. */
    burner: string | null;
    /** Can halt all transfers. */
    pauser: string | null;
    /** Can change the corporate-action multiplier. */
    multiplierUpdater: string | null;
    /** The contract whose list blocks an address from sending or receiving. */
    sanctionsList: string | null;
    /** The EIP-1967 ProxyAdmin: whoever controls it can replace the token's code. */
    upgradeAdmin: string | null;
    /** A non-zero minter is set. Null when the minter could not be read. */
    canMint: boolean | null;
    /** A non-zero pauser is set. Null when the pauser could not be read. */
    canPause: boolean | null;
    /** Whether transfers are halted right now. */
    paused: boolean | null;
  };

  /** The same questions of the wrapper, which has its own owner, pauser and proxy. */
  wrapper: {
    owner: string | null;
    pauser: string | null;
    upgradeAdmin: string | null;
    paused: boolean | null;
  };

  /** Tokens in existence on X Layer, in whole tokens. Null where unread. */
  supply: {
    /** Raw xStocks on X Layer (wrapped or not). */
    raw: number | null;
    /** Wrapper shares outstanding. */
    wrapped: number | null;
    /** Raw xStocks the wrapper holds (`totalAssets()`). */
    wrappedAssets: number | null;
  };

  reserves:
    | {
        verified: true;
        ratio: number;
        fullyBacked: boolean;
        sharesHeld: number;
        circulatingSupply: number;
        custodians: CustodyHolding[];
        /** The attestor's own observation time. */
        asOf: string;
        /** How old that observation is, in seconds, at the moment of this read. */
        ageSeconds: number;
        stale: boolean;
      }
    | { verified: false; reason: string };

  multiplier: {
    /** The raw token's `multiplier()`, 1.0 = no corporate action yet. Null where unread. */
    current: number | null;
    /** When the current multiplier took effect, where the contract states it. */
    effectiveAt: string | null;
    /** A scheduled change the issuer has already published on chain. */
    pending: { multiplier: number; effectiveAt: string } | null;
    /**
     * Changes we have actually recorded. Empty is a real answer — it means we have watched this
     * token but seen no change yet, not that no change has ever happened.
     */
    history: MultiplierPoint[];
  };

  /** Attestations we have recorded, newest first. Empty where we have not recorded any. */
  attestationHistory: { ratio: number; sharesHeld: number; asOf: string }[];
};

/** What this module needs of a viem public client — a fake is easy to hand in a test. */
export type BackingReader = {
  multicall(args: {
    contracts: readonly { address: Address; abi: unknown; functionName: string }[];
    allowFailure: true;
  }): Promise<{ status: 'success' | 'failure'; result?: unknown }[]>;
  getStorageAt(args: { address: Address; slot: Hex }): Promise<Hex | undefined>;
};

/**
 * The client these facts are read from. They are X Layer MAINNET facts: on mainnet or its fork the
 * executor's own client; on the testnet (where the xStocks do not exist) a mainnet reader.
 */
let mainnetReader: BackingReader | undefined;
async function defaultReader(): Promise<BackingReader> {
  if (IS_MAINNET_STATE) {
    const { publicClient } = await import('../evm/client.js');
    return publicClient as unknown as BackingReader;
  }
  mainnetReader ??= createPublicClient({
    chain: xLayer,
    transport: http(process.env.XLAYER_RPC ?? 'https://rpc.xlayer.tech'),
  }) as unknown as BackingReader;
  return mainnetReader;
}

/** Remember a multiplier as observed. Unchanged values collapse onto the existing row. */
export async function recordMultiplier(params: {
  mint: string;
  symbol: string | null;
  multiplier: number;
  decimals: number;
  effectiveAt: string;
  pending: { multiplier: number; effectiveAt: string } | null;
}): Promise<void> {
  await query(
    `INSERT INTO multiplier_observations
       (mint, symbol, multiplier, decimals, new_multiplier, new_multiplier_at, effective_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (mint, multiplier, effective_at) DO NOTHING`,
    [
      params.mint,
      params.symbol,
      params.multiplier,
      params.decimals,
      params.pending?.multiplier ?? null,
      params.pending?.effectiveAt ?? null,
      params.effectiveAt,
    ],
  ).catch(() => undefined);
}

/** Keyed by the wrapper address, as `/xstocks/:symbol/yield` reads the same table. */
async function multiplierHistory(address: string, limit = 30): Promise<MultiplierPoint[]> {
  const rows = await query<{ multiplier: string; effective_at: Date; observed_at: Date }>(
    `SELECT multiplier, effective_at, observed_at FROM multiplier_observations
      WHERE mint = $1 ORDER BY effective_at DESC, observed_at DESC LIMIT $2`,
    [address, limit],
  ).catch(() => []);

  return rows.map((r) => ({
    multiplier: Number(r.multiplier),
    effectiveAt: r.effective_at.toISOString(),
    observedAt: r.observed_at.toISOString(),
  }));
}

function addr(v: unknown): string | null {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? getAddress(v) : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
function big(v: unknown): bigint | null {
  return typeof v === 'bigint' ? v : null;
}
function tokens(v: bigint | null): number | null {
  return v === null ? null : Number(v) / 1e18;
}
function ratio(v: bigint | null): number | null {
  return v === null || v <= 0n ? null : Number((v * 1_000_000_000_000n) / ONE) / 1e12;
}
/** Whether a role is held, from its address: null when unread, false when set to the zero address. */
function held(a: string | null): boolean | null {
  return a === null ? null : a !== zeroAddress;
}

/** The proxy admin out of the EIP-1967 slot. Null when unread or empty (not a transparent proxy). */
async function proxyAdmin(reader: BackingReader, address: Address): Promise<string | null> {
  const word = await reader.getStorageAt({ address, slot: ADMIN_SLOT }).catch(() => undefined);
  if (!word || word.length < 42) return null;
  const a = `0x${word.slice(-40)}`;
  return a === zeroAddress ? null : getAddress(a);
}

export async function backingDetail(symbolOrAddress: string, reader?: BackingReader): Promise<BackingDetail | null> {
  const key = xStockKey(symbolOrAddress) ?? symbolOrAddress;
  const token = XSTOCKS[key];
  if (!token) return null;

  const issuer: BackingDetail['issuer'] = {
    owner: null,
    minter: null,
    burner: null,
    pauser: null,
    multiplierUpdater: null,
    sanctionsList: null,
    upgradeAdmin: null,
    canMint: null,
    canPause: null,
    paused: null,
  };
  const wrapper: BackingDetail['wrapper'] = { owner: null, pauser: null, upgradeAdmin: null, paused: null };
  const supply: BackingDetail['supply'] = { raw: null, wrapped: null, wrappedAssets: null };
  let current: number | null = null;
  let effectiveAt: string | null = null;
  let pending: { multiplier: number; effectiveAt: string } | null = null;

  try {
    const client = reader ?? (await defaultReader());
    const rawFns = [
      'owner',
      'minter',
      'burner',
      'pauser',
      'multiplierUpdater',
      'sanctionsList',
      'isPaused',
      'multiplier',
      'newMultiplier',
      'newMultiplierActivationTime',
      'totalSupply',
    ] as const;
    const wrapFns = ['owner', 'pauser', 'isPaused', 'totalSupply', 'totalAssets'] as const;
    const [answers, rawAdmin, wrapAdmin] = await Promise.all([
      client.multicall({
        allowFailure: true,
        contracts: [
          ...rawFns.map((functionName) => ({ address: token.raw, abi: RAW_ABI, functionName })),
          ...wrapFns.map((functionName) => ({ address: token.address, abi: WRAPPER_ABI, functionName })),
        ],
      }),
      proxyAdmin(client, token.raw),
      proxyAdmin(client, token.address),
    ]);
    const at = (i: number): unknown => (answers[i]?.status === 'success' ? answers[i]!.result : undefined);
    const r = Object.fromEntries(rawFns.map((f, i) => [f, at(i)])) as Record<(typeof rawFns)[number], unknown>;
    const w = Object.fromEntries(wrapFns.map((f, i) => [f, at(rawFns.length + i)])) as Record<
      (typeof wrapFns)[number],
      unknown
    >;

    issuer.owner = addr(r.owner);
    issuer.minter = addr(r.minter);
    issuer.burner = addr(r.burner);
    issuer.pauser = addr(r.pauser);
    issuer.multiplierUpdater = addr(r.multiplierUpdater);
    issuer.sanctionsList = addr(r.sanctionsList);
    issuer.upgradeAdmin = rawAdmin;
    issuer.canMint = held(issuer.minter);
    issuer.canPause = held(issuer.pauser);
    issuer.paused = bool(r.isPaused);

    wrapper.owner = addr(w.owner);
    wrapper.pauser = addr(w.pauser);
    wrapper.upgradeAdmin = wrapAdmin;
    wrapper.paused = bool(w.isPaused);

    supply.raw = tokens(big(r.totalSupply));
    supply.wrapped = tokens(big(w.totalSupply));
    supply.wrappedAssets = tokens(big(w.totalAssets));

    current = ratio(big(r.multiplier));
    const next = ratio(big(r.newMultiplier));
    const activation = big(r.newMultiplierActivationTime);
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (activation !== null && activation > 0n) {
      const when = new Date(Number(activation) * 1000).toISOString();
      if (activation > nowSec) {
        // Announced on chain and not yet in force: the pending action, and the current value stands.
        if (next !== null && next !== current) pending = { multiplier: next, effectiveAt: when };
      } else {
        effectiveAt = when;
      }
    }

    // The table's `effective_at` is required; with no stated effective time there is nothing honest to key a row on.
    if (current !== null && effectiveAt !== null) {
      void recordMultiplier({
        mint: token.address,
        symbol: token.symbol,
        multiplier: current,
        decimals: token.decimals,
        effectiveAt,
        pending,
      });
    }
  } catch {
    // Leave every contract field null: "we have no record of this" is the honest shape, and the
    // screen renders that as words rather than as a dash.
  }

  const status = await backingFor(token.symbol);
  const reserves: BackingDetail['reserves'] =
    status.status === 'verified'
      ? (() => {
          const b = status.backing;
          const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(b.asOf)) / 1000));
          return {
            verified: true as const,
            ratio: b.ratio,
            fullyBacked: b.ratio >= 1,
            sharesHeld: b.sharesHeld,
            circulatingSupply: b.circulatingSupply,
            custodians: b.custodians,
            asOf: b.asOf,
            ageSeconds,
            stale: ageSeconds > STALE_AFTER_SECONDS,
          };
        })()
      : { verified: false as const, reason: status.reason };

  const [history, attestations] = await Promise.all([
    multiplierHistory(token.address),
    backingHistory(token.symbol),
  ]);

  return {
    symbol: token.symbol,
    name: token.name ?? null,
    address: token.address,
    raw: token.raw,
    issuer,
    wrapper,
    supply,
    reserves,
    multiplier: { current, effectiveAt, pending, history },
    attestationHistory: attestations.map((a) => ({
      ratio: a.ratio,
      sharesHeld: a.sharesHeld,
      asOf: a.asOf,
    })),
  };
}
