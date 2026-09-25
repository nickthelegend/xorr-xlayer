/**
 * Converting USDT0 to USDC, signed by the person (PLAN.md P4.12). The rules are `convert.ts`; this is the wiring.
 *
 * Two steps, each the person's choice: `preview` reads the whole USDT0 balance from the chain and asks the executor for a
 * quote, so the screen can show the rate and the minimum received; `convert` signs what the preview showed. Nothing is
 * signed without a preview, and nothing happens on its own.
 *
 * Signed with the same `sendTransaction` the grant, a withdrawal and "withdraw everything" use (`src/wallet/userSigning.ts`
 * underneath): the wallet is put on this build's chain first, and on a fork it only signs while the app broadcasts.
 */
import { useCallback, useState } from 'react';
import { formatUnits, type Address, type Hex } from 'viem';
import { useGrantDelegation } from '@/auth/useGrantDelegation';
import { chainAccess } from '@/wallet/chainAccess';
import { receiptOf } from '@/wallet/receipt';
import { humanWalletError } from '@/wallet/walletError';
import { api } from '@/data/api';
import { ApiError, errorText } from '@/data/apiError';
import { waitOutWarming } from '@/data/warming';
import type { SwapQuoteResult } from '@/data/useSwapQuote';
import {
  CONVERT_ERC20_ABI,
  CONVERT_SLIPPAGE_PCT,
  SWAP_ROUTER_02,
  conversionCalls,
  floorFromQuote,
} from './convert';
import { STABLE_DECIMALS, USDT0_MAINNET } from './stablecoins';

export type ConvertPreview = {
  amountInRaw: bigint;
  amountIn: number;
  outAmount: number;
  /** The floor the swap is signed with, in USDC base units, and as an amount. */
  minOutRaw: bigint;
  minimumOut: number;
};

export type ConvertState =
  | { step: 'idle' }
  | { step: 'quoting' }
  | { step: 'preview'; preview: ConvertPreview }
  | { step: 'signing'; preview: ConvertPreview; of: number; total: number }
  | { step: 'done'; txHash: Hex; preview: ConvertPreview }
  | { step: 'failed'; error: string; preview?: ConvertPreview };

/** A refusal from the executor keeps its sentence; anything else is the wallet's or the chain's, translated. */
const failure = (e: unknown) => (e instanceof ApiError ? errorText(e) : humanWalletError(e));

export function useConvertUsdt0(owner: Address | undefined, onConverted?: () => void) {
  const { sendTransaction } = useGrantDelegation();
  const [state, setState] = useState<ConvertState>({ step: 'idle' });

  const preview = useCallback(async () => {
    if (!owner) return;
    setState({ step: 'quoting' });
    try {
      // The whole balance, exactly, from the chain — not the float a balance list carries.
      const amountInRaw = await chainAccess.readContract({
        address: USDT0_MAINNET,
        abi: CONVERT_ERC20_ABI,
        functionName: 'balanceOf',
        args: [owner],
      });
      if (amountInRaw <= 0n) throw new Error('This wallet holds no USDT0.');
      const amount = formatUnits(amountInRaw, STABLE_DECIMALS);
      const q = await waitOutWarming(() =>
        api.get<SwapQuoteResult>(`/swap/quote?in=USDT0&out=USDC&amount=${amount}&slippage=${CONVERT_SLIPPAGE_PCT}`),
      );
      const minOutRaw = floorFromQuote(amountInRaw, q.minimumOut);
      setState({
        step: 'preview',
        preview: {
          amountInRaw,
          amountIn: Number(amount),
          outAmount: q.outAmount,
          minOutRaw,
          minimumOut: Number(formatUnits(minOutRaw, STABLE_DECIMALS)),
        },
      });
    } catch (e) {
      setState({ step: 'failed', error: failure(e) });
    }
  }, [owner]);

  const convert = useCallback(async () => {
    // From the preview, or again after a signature that failed or was declined — always what the screen is showing.
    const shown = state.step === 'preview' || state.step === 'failed' ? state.preview : undefined;
    if (!owner || !shown) return;
    try {
      const allowance = await chainAccess.readContract({
        address: USDT0_MAINNET,
        abi: CONVERT_ERC20_ABI,
        functionName: 'allowance',
        args: [owner, SWAP_ROUTER_02],
      });
      const calls = conversionCalls({ owner, allowance, amountInRaw: shown.amountInRaw, minOutRaw: shown.minOutRaw });
      let last: Hex | undefined;
      for (const [i, call] of calls.entries()) {
        setState({ step: 'signing', preview: shown, of: i + 1, total: calls.length });
        const hash = await sendTransaction(call.to, call.data);
        // Each is mined before the next is asked for: the swap cannot be estimated until its approval is on chain.
        const receipt = await receiptOf(chainAccess, hash);
        if (receipt.status !== 'success') throw new Error('The transaction reverted on chain. Your USDT0 was not converted.');
        last = hash;
      }
      setState({ step: 'done', txHash: last!, preview: shown });
      onConverted?.();
    } catch (e) {
      setState({ step: 'failed', error: failure(e), preview: shown });
    }
  }, [owner, state, sendTransaction, onConverted]);

  const reset = useCallback(() => setState({ step: 'idle' }), []);

  return { state, preview, convert, reset };
}
