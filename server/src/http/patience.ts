/**
 * How long a read behind a screen waits on each thing it asks for.
 *
 * The app gives up on a read at 45 seconds (`READ_TIMEOUT_MS`, `src/data/api.ts`). In the endpoint QA run against the
 * hosted fork executor at 8c05266, three reads gave no answer inside sixty: `GET /graph/decision?usd=100`,
 * `GET /panic/preview` and `GET /wallet/balance`. None had a bound of its own. Each priced what the wallet holds through
 * `priceOf` with no deadline — the scheduler's patience: five attempts in a CoinGecko lane that the market-cache warmer
 * keeps busy. That deployment's public `/verify` price check, one `priceOf` with an eight-second deadline, took 8,001 ms
 * while its RPC answered `/health` in 13 ms. The decision priced its size before asking anything else, the Aqua index
 * query had no deadline at all, and every chain read had only viem's own: ten seconds an attempt, over four attempts.
 *
 * So each read is bounded by what it waits on, and when a bound passes it answers the way the app already understands:
 *   - `chainReadMs`, all of a route's chain reads: `chain_read_failed`, a 502 naming what could not be read, which the
 *     app shows with a retry;
 *   - `priceMs`, a price: the last price within ten minutes, or `warming`, a 503 with a `retry-after`. Four seconds, as
 *     `/positions` waits for a mark and `/wallet/tokens` for a price;
 *   - `aaveMs`, the Aave reserve, read from Base mainnet over a public endpoint: nothing supplied, logged — what a failed
 *     read of it already gives a screen (`evm/balances.ts`).
 *   - `routeMs`, every venue asked about one trade (`venues/compare.ts`): the venues that answered, and each that had not
 *     as not answering in time. Twenty-five seconds, inside the app's forty-five: against the hosted fork one comparison
 *     took 46 s and another gave no answer inside 90 (E165). The swap screen's quote is one venue asked about one trade,
 *     and past the same bound it is `warming`: with no bound, one answered after 97 s (`/swap/quote`, E187).
 *
 * Every upstream `/wallet/balance` and `/panic/preview` wait on is inside `chainReadMs`, so each answers in about twenty
 * seconds at worst; `/graph/decision` is inside the subgraphs' five-second deadlines and `priceMs`.
 */
const DEFAULTS = { chainReadMs: 20_000, priceMs: 4_000, aaveMs: 8_000, routeMs: 25_000 };

let current: typeof DEFAULTS = { ...DEFAULTS };

export function screenPatience(): Readonly<typeof DEFAULTS> {
  return current;
}

/** Testing only: bounds short enough for a test to wait out. Called with nothing, the real ones come back. */
export function setScreenPatienceForTests(over: Partial<typeof DEFAULTS> = {}): void {
  current = { ...DEFAULTS, ...over };
}
