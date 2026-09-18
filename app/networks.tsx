/**
 * Networks — every network xorr runs on, what works on each, and which one this app uses (2026-09-15).
 *
 * The product is built to run on whichever chain a hackathon asks for, one deployment per chain. Each card is a
 * deployment from `src/networks/deployments.ts`, and every fact on it is read live from that network's own executor:
 * whether it is up and at which block, whether trades settle there, whether idle cash can earn. A network that does not
 * answer says so; nothing stands in for an answer.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import { Fill, HeaderBar, Placeholder, Press, Screen, SheetCard, Tag, Text, colors, radius, space } from '@/ui';
import { useAsync } from '@/data/useAsync';
import { useFreshOnReturn } from '@/data/useFreshOnReturn';
import { TimedOut, errorText } from '@/data/apiError';
import { readNetwork } from '@/data/networks';
import { DEPLOYMENTS, thisDeployment, type Deployment } from '@/networks/deployments';
import { networkStatus, type NetworkStatus } from '@/networks/status';

export default function Networks() {
  const goBack = useGoBack();
  const current = thisDeployment();

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Networks</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          Where xorr runs, and what works on each.
        </Text>
      </View>

      <Fill style={{ marginTop: space.s16 }}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.s30, gap: space.s10 }}
        >
          {DEPLOYMENTS.map((d) => (
            <NetworkCard key={d.key} deployment={d} current={current?.key === d.key} />
          ))}
          {current ? null : (
            // A developer's build against a local executor: say so rather than mark a network it does not use.
            <Text variant="footnote" color={colors.ink55}>
              This build talks to an executor none of these serve.
            </Text>
          )}
        </ScrollView>
      </Fill>
    </Screen>
  );
}

function NetworkCard({ deployment, current }: { deployment: Deployment; current: boolean }) {
  const router = useRouter();
  const read = useAsync(() => readNetwork(deployment.api), [deployment.api]);
  useFreshOnReturn(read);
  const status = read.data ? networkStatus(deployment, read.data) : undefined;
  const unreachable = read.data && read.data.health instanceof Error ? read.data.health : undefined;

  return (
    <Press
      onPress={() => router.push({ pathname: '/network', params: { key: deployment.key } })}
      accessibilityRole="button"
      accessibilityLabel={`${deployment.name}${current ? ', this app' : ''}. ${status ? stateLine(status, unreachable) : 'Reading'}`}
    >
      <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
          <Text variant="rowPrimaryLg" numberOfLines={1} style={{ flexShrink: 1 }}>
            {deployment.name}
          </Text>
          {current ? <Tag label="This app" sentence radius={radius.full} /> : null}
          <Text variant="footnote" color={colors.ink55} style={{ marginLeft: 'auto' }}>
            {`Chain ${deployment.chainId}`}
          </Text>
        </View>

        {!status ? (
          <Placeholder height={44} style={{ marginTop: space.s12 }} />
        ) : (
          <View style={{ marginTop: space.s10, gap: space.s4 }}>
            <Text variant="secondary" color={status.state === 'up' ? colors.ink65 : colors.warn}>
              {stateLine(status, unreachable)}
            </Text>
            {status.mismatch && status.chain ? (
              <Text variant="secondarySm" color={colors.warn}>
                {`Its executor serves ${status.chain}, not ${deployment.key}.`}
              </Text>
            ) : null}
            <Text variant="secondarySm" color={colors.ink55}>
              {status.trades === 'fill'
                ? 'Trades settle here.'
                : status.trades === 'watch'
                  ? 'Watch only: trades do not settle here.'
                  : 'Trades: —'}
            </Text>
            <Text variant="secondarySm" color={colors.ink55}>
              {status.earn === true ? 'Idle cash can earn.' : status.earn === false ? 'Idle cash cannot earn here.' : 'Earning: —'}
            </Text>
            {deployment.test ? (
              <Text variant="secondarySm" color={colors.ink55}>
                Test network. Not real money.
              </Text>
            ) : null}
          </View>
        )}
      </SheetCard>
    </Press>
  );
}

/** Up and at which block, or what is wrong, in one line. */
function stateLine(status: NetworkStatus, unreachable: Error | undefined): string {
  const block = status.block === undefined ? '' : ` · block ${status.block.toLocaleString('en-US')}`;
  switch (status.state) {
    case 'up':
      return `Up${block}`;
    case 'degraded':
      return `Degraded${block}`;
    case 'down':
      return 'Down';
    case 'unreachable':
      return unreachable instanceof TimedOut ? 'Not answering in time.' : `Not reachable: ${errorText(unreachable)}`;
  }
}
