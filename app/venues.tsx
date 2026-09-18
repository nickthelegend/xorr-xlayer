/**
 * The venues this wallet's permission may reach, as granted — read from the contract.
 *
 * This is the allowlist the contract enforces on every single route. It is why "the bot can only
 * trade" is a property and not a promise: a swap to an address that is not in this list reverts,
 * whatever the executor intended and whoever is holding its key.
 *
 * It showed `/delegation/params`, which is the list the executor would ask a NEW grant to allow.
 * That is not the list the contract holds for this wallet, and it answers wrongly for anyone who
 * granted before a venue was added or removed: "anything not here reverts" was only true when the
 * grant happened to match today's parameters. The venues now come from `/delegation`, which asks the
 * contract what this wallet actually allowed.
 *
 * The tokens it may pull are the standing approvals, and those have their own screen, read from the
 * chain. The executor's list of what a grant would approve was the same mistake one section down, so
 * it is a link now rather than a second list.
 *
 * Addresses in full. This is a list someone checks against a block explorer, and six characters of
 * a router address identifies nothing.
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
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  size,
  space,
} from '@/ui';
import { shortAddress } from '@/format';
import { useAsync } from '@/data/useAsync';
import { repos } from '@/data';
import { system } from '@/data/system';

export default function Venues() {
  const goBack = useGoBack();
  const router = useRouter();
  const grant = useAsync(() => repos.wallet.delegation(), []);
  /* Only for the contract's own address, which the permission does not carry. */
  const params = useAsync(() => system.delegationParams(), []);

  const venues = grant.data?.venueAllowlist ?? [];

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Venues</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          The only places a trade can fill.
        </Text>
      </View>

      <Fill style={{ marginTop: space.s16 }}>
        {grant.error ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <ErrorState error={grant.error} onRetry={grant.reload} />
          </View>
        ) : grant.loading && grant.data === undefined ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <LoadingRows count={4} height={size.row} />
          </View>
        ) : !grant.data ? (
          <EmptyState text="Nothing is granted, so no trade can fill." />
        ) : venues.length === 0 ? (
          <EmptyState text="No venues are allowed, so no trade can fill." />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: space.gutter,
              paddingBottom: space.s30,
              gap: space.s10,
            }}
          >
            <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
              <Text variant="footnote" color={colors.ink55}>
                CONTRACT
              </Text>
              <Text variant="rowPrimary" style={{ marginTop: space.s4 }}>
                {params.data ? shortAddress(params.data.contract) : params.error ? '—' : '· · ·'}
              </Text>
              <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s6 }}>
                {/* The key the grant names, which is not always the key the executor signs with today. */}
                granted to {shortAddress(grant.data.delegatePubkey)}
              </Text>
            </SheetCard>

            <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s10 }}>
              {venues.length === 1 ? 'ONE VENUE' : `${venues.length} VENUES`}
            </Text>
            {venues.map((v) => (
              <SheetCard key={v} bordered borderRadius={radius.panel} padding={space.s14}>
                <Text variant="footnoteSm" color={colors.ink65}>
                  {v}
                </Text>
              </SheetCard>
            ))}

            <Button
              label="What it may pull"
              variant="ghost"
              style={{ marginTop: space.s6 }}
              onPress={() => router.push('/approvals')}
            />
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
