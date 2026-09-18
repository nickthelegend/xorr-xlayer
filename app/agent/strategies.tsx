/**
 * Strategies (2026-09-16): pick what a new agent runs — any of them, or all.
 *
 * Opened from New agent. Every strategy the executor can run here (`src/strategies/agentStrategies.ts`), each with a
 * box to tick and what it did over the last 90 days of real prices; the ones that made money are marked working, and
 * listed first once every replay is in. Narrowed by what it does, or to the working ones; "Select all" picks everything
 * showing. The pick is shared with New agent, which makes the agent and gives it each strategy.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  BackButton,
  Button,
  Fill,
  Pill,
  Press,
  Screen,
  SignInPrompt,
  Tag,
  Text,
  border,
  colors,
  radius,
  space,
} from '@/ui';
import { Icon } from '@/design/Icon';
import { useSignedOut } from '@/auth/useSignedOut';
import { usePrices } from '@/data/usePrices';
import { ReplayLine } from '@/strategies/ReplayLine';
import {
  PRICED,
  STRATEGY_TEMPLATES,
  isWorking,
  marksOf,
  scoreOf,
  useAgentStrategies,
  useStrategyReplays,
  type Marks,
  type Replay,
  type StrategyGroup,
  type StrategyTemplate,
} from '@/strategies/agentStrategies';

type Filter = 'all' | 'working' | StrategyGroup;

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'working', label: 'Working' },
  { value: 'buys', label: 'Buys' },
  { value: 'trading', label: 'Trading' },
  { value: 'protect', label: 'Protect' },
  { value: 'cash', label: 'Cash' },
];

const CHECK = 22;
const CHECK_RADIUS = 6;
const CHECK_RING = 2;

export default function PickStrategies() {
  const goBack = useGoBack();
  const signedOut = useSignedOut();
  const { quotes } = usePrices(PRICED);
  const marks = marksOf(quotes);
  useStrategyReplays(marks, !signedOut);
  const chosen = useAgentStrategies((s) => s.chosen);
  const replays = useAgentStrategies((s) => s.replays);
  const toggle = useAgentStrategies((s) => s.toggle);
  const choose = useAgentStrategies((s) => s.choose);
  const unchoose = useAgentStrategies((s) => s.unchoose);
  const [filter, setFilter] = useState<Filter>('all');

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
      <BackButton onPress={() => goBack()} />
      <Text variant="screenTitle" style={{ flex: 1 }}>
        Strategies
      </Text>
    </View>
  );

  if (signedOut) {
    return (
      <Screen>
        {header}
        <SignInPrompt text="Sign in to pick strategies." />
      </Screen>
    );
  }

  // Sorted once every replay is in, so a row never moves under a finger that is reaching for it.
  const settled = STRATEGY_TEMPLATES.every((t) => !t.replay || !!replays[t.key]);
  const visible = STRATEGY_TEMPLATES.filter((t) =>
    filter === 'all' ? true : filter === 'working' ? isWorking(replays[t.key]) : t.group === filter,
  );
  const ordered = settled ? [...visible].sort((a, b) => scoreOf(b, replays[b.key]) - scoreOf(a, replays[a.key])) : visible;
  const pickable = ordered.filter((t) => !t.needs || !!marks[t.needs]);
  const allPicked = pickable.length > 0 && pickable.every((t) => chosen.has(t.key));
  const keys = pickable.map((t) => t.key);

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
        <BackButton onPress={() => goBack()} />
        <Text variant="screenTitle" style={{ flex: 1 }}>
          Strategies
        </Text>
        {pickable.length > 0 ? (
          <Press
            onPress={() => (allPicked ? unchoose(keys) : choose(keys))}
            accessibilityRole="button"
            accessibilityLabel={allPicked ? 'Clear every strategy showing' : 'Select every strategy showing'}
            hitHeight={44}
          >
            <Text variant="rowPrimary" color={colors.ink}>
              {allPicked ? 'Clear all' : 'Select all'}
            </Text>
          </Press>
        ) : null}
      </View>

      <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }}>
        Pick any, or all. Each was replayed on the last 90 days of real prices, fees included. Nothing here is a promise.
      </Text>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, marginTop: space.s14 }}
        contentContainerStyle={{ gap: space.s8 }}
      >
        {FILTERS.map((f) => (
          <Pill key={f.value} label={f.label} selected={f.value === filter} onPress={() => setFilter(f.value)} />
        ))}
      </ScrollView>

      <Fill style={{ marginTop: space.s14 }}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: space.s10, paddingBottom: space.s20 }}>
          {ordered.length === 0 ? (
            <Text variant="body" color={colors.ink55} style={{ marginTop: space.s16 }}>
              {settled ? 'None of these made money over the last 90 days.' : 'Still replaying these.'}
            </Text>
          ) : (
            ordered.map((t) => (
              <StrategyRow
                key={t.key}
                template={t}
                replay={replays[t.key]}
                marks={marks}
                selected={chosen.has(t.key)}
                onPress={() => toggle(t.key)}
              />
            ))
          )}
        </ScrollView>
      </Fill>

      <Button label={chosen.size > 0 ? `Done · ${chosen.size} picked` : 'Done'} onPress={() => goBack()} />
    </Screen>
  );
}

function StrategyRow({
  template,
  replay,
  marks,
  selected,
  onPress,
}: {
  template: StrategyTemplate;
  replay: Replay | undefined;
  marks: Marks;
  selected: boolean;
  onPress: () => void;
}) {
  // A range or a stop is drawn against today's price, so it waits for that price before it can be picked.
  const available = !template.needs || !!marks[template.needs];
  return (
    <Press
      onPress={onPress}
      disabled={!available}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled: !available }}
      aria-checked={selected}
      accessibilityLabel={`${template.title}, ${template.what}`}
      style={[
        {
          backgroundColor: colors.surface,
          borderRadius: radius.panel,
          padding: space.s16,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.s14,
        },
        selected ? border.selected : border.card,
      ]}
    >
      <View
        style={{
          width: CHECK,
          height: CHECK,
          borderRadius: CHECK_RADIUS,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: selected ? 0 : CHECK_RING,
          borderColor: colors.radioBorder,
          backgroundColor: selected ? colors.ink : colors.surface,
        }}
      >
        {selected ? <Icon name="check" size={15} color={colors.bg} strokeWidth={2.6} /> : null}
      </View>
      <View style={{ flex: 1, gap: space.s2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
          <Text variant="rowPrimary" numberOfLines={1} style={{ flexShrink: 1 }}>
            {template.title}
          </Text>
          {isWorking(replay) ? <Tag label="Working" small colors={{ bg: colors.surfaceAlt, fg: colors.up }} /> : null}
        </View>
        <Text variant="secondarySm" numberOfLines={2}>
          {template.what}
        </Text>
        <ReplayLine template={template} replay={replay} marks={marks} />
      </View>
    </Press>
  );
}
