/**
 * Notification inbox — PLAN.md 10.10 [G14].
 *
 * A push can be missed, dismissed, or muted. The inbox is where the thing the push was
 * about still lives, and every row deep-links to the same place the notification would have.
 *
 * Only those rows. It listed the whole audit trail — strategies created, runs with nothing to do,
 * watched runs that "would have" bought — and sent whatever it could not place to Alerts.
 * `interruptionFor` keeps the rows a push went out with, by the executor's own wording.
 */
import React, { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  BackButton,
  EmptyState,
  Fill,
  LoadingRows,
  Row,
  Screen,
  Text,
  noteDotColor,
  radius,
  space,
  ErrorState,
  SignInPrompt,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { activityDot } from '@/state/derived';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { useRefreshControl } from '@/ui/useRefreshControl';
import { interruptionFor, routeFor } from '@/notifications/routes';
import { plainAction, plainDetail } from '@/format/activity';
import { eventTime } from '@/format';

const DOT = 8;

export default function Inbox() {
  const router = useRouter();
  const goBack = useGoBack();
  const { data, loading, error, reload } = useAsync(() => repos.activity.list(), []);
  const refresh = useRefreshControl(reload);
  const signedOut = useSignedOut();

  /* Each row with the push it went out with; a row that sent none is a record, and Activity has it. */
  const rows = useMemo(
    () =>
      (data ?? []).flatMap((event) => {
        const kind = interruptionFor(event);
        return kind ? [{ event, route: routeFor(kind) }] : [];
      }),
    [data],
  );

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
        <BackButton onPress={() => goBack()} />
        <Text variant="screenTitle">Inbox</Text>
      </View>
      <Text variant="secondary" style={{ marginTop: space.s10 }}>
        What would have interrupted you.
      </Text>

      <Fill style={{ marginTop: space.s14 }}>
        {signedOut ? (
          <SignInPrompt />
        ) : loading && !data ? (
          <LoadingRows count={5} />
        ) : error && !data ? (
          /* An inbox that could not be read is not an empty one. It used to say "Nothing to catch up on". */
          <ErrorState error={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyState
            text="Nothing needs you."
            actionLabel="What the bot can do"
            onAction={() => router.push('/safety')}
          />
        ) : (
          <ScrollView refreshControl={refresh.control} showsVerticalScrollIndicator={false}>
            {/* A pull that failed says so, over the rows it could not replace. A success says nothing. */}
            {refresh.notice}
            {rows.map(({ event, route }) => (
              <Row
                key={event.id}
                left={
                  <View
                    style={{
                      width: DOT,
                      height: DOT,
                      borderRadius: radius.full,
                      backgroundColor: noteDotColor[activityDot(event.kind)],
                    }}
                  />
                }
                title={plainAction(event.action)}
                secondary={`${plainDetail(event.detail)} · ${eventTime(event)}`}
                height={68}
                onPress={() => router.push(route as never)}
              />
            ))}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
