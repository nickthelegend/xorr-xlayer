/**
 * Watchlist — what the bot can follow here, priced. screens.md Group B, screen 5.
 *
 * This listed three groups from the design fixtures — TSLAc, SOL, HYPE / NVDAc, AAPLc, MSTRc / AAVE —
 * as though someone had built them, under the title "Markets", with a header promising five tabs. The
 * executor keeps no saved watchlist. What it does keep is `/market/watchable`: the tokens a strategy can
 * follow on this network. That is the list, split into crypto and shares only when both are there.
 *
 * The prices sat at "· · ·" for as long as the share snapshot took, signed in or out: TSLAc was in the
 * first group and one request priced every row, so SOL waited eight seconds for Tesla. Each row now
 * waits only for its own source (`useSpotPrices`), and a failed read says so.
 *
 * The sparkline is the day's closes from the one request the Markets list already makes. A symbol
 * without a series gets no line rather than someone else's, and never the fixtures' hand-drawn ones.
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import { assetGradient } from '@/design/gradients';
import {
  AssetMark,
  EmptyList,
  ErrorState,
  Eyebrow,
  Fill,
  HeaderBar,
  LoadingRows,
  Pill,
  PillRow,
  Placeholder,
  Press,
  Price,
  Row,
  Screen,
  Sparkline,
  Text,
  colors,
  percent,
  pnlTone,
  price as fmtPrice,
  size,
  space,
} from '@/ui';
import { repos } from '@/data';
import { isStockSymbol } from '@/data/marketData';
import { system } from '@/data/system';
import { useAsync } from '@/data/useAsync';
import { logoProps, useLogos } from '@/data/useLogos';
import { useSpotPrices } from '@/markets/useSpotPrices';
import { useStore } from '@/state/store';
import { Icon } from '@/design/Icon';
import { applyOrder, canMove, move, orderChanged, orderToSave } from '@/markets/watchOrder';
import { errorText } from '@/data/apiError';

const ROW_H = 64;
const NONE: readonly string[] = [];

/** The watchable tokens as tabs — crypto, then shares — keeping only the tabs with something in them. */
function groupsOf(symbols: readonly string[]): { label: string; symbols: string[] }[] {
  return [
    { label: 'Crypto', symbols: symbols.filter((s) => !isStockSymbol(s)) },
    { label: 'Stocks', symbols: symbols.filter((s) => isStockSymbol(s)) },
  ].filter((g) => g.symbols.length > 0);
}

export default function Watchlist() {
  const router = useRouter();
  const goBack = useGoBack();
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);

  const watchable = useAsync(() => system.watchable(), []);
  /*
   * The order this wallet's owner put the list in, persisted by the executor.
   *
   * A preference APPLIED to the watchable list, never a copy of it — `markets/watchOrder.ts` holds
   * both halves: a saved symbol the executor no longer offers keeps its place rather than being
   * forgotten, and a newly watchable one appears rather than being hidden until someone re-saves.
   */
  const savedOrder = useAsync(() => system.watchOrder(), []);
  /** The arrangement being edited. Undefined until the first move, so the saved one is the source. */
  const [edited, setEdited] = useState<string[]>();
  const [arranging, setArranging] = useState(false);
  const [saveNote, setSaveNote] = useState<string>();

  const saved = useMemo(() => edited ?? savedOrder.data ?? NONE, [edited, savedOrder.data]);
  const groups = useMemo(() => {
    const all = (watchable.data ?? []).map((t) => t.symbol);
    return groupsOf(applyOrder(all, saved));
  }, [watchable.data, saved]);
  const group = groups[tab] ?? groups[0];
  const symbols = group?.symbols ?? NONE;
  const key = symbols.join(',');

  /*
   * A move rearranges the WHOLE list, not the tab.
   *
   * The tabs are a view — crypto and shares filtered out of one order — so moving a row inside
   * "Stocks" has to move it within the order those tabs are cut from, or the arrangement would be
   * lost the moment the split changed.
   */
  const everySymbol = useMemo(
    () => applyOrder((watchable.data ?? []).map((t) => t.symbol), saved),
    [watchable.data, saved],
  );

  async function reorder(symbol: string, direction: 'up' | 'down') {
    const next = move(everySymbol, symbol, direction);
    if (!orderChanged(everySymbol, next)) return;
    setEdited(next);
    setSaveNote(undefined);

    const toSave = orderToSave(next, savedOrder.data ?? [], (watchable.data ?? []).map((t) => t.symbol));
    try {
      await system.saveWatchOrder(toSave);
    } catch (e) {
      /*
       * The move stays on screen and the failure is stated.
       *
       * Snapping the row back would undo something the person just did because a request failed,
       * which reads as the control being broken. Saying it did not save leaves them able to try
       * again with the arrangement they wanted still in front of them.
       */
      setSaveNote(`Not saved: ${errorText(e)}`);
    }
  }

  const prices = useSpotPrices(symbols);
  const logos = useLogos(symbols);
  // A day of closes per row. A decoration: a row without its glyph is still a row.
  const sparks = useAsync(() => repos.markets.sparklines(key ? key.split(',') : []), [key]);

  return (
    <Screen>
      <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Watchlist</Text>} />
      <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
        What the bot can follow here.
      </Text>

      {groups.length > 1 ? (
        <PillRow style={{ marginTop: space.s16, flexGrow: 0 }}>
          {groups.map((g, i) => (
            <Pill key={g.label} label={g.label} selected={g === group} onPress={() => setTab(i)} />
          ))}
        </PillRow>
      ) : null}

      {group ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: space.s22,
          }}
        >
          <Eyebrow small>
            {`${symbols.length} ${symbols.length === 1 ? 'market' : 'markets'} · 24h`}
          </Eyebrow>
          {/*
            Arranging is a mode, not a permanent pair of arrows on every row.

            The list is read far more often than it is rearranged, and two controls on each row
            would crowd the price and the sparkline — the things someone actually came to look at —
            on every visit for the sake of something done once.
          */}
          {symbols.length > 1 ? (
            <Press
              onPress={() => setArranging((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={arranging ? 'Finish arranging' : 'Arrange your watchlist'}
              hitHeight={size.hit}
            >
              <Text variant="footnote" color={arranging ? colors.ink : colors.ink55}>
                {arranging ? 'Done' : 'Arrange'}
              </Text>
            </Press>
          ) : null}
        </View>
      ) : null}

      {saveNote ? (
        <Text variant="footnote" color={colors.down} style={{ marginTop: space.s8 }} accessibilityLiveRegion="polite">
          {saveNote}
        </Text>
      ) : null}

      <Fill style={{ marginTop: space.s6 }}>
        {watchable.error ? (
          <ErrorState error={watchable.error} onRetry={watchable.reload} />
        ) : prices.error ? (
          <ErrorState error={prices.error} onRetry={prices.reload} />
        ) : watchable.loading && !watchable.data ? (
          <LoadingRows count={4} height={ROW_H} spark />
        ) : !group ? (
          <EmptyList list="watchlist" />
        ) : (
          <ScrollView showsVerticalScrollIndicator={false}>
            {symbols.map((sym) => {
              const price = prices.priceOf(sym);
              const q = price.loading ? undefined : price.quote;
              const closes = sparks.data?.[sym] ?? [];
              return (
                <Row
                  key={sym}
                  left={<AssetMark gradient={assetGradient(sym)} {...logoProps(logos, sym)} size={32} />}
                  title={sym}
                  middle={
                    closes.length > 1 ? (
                      <View style={{ marginHorizontal: space.s10 }}>
                        <Sparkline data={closes} />
                      </View>
                    ) : undefined
                  }
                  /*
                    A dash means "nothing prices this". It must not also mean "the price has not
                    arrived yet", so a price still on its way is a placeholder, and quiet.
                  */
                  value={
                    price.loading ? (
                      <Placeholder height={12} width={64} />
                    ) : q ? (
                      fmtPrice(q.price)
                    ) : (
                      <Price variant="rowPrimary" color={colors.ink55} figure="market">
                        —
                      </Price>
                    )
                  }
                  figure="market"
                  delta={q?.change24h !== undefined ? percent(q.change24h, 2) : undefined}
                  deltaTone={q?.change24h !== undefined ? pnlTone(q.change24h) : 'neutral'}
                  height={ROW_H}
                  // While arranging, the row is a thing being moved rather than a link to follow.
                  onPress={arranging ? undefined : () => router.push(`/asset/${sym}`)}
                  right={
                    arranging ? (
                      <MoveControls
                        canUp={canMove(everySymbol, sym, 'up')}
                        canDown={canMove(everySymbol, sym, 'down')}
                        onUp={() => void reorder(sym, 'up')}
                        onDown={() => void reorder(sym, 'down')}
                        symbol={sym}
                      />
                    ) : (
                      /*
                       * An alert, from where someone is already looking at the market.
                       *
                       * The watchlist IS the list of things they want to be told about, and setting
                       * an alert meant going to another screen and typing the ticker they had just
                       * tapped. The symbol travels with the tap; the level is seeded from the live
                       * price on the screen that takes it.
                       */
                      <Press
                        onPress={() => router.push(`/alerts/new?symbol=${encodeURIComponent(sym)}`)}
                        accessibilityRole="button"
                        accessibilityLabel={`Set an alert on ${sym}`}
                        hitHeight={size.hit}
                        hitWidth={size.hit}
                      >
                        <Icon name="bell" size={16} color={colors.ink40} />
                      </Press>
                    )
                  }
                />
              );
            })}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}

/**
 * Up and down, rather than a drag.
 *
 * A drag handle needs a gesture library, does not work with a screen reader without a great deal of
 * extra work, and is unusable one-handed on a long list. Two buttons are none of those things, and
 * the end of the list disables the one that would do nothing — a control that does nothing when
 * tapped reads as broken.
 */
function MoveControls({
  canUp,
  canDown,
  onUp,
  onDown,
  symbol,
}: {
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
  symbol: string;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: space.s8 }}>
      <Press
        onPress={canUp ? onUp : undefined}
        disabled={!canUp}
        accessibilityRole="button"
        accessibilityLabel={`Move ${symbol} up`}
        accessibilityState={{ disabled: !canUp }}
        hitHeight={size.hit}
        hitWidth={size.hit}
        // `chevron` is the trailing "›" the rest of the app uses; a quarter turn each way makes
        // the pair, rather than adding two glyphs to the set for one screen.
        style={{ opacity: canUp ? 1 : 0.3, transform: [{ rotate: '-90deg' }] }}
      >
        <Icon name="chevron" size={18} color={colors.ink65} />
      </Press>
      <Press
        onPress={canDown ? onDown : undefined}
        disabled={!canDown}
        accessibilityRole="button"
        accessibilityLabel={`Move ${symbol} down`}
        accessibilityState={{ disabled: !canDown }}
        hitHeight={size.hit}
        hitWidth={size.hit}
        style={{ opacity: canDown ? 1 : 0.3, transform: [{ rotate: '90deg' }] }}
      >
        <Icon name="chevron" size={18} color={colors.ink65} />
      </Press>
    </View>
  );
}
