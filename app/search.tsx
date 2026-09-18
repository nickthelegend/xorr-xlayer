/**
 * Markets search — PLAN.md 10.4 [G14]. The search circle on screen 24 had no destination.
 * Symbol search across all 5 classes, using the same Row the market list uses.
 *
 * The catalog is searchable the moment the screen opens, and prices fill in class by class as each
 * read answers. This waited on `listClasses`, whose slowest read — the share snapshot — measured eight
 * seconds, and said "Loading markets…" over a list of names it already had.
 *
 * Two things were wrong with the search itself.
 *
 * It matched a SUBSTRING, which is exact matching with a friendlier name: "nvidia" found nothing,
 * because the symbol is `NVDAx`, and "aple" found nothing at all. It now ranks by subsequence
 * (`markets/fuzzy.ts`) — forgiving of a dropped letter and of typing the company instead of the
 * ticker, and still strict enough that a wrong character finds nothing rather than something close.
 *
 * And it searched the EVM market classes only, so none of the xStocks were reachable from here at
 * all — the catalogue this app can actually trade on Solana was invisible to its own search box.
 * They are merged in from `/market/xstocks`, priced or saying "No price", never a placeholder.
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  AssetMark,
  CloseButton,
  EmptyState,
  Fill,
  Placeholder,
  Press,
  Price,
  Row,
  Screen,
  Text,
  border,
  colors,
  radius,
  size,
  space,
  typeScale,
} from '@/ui';
import { logoProps, useLogos } from '@/data/useLogos';
import { useMarketPrices } from '@/markets/useMarketPrices';
import { assetGradient } from '@/design/gradients';
import { useAsync } from '@/data/useAsync';
import { system } from '@/data/system';
import { fuzzyRank } from '@/markets/fuzzy';
import { openingList } from '@/markets/recents';
import { useStore } from '@/state/store';
import { price as fmtPrice } from '@/format';

const FIELD_H = 46;

/**
 * One searchable row, whichever catalogue it came from.
 *
 * `symbol` and `name` are what `fuzzyRank` scores against; everything else is what the row draws.
 * Flattening the two sources into one shape is what lets a single query rank an xStock against a
 * crypto instrument instead of searching two lists and concatenating the answers.
 */
type Hit = {
  key: string;
  symbol: string;
  /** Set only on the opening list: this is one the reader has looked at before. */
  recent?: boolean;
  name: string;
  secondary: string;
  gradient: { c1: string; c2: string };
  price: string;
  /** Drawn in muted ink, and never a number. */
  unpriced: boolean;
  delta?: string;
  up: boolean;
  state: 'ready' | 'loading' | 'failed';
  href: string;
};
/** With no query, show a sample rather than all 45 — the list is a starting point. */
const PREVIEW = 12;

export default function Search() {
  const router = useRouter();
  const goBack = useGoBack();
  const [q, setQ] = useState('');
  const classes = useMarketPrices();
  const recents = useStore((s) => s.recentMarkets);
  const rememberMarket = useStore((s) => s.rememberMarket);

  /*
   * The xStocks catalogue, merged in beside the market classes.
   *
   * Its own read, so a search box opens instantly on the names it already has and the Solana rows
   * arrive when the executor answers — the same reasoning the class prices already follow.
   */
  const xstocks = useAsync(() => system.xstocks(), []);

  const results = useMemo(() => {
    const fromClasses: Hit[] = classes.flatMap((c) =>
      c.instruments.map((i) => ({
        key: `${i.classId}-${i.sym}`,
        symbol: i.sym,
        name: i.name,
        secondary: `${i.name} · ${i.tag}`,
        gradient: { c1: i.c1, c2: i.c2 },
        price: i.px,
        unpriced: i.feed === 'unavailable',
        delta: i.chg,
        up: i.up,
        state: c.state,
        href: `/asset/${i.sym}`,
      })),
    );

    const fromXStocks: Hit[] = (xstocks.data?.rows ?? []).map((r) => ({
      key: `xstock-${r.address}`,
      symbol: r.symbol,
      name: r.name,
      secondary: `${r.name} · ${r.sector}`,
      gradient: assetGradient(r.symbol),
      /*
       * Never a placeholder number. A mint nothing will price says so, here as on the catalogue
       * screen — the row exists because the asset exists, and the missing price is the fact.
       */
      price: r.price === null ? 'No price' : fmtPrice(r.price),
      unpriced: r.price === null,
      delta: undefined,
      up: false,
      state: 'ready' as const,
      // The cost breakdown, which is the only xStock screen there is to open.
      href: `/xstock/${r.symbol}`,
    }));

    const all = [...fromClasses, ...fromXStocks];
    if (q.trim()) return fuzzyRank(all, q);

    /*
     * Before anyone types: what they keep coming back to, then the catalogue.
     *
     * Twelve arbitrary rows is a sample of a list rather than a starting point. Almost every search
     * in a trading app is a repeat of an earlier one, and `markets/recents.ts` keeps the two rules
     * that matter — a recent the catalogue no longer holds is not offered, and the list is never
     * ONLY recents, since finding a seventh market is the one thing this screen exists for.
     */
    const bySymbol = new Map(all.map((h) => [h.symbol, h]));
    return openingList({
      recents,
      catalogue: all.map((h) => h.symbol),
      known: new Set(bySymbol.keys()),
      limit: PREVIEW,
    }).flatMap(({ symbol, recent }) => {
      const hit = bySymbol.get(symbol);
      return hit ? [{ ...hit, recent }] : [];
    });
  }, [classes, xstocks.data, q, recents]);

  // Real logos for whatever the query matched, same as every other list of instruments.
  const symbols = useMemo(() => results.map((r) => r.symbol), [results]);
  const logos = useLogos(symbols);

  // Each read that failed, once: the four classes the feed prices share one.
  const retries = useMemo(
    () => [...new Set(classes.filter((c) => c.state === 'failed').map((c) => c.reload))],
    [classes],
  );

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="screenTitle">Search</Text>
        <CloseButton onPress={() => goBack()} accessibilityLabel="Close search" />
      </View>

      <View
        style={[
          {
            marginTop: space.s18,
            height: FIELD_H,
            borderRadius: radius.panel,
            backgroundColor: colors.inputBg,
            paddingHorizontal: space.s16,
            justifyContent: 'center',
          },
          border.input,
        ]}
      >
        <TextInput
          value={q}
          onChangeText={setQ}
          autoFocus
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="Symbol or name"
          placeholderTextColor={colors.ink35}
          style={[typeScale.body, { color: colors.ink }]}
          accessibilityLabel="Search markets"
        />
      </View>

      {retries.length > 0 ? (
        // A price that did not load is not a dash: the rows it left blank say nothing, and this says why.
        <Press
          onPress={() => retries.forEach((retry) => retry())}
          accessibilityRole="button"
          accessibilityLabel="Load prices again"
          hitHeight={size.hit}
          style={{ marginTop: space.s10 }}
        >
          <Text variant="secondary" color={colors.ink55}>
            Some prices did not load. Try again ›
          </Text>
        </Press>
      ) : null}

      <Fill style={{ marginTop: space.s10 }}>
        {results.length === 0 ? (
          <EmptyState text={`Nothing matches "${q}".`} />
        ) : (
          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {results.map((hit) => (
              <Row
                key={hit.key}
                left={<AssetMark gradient={hit.gradient} {...logoProps(logos, hit.symbol)} size={32} />}
                title={hit.symbol}
                // "Recent" earns its place only before a query: among search RESULTS it would be
                // noise, and the ordering there is the relevance, not the history.
                secondary={hit.recent && !q.trim() ? `Recent · ${hit.secondary}` : hit.secondary}
                value={
                  hit.state === 'ready' ? (
                    <Price color={hit.unpriced ? colors.ink55 : undefined} figure="market">
                      {hit.price}
                    </Price>
                  ) : hit.state === 'loading' ? (
                    <Placeholder height={12} width={56} />
                  ) : undefined
                }
                delta={hit.state === 'ready' ? hit.delta : undefined}
                deltaTone={hit.up ? 'up' : 'down'}
                height={62}
                onPress={() => {
                  // Recorded on the tap, which is the moment the interest is real — not on every
                  // keystroke that happened to match.
                  rememberMarket(hit.symbol);
                  router.replace(hit.href as never);
                }}
              />
            ))}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
