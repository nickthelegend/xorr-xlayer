/**
 * The permission itself: what was granted, to whom, until when.
 *
 * `/safety` shows whether the bot is on and gives you the switch. This is the underlying grant —
 * the contract, the key it names, the venues it may reach, the cap and the expiry. Two different
 * questions, and the second one had no screen.
 *
 * `delegateIsCurrent` is the field that earns this screen its place. A permission granted to a key
 * the executor no longer signs with is unusable and reads as perfectly healthy: not revoked, cap
 * intact, unexpired. Saying LIVE in that state is the one mistake this surface must never make.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
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
  type FigureKind,
} from '@/ui';
import { day, money, shortAddress } from '@/format';
import { useAsync } from '@/data/useAsync';
import { repos } from '@/data';
import { useNow } from '@/state/useNow';

/**
 * How far off the expiry is, in words — and in the past tense once it has passed.
 *
 * This was a signed day count, so an expired grant read "· -3 days": an ASCII hyphen standing in for
 * a minus, on a duration nobody says with a sign. Days are floored, hours take over on the last day,
 * and a passed expiry says how long ago.
 */
function expiryPhrase(expiresAt: number, now: number): string {
  const ms = Math.abs(expiresAt - now);
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor(ms / 3_600_000);
  const span =
    days >= 1
      ? `${days} ${days === 1 ? 'day' : 'days'}`
      : hours >= 1
        ? `${hours} ${hours === 1 ? 'hour' : 'hours'}`
        : undefined;
  if (expiresAt > now) return span ? `In ${span}` : 'In under an hour';
  return span ? `Expired ${span} ago` : 'Expired just now';
}

export default function DelegationDetail() {
  const goBack = useGoBack();
  const { data, loading, error, reload } = useAsync(() => repos.wallet.delegation(), []);
  /*
   * A minute, not a second. This screen compares against an expiry days away; the one-second tick
   * the proposal countdown uses would be a wakeup per second for a number that changes daily.
   */
  const now = useNow();

  const stale = data?.delegateIsCurrent === false;
  const expired = data ? data.expiresAt <= now : false;

  const state = !data
    ? '—'
    : data.revoked
      ? 'Revoked'
      : expired
        ? 'Expired'
        : stale
          ? 'Granted to an old key'
          : 'Live';

  const tone = !data || data.revoked || expired || stale ? colors.down : colors.up;

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Permission</Text>} />
      </View>

      <Fill style={{ marginTop: space.s16 }}>
        {error ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <ErrorState error={error} onRetry={reload} />
          </View>
        ) : loading && !data ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <Placeholder height={160} />
          </View>
        ) : !data ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <Text variant="body" color={colors.ink55}>
              Nothing has been granted. The bot cannot place an order.
            </Text>
          </View>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: space.gutter,
              paddingBottom: space.s30,
              gap: space.s10,
            }}
          >
            <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
              <Text variant="footnote" color={colors.ink55}>
                STATE
              </Text>
              <Text variant="screenTitle" color={tone} style={{ marginTop: space.s6 }}>
                {state}
              </Text>
              {stale ? (
                <Text variant="secondary" color={colors.ink65} style={{ marginTop: space.s10 }}>
                  {/*
                    The whole reason this field is rendered. Everything else about this grant looks
                    healthy, and it cannot be used.
                  */}
                  The permission names a key the executor no longer signs with, so every order it
                  attempts will be refused by the contract. Nothing else about this grant is wrong.
                </Text>
              ) : null}
            </SheetCard>

            <Field label="Daily cap" value={money(data.dailyCapUsd)} figure="own" />
            <Field
              label="Expiry"
              value={expiryPhrase(data.expiresAt, now)}
              sub={day(data.expiresAt)}
            />
            <Field
              label="Owner"
              value={data.ownerName ?? shortAddress(data.ownerPubkey)}
              sub={data.ownerName ? shortAddress(data.ownerPubkey) : undefined}
            />
            <Field
              label="Delegate"
              value={data.delegateName ?? shortAddress(data.delegatePubkey)}
              sub={data.delegateName ? shortAddress(data.delegatePubkey) : undefined}
            />

            <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
              <Text variant="footnote" color={colors.ink55}>
                VENUES IT MAY REACH
              </Text>
              {data.venueAllowlist.length === 0 ? (
                <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }}>
                  None. Every route is refused.
                </Text>
              ) : (
                data.venueAllowlist.map((v) => (
                  <Text key={v} variant="secondarySm" color={colors.ink65} style={{ marginTop: space.s8 }}>
                    {shortAddress(v)}
                  </Text>
                ))
              )}
            </SheetCard>
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}

/** One fact of the grant. The cap is the person's money and hides while balances are hidden; the rest are not figures. */
function Field({ label, value, sub, figure }: { label: string; value: string; sub?: string; figure?: FigureKind }) {
  return (
    <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
      <Text variant="footnote" color={colors.ink55}>
        {label}
      </Text>
      <Text variant="rowPrimary" style={{ marginTop: space.s4 }} figure={figure}>
        {value}
      </Text>
      {sub ? (
        <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s2 }}>
          {sub}
        </Text>
      ) : null}
    </SheetCard>
  );
}
