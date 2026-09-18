/**
 * Agent & asset identity gradients — design.md §1 "Agent identity gradients".
 *
 * Every mark is `radial-gradient(circle at 32% 26%, c1, c2 74%)`. The off-center origin IS the
 * specular highlight and MUST NOT MOVE — design.md states this explicitly.
 *
 * React Native has no CSS radial gradient, so `AgentOrb` renders this with react-native-svg's
 * <RadialGradient> using exactly these numbers: fx/fy = 32%/26%, the c2 stop at 74%.
 */

import { assetClasses } from '../data/fixtures/markets';
import { normaliseSeed, pick, seededRandom } from './seed';

export type GradientPair = { c1: string; c2: string };

/** The five agent gradients. design.md §1. */
export const agentGradients = {
  'Momentum Scout': { c1: '#5B93FF', c2: '#1B44CE' },
  Signals: { c1: '#5B93FF', c2: '#1B44CE' },
  'Earnings Desk': { c1: '#F0BE55', c2: '#C98518' },
  Stocks: { c1: '#F0BE55', c2: '#C98518' },
  'Yield Keeper': { c1: '#49E39B', c2: '#12A45F' },
  Crypto: { c1: '#49E39B', c2: '#12A45F' },
  'Drawdown Guard': { c1: '#B58CFF', c2: '#7A45E0' },
  Strategist: { c1: '#C79BFF', c2: '#7B3FE4' },
} as const satisfies Record<string, GradientPair>;

export type AgentGradientName = keyof typeof agentGradients;

/**
 * Gradients for agents §1 does not name.
 *
 * `agentGradient` used to give any unknown name Momentum Scout's blue, so a new agent arrived wearing
 * another agent's identity — the mistake `assetGradient` below already refuses to make. These sit
 * beside the §1 five (a light c1 falling into a deeper c2 at the same lightness), none of them
 * repeats one, and none is the profit green or the loss red.
 */
export const AGENT_PALETTE = [
  { c1: '#5ED8F5', c2: '#1690C4' }, // cyan
  { c1: '#FF8FC7', c2: '#D1408F' }, // rose
  { c1: '#FFB35C', c2: '#DD6B12' }, // orange
  { c1: '#8F8CFF', c2: '#4A45D8' }, // indigo
  { c1: '#B7C0CC', c2: '#667183' }, // slate
  { c1: '#5BE6D0', c2: '#139C8B' }, // mint
] as const satisfies readonly GradientPair[];

/** The exact geometry of the recipe. Consumed by AgentOrb / AssetMark; never hand-tune per call. */
export const RADIAL = {
  /** `circle at 32% 26%` — the specular origin. */
  fx: '32%',
  fy: '26%',
  /** `c2 74%` — where the second stop lands. */
  c2Stop: '74%',
  /** The gradient circle covers the whole square mark. */
  r: '74%',
} as const;

/**
 * An agent's gradient: its own from §1, or — for a name §1 does not list — one from `AGENT_PALETTE`,
 * chosen from the name so the same agent always gets the same one.
 */
export function agentGradient(name: string): GradientPair {
  const key = normaliseSeed(name);
  for (const [known, pair] of Object.entries(agentGradients)) {
    if (normaliseSeed(known) === key) return pair;
  }
  return pick(seededRandom(name), AGENT_PALETTE);
}

/**
 * The gradient for a tradable symbol.
 *
 * Every instrument in the catalogue carries its own `c1`/`c2`, and screens were typing a
 * pair in by hand at the call site — which meant one asset's identity got drawn over all of
 * them. This is that lookup, done once.
 *
 * A symbol not in the catalogue falls back to a neutral grey rather than borrowing another
 * asset's identity: an unknown mark should not claim to be something it is not.
 */
export function assetGradient(symbol: string): GradientPair {
  for (const cls of assetClasses) {
    for (const i of cls.instruments) {
      if (i.sym === symbol) return { c1: i.c1, c2: i.c2 };
    }
  }
  return { c1: '#9AA3AD', c2: '#5C636B' };
}
