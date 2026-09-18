/**
 * What a route is quoted from, and how its fill paths are named on screen.
 */
import { settlementSymbol } from '@/data/tradable';

/**
 * What a buy pays with. The executor settles every purchase out of USDC, so a route from anything else
 * prices a trade the bot would never make — and a route into USDC is USDC for USDC, which can only fail.
 */
export const PAYS_WITH = 'USDC';

/** Is there a route to show into this symbol? Not into the token that pays for it. */
export function routesInto(symbol: string): boolean {
  return settlementSymbol(symbol).toUpperCase() !== PAYS_WITH;
}

/**
 * The ways a fill can be sourced on X Layer, named for what each one is, keyed by the venue name
 * `/route/compare` answers with. The screens carry no venue names; the route screen names its
 * providers once, in a footnote. A venue not listed here is shown as the executor named it.
 */
export const FILL_PATH: Readonly<Record<string, string>> = {
  'Uniswap v3': 'Pool swap',
  'OKX DEX': 'Aggregator',
};
