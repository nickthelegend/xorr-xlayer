/**
 * How far behind the subgraph is.
 *
 * The Graph is load-bearing here — the spend history and the routing decision both read from it —
 * and an index that has stopped is indistinguishable from a quiet week unless something says so.
 * `_meta` answers both questions in one call: the block it has reached, and whether it hit an
 * indexing error getting there.
 *
 * "Healthy" is reported separately from "current". A subgraph can be error-free and forty thousand
 * blocks behind, which is the failure mode that actually happens and the one a single badge hides.
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
import { useAsync } from '@/data/useAsync';
import { shortAddress } from '@/format';
import { system } from '@/data/system';

export default function GraphHealth() {
  const goBack = useGoBack();
  const router = useRouter();
  const graph = useAsync(() => system.graphHealth(), []);
  // The chain's own head, to say how far behind the index is. Without it "block 50983271" is a
  // number with nothing to compare to.
  const health = useAsync(() => system.health(), []);

  const headDetail = health.data?.dependencies.find((d) => d.name === 'rpc')?.detail ?? '';
  const head = Number(/block (\d+)/.exec(headDetail)?.[1] ?? NaN);
  /*
   * Like with like. The head is a block on this build's chain; the index's block is one on whatever network the index
   * follows. On the fork build that is Sepolia, millions of blocks from Base, and the difference was printed as a lag.
   * Blocks are compared only for an index of this deployment's own contract — which cannot be on a fork or a local
   * node, since nothing indexes those.
   */
  const comparable =
    graph.data?.indexesThisDeployment === true && health.data !== undefined && !/fork|local/i.test(health.data.chain);
  const behind = graph.data && comparable && Number.isFinite(head) ? head - graph.data.block : null;

  return (
    <Screen>
      <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Index</Text>} />

      <Fill style={{ marginTop: space.s20, gap: space.s12 }}>
        {graph.error ? (
          <ErrorState error={graph.error} onRetry={graph.reload} />
        ) : graph.loading && !graph.data ? (
          <Placeholder height={150} />
        ) : !graph.data ? null : (
          <>
            <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
              <Text variant="footnote" color={colors.ink55}>
                INDEXED TO
              </Text>
              <Text variant="screenTitle" style={{ marginTop: space.s6 }}>
                {graph.data.block.toLocaleString('en-US')}
              </Text>
              <Text
                variant="secondary"
                color={graph.data.healthy ? colors.up : colors.down}
                style={{ marginTop: space.s10 }}
              >
                {graph.data.healthy ? 'No indexing errors.' : 'The index reported errors.'}
              </Text>
              {/*
                Two different facts, kept apart. A subgraph can be error-free and badly behind, and
                that is the failure that actually happens.
              */}
              {/* No lag at all for another deployment's index: the line below says whose it is instead. */}
              {graph.data.indexesThisDeployment === false ? null : (
                <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s6 }}>
                  {behind === null
                    ? 'Cannot compare to the chain head right now.'
                    : behind <= 1
                      ? 'Level with the chain head.'
                      : `${behind.toLocaleString('en-US')} blocks behind the head.`}
                </Text>
              )}
              {/*
                Whether any of the above is about THIS deployment.
                
                `graph/client.ts` has always computed `indexesThisDeployment` and says why in as
                many words: "a perfectly synced index of a different contract is worse than no
                index, because it answers confidently about somebody else's policy." The executor
                sends it. This screen was not reading it — so on the fork build, where the index
                covers the Sepolia contract and the app trades chain 8453, it reported "No indexing
                errors. Level with the chain head." That is true of the index and says nothing about
                the wallet in front of you, which is precisely the confident answer about somebody
                else's contract the module was written to prevent.
              */}
              {graph.data.indexesThisDeployment === false ? (
                <Text variant="secondarySm" color={colors.warn} style={{ marginTop: space.s10 }}>
                  {/* Both addresses only when both were sent: an unset one would print as a lone minus sign. */}
                  {graph.data.indexedDelegation && graph.data.activeDelegation
                    ? `This index follows ${shortAddress(graph.data.indexedDelegation)}, not this deployment’s ${shortAddress(graph.data.activeDelegation)}.`
                    : 'This index follows a different deployment.'}
                </Text>
              ) : null}
            </SheetCard>

            <Button
              label="Spend events"
              variant="ghost"
              onPress={() => router.push('/graph/spends')}
            />
            <Button
              label="Routing decision"
              variant="ghost"
              onPress={() => router.push('/graph/decision')}
            />
          </>
        )}
      </Fill>
    </Screen>
  );
}
