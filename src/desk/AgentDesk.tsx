/**
 * The desk: under the agents on Home, what each one will do next and what they did (2026-09-26).
 *
 * The agents trade on their own — a schedule the executor keeps, inside a budget the contract holds — and Home showed
 * their faces above an empty sheet. This is the rest of it: per agent, the budget left on chain and the next run
 * counting down; below, the trail as it lands, read every few seconds while Home is in view, a new fill arriving at the
 * top with "Just now" on it. The phone's banner for the same fill is `useTradeNotifications`.
 */
import React from 'react';
import { View } from 'react-native';
import { agentGradient } from '@/design/gradients';
import { AgentOrb, Eyebrow, LoadingRows, Press, Text, colors, money, radius, size, space } from '@/ui';
import { Rise } from '@/ui/Rise';
import { TransactionRef } from '@/ui/TransactionRef';
import { repos } from '@/data';
import { usePoll } from '@/data/usePoll';
import type { ActivityEvent, Agent } from '@/data/types';
import { plainAction, plainDetail } from '@/format/activity';
import { eventTime } from '@/format';
import { useNow } from '@/state/useNow';
import { agentLine, deskFeed, isFresh, spentBy, type DeskStanding } from './desk';

/** The trail is read this often while Home is in view: a fill is a transaction, so a few seconds late is on time. */
const FEED_EVERY_MS = 6_000;
const BOOK_EVERY_MS = 20_000;
const ORB = 52 as const;
const DOT = 7;
const METER_H = 4;

function Dot({ color }: { color: string }) {
  return <View style={{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: color }} />;
}

export function AgentDesk({
  agents,
  standing,
  onOpenAgent,
  onSeeAll,
}: {
  agents: readonly Agent[];
  standing: DeskStanding;
  onOpenAgent: (id: string) => void;
  onSeeAll: () => void;
}) {
  const now = useNow(1_000);
  const trail = usePoll(() => repos.activity.list(), FEED_EVERY_MS);
  const book = usePoll(() => repos.strategies.list(), BOOK_EVERY_MS);
  const events = trail.data ?? [];
  const feed = deskFeed(events, agents.map((a) => a.name));
  const live = standing === 'live';

  return (
    <View style={{ marginTop: space.s26, gap: space.s10 }} testID="agent-desk">
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Eyebrow small>The desk</Eyebrow>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s6 }}>
          <Dot color={live ? colors.up : standing === 'revoked' ? colors.down : colors.ink40} />
          <Text variant="secondarySm" color={colors.ink55}>
            {live ? 'Trading on its own' : standing === 'revoked' ? 'Stopped' : 'Not trading'}
          </Text>
        </View>
      </View>

      {agents.map((a) => {
        const line = agentLine(a, book.data ?? [], standing, now);
        const left = a.budgetUsd ?? 0;
        const spent = spentBy(a.name, events);
        const share = left + spent > 0 ? left / (left + spent) : 0;
        return (
          <Press
            key={a.id}
            onPress={() => onOpenAgent(a.id)}
            accessibilityRole="button"
            accessibilityLabel={`${a.name}. ${line.runs ?? a.role}. ${line.status}. ${money(left)} left`}
            style={{ backgroundColor: colors.surface, borderRadius: radius.panel, padding: space.s14, gap: space.s10 }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10 }}>
              <AgentOrb gradient={agentGradient(a.name)} identity={a.name} size={ORB} face />
              <View style={{ flex: 1 }}>
                <Text variant="rowPrimary" numberOfLines={1}>
                  {a.name}
                </Text>
                <Text variant="secondarySm" color={colors.ink55} numberOfLines={1}>
                  {line.runs ?? a.role}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text variant="rowPrimary" figure="own">
                  {a.budgetUsd === null || a.budgetUsd === undefined ? '—' : money(left)}
                </Text>
                <Text variant="footnote" color={colors.ink40}>
                  left on chain
                </Text>
              </View>
            </View>
            <View style={{ height: METER_H, borderRadius: METER_H / 2, backgroundColor: colors.hairline }}>
              <View
                style={{
                  width: `${Math.round(share * 100)}%`,
                  height: METER_H,
                  borderRadius: METER_H / 2,
                  backgroundColor: line.due ? colors.up : colors.ink55,
                }}
              />
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s6 }}>
              <Dot color={line.due ? colors.up : live && left > 0 ? colors.ink40 : colors.warn} />
              <Text variant="footnote" color={line.due ? colors.up : colors.ink55} style={{ flex: 1 }} numberOfLines={1}>
                {line.status}
              </Text>
              {spent > 0 ? (
                <Text variant="footnote" color={colors.ink40} figure="own">
                  {`${money(spent)} spent`}
                </Text>
              ) : null}
            </View>
          </Press>
        );
      })}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: space.s10,
        }}
      >
        <Eyebrow small>What they did</Eyebrow>
        <Press onPress={onSeeAll} accessibilityRole="button" accessibilityLabel="See all activity" hitHeight={size.hit}>
          <Text variant="control" color={colors.ink55}>
            See all
          </Text>
        </Press>
      </View>
      {trail.data === undefined && trail.error === undefined ? (
        <LoadingRows count={3} height={size.rowLg} />
      ) : feed.length === 0 ? (
        <Text variant="secondarySm" color={colors.ink55}>
          Nothing yet. Their fills, and the trades they refused, land here as they happen.
        </Text>
      ) : (
        feed.map((e, i) => (
          <Rise key={e.id} index={i === 0 ? 0 : 1}>
            <FeedRow e={e} now={now} />
          </Rise>
        ))
      )}
    </View>
  );
}

function FeedRow({ e, now }: { e: ActivityEvent; now: number }) {
  const fresh = isFresh(e, now);
  const tone = e.kind === 'trade' ? colors.up : e.kind === 'block' ? colors.down : colors.warn;
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: space.s10,
        paddingVertical: space.s10,
        borderBottomWidth: 1,
        borderBottomColor: colors.hairline,
      }}
    >
      <View style={{ paddingTop: space.s6 }}>
        <Dot color={tone} />
      </View>
      <View style={{ flex: 1, gap: space.s2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
          <Text variant="rowPrimary" numberOfLines={1} style={{ flex: 1 }}>
            {plainAction(e.action)}
          </Text>
          {fresh ? (
            <View
              style={{
                paddingHorizontal: space.s8,
                paddingVertical: space.s2,
                borderRadius: radius.full,
                backgroundColor: colors.up,
              }}
            >
              <Text variant="footnote" color={colors.bg}>
                Just now
              </Text>
            </View>
          ) : (
            <Text variant="footnote" color={colors.ink40}>
              {eventTime(e)}
            </Text>
          )}
        </View>
        {e.detail ? (
          <Text variant="secondarySm" color={colors.ink55} numberOfLines={2}>
            {plainDetail(e.detail)}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text variant="footnote" color={colors.ink40}>
            {e.agent === 'xorr' ? 'You' : e.agent}
          </Text>
          {e.explorer ? <TransactionRef explorer={e.explorer} /> : null}
        </View>
      </View>
    </View>
  );
}
