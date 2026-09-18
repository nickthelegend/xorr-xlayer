/**
 * Which chain this build is actually pointed at.
 *
 * More useful than it sounds, because this app runs against three: Base mainnet, Base Sepolia, and
 * a mainnet fork. They look identical from every other screen and behave completely differently —
 * 1inch cannot settle on Sepolia, the tokenized equities do not function on the fork, and a block
 * explorer link means nothing on either. Someone reading a price should be able to find out which
 * of those they are looking at without reading the source.
 *
 * The block height comes from the RPC dependency's own detail string in `/health`, which is where
 * the executor already reports it. Parsing it here rather than adding a route keeps one source of
 * truth for "what block are we on".
 *
 * Since 2026-09-15 it is also any network xorr runs on (`/network?key=base-sepolia`, from Networks): the same cards, read
 * from that network's own executor, with what works there. Without a key it is the network this app talks to, and it
 * says when this build and its executor disagree about which chain that is.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  Placeholder,
  Screen,
  SheetCard,
  Tag,
  Text,
  colors,
  radius,
  space,
} from '@/ui';
import { shortAddress } from '@/format';
import { CHAIN_KEY } from '@/chain';
import { API_BASE } from '@/data/apiBase';
import { useAsync } from '@/data/useAsync';
import { readNetwork } from '@/data/networks';
import { deploymentFor, thisDeployment } from '@/networks/deployments';
import { networkStatus } from '@/networks/status';

/**
 * What each chain key means for what the app can actually do, in one line each.
 *
 * Sepolia cannot fill a swap because no aggregator is deployed there; a fork fills against copied liquidity that no
 * public explorer has seen. The reasons live here, not on the screen.
 */
const CHAIN_NOTE: Record<string, string> = {
  base: 'Base mainnet. Real money, real fills.',
  'base-sepolia': 'A test network. Transactions settle; swaps cannot fill.',
  'base-fork': 'A fork of Base. Fills are real here and nowhere else.',
  localnet: 'A local chain. Nothing leaves this machine.',
};

export default function Network() {
  const goBack = useGoBack();
  const router = useRouter();
  const { key } = useLocalSearchParams<{ key?: string }>();
  const current = thisDeployment();
  // The network the link names, or the one this app talks to. A build no deployment serves reads its own executor.
  const named = deploymentFor(key);
  const target = key ? named : current;
  const isThisApp = !key || (current !== undefined && named?.key === current.key);
  const api = target?.api ?? API_BASE;
  const { data, loading, reload } = useAsync(() => readNetwork(api), [api]);

  if (key && !named) {
    return (
      <Screen gutter="none">
        <View style={{ paddingHorizontal: space.gutter }}>
          <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Network</Text>} />
          <EmptyState
            text={`xorr does not run on ${key}.`}
            actionLabel="Every network"
            onAction={() => router.replace('/networks')}
          />
        </View>
      </Screen>
    );
  }

  const health = data && !(data.health instanceof Error) ? data.health : undefined;
  const failed = data && data.health instanceof Error ? data.health : undefined;
  const status = data && target ? networkStatus(target, data) : undefined;

  const rpc = health?.dependencies.find((d) => d.name === 'rpc');
  const gas = health?.dependencies.find((d) => d.name === 'gas');
  const block = /block (\d+)/.exec(rpc?.detail ?? '')?.[1];
  // Which chain the network is meant to be: this build's own key here, the deployment's key for another network.
  const expected = isThisApp ? CHAIN_KEY : target?.key;
  const disagree = health !== undefined && expected !== undefined && health.chain !== expected;

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Network</Text>} />
      </View>

      <Fill style={{ marginTop: space.s16 }}>
        {failed ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <ErrorState error={failed} onRetry={reload} />
          </View>
        ) : loading && !data ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <Placeholder height={150} />
          </View>
        ) : !health ? null : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: space.gutter,
              paddingBottom: space.s30,
              gap: space.s10,
            }}
          >
            <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
                <Text variant="footnote" color={colors.ink55}>
                  CHAIN
                </Text>
                {isThisApp && target ? <Tag label="This app" sentence radius={radius.full} /> : null}
              </View>
              <Text variant="screenTitle" style={{ marginTop: space.s6 }}>
                {target?.name ?? health.chain}
              </Text>
              {target ? (
                <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s4 }}>
                  {`Chain ${target.chainId} · ${health.chain}`}
                </Text>
              ) : null}
              <Text variant="secondary" color={colors.ink65} style={{ marginTop: space.s10 }}>
                {/*
                  The consequence, not just the name. "base-fork" tells a reader nothing about why
                  their explorer link is missing.
                */}
                {CHAIN_NOTE[health.chain] ?? 'An unrecognised chain key. Treat everything here with suspicion.'}
              </Text>
            </SheetCard>

            {disagree ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                <Text variant="secondary" color={colors.warn}>
                  {isThisApp
                    ? `This build expects ${expected}, and its executor serves ${health.chain}.`
                    : `Its executor serves ${health.chain}, not ${expected}.`}
                </Text>
              </SheetCard>
            ) : null}

            {status ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                <Text variant="footnote" color={colors.ink55}>
                  WHAT WORKS HERE
                </Text>
                <Text variant="secondary" color={colors.ink65} style={{ marginTop: space.s6 }}>
                  {status.trades === 'fill'
                    ? 'Trades settle here.'
                    : status.trades === 'watch'
                      ? 'Watch only: trades do not settle here.'
                      : 'Trades: —'}
                </Text>
                <Text variant="secondary" color={colors.ink65} style={{ marginTop: space.s4 }}>
                  {status.earn === true
                    ? 'Idle cash can earn.'
                    : status.earn === false
                      ? 'Idle cash cannot earn here.'
                      : 'Earning: —'}
                </Text>
                {target?.test ? (
                  <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s6 }}>
                    Test network. Not real money.
                  </Text>
                ) : null}
              </SheetCard>
            ) : null}

            {block ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                <Text variant="footnote" color={colors.ink55}>
                  BLOCK
                </Text>
                <Text variant="rowPrimary" style={{ marginTop: space.s4 }}>
                  {Number(block).toLocaleString('en-US')}
                </Text>
                {rpc?.ms === undefined ? null : (
                  <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s4 }}>
                    RPC answered in {rpc.ms}ms
                  </Text>
                )}
              </SheetCard>
            ) : null}

            <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
              <Text variant="footnote" color={colors.ink55}>
                DELEGATION CONTRACT
              </Text>
              <Text variant="rowPrimary" style={{ marginTop: space.s4 }}>
                {shortAddress(health.delegation)}
              </Text>
              <Text variant="footnoteSm" color={colors.ink55} style={{ marginTop: space.s4 }}>
                {health.delegation}
              </Text>
            </SheetCard>

            {gas ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                <Text variant="footnote" color={colors.ink55}>
                  GAS WALLET
                </Text>
                <Text variant="secondary" color={colors.ink65} style={{ marginTop: space.s6 }}>
                  {/*
                    Worth its own card: the bot pays its own gas and never touches the user's ETH,
                    which is a claim `/verify` checks and this is where the balance behind it lives.
                  */}
                  {gas.detail ?? '—'}
                </Text>
              </SheetCard>
            ) : null}

            {target?.explorer ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                <Text variant="footnote" color={colors.ink55}>
                  EXPLORER
                </Text>
                <Text variant="rowPrimary" style={{ marginTop: space.s4 }}>
                  {target.explorer.replace(/^https:\/\//, '')}
                </Text>
              </SheetCard>
            ) : null}

            {/* System reads this app's own executor, so it is offered only here. */}
            {isThisApp ? (
              <Button label="Everything the system needs" variant="ghost" onPress={() => router.push('/system')} />
            ) : null}
            <Button label="Every network" variant="ghost" onPress={() => router.push('/networks')} />
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
