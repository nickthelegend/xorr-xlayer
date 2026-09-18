/**
 * What flattening would actually sell, before you ask for it.
 *
 * `/flatten` is the button. This is the preview: every leg, its size, and the total — plus the dust
 * threshold, which is the part people are surprised by afterwards. A position under it is left
 * behind, and finding that out after pressing the panic button is the worst possible moment.
 *
 * Reads only. There is deliberately no confirm here: this screen exists to be looked at, and the
 * screen that sells is the one with the warnings on it.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Price,
  Row,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  size,
  space,
} from '@/ui';
import { money, quantity } from '@/format';
import { useAsync } from '@/data/useAsync';
import { system } from '@/data/system';

export default function SellEverything() {
  const goBack = useGoBack();
  const router = useRouter();
  const { data, loading, error, reload } = useAsync(() => system.flattenPreview(), []);

  const legs = data?.legs ?? [];

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">What would sell</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          A preview. Nothing here sells anything.
        </Text>
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <LoadingRows count={4} height={size.rowLg} />
        ) : legs.length === 0 ? (
          <EmptyState text="Nothing is held above the dust threshold, so flattening would sell nothing." />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30 }}
          >
            <View style={{ paddingBottom: space.s12 }}>
              <Text variant="footnote" color={colors.ink55}>
                TOTAL
              </Text>
              <Price variant="screenTitle" style={{ marginTop: space.s6 }}>
                {money(data!.totalUsd)}
              </Price>
              <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }}>
                Across {legs.length === 1 ? 'one position' : `${legs.length} positions`}.
              </Text>
            </View>

            {legs.map((l) => (
              <Row
                key={l.symbol}
                height={size.rowLg}
                title={l.symbol}
                secondary={quantity(l.units)}
                secondaryFigure="units"
                value={<Price variant="rowPrimary">{money(l.usd)}</Price>}
              />
            ))}

            <SheetCard
              bordered
              borderRadius={radius.panel}
              padding={space.s14}
              style={{ marginTop: space.s16 }}
            >
              {/*
                The surprise, said before rather than after. Someone who presses the panic button
                and then finds a position still open has been let down by the button, not by the
                threshold.
              */}
              <Text variant="secondarySm" color={colors.ink65}>
                Positions worth less than {money(data!.dustBelowUsd)} are left where they are.
                Selling them would cost more in fees than they are worth.
              </Text>
            </SheetCard>

            <Button
              label="Go to the flatten screen"
              variant="ghost"
              style={{ marginTop: space.s16 }}
              onPress={() => router.push('/flatten')}
            />
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
