/**
 * What idle cash earns, and where the number comes from.
 *
 * The yield screen offers the way out. This is the rate itself: read as `currentLiquidityRate` from
 * the Aave v3 pool on X Layer, which is a floating number that changes with utilisation and is not a
 * promise. The distinction matters because a rate presented as a product feature reads as a
 * guarantee, and this one is neither ours to set nor stable.
 *
 * The rate is read from X Layer mainnet (or the fork's own state) on every build, so it is real everywhere; a rate the executor
 * cannot read is a 503 with a sentence and a retry, never a number. It can be earned only where the
 * pool is deployed, which `availableHere` says. Where it is not, the card says so, and nothing below
 * offers to earn it.
 *
 * Distilled 2026-09-14 (PLAN.md O3): no venue or network on the card — Sources names them. Signed out, the rate is
 * public and shown; "yours" is not, and a "$0.00 supplied · $0.00 idle" for a wallet nobody named is left out.
 */
import React from 'react';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
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
import { useSignedOut } from '@/auth/useSignedOut';
import { money, percent } from '@/format';
import { useAsync } from '@/data/useAsync';
import { repos } from '@/data';

export default function Rates() {
  const goBack = useGoBack();
  const router = useRouter();
  // A read that fails reaches the ErrorState: `staking()` used to swallow it into "No lending pool here".
  const rate = useAsync(() => repos.yield.staking(), []);
  const balance = useAsync(() => repos.portfolio.balance(), []);
  const signedOut = useSignedOut();

  const apy = rate.data?.estimatedApy ?? null;
  /* Absent is not false: an executor older than the field cannot say, and a pool it cannot vouch against is not denied. */
  const earnableHere = rate.data?.availableHere !== false;

  return (
    <Screen>
      <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Rate</Text>} />

      <Fill style={{ marginTop: space.s20, gap: space.s12 }}>
        {rate.error ? (
          <ErrorState error={rate.error} onRetry={rate.reload} />
        ) : rate.loading && !rate.data ? (
          <Placeholder height={150} />
        ) : !rate.data || apy === null ? (
          <Text variant="body" color={colors.ink55}>
            No rate right now.
          </Text>
        ) : (
          <>
            <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
              <Text variant="footnote" color={colors.ink55}>
                USDC SUPPLY RATE
              </Text>
              {/*
                `estimatedApy` is a FRACTION, not percentage points — 0.0412 is 4.12%. Getting that
                wrong by a factor of a hundred is the classic bug on a screen like this.
              */}
              <Text variant="screenTitle" style={{ marginTop: space.s6 }}>
                {percent(apy * 100, { digits: 2, explicitSign: false })}
              </Text>
              <Text variant="secondary" color={colors.ink65} style={{ marginTop: space.s10 }}>
                It floats. It is not a promise.
              </Text>
              {earnableHere ? null : (
                <Text variant="secondarySm" color={colors.warn} style={{ marginTop: space.s8 }}>
                  You can’t earn this here.
                </Text>
              )}
            </SheetCard>

            {/*
              Yours only where it is someone's and can earn: signed out it describes nobody, and where the pool is not
              deployed "idle cash would earn" is arithmetic on a rate nothing here can get. A balance that could not be
              read says so, rather than dropping the card as though there were nothing to show.
            */}
            {signedOut || !earnableHere ? null : balance.error ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
                <Text variant="footnote" color={colors.ink55}>
                  YOURS
                </Text>
                <Text variant="secondary" style={{ marginTop: space.s6 }}>
                  Couldn’t load your balance.
                </Text>
              </SheetCard>
            ) : !balance.data ? null : (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
                <Text variant="footnote" color={colors.ink55}>
                  YOURS
                </Text>
                <Text variant="rowPrimary" style={{ marginTop: space.s6 }} figure="own">
                  {money(balance.data.supplied)} supplied · {money(balance.data.cash)} idle
                </Text>
                <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }} figure="own">
                  {/*
                    What the rate would be worth on the idle balance — clearly framed as arithmetic on
                    a floating rate, not a projection of earnings.
                  */}
                  Idle cash would earn about {money(balance.data.cash * apy)} a year, if today&apos;s rate held.
                </Text>
              </SheetCard>
            )}

            {/*
              Each button names what its screen does. "Supply or withdraw" opened a screen that only withdraws. Supplying
              here is a sweep of idle cash, set up on its own screen, and neither exists where the pool does not.
            */}
            {earnableHere ? (
              <>
                <Button label="Earn on idle cash" variant="ghost" onPress={() => router.push('/strategy/yield')} />
                <Button label="Withdraw" variant="ghost" onPress={() => router.push('/yield')} />
              </>
            ) : null}
          </>
        )}
      </Fill>
    </Screen>
  );
}
