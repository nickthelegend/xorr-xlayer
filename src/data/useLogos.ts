/**
 * Real logos for a list of symbols, from `/market/logos`.
 *
 * Cached for the session because logos do not move and the server resolves them against two
 * rate-limited upstreams. A screen that mounts, unmounts and remounts — every tab switch — should
 * not cost a round trip, let alone two upstream lookups per row.
 *
 * A symbol the server cannot resolve comes back `null`, and `AssetMark` keeps its gradient for it.
 * That is deliberate: the commodities, indices and pre-IPO names have no issuer and no token, so
 * there is no logo to show and inventing one would put a false identity on an instrument.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';

type LogoResponse = Record<string, { url: string | null }>;

/**
 * When to ask again for symbols the server left out (2026-09-16).
 *
 * A symbol the server could not resolve inside its deadline is absent from its answer, and it goes on resolving there. The
 * hook asked once, so an absent symbol stayed "still resolving" for as long as the screen was open: NVDAc and TSLAc sat on
 * Home's Stocks tab with no mark. Three more asks, further apart; after the last, those rows take their gradient for this
 * visit, and the next screen that asks starts over.
 */
const RETRY_MS = [1_500, 4_000, 10_000] as const;

/** Session cache, shared across every screen that asks. */
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<void>>();

async function load(symbols: string[]): Promise<void> {
  const missing = symbols.filter((s) => !cache.has(s));
  if (missing.length === 0) return;

  const key = missing.slice().sort().join(',');
  const pending = inflight.get(key);
  if (pending) return pending;

  const run = (async () => {
    try {
      const res = await api.get<LogoResponse>(
        `/market/logos?symbols=${encodeURIComponent(missing.join(','))}`,
      );
      /*
       * Only what the server actually decided about.
       *
       * A symbol it could not resolve inside its deadline is ABSENT from the response, not null —
       * and caching those as null was the same mistake as the catch below, one layer up: a
       * CoinGecko rate limit during the first Markets load would have left every crypto row
       * wearing a gradient until the app restarted.
       */
      for (const s of missing) {
        const entry = res[s];
        if (entry) cache.set(s, entry.url);
      }
    } catch {
      /*
       * A failed lookup is not "this symbol has no logo".
       *
       * Caching null here would make one bad request permanent for the session and leave every
       * row wearing a gradient until the app restarts. Left uncached, so the next screen that
       * asks tries again — and the gradient renders in the meantime either way.
       */
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}

/** `{ [symbol]: url | null }`. Absent keys simply have not resolved yet. */
export function useLogos(symbols: readonly string[]): Record<string, string | null> {
  const key = useMemo(() => [...new Set(symbols)].sort().join(','), [symbols]);
  /* Only to re-render once the load lands; the map itself is read straight from the cache. */
  const [, bump] = useState(0);
  /* Symbols still unresolved after the last ask, shown without a logo for this mount rather than as loading forever. */
  const [gaveUp, setGaveUp] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!key) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const symbols = key.split(',');
    const ask = (attempt: number) => {
      void load(symbols).then(() => {
        if (!alive) return;
        bump((n) => n + 1);
        const unresolved = symbols.filter((s) => !cache.has(s));
        if (unresolved.length === 0) return;
        if (attempt < RETRY_MS.length) {
          timer = setTimeout(() => ask(attempt + 1), RETRY_MS[attempt]);
        } else {
          setGaveUp(new Set(unresolved));
        }
      });
    };
    ask(0);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [key]);

  /*
   * Rebuilt every render, deliberately.
   *
   * This was memoised on `[key]`, and `key` does not change when the fetch lands — so the load
   * completed, the state bumped, the component re-rendered, and `useMemo` handed back the same
   * empty object it had built before the request went out. Lists kept their gradients until
   * something else remounted them, which is why it looked right on the asset screen (a fresh mount
   * every visit) and did nothing at all on Markets (a tab, mounted once and kept).
   *
   * Sixty lookups against a Map is not worth memoising, and a version counter in the dependency
   * array would only be lying to the compiler about what this reads.
   */
  const out: Record<string, string | null> = {};
  for (const s of key ? key.split(',') : []) {
    const hit = cache.get(s);
    if (hit !== undefined) out[s] = hit;
    else if (gaveUp.has(s)) out[s] = null;
  }
  return out;
}

/**
 * Everything `AssetMark` needs for one symbol, so no call site has to remember the three states.
 *
 * The map already distinguishes them — absent is "still resolving", `null` is "no registry issues
 * one", a string is the logo — but `logos[sym]` collapses the first two to falsy at the call site,
 * which is exactly how every list ended up rendering a mid-load row as though every issuer had
 * declined to have a mark. Spreading this instead makes that unrepresentable.
 */
/**
 * The mark for a futures contract (2026-09-16): the registry's logo where one resolved, and otherwise the venue's own icon
 * for the contract it lists.
 *
 * The futures come from Hyperliquid, and nearly every contract there (REZ, INJ, SOPH…) is in neither the 1inch registry nor
 * the CoinGecko batch, so the list was a column of grey gradients. The venue publishes an icon per contract; one it has
 * none for fails to load and `AssetMark` keeps the gradient, with its skeleton while the icon is on its way.
 */
export function perpLogoProps(
  logos: Record<string, string | null>,
  symbol: string,
): { uri: string | null; pending: boolean } {
  return { uri: logos[symbol] || `https://app.hyperliquid.xyz/coins/${encodeURIComponent(symbol)}.svg`, pending: false };
}

export function logoProps(
  logos: Record<string, string | null>,
  symbol: string,
): { uri: string | null; pending: boolean } {
  return { uri: logos[symbol] ?? null, pending: !(symbol in logos) };
}

/**
 * One symbol, for the screens that show a single asset. Spread straight onto `AssetMark`.
 *
 * Returns the same shape as `logoProps` rather than a bare url, for the same reason: a screen that
 * has not heard back yet is not a screen whose asset has no logo.
 */
export function useLogo(symbol: string | undefined): { uri: string | null; pending: boolean } {
  const symbols = useMemo(() => (symbol ? [symbol] : []), [symbol]);
  const logos = useLogos(symbols);
  if (!symbol) return { uri: null, pending: false };
  return logoProps(logos, symbol);
}
