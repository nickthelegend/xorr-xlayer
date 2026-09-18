/**
 * What Privy will refuse, independently of anything we control.
 *
 * This is the strongest safety claim in the product and it was buried. The delegation contract
 * limits what the bot may spend; the Privy policy limits where the wallet may send *at all*, and it
 * is enforced by Privy's signer rather than by our code — so a compromised executor cannot widen
 * it. The screen exists to make that checkable rather than asserted.
 *
 * `enforced: false` is shown as a distinct state from "broken". A wallet that predates the policy
 * cannot have one attached by us, because Privy makes the wallet's owner authorise that and for an
 * embedded wallet the owner is the user. "This control exists and belongs to you, not to us" is the
 * more interesting fact, and it is the one a bare red cross would hide.
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
  EmptyState,
  SignInPrompt,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { shortAddress } from '@/format';
import { useAsync } from '@/data/useAsync';
import { repos } from '@/data';

export default function Policy() {
  const goBack = useGoBack();
  const { data, loading, error, reload } = useAsync(() => repos.wallet.privyPolicy(), []);
  const signedOut = useSignedOut();

  /*
   * Attached destinations if there are any, otherwise what the policy WOULD allow. Showing an
   * empty list for an unattached policy makes it look like the control permits nothing, when in
   * fact it permits nothing *yet*.
   */
  const destinations = data ? (data.enforced ? data.allowed : data.wouldAllow) : [];

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Wallet policy</Text>} />
      </View>

      <Fill style={{ marginTop: space.s16 }}>
        {signedOut ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <SignInPrompt />
          </View>
        ) : error ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <ErrorState error={error} onRetry={reload} />
          </View>
        ) : loading && !data ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <Placeholder height={150} />
          </View>
        ) : !data ? (
          /*
            A failed read throws and is the error state above; the executor never answers null. This only keeps an
            empty answer from rendering as a blank screen, which would say nothing at all.
          */
          <View style={{ paddingHorizontal: space.gutter }}>
            <EmptyState text="The wallet policy could not be read." actionLabel="Try again" onAction={reload} />
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
                PRIVY POLICY
              </Text>
              <Text
                variant="screenTitle"
                color={data.enforced ? colors.up : colors.ink40}
                style={{ marginTop: space.s6 }}
              >
                {data.enforced ? 'Enforcing' : 'Not attached'}
              </Text>
              <Text variant="secondary" color={colors.ink65} style={{ marginTop: space.s10 }}>
                {data.enforced
                  ? 'Privy refuses any transaction this policy does not name, before it is signed. We cannot override it.'
                  : 'The policy exists but is not attached to this wallet. Attaching it is authorised by the wallet owner, which is you — not us.'}
              </Text>
              {data.policyName ? (
                <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s8 }}>
                  {data.policyName}
                </Text>
              ) : null}
            </SheetCard>

            {destinations.length > 0 ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                <Text variant="footnote" color={colors.ink55}>
                  {data.enforced ? 'MAY SEND TO' : 'WOULD ALLOW'}
                </Text>
                {destinations.map((d) => (
                  <View key={`${d.label}:${d.address}`} style={{ marginTop: space.s10 }}>
                    <Text variant="rowPrimary">{d.label}</Text>
                    <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s2 }}>
                      {shortAddress(d.address)}
                    </Text>
                  </View>
                ))}
              </SheetCard>
            ) : null}

            {data.ownedByQuorum ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                <Text variant="footnote" color={colors.ink55}>
                  OWNED BY
                </Text>
                <Text variant="secondarySm" color={colors.ink65} style={{ marginTop: space.s6 }}>
                  {/*
                    The quorum is why widening the policy is not something we can do quietly. It is
                    the mechanism behind the claim above, so it is named rather than summarised.
                  */}
                  Key quorum {data.ownedByQuorum}. Changing what this policy allows needs that
                  quorum, which the executor is not a member of.
                </Text>
              </SheetCard>
            ) : null}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
