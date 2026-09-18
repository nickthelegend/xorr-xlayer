/**
 * Jupiter DEX Aggregator client on Solana (PLAN.md §8.4).
 *
 * Supports quote resolution and execution on Solana mainnet and solana-fork.
 * On solana-fork, if aggregator AMMs are not cloned on the local validator,
 * swaps execute via the on-chain venue vault at the live Jupiter quote price.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createTransferInstruction,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from '@solana/spl-token';
import { connection as defaultConnection, waitForTx } from '../solana/connection.js';
import { DEFAULT_MINTS, CLUSTER_KEY } from '../solana/clusters.js';
import { payerKeypair, venueVaultKeypair } from '../solana/keys.js';
import { ataFor, tokenProgramForMint, readMintScale } from '../solana/balances.js';

export const JUPITER_TOKENS: Record<string, string> = {
  USDC: DEFAULT_MINTS.USDC,
  WSOL: DEFAULT_MINTS.WSOL,
  SOL: DEFAULT_MINTS.WSOL,
  NVDAx: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
  TSLAx: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
  AAPLx: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp',
  MSFTx: 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX',
  AMZNx: 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg',
  GOOGLx: 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN',
  METAx: 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu',
  MSTRx: 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ',
  COINx: 'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu',
  SPYx: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
  QQQx: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ',
};

export function resolveMint(symbolOrMint: string): string {
  if (JUPITER_TOKENS[symbolOrMint]) {
    return JUPITER_TOKENS[symbolOrMint]!;
  }
  // Try case-insensitive lookup
  const upper = symbolOrMint.toUpperCase();
  for (const [sym, mint] of Object.entries(JUPITER_TOKENS)) {
    if (sym.toUpperCase() === upper) return mint;
  }
  return symbolOrMint;
}

export type JupiterQuoteResponse = {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  /** The floor at `slippageBps`: what the venue guarantees to deliver, not what it expects to. */
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  /**
   * What the aggregator itself takes, when a referral account is configured. `null` is the honest
   * and usual answer here — this deployment sets none — and a breakdown must report that rather
   * than quietly omitting the line, which reads the same as not having checked.
   */
  platformFee?: { amount: string; feeBps: number } | null;
  routePlan?: Array<{
    swapInfo: { label: string; inAmount: string; outAmount: string };
    /** How much of the input this hop carries. A split route has several, summing to 100. */
    percent?: number;
  }>;
};

/**
 * `venue` is the honest part: `jupiter-route` means the Jupiter program was invoked and an AMM
 * filled the order, `venue-vault` means the venue vault settled it at the Jupiter quote price
 * without any route being executed. Callers must not describe the second as a Jupiter swap.
 */
export type FillVenue = 'jupiter-route' | 'venue-vault';

export type JupiterSwapResult = {
  signature: string;
  slot: number;
  inAmount: bigint;
  outAmount: bigint;
  inputMint: string;
  outputMint: string;
  venue: FillVenue;
};

const JUPITER_APIS = [
  'https://api.jup.ag/swap/v1',
  'https://public.jupiterapi.com',
];

/**
 * Raised when Jupiter cannot price a pair: no route, or the API could not be reached.
 *
 * Its own class so a caller can tell "we could not find out" from "the swap failed" — the first is a
 * screen that says so and a button still worth pressing later, the second is money that moved.
 */
export class UnpricedError extends Error {
  override readonly name = 'UnpricedError';
}

/**
 * Fetch a quote from Jupiter.
 *
 * Throws `UnpricedError` when no venue answers. It never invents one — see the throw below.
 */
/**
 * The least slippage a fork can execute a cloned route at.
 *
 * Not a view on what a trade should tolerate — it is the distance between a live quote and a
 * frozen pool. See the note in `quote`.
 */
const FORK_MIN_SLIPPAGE_BPS = Number(process.env.FORK_MIN_SLIPPAGE_BPS ?? 200);

export async function quote(params: {
  inSymbolOrMint: string;
  outSymbolOrMint: string;
  amountUnits: bigint | number;
  slippageBps?: number;
}): Promise<JupiterQuoteResponse> {
  const inputMint = resolveMint(params.inSymbolOrMint);
  const outputMint = resolveMint(params.outSymbolOrMint);
  const amount = params.amountUnits.toString();
  /*
   * Off mainnet, the quote and the pool are not looking at the same moment.
   *
   * The price comes from Jupiter's LIVE mainnet quote API; the fill executes against pool accounts
   * cloned onto the fork at some earlier slot. Mainnet keeps moving and the clone does not, so the
   * two drift apart — and the route reverts with `0x1771` (6001, SlippageToleranceExceeded) the
   * moment the gap exceeds the tolerance, whereupon the fill degrades to the venue vault and stops
   * being a Jupiter swap at all.
   *
   * Measured rather than guessed: at $100 of NVDAx the cloned Whirlpool delivered 45,664,177
   * against a 50 bps floor of 45,678,185 — short by roughly three basis points. So 50 sits exactly
   * on the edge, and the gap widens the longer a fork runs. 200 bps is headroom for a frozen clone,
   * not a trading decision, and it is why this is floored only off mainnet: on mainnet the quote
   * and the pool ARE the same moment, 50 bps is the real tolerance, and widening it there would
   * mean accepting a materially worse fill than the one quoted.
   */
  const asked = params.slippageBps ?? 50;
  const slippageBps =
    CLUSTER_KEY === 'solana-mainnet' ? asked : Math.max(asked, FORK_MIN_SLIPPAGE_BPS);

  /*
   * Off mainnet, pin the quote to the one AMM the fork has cloned.
   *
   * Jupiter picks the best route per request, and it moves — the same pair quoted Whirlpool one
   * minute and Raydium CLMM the next. A fork carries the pool accounts for one route, so an
   * unpinned quote names a pool that is not there, the swap fails on a missing address lookup
   * table, and the fill silently degrades to the vault. Pinning keeps the executed route and the
   * cloned route the same thing. Mainnet is left free to take the genuinely best route.
   */
  const pinnedDex = CLUSTER_KEY === 'solana-mainnet' ? null : process.env.FORK_ROUTE_DEX ?? 'Whirlpool';

  /*
   * The pin is a preference, not a constraint.
   *
   * One pool is not the whole market: a size the cloned Whirlpool cannot absorb returns
   * NO_ROUTES_FOUND under the pin while the open market quotes it happily — which is how a sell
   * large enough to matter became unsellable, exits included. So the pinned route is tried first,
   * because it is the one the fork can actually execute, and an unpinned quote is taken when the
   * pin has nothing. The fill then settles through the venue vault and is labelled `venue-vault`,
   * which is honest: a real price, and no claim that a route ran.
   */
  const attempts = pinnedDex
    ? [`&dexes=${encodeURIComponent(pinnedDex)}&onlyDirectRoutes=true`, '']
    : [''];

  let lastError: Error | null = null;
  for (const routePin of attempts) {
  for (const baseUrl of JUPITER_APIS) {
    try {
      const url = `${baseUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}${routePin}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        throw new Error(`Jupiter quote HTTP ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as JupiterQuoteResponse;
      if (!data.outAmount) throw new Error('Invalid quote response: missing outAmount');
      return data;
    } catch (err) {
      lastError = err as Error;
    }
  }
  }

  /*
   * No quote is no quote.
   *
   * This used to fall back to a table of remembered share prices — NVDA at $216, TSLA at $250 — and
   * return them wearing the shape of a real answer: a `priceImpactPct` of 0.0001 nobody measured and
   * a route plan naming a pool that was never consulted. Two things read that. `xStockPriceUsd`
   * published it as a live mark, and `executor/place.ts` handed it to `swap()`, where the venue vault
   * settles a REAL on-chain transfer at whatever price it is given. An unreachable API therefore did
   * not stop trading; it moved someone's tokens at a number this file made up, and the fill was
   * recorded as though Jupiter had priced it.
   *
   * A price is either observed or it is not. Callers that can degrade already know how — the catalog
   * shows "No price", `xStockPriceUsd` returns null — and an order that cannot be priced must not be
   * placed at all.
   */
  throw new UnpricedError(
    `No Jupiter quote for ${inputMint} -> ${outputMint}: ${lastError?.message ?? 'no route'}`,
  );
}

/**
 * Execute swap.
 *
 * On mainnet, this submits the signed Jupiter VersionedTransaction.
 * On solana-fork / localnet, it settles on-chain through the venue vault,
 * executing real on-chain SPL Token transfers with real signatures.
 */
/** The change in a token account's raw balance, as recorded in a confirmed transaction. */
async function readDestinationDelta(
  signature: string,
  destination: PublicKey,
  conn: Connection,
): Promise<bigint | null> {
  const tx = await conn.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta) return null;

  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta.loadedAddresses,
  });
  const index = keys.staticAccountKeys.concat(
    tx.meta.loadedAddresses?.writable ?? [],
    tx.meta.loadedAddresses?.readonly ?? [],
  ).findIndex((k) => k.equals(destination));
  if (index < 0) return null;

  const pre = tx.meta.preTokenBalances?.find((b) => b.accountIndex === index);
  const post = tx.meta.postTokenBalances?.find((b) => b.accountIndex === index);
  if (!post) return null;
  return BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? '0');
}

/**
 * Execute the quote as a real Jupiter route, signed by `signer`, delivering the output to
 * `destinationTokenAccount`.
 *
 * Jupiter builds the transaction against mainnet, so the blockhash it returns means nothing on a
 * fork; it is re-anchored and re-signed here. Everything else — the route, the pool accounts, the
 * AMM's own reserves — is real, which is also why this throws rather than degrades: a fork
 * missing the route's pool accounts must not quietly become a vault transfer wearing Jupiter's name.
 */
async function routeThroughJupiter(params: {
  quoteResponse: JupiterQuoteResponse;
  signer: Keypair;
  destinationTokenAccount?: PublicKey;
  conn: Connection;
}): Promise<{ signature: string; slot: number; actualOut: bigint | null }> {
  const { quoteResponse, signer, destinationTokenAccount, conn } = params;

  let lastError: Error | null = null;
  for (const baseUrl of JUPITER_APIS) {
    try {
      const res = await fetch(`${baseUrl}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: signer.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          ...(destinationTokenAccount
            ? { destinationTokenAccount: destinationTokenAccount.toBase58() }
            : {}),
        }),
      });
      if (!res.ok) throw new Error(`Jupiter swap build HTTP ${res.status}: ${await res.text()}`);

      const { swapTransaction } = (await res.json()) as { swapTransaction: string };
      const vtx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));

      const latest = await conn.getLatestBlockhash('confirmed');
      vtx.message.recentBlockhash = latest.blockhash;
      vtx.sign([signer]);

      const signature = await conn.sendRawTransaction(vtx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });
      const { slot, err } = await waitForTx(signature, conn);
      if (err) throw new Error(`Jupiter route reverted: ${JSON.stringify(err)}`);

      /*
       * What the AMM actually paid out, which is not what the quote predicted — a quote is a
       * forecast against pool state that moves. Reporting the forecast as the fill is how a
       * position and its cost basis drift apart, so read the destination account's own delta
       * out of the transaction and fall back to the quote only if it cannot be found.
       */
      const actualOut = destinationTokenAccount
        ? await readDestinationDelta(signature, destinationTokenAccount, conn)
        : null;
      return { signature, slot, actualOut };
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error('Jupiter route failed for an unknown reason.');
}

export async function swap(params: {
  quoteResponse: JupiterQuoteResponse;
  userPublicKey: PublicKey | string;
  userSigner?: Keypair;
  conn?: Connection;
  feePayer?: Keypair;
  vaultKeypair?: Keypair;
  /** Refuse to settle through the vault if the route cannot execute. */
  requireRoute?: boolean;
}): Promise<JupiterSwapResult> {
  const {
    quoteResponse,
    userPublicKey,
    userSigner,
    conn = defaultConnection,
    feePayer = payerKeypair(),
    vaultKeypair = venueVaultKeypair(),
    requireRoute = false,
  } = params;

  const userPk = typeof userPublicKey === 'string' ? new PublicKey(userPublicKey) : userPublicKey;
  const inputMintPk = new PublicKey(quoteResponse.inputMint);
  const outputMintPk = new PublicKey(quoteResponse.outputMint);
  const inAmount = BigInt(quoteResponse.inAmount);
  const outAmount = BigInt(quoteResponse.outAmount);

  const inputProg = tokenProgramForMint(inputMintPk);
  const outputProg = tokenProgramForMint(outputMintPk);

  /*
   * Try the real route first, on every cluster.
   *
   * The route was previously attempted on mainnet alone, so a fork always settled through the
   * vault and the Jupiter program was never once invoked — while the surrounding code still
   * called the result a Jupiter swap. A fork that clones the route's pool accounts can execute
   * the genuine thing, so ask for it, and say plainly which one happened.
   *
   * The vault signs: by the time a buy reaches here the delegate has already moved the user's
   * USDC into the vault, so the vault is the account holding the input. Jupiter delivers the
   * output straight to the user's own token account.
   */
  const routeSigner = userSigner ?? vaultKeypair;
  const userOutAtaForRoute = ataFor(userPk, outputMintPk, outputProg);
  try {
    const routed = await routeThroughJupiter({
      quoteResponse,
      signer: routeSigner,
      destinationTokenAccount: userOutAtaForRoute,
      conn,
    });
    return {
      signature: routed.signature,
      slot: routed.slot,
      inAmount,
      outAmount: routed.actualOut ?? outAmount,
      inputMint: quoteResponse.inputMint,
      outputMint: quoteResponse.outputMint,
      venue: 'jupiter-route',
    };
  } catch (err) {
    if (requireRoute) {
      throw new Error(
        `Jupiter route could not execute and requireRoute was set, so nothing was filled: ${
          (err as Error).message
        }`,
      );
    }
    console.warn(
      `Jupiter route unavailable (${(err as Error).message}). Settling through the venue vault ` +
        'at the quoted price — this fill is NOT a Jupiter swap.',
    );
  }

  /*
   * Fallback (PLAN.md §6.2 option A): a capped SPL delegate transfer settled by the venue vault.
   * Real on-chain transfers at the quoted price, but no route and no AMM — `venue` says so.
   *
   * 1) If userSigner is provided and input is not yet in vault: transfer input from user to vault
   * 2) Transfer output tokens from vault to user ATA
   */
  // Both legs are `transferChecked`, which rejects a decimals value the mint disagrees with.
  const [inputScale, outputScale] = await Promise.all([
    readMintScale(inputMintPk, conn, inputProg),
    readMintScale(outputMintPk, conn, outputProg),
  ]);

  const userInAta = ataFor(userPk, inputMintPk, inputProg);
  const vaultInAta = ataFor(vaultKeypair.publicKey, inputMintPk, inputProg);
  const userOutAta = ataFor(userPk, outputMintPk, outputProg);
  const vaultOutAta = ataFor(vaultKeypair.publicKey, outputMintPk, outputProg);

  const tx = new Transaction();

  // Ensure vault output ATA and user output ATA exist
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      feePayer.publicKey,
      userOutAta,
      userPk,
      outputMintPk,
      outputProg,
    ),
  );
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      feePayer.publicKey,
      vaultInAta,
      vaultKeypair.publicKey,
      inputMintPk,
      inputProg,
    ),
  );

  // If user signs directly (e.g. for selling), transfer input to vault
  if (userSigner && !userSigner.publicKey.equals(vaultKeypair.publicKey)) {
    tx.add(
      createTransferCheckedInstruction(
        userInAta,
        inputMintPk,
        vaultInAta,
        userSigner.publicKey,
        inAmount,
        inputScale.decimals,
        [],
        inputProg,
      ),
    );
  }

  // Transfer outAmount from vault to user
  tx.add(
    createTransferCheckedInstruction(
      vaultOutAta,
      outputMintPk,
      userOutAta,
      vaultKeypair.publicKey,
      outAmount,
      outputScale.decimals,
      [],
      outputProg,
    ),
  );

  const signers = [feePayer, vaultKeypair];
  if (userSigner && !signers.some((s) => s.publicKey.equals(userSigner.publicKey))) {
    signers.push(userSigner);
  }

  const sig = await sendAndConfirmTransaction(conn, tx, signers, {
    commitment: 'confirmed',
  });

  const { slot } = await waitForTx(sig, conn);
  return {
    signature: sig,
    slot,
    inAmount,
    outAmount,
    inputMint: quoteResponse.inputMint,
    outputMint: quoteResponse.outputMint,
    venue: 'venue-vault',
  };
}
