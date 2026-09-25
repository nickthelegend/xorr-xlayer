/**
 * Screen 23 — News, with agent takes. screens.md Group D.
 *
 * "Briefing" + when it was fetched. Three cards: a class tag chip + relative time, headline
 * 15.5/600, then a hairline-separated agent take (8pt `up` dot + secondary body).
 * Ghost "Ask for the full rundown" → routes into Bot chat.
 *
 * PLAN.md 8.6: this is the "trades while you chill" payoff surface — what the user reads
 * when they come back after a week. Treated as a headline feature, not a leaf screen.
 *
 * The header said "Updated 18m ago" as a literal, forever. The feed carries no timestamp,
 * so the honest fact is when THIS screen last got an answer — which is what it now reports.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  BackButton,
  Button,
  EmptyState,
  ErrorState,
  Fill,
  LoadingRows,
  Screen,
  SheetCard,
  Tag,
  Text,
  colors,
  divider,
  radius,
  space,
} from '@/ui';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { useGoBack } from '@/nav/useGoBack';

const DOT = 8;
export default function Briefing() {
  const goBack = useGoBack();
  const router = useRouter();
  const { data, loading, error, reload, settledAt } = useAsync(() => repos.news.briefing(), []);

  // An ABSOLUTE time, not "4m ago": a relative age needs a ticking clock to stay true, and
  // a stale "4m ago" is the same lie as the hardcoded "18m ago" this replaced, just slower.
  const loadedAt =
    settledAt === undefined
      ? undefined
      : new Date(settledAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  return (
    <Screen>
      {/*
        A pushed screen needs a way back that is visible.

        This had none: the only exit was iOS's edge-swipe, which is undiscoverable and does not
        exist on web at all. Same header as History, which had it right.
      */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
          <BackButton onPress={() => goBack()} />
          <Text variant="screenTitle">Briefing</Text>
        </View>
        <Text variant="footnote" color={colors.ink55}>
          {loadedAt === undefined ? '' : `Loaded ${loadedAt}`}
        </Text>
      </View>
      <Text variant="secondary" style={{ marginTop: space.s10 }}>
        Headlines that touch what you hold, or the newest ones until something does — and what each could mean.
      </Text>

      <Fill style={{ marginTop: space.s18 }}>
        {loading && !data ? (
          <LoadingRows count={3} height={110} />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : (data ?? []).length === 0 ? (
          /* The feed answered with nothing. A blank area under the header read as still loading. */
          <EmptyState text="No headlines right now." />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ gap: space.s12 }}
          >
            {(data ?? []).map((n) => (
              <SheetCard key={n.id} borderRadius={radius.panel} padding={space.s16}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
                  <Tag label={n.tag} small colors={{ bg: n.tagBg, fg: n.tagFg }} />
                  <Text variant="footnote" color={colors.ink55}>
                    {n.t}
                  </Text>
                </View>

                <Text variant="rowPrimaryLg" style={{ marginTop: space.s12 }}>
                  {n.headline}
                </Text>

                {/*
                  A take, never a written-in-advance line dressed as one. With no model configured this rendered the same
                  sentence under three unrelated headlines, and on an empty wallet that sentence ("Everything is inside its
                  limits") described positions that did not exist. Then the admission that there was none repeated under
                  every card; it is said once, below the list.
                */}
                {n.take ? (
                  <View
                    style={[
                      {
                        flexDirection: 'row',
                        gap: space.s10,
                        marginTop: space.s14,
                        paddingTop: space.s14,
                        borderTopWidth: divider.borderBottomWidth,
                        borderTopColor: divider.borderBottomColor,
                      },
                    ]}
                  >
                    <View
                      style={{
                        width: DOT,
                        height: DOT,
                        borderRadius: radius.full,
                        backgroundColor: colors.up,
                        marginTop: space.s4,
                      }}
                    />
                    <Text variant="secondarySm" color={colors.ink45} style={{ flex: 1 }}>
                      {n.take}
                    </Text>
                  </View>
                ) : null}
              </SheetCard>
            ))}
            {(data ?? []).every((n) => !n.take) ? (
              <Text variant="footnote" color={colors.ink55} align="center" style={{ marginTop: space.s4 }}>
                No agent comments: this build has no language model.
              </Text>
            ) : null}
          </ScrollView>
        )}
      </Fill>

      <Button
        label="Ask for the full rundown"
        variant="ghost"
        onPress={() => router.push('/bot')}
        style={{ marginTop: space.s14 }}
      />
    </Screen>
  );
}

