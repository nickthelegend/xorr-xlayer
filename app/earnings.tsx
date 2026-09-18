/**
 * When each tokenized equity last reported, and when it is projected to report next.
 *
 * Straight from EDGAR — the dates are the regulator's own filing record, not a vendor's calendar.
 * This has driven the event-driven planner since it was written and was reachable from nowhere in
 * the app, which is strange for a product shipping an agent whose entire mandate is trading around
 * these dates.
 *
 * The projection is labelled as one, with the error the company's own cadence justifies. A
 * predicted date rendered in the same weight as the observed ones is a date someone trades on, and
 * the difference between "they filed on this day" and "they usually file about now" is the whole
 * distinction this screen has to preserve.
 *
 * Every read names its symbol, and an answer is shown only under the pill that asked for it:
 * `useAsync` keeps the last answer while the next is on its way, so switching pills put one
 * company's filings under another's name until the new ones landed. Distilled (PLAN.md O3): no
 * source name and no filer number on the screen — Sources names where the dates come from.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  ErrorState,
  Fill,
  HeaderBar,
  Pill,
  PillRow,
  Placeholder,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  space,
} from '@/ui';
import { useAsync } from '@/data/useAsync';
import { system } from '@/data/system';

/** The tokenized equities, which are the only symbols the filing record can answer for. */
const EQUITIES = ['NVDAc', 'AAPLc', 'TSLAc', 'METAc', 'MSFTc', 'AMZNc', 'GOOGLc', 'MSTRc'] as const;
type Equity = (typeof EQUITIES)[number];

const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

export default function Earnings() {
  const goBack = useGoBack();
  // Always one of the eight: `/market/earnings` answers any other symbol, or none, with a 404.
  const [symbol, setSymbol] = useState<Equity>(EQUITIES[0]);
  const { data, error, reload } = useAsync(() => system.earnings(symbol), [symbol]);
  /* The lit pill's calendar and no other — the executor names the symbol it answered for. */
  const calendar = data && data.symbol.toLowerCase() === symbol.toLowerCase() ? data : undefined;

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Earnings</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          Past filings, and when the next is likely.
        </Text>
      </View>

      <PillRow style={{ marginTop: space.s14 }} contentPadding={space.gutter}>
        {EQUITIES.map((s) => (
          <Pill key={s} label={s} selected={s === symbol} onPress={() => setSymbol(s)} />
        ))}
      </PillRow>

      <Fill style={{ marginTop: space.s12, paddingHorizontal: space.gutter }}>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !calendar ? (
          <Placeholder height={160} />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30, gap: space.s10 }}
          >
            <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
              <Text variant="footnote" color={colors.ink55}>
                PROJECTED NEXT
              </Text>
              {/*
                Amber, not white, and the word "projected" carries the weight. This is the only
                date on the screen nobody has filed.
              */}
              <Text
                variant="screenTitle"
                color={calendar.nextAt ? colors.warn : colors.ink40}
                style={{ marginTop: space.s6 }}
              >
                {calendar.nextAt ? day(calendar.nextAt) : 'No projection'}
              </Text>
              <Text variant="secondary" color={colors.ink65} style={{ marginTop: space.s10 }}>
                {calendar.nextAt
                  ? `Projected from past filings, give or take ${calendar.errorDays} days.`
                  : 'The filings keep no steady rhythm, so no date is guessed.'}
              </Text>
              {calendar.medianGapDays ? (
                <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s8 }}>
                  Usually {calendar.medianGapDays} days apart.
                </Text>
              ) : null}
            </SheetCard>

            <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
              <Text variant="footnote" color={colors.ink55}>
                FILED
              </Text>
              {calendar.reported.length === 0 ? (
                <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }}>
                  No filings found.
                </Text>
              ) : (
                calendar.reported.slice(0, 10).map((at, i) => (
                  <View
                    key={at}
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      marginTop: space.s10,
                    }}
                  >
                    <Text variant="secondarySm" color={colors.ink65}>
                      {day(at)}
                    </Text>
                    {/* The gap that came after this filing — the evidence for the projection. */}
                    {calendar.gapDays[i] === undefined ? null : (
                      <Text variant="secondarySm" color={colors.ink55}>
                        {calendar.gapDays[i]} days
                      </Text>
                    )}
                  </View>
                ))
              )}
            </SheetCard>
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
