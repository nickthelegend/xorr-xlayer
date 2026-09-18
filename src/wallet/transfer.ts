/**
 * The ERC-20 transfer a send signs (PLAN.md 3.11).
 *
 * Send moved only USDC, with six decimals written into the hook, so any other token would have gone out at a
 * millionth — or a trillion times — the amount typed. The amount is parsed in the token's own decimals from the
 * string the person typed, never through a float, and more precision than the token has is refused rather than
 * rounded away without a word.
 */
import { encodeFunctionData, erc20Abi, parseUnits, type Address, type Hex } from 'viem';

export function transferCall(
  token: { address: string; decimals: number },
  to: Address,
  amount: string,
): { to: Address; data: Hex } {
  const typed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(typed)) throw new Error(`${amount} is not an amount.`);
  const fraction = typed.split('.')[1] ?? '';
  if (fraction.length > token.decimals) {
    throw new Error(`This token has ${token.decimals} decimal places; ${typed} has ${fraction.length}.`);
  }
  return {
    to: token.address as Address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, parseUnits(typed, token.decimals)] }),
  };
}
