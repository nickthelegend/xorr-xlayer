/**
 * The target basket, where it actually sits, and what the next rebalance would do.
 *
 * A basket is a set of target weights the executor will buy and sell to reach, on its own. The
 * screen's job is to make the gap between the target and the truth visible before a trade closes
 * it, so nothing the agent does here is a surprise.
 *
 * Drift is in percentage POINTS of the basket — a sleeve targeted at 40% sitting at 46% has drifted
 * 6 — because that is the unit the band is set in. Re-expressing it as a percentage OF the target
 * would make the same sleeve read as 15% out and the band would stop meaning what it says.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  BackButton,
  ErrorState,
  Fill,
  LoadingRows,
  NoteStrip,
  Price,
  Row,
  Screen,
  Text,
  colors,
  money,
  size,
  space,
} from '@/ui';
import { api } from '@/data/api';
import { useAsync } from '@/data/useAsync';
import {
  driftText,
  nextLeg,
  nextRebalanceSentence,
  outOfBand,
  unpricedNote,
  weightText,
  type BasketRun,
  type BasketState,
} from '@/bot/basket';

export default function AgentBasket() {
  const goBack = useGoBack();
  const read = useAsync(() => api.get<BasketState>('/agents/basket'), []);
  const runs = useAsync(() => api.get<BasketRun[]>('/agents/basket/runs'), []);
  const state = read.data;

  return (
    <Screen gutter="none" sheet>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.s8,
          paddingHorizontal: space.gutter,
        }}
      >
        <BackButton onPress={() => goBack()} />
        <Text variant="screenTitle">Basket</Text>
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        {read.error ? (
          <ErrorState error={read.error} onRetry={read.reload} />
        ) : !state ? (
          <LoadingRows count={4} height={size.rowLg} />
        ) : !state.configured ? (
          <Text variant="secondary" color={colors.ink55}>
            No basket set. A basket is a list of target weights — 40% NVDAx, 30% TSLAx, 30% AAPLx —
            that the agent buys and sells to hold, once a sleeve drifts past the band you choose.
          </Text>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30 }}
          >
            <BasketBody state={state} runs={runs.data} />
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}

function BasketBody({
  state,
  runs,
}: {
  state: Extract<BasketState, { configured: true }>;
  runs: BasketRun[] | undefined;
}) {
  const note = unpricedNote(state.unpriced);
  const leg = nextLeg(state.sleeves, state.bandPct);

  return (
    <>
      {/*
        The honest state, first and unmissable.

        While a sleeve is unpriced, every percentage below it is unknowable — the total is missing
        a holding, so each remaining weight would read too high. Saying so above the numbers is the
        only placement that stops someone reading them as facts.
      */}
      {note ? <NoteStrip kind="blocked">{note}</NoteStrip> : null}

      <Row
        title="Basket value"
        value={
          state.unpriced.length > 0 ? (
            <Text variant="rowPrimary" color={colors.ink55}>
              Unavailable
            </Text>
          ) : (
            <Price figure="own">{money(state.totalUsd)}</Price>
          )
        }
        secondary={`Rebalanced ${state.cadence} once a sleeve is ${state.bandPct} points out`}
        height={size.rowLg}
      />

      <Text variant="cardTitle" style={{ marginTop: space.s16, marginBottom: space.s8 }}>
        Weights
      </Text>

      {state.sleeves.map((s, i, all) => (
        <Row
          key={s.symbol}
          title={s.symbol}
          // Target first: it is the instruction, and the actual is the thing being compared to it.
          secondary={`target ${s.targetPct}%`}
          value={
            s.actualPct === null ? (
              <Text variant="rowPrimary" color={colors.ink55}>
                Unpriced
              </Text>
            ) : (
              <Text variant="rowPrimary">{weightText(s.actualPct)}</Text>
            )
          }
          delta={s.driftPct === null ? undefined : driftText(s.driftPct)}
          /*
            Coloured only past the band. A sleeve two points out is ordinary drift, and colouring
            that would teach people to ignore the colour by the time one is ten points out.

            `down` for both directions deliberately: the tone here is "this is what the next trade
            will act on", not a gain or a loss. A sleeve that has RUN is over-weight — good news
            about the holding and still the thing about to be sold — so painting it green would
            say the opposite of what the row means.
          */
          deltaTone={outOfBand(s, state.bandPct) ? 'down' : 'neutral'}
          height={size.rowLg}
          divider={i < all.length - 1}
        />
      ))}

      {/*
        What happens next, by the same rule the planner uses rather than an approximation of it.
      */}
      <NoteStrip kind={leg ? 'risk' : 'acted'} style={{ marginTop: space.s16 }}>
        {nextRebalanceSentence(state.sleeves, state.bandPct, state.unpriced)}
      </NoteStrip>

      {/*
        The runs, including the ones that did nothing.

        A history that showed only the trades would make a rebalancer that is correctly sitting
        still look like one that has stopped running.
      */}
      {runs && runs.length > 0 ? (
        <>
          <Text variant="cardTitle" style={{ marginTop: space.s20, marginBottom: space.s8 }}>
            Recent runs
          </Text>
          {runs.map((r, i) => (
            <Row
              key={r.id}
              title={
                r.status === 'filled' && r.symbol
                  ? `${r.side === 'sell' ? 'Sold' : 'Bought'} ${r.symbol}`
                  : r.status === 'failed'
                    ? 'Did not go through'
                    : 'Looked, did nothing'
              }
              secondary={r.detail}
              value={
                r.usd !== null && r.status === 'filled' ? (
                  <Price figure="units">{money(r.usd)}</Price>
                ) : undefined
              }
              height={size.rowLg}
              divider={i < runs.length - 1}
            />
          ))}
        </>
      ) : null}
    </>
  );
}
