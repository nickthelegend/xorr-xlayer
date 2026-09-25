/**
 * One entry from the trail, with everything it committed to.
 *
 * Activity is a list, and a list has room for a line each. This is the row expanded: what was done,
 * what moved, the signature if there was one, and where to go and check it — which is the whole
 * claim the trail makes and the part a list cannot fit.
 *
 * `explorer` is rendered exactly as the server sends it. On a fork or a local chain it comes back as
 * a `fork:` label rather than a URL, deliberately: a link to a block explorer that has never seen
 * the transaction 404s, and a 404 reads as the transaction not being real rather than the network
 * not being public.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  ErrorState,
  Fill,
  HeaderBar,
  Placeholder,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  space,
} from '@/ui';
import { useAsync } from '@/data/useAsync';
import { repos } from '@/data';
import { eventTime } from '@/format';

export default function AuditEntry() {
  const goBack = useGoBack();
  /*
   * `seq` is the entry's sequence number, and matching it against `id` is correct: `/activity`
   * answers each row's `id` as `String(seq)` (server/src/routes/index.ts), which is also the value
   * `/audit/chain` links here with.
   *
   * What was wrong was the claim when it is missing. `/activity` returns only the newest entries, so
   * an older sequence number is in the trail and simply not in this list — and the screen said "No
   * entry with that sequence number is in the trail." It now says what it looked through.
   */
  const { seq } = useLocalSearchParams<{ seq: string }>();
  const { data, loading, error, reload } = useAsync(() => repos.activity.list(), []);
  const entry = (data ?? []).find((e) => e.id === seq);
  const searched = (data ?? []).length;

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Entry {seq}</Text>} />
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <Placeholder height={170} />
        ) : !entry ? (
          <Text variant="body" color={colors.ink55}>
            {searched === 0
              ? 'The trail has no entries yet.'
              : `Entry ${seq ?? ''} is not among the latest ${searched}.`}
          </Text>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30, gap: space.s10 }}
          >
            <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
              <Text variant="footnote" color={colors.ink55}>
                {entry.agent.toUpperCase()} · {eventTime(entry)}
              </Text>
              <Text variant="screenTitle" style={{ marginTop: space.s6 }}>
                {entry.action}
              </Text>
              <Text variant="secondary" color={colors.ink65} style={{ marginTop: space.s10 }}>
                {entry.detail}
              </Text>
              {/* Empty when the event moved no money — which is most of them, and is the point. */}
              {entry.amount ? (
                <Text variant="rowPrimaryLg" style={{ marginTop: space.s12 }}>
                  {entry.amount}
                </Text>
              ) : null}
            </SheetCard>

            {entry.signature ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                <Text variant="footnote" color={colors.ink55}>
                  TRANSACTION
                </Text>
                <Text variant="footnoteSm" color={colors.ink65} style={{ marginTop: space.s6 }}>
                  {entry.signature}
                </Text>
                {entry.explorer ? (
                  <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s10 }}>
                    {/*
                      As sent. A `fork:` label instead of a URL is the server saying this chain has
                      no public explorer — better than a link that 404s and makes a real transaction
                      look fabricated.
                    */}
                    {entry.explorer}
                  </Text>
                ) : null}
              </SheetCard>
            ) : (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                <Text variant="secondarySm" color={colors.ink55}>
                  No transaction. This entry records something the bot decided, not something it
                  sent — which is why the trail has more rows than the chain does.
                </Text>
              </SheetCard>
            )}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
