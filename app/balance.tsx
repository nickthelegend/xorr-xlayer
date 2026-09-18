/**
 * Where the money is, split by what it is doing.
 *
 * Home shows one total. This is the split the total is made of: cash that can be spent today,
 * holdings marked at the live route, and whatever is supplied to Aave earning a rate. They behave
 * completely differently — one is spendable now, one moves with the market, one has to be withdrawn
 * first — and a single figure erases all three distinctions.
 *
 * The bar is proportional and drawn from the same numbers as the rows beneath it, so it cannot
 * disagree with them.
 *
 * Distilled 2026-09-14 (PLAN.md O3). Signed out it asks for a sign-in: "could not be read" was a claim about a request
 * nobody made. A read that did fail is an error with its reason — `balance()` throws now, where it answered null.
 */
import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  ErrorState,
  Fill,
  HeaderBar,
  Placeholder,
  Price,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  space,
  SignInPrompt,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
// Unsigned: a share of the whole is not a move, and "+62.4%" read as a gain.
import { money, percent as pct } from '@/format';
import { useAsync } from '@/data/useAsync';
import { useFreshOnReturn } from '@/data/useFreshOnReturn';
import { repos } from '@/data';

const BAR_H = 8;

export default function Balance() {
  const goBack = useGoBack();
  const router = useRouter();
  const balance = useAsync(() => repos.portfolio.balance(), []);
  const { data, loading, error, reload } = balance;
  // The split moves with every trade, deposit and withdrawal made on another screen: read it again on return
  // (FEATURES.md #27).
  useFreshOnReturn(balance);
  const signedOut = useSignedOut();

  const total = data?.total ?? 0;
  const held = data ? Math.max(0, data.total - data.cash - data.supplied) : 0;
  const share = (n: number) => (total > 0 ? n / total : 0);

  return (
    <Screen>
      <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Balance</Text>} />

      <Fill style={{ marginTop: space.s20, gap: space.s12 }}>
        {signedOut ? (
          <SignInPrompt />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <Placeholder height={160} />
        ) : !data ? (
          <Text variant="body" color={colors.ink55}>
            The balance could not be read.
          </Text>
        ) : (
          <>
            <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
              <Text variant="footnote" color={colors.ink55}>
                TOTAL
              </Text>
              <Price variant="screenTitle" style={{ marginTop: space.s6 }}>
                {money(data.total)}
              </Price>

              {/* One bar, three segments, in the order money moves: spendable, at risk, earning. */}
              <View
                style={{
                  flexDirection: 'row',
                  height: BAR_H,
                  borderRadius: BAR_H / 2,
                  backgroundColor: colors.control,
                  marginTop: space.s16,
                  overflow: 'hidden',
                }}
              >
                <View style={{ width: `${share(data.cash) * 100}%`, backgroundColor: colors.ink }} />
                <View style={{ width: `${share(held) * 100}%`, backgroundColor: colors.ink55 }} />
                <View
                  style={{ width: `${share(data.supplied) * 100}%`, backgroundColor: colors.ink30 }}
                />
              </View>
            </SheetCard>

            <Slice label="Cash" note="Spendable now. The cap draws from this." usd={data.cash} share={share(data.cash)} />
            <Slice label="Held" note="Marked at what a sale would get." usd={held} share={share(held)} />
            <Slice label="Supplied" note="Earning. Withdraw it to spend it." usd={data.supplied} share={share(data.supplied)} />

            <Button label="Where it sits" variant="ghost" onPress={() => router.push('/allocation')} />
          </>
        )}
      </Fill>
    </Screen>
  );
}

function Slice({
  label,
  note,
  usd,
  share,
}: {
  label: string;
  note: string;
  usd: number;
  share: number;
}) {
  return (
    <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text variant="rowPrimary">{label}</Text>
        <Price variant="rowPrimary">{money(usd)}</Price>
      </View>
      <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s4 }}>
        {pct(share * 100, { digits: 1, explicitSign: false })}
      </Text>
      <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }}>
        {note}
      </Text>
    </SheetCard>
  );
}
