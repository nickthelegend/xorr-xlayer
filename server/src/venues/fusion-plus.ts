/**
 * Cross-chain quotes through 1inch Fusion+ (PLAN.md 3.16) — a quote, and nothing that could be sent.
 *
 * Fusion+ moves a token between chains by auction. The user signs an order, a resolver locks funds in escrow on both
 * chains, and the destination side is released against a secret only the user holds. Every step after the quote
 * commits real funds on mainnet, so this module stops at the quote: it asks with `enableEstimate=false`, which issues no
 * quote id for an order to be built from, and every answer carries `submittable: false` with the reason.
 *
 * The source is Base mainnet whichever chain this executor settles on. `TOKENS` holds Base mainnet addresses, and a
 * quote is a question for 1inch's API rather than for the chain we run against — the arrangement `quote()` in
 * `oneinch.ts` already has for swaps.
 */
import { formatUnits, parseUnits, type Address } from 'viem';
import { ONEINCH_CHAIN_ID } from '../evm/chains.js';
import { TOKENS, canonicalSymbol, oneinchApi } from './oneinch.js';

/** The tokens a cross-chain quote is offered for: the settlement token, and the one other asset every destination holds. */
export const CROSSCHAIN_TOKENS = ['USDC', 'WETH'] as const;
export type CrosschainToken = (typeof CROSSCHAIN_TOKENS)[number];

/** Where every quote starts. */
export const SOURCE = { chainId: ONEINCH_CHAIN_ID, name: 'Base' } as const;

export type Destination = {
  chainId: number;
  name: string;
  tokens: Record<CrosschainToken, { address: Address; decimals: number }>;
};

/**
 * Where a quote can go, and exactly which contract arrives there.
 *
 * Every address was checked on 2026-09-13 against 1inch's own answers: the Token API names it (`USDC` with 6 decimals,
 * `WETH` with 18) and the Fusion+ quoter quotes it from Base, with a dollar price that matches the token.
 * `fusion-plus.live.test.ts` asks both again. A wrong address would not fail — it would quote someone else's token — so
 * nothing is listed that was not checked. USDC is Circle's native deployment on each chain, not the bridged USDC.e that
 * trades beside it at a different address and nearly the same price.
 *
 * Other chains the quoter supports are left out rather than guessed at. Adding one means adding its addresses here and
 * letting the live test check them.
 */
export const DESTINATIONS: readonly Destination[] = [
  {
    chainId: 42161,
    name: 'Arbitrum',
    tokens: {
      USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
      WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
    },
  },
  {
    chainId: 10,
    name: 'Optimism',
    tokens: {
      USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
      WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    },
  },
  {
    chainId: 1,
    name: 'Ethereum',
    tokens: {
      USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    },
  },
  {
    chainId: 137,
    name: 'Polygon',
    tokens: {
      USDC: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
      WETH: { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
    },
  },
];

/** Why no quote here can be submitted. Sent with every answer, so no client has to infer it from a missing button. */
export const NOT_SUBMITTABLE =
  'Quote only. Submitting a Fusion+ order locks real funds on Base mainnet until a resolver delivers them on the other ' +
  'chain. That is a mainnet action, and this app does not take it.';

/** A question the quoter can be asked. */
export type CrosschainAsk = {
  destination: Destination;
  token: CrosschainToken;
  /** The decimal as it was typed, for the sentences that describe the question. */
  amount: string;
  /** The same amount in the source token's base units. */
  raw: bigint;
};

export type AskRefusal = { error: 'unknown_chain' | 'unknown_token' | 'invalid_amount'; detail: string };

const DECIMAL = /^\d+(\.\d+)?$/;

/** "Arbitrum (42161), Optimism (10), Ethereum (1) or Polygon (137)". */
function destinationList(): string {
  const names = DESTINATIONS.map((d) => `${d.name} (${d.chainId})`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names.join('');
}

/** The Base token a quote sends. Both are in the registry by construction; losing one is a bug to hear about, not a quote to guess. */
function sourceToken(token: CrosschainToken): { address: Address; decimals: number } {
  const t = TOKENS[token];
  if (!t) throw new Error(`${token} is missing from the token registry.`);
  return t;
}

/**
 * The question in a request's `to`, `token` and `amount`, or which of them is wrong.
 *
 * The amount is parsed into base units from the decimal as typed, never through a float — the float of "0.1" is
 * 100000000000000006 wei. A decimal finer than the token can hold is refused rather than rounded, because a quote for a
 * different amount than the one on screen is a wrong quote.
 */
export function readAsk(query: { to?: string; token?: string; amount?: string }): CrosschainAsk | AskRefusal {
  const to = query.to?.trim() ?? '';
  const destination = DESTINATIONS.find((d) => String(d.chainId) === to);
  if (!destination) {
    return {
      error: 'unknown_chain',
      detail: to
        ? `Chain ${to} is not a destination here. A quote goes from Base to ${destinationList()}.`
        : `Name the destination chain: ${destinationList()}.`,
    };
  }

  // Resolved through the registry's spelling, never uppercased here: see `canonicalSymbol`.
  const symbol = canonicalSymbol(query.token ?? '');
  const token = CROSSCHAIN_TOKENS.find((t) => t === symbol);
  if (!token) {
    return {
      error: 'unknown_token',
      detail: symbol ? `${symbol} is not quoted across chains here, only USDC and WETH.` : 'Name the token: USDC or WETH.',
    };
  }

  const amount = query.amount?.trim() ?? '';
  const { decimals } = sourceToken(token);
  if (!amount) return { error: 'invalid_amount', detail: 'Name an amount: a decimal above zero, like 100.' };
  if (!DECIMAL.test(amount)) {
    return { error: 'invalid_amount', detail: `${amount} is not an amount. Send a plain decimal, like 100 or 0.5.` };
  }
  if ((amount.split('.')[1] ?? '').length > decimals) {
    return { error: 'invalid_amount', detail: `${token} has ${decimals} decimal places, and ${amount} has more.` };
  }
  const raw = parseUnits(amount, decimals);
  if (raw <= 0n) return { error: 'invalid_amount', detail: 'The amount must be above zero.' };
  return { destination, token, amount, raw };
}

export const PRESETS = ['fast', 'medium', 'slow'] as const;
export type PresetName = (typeof PRESETS)[number];

/** One auction preset in the quoter's answer — the fields read here, as `fusion-plus.live.test.ts` saw them. */
export type QuoterPreset = {
  /** Seconds the auction runs once it opens. */
  auctionDuration: number;
  /** Seconds until it opens. */
  startAuctionIn: number;
  /** What a resolver delivers at the opening price, in the destination token's base units. */
  auctionStartAmount: string;
  /** Where the price ends: the least the order accepts, in base units. */
  auctionEndAmount: string;
  /** 1inch's estimate of what filling costs, in the destination token's base units. */
  costInDstToken: string;
};

/** `GET /fusion-plus/quoter/v1.0/quote/receive` — the fields read here. */
export type QuoterAnswer = {
  srcTokenAmount: string;
  dstTokenAmount: string;
  presets: Partial<Record<PresetName, QuoterPreset | null>>;
  recommendedPreset?: string;
  /** Dollar prices of both tokens, as decimal strings. */
  prices?: { usd?: { srcToken?: string; dstToken?: string } };
};

/** One preset, as a person chooses between them. */
export type CrosschainPreset = {
  name: PresetName;
  /** The preset 1inch recommends for this quote. */
  recommended: boolean;
  /** Seconds until the auction opens, and how long it then runs. Not an arrival time: a resolver fills somewhere inside it. */
  startsInSeconds: number;
  auctionSeconds: number;
  /** What arrives on the destination chain, in token units: the opening price, and the least it may fall to. */
  receiveMost: number;
  receiveLeast: number;
  /** 1inch's estimate of what filling costs, in the token — and in dollars at 1inch's own price, when it sent one. */
  costInToken: number;
  costUsd: number | null;
};

export type CrosschainQuote = {
  token: CrosschainToken;
  from: { chainId: number; name: string; address: Address; amount: number };
  to: { chainId: number; name: string; address: Address; amount: number };
  presets: CrosschainPreset[];
  submittable: false;
  reason: string;
};

/** The path the quoter is asked, exactly. Exported so the live test asks the question the route asks. */
export function quotePath(ask: CrosschainAsk, wallet: Address): string {
  const params = new URLSearchParams({
    srcChain: String(SOURCE.chainId),
    dstChain: String(ask.destination.chainId),
    srcTokenAddress: sourceToken(ask.token).address,
    dstTokenAddress: ask.destination.tokens[ask.token].address,
    amount: ask.raw.toString(),
    walletAddress: wallet,
    // No estimate, so 1inch issues no quote id — the handle an order would be built from.
    enableEstimate: 'false',
  });
  return `/fusion-plus/quoter/v1.0/quote/receive?${params}`;
}

/**
 * What would arrive, for this wallet.
 *
 * Through `oneinchApi`, so it shares the swap API's key, request lane and breaker, and its cache: the same question
 * asked again within fifteen seconds — the screen re-asking after a keypress that changed nothing — spends nothing.
 */
export async function crosschainQuote(ask: CrosschainAsk, wallet: Address): Promise<CrosschainQuote> {
  return toCrosschainQuote(ask, await oneinchApi<QuoterAnswer>(quotePath(ask, wallet)));
}

/** 1inch answered, but not with a quote this module can read. A failure with what was missing — never a zero. */
export class UnusableQuote extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'UnusableQuote';
  }
}

const describeAsk = (ask: CrosschainAsk) => `${ask.amount} ${ask.token} from ${SOURCE.name} to ${ask.destination.name}`;

/** The quoter's answer in token units, preset by preset. */
export function toCrosschainQuote(ask: CrosschainAsk, answer: QuoterAnswer): CrosschainQuote {
  const src = sourceToken(ask.token);
  const dst = ask.destination.tokens[ask.token];
  const missing = (what: string) => new UnusableQuote(`1inch's quote for ${describeAsk(ask)} came back without ${what}.`);
  const units = (raw: unknown, decimals: number, what: string): number => {
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw missing(what);
    return Number(formatUnits(BigInt(raw), decimals));
  };
  const seconds = (value: unknown, what: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw missing(what);
    return value;
  };

  // 1inch's own dollar price for the destination token, from the same answer. Absent, the cost is not priced — not free.
  const dstUsd = Number(answer.prices?.usd?.dstToken);
  const presets = PRESETS.flatMap((name): CrosschainPreset[] => {
    const p = answer.presets?.[name];
    if (!p) return [];
    const costInToken = units(p.costInDstToken, dst.decimals, `the ${name} preset's cost`);
    return [
      {
        name,
        recommended: answer.recommendedPreset === name,
        startsInSeconds: seconds(p.startAuctionIn, `the ${name} preset's start`),
        auctionSeconds: seconds(p.auctionDuration, `the ${name} preset's duration`),
        receiveMost: units(p.auctionStartAmount, dst.decimals, `the ${name} preset's opening amount`),
        receiveLeast: units(p.auctionEndAmount, dst.decimals, `the ${name} preset's closing amount`),
        costInToken,
        costUsd: Number.isFinite(dstUsd) && dstUsd > 0 ? costInToken * dstUsd : null,
      },
    ];
  });
  if (presets.length === 0) throw missing('any auction presets');

  return {
    token: ask.token,
    from: {
      chainId: SOURCE.chainId,
      name: SOURCE.name,
      address: src.address,
      amount: units(answer.srcTokenAmount, src.decimals, 'the source amount'),
    },
    to: {
      chainId: ask.destination.chainId,
      name: ask.destination.name,
      address: dst.address,
      amount: units(answer.dstTokenAmount, dst.decimals, 'the destination amount'),
    },
    presets,
    submittable: false,
    reason: NOT_SUBMITTABLE,
  };
}

export type QuoteFailure = { error: 'quoter_refused' | 'quoter_unavailable' | 'quote_unusable'; detail: string };

/**
 * A failed quote, as a sentence about the question that was asked.
 *
 * `oneinchApi` reports a refusal as its status line and the URL it asked — `400  for https://api.1inch.dev/…`, with no
 * reason phrase over HTTP/2 — and keeps nothing of the body, so the status is all of 1inch's reason that reaches this
 * module. The URL is dropped: it is our question, not their answer.
 *
 * A 429 or a 5xx that outlasted the retries, a timeout and an open breaker are not refusals — 1inch did not answer — and
 * are named apart, so a screen offers to ask again only where asking again can help.
 */
export function quoteFailure(e: unknown, ask: CrosschainAsk): QuoteFailure {
  if (e instanceof UnusableQuote) return { error: 'quote_unusable', detail: e.message };
  const said =
    (e instanceof Error ? e.message : String(e))
      .replace(/\s*(?:for|:)\s*https?:\/\/\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\.$/, '') || 'no reason given';
  const refused = /^4\d\d\b/.test(said) && !/^429\b/.test(said) && !/after \d+ attempts/.test(said);
  return refused
    ? { error: 'quoter_refused', detail: `1inch's Fusion+ quoter would not quote ${describeAsk(ask)}. It answered ${said}.` }
    : { error: 'quoter_unavailable', detail: `1inch's Fusion+ quoter did not answer for ${describeAsk(ask)}: ${said}.` };
}
