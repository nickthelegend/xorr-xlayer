/**
 * A transaction's receipt, asked for until it comes or the time is up (2026-09-26).
 *
 * rpc.xlayer.tech balances each request across nodes that sit a block or two apart. viem's `waitForTransactionReceipt`
 * learns a new block from one node and asks another for it; the one behind answers "block is out of range", and the
 * waiter gives up. On mainnet the budget card printed exactly that under a budget that had landed. Here only the receipt
 * is asked for, and any answer that is not one yet — not found, a node behind, a dropped request — is asked again.
 */
import type { Hex, PublicClient, TransactionReceipt } from 'viem';

export type ReceiptReader = Pick<PublicClient, 'getTransactionReceipt'>;

/** The receipt never came within the time allowed. The transaction may still land; this only says it has not been seen. */
export class ReceiptTimeoutError extends Error {
  constructor(readonly hash: Hex) {
    super('The chain has not confirmed it yet.');
    this.name = 'ReceiptTimeoutError';
  }
}

export type ReceiptWait = {
  timeoutMs?: number;
  everyMs?: number;
  /** For tests: the clock and the pause. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function receiptOf(
  reader: ReceiptReader,
  hash: Hex,
  { timeoutMs = 60_000, everyMs = 1_500, now = Date.now, sleep = pause }: ReceiptWait = {},
): Promise<TransactionReceipt> {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      return await reader.getTransactionReceipt({ hash });
    } catch {
      // Not mined yet, or asked of a node that has not seen it: asked again below.
    }
    if (now() >= deadline) throw new ReceiptTimeoutError(hash);
    await sleep(everyMs);
  }
}

/**
 * A read made again while it fails, a few times, for a figure asked of the chain just after a transaction landed.
 *
 * Read at the block the transaction landed in, a node that has not reached it yet refuses the read rather than answering
 * from before it — so a refusal is worth asking again, and an answer is the state after the transaction.
 */
export async function readAgain<T>(
  read: () => Promise<T>,
  { tries = 6, everyMs = 1_000, sleep = pause }: { tries?: number; everyMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (e) {
      if (attempt >= tries) throw e;
      await sleep(everyMs);
    }
  }
}
